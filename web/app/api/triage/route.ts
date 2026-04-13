import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveAuth } from "@/lib/auth-helpers";
import { runAgentLoop } from "@/lib/agent";
import { getSystemPrompt } from "@/lib/config";
import { DEFAULT_MODEL } from "@/lib/config";
import { recordUsage } from "@/lib/usage-tracker";
import { logger, hashPii, setLogContext } from "@/lib/logger";
import { resolveTriageSkill, checkCallerAllowlist } from "@/lib/triage-dispatch";
import {
  TRIAGE_VERDICT_TOOL,
  TRIAGE_VERDICT_TOOL_NAME,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageResult,
  applyGuardrails,
} from "@/lib/triage-wrapper";
import { checkCircuitBreaker, recordTriageOutcome } from "@/lib/triage-circuit-breaker";
import { createTriageRun, getTriageRunByAlertId, updateTriageRun } from "@/lib/triage-store";
import type {
  TriageRequest,
  TriageResponse,
  TriageRun,
  TriageSource,
  TriageProduct,
  TriageAlertSeverity,
  TokenUsage,
  LogIdentityContext,
} from "@/lib/types";
import { TRIAGE_RUN_TTL } from "@/lib/types";

// ── Per-caller rate limiter ───────────────────────────────────
// Prevents a single service principal from tripping the circuit breaker
// by flooding the endpoint with requests. Resets per window.
const RATE_LIMIT_PER_CALLER = 100;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min

interface CallerWindow {
  count: number;
  windowStart: number;
}
const callerWindows = new Map<string, CallerWindow>();

function checkCallerRateLimit(callerId: string): boolean {
  const now = Date.now();
  const entry = callerWindows.get(callerId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    callerWindows.set(callerId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_PER_CALLER;
}

const VALID_PRODUCTS = new Set<string>([
  "DefenderXDR", "Sentinel", "EntraIDProtection", "Purview", "DefenderForCloudApps",
]);
const VALID_SEVERITIES = new Set<string>(["Informational", "Low", "Medium", "High"]);

function validateTriageRequest(
  body: unknown,
): { valid: true; request: TriageRequest } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object." };
  }
  const obj = body as Record<string, unknown>;

  // source
  const source = obj.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") {
    return { valid: false, error: "Missing or invalid 'source' object." };
  }
  if (typeof source.alertId !== "string" || !source.alertId) {
    return { valid: false, error: "Missing 'source.alertId'." };
  }
  if (source.alertId.length > 255) {
    return { valid: false, error: "'source.alertId' exceeds 255-character limit." };
  }
  if (typeof source.product !== "string" || !VALID_PRODUCTS.has(source.product)) {
    return { valid: false, error: `Invalid 'source.product'. Must be one of: ${[...VALID_PRODUCTS].join(", ")}` };
  }
  if (typeof source.alertType !== "string" || !source.alertType) {
    return { valid: false, error: "Missing 'source.alertType'." };
  }
  if (typeof source.severity !== "string" || !VALID_SEVERITIES.has(source.severity)) {
    return { valid: false, error: `Invalid 'source.severity'. Must be one of: ${[...VALID_SEVERITIES].join(", ")}` };
  }

  // payload
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Missing or invalid 'payload' object." };
  }
  const essentials = payload.essentials as Record<string, unknown> | undefined;
  if (!essentials || typeof essentials !== "object") {
    return { valid: false, error: "Missing 'payload.essentials'." };
  }
  if (typeof essentials.title !== "string") {
    return { valid: false, error: "Missing 'payload.essentials.title'." };
  }
  if (essentials.description !== undefined && typeof essentials.description !== "string") {
    return { valid: false, error: "'payload.essentials.description' must be a string." };
  }

  // Cap payload.raw to prevent Cosmos item-size overflows (2 MB limit)
  if (payload.raw) {
    const rawSize = JSON.stringify(payload.raw).length;
    if (rawSize > 1_000_000) {
      return { valid: false, error: `'payload.raw' is too large (${(rawSize / 1024).toFixed(0)} KB). Maximum: 1 MB.` };
    }
  }

  // Validate portalUrl scheme if present
  if (payload.links && typeof payload.links === "object") {
    const links = payload.links as Record<string, unknown>;
    if (links.portalUrl && typeof links.portalUrl === "string") {
      try {
        const url = new URL(links.portalUrl as string);
        if (url.protocol !== "https:") {
          return { valid: false, error: "'payload.links.portalUrl' must use the https: scheme." };
        }
      } catch {
        return { valid: false, error: "'payload.links.portalUrl' is not a valid URL." };
      }
    }
  }

  // context
  const context = obj.context as Record<string, unknown> | undefined;
  if (!context || typeof context !== "object") {
    return { valid: false, error: "Missing or invalid 'context' object." };
  }
  if (typeof context.requesterId !== "string") {
    return { valid: false, error: "Missing 'context.requesterId'." };
  }
  if (context.analystNotes && typeof context.analystNotes === "string" && context.analystNotes.length > 10_000) {
    return { valid: false, error: "'context.analystNotes' exceeds 10,000-character limit." };
  }

  return {
    valid: true,
    request: {
      source: {
        product: source.product as TriageProduct,
        alertType: source.alertType as string,
        severity: source.severity as TriageAlertSeverity,
        tenantId: (source.tenantId as string) ?? "",
        alertId: source.alertId as string,
        detectionTime: (source.detectionTime as string) ?? new Date().toISOString(),
      },
      payload: payload as unknown as TriageRequest["payload"],
      context: {
        requesterId: context.requesterId as string,
        playbookRunId: (context.playbookRunId as string) ?? undefined,
        dryRun: context.dryRun === true,
        analystNotes: (context.analystNotes as string) ?? undefined,
      },
    },
  };
}

function buildFailSafeResponse(
  reason: string,
  neoRunId: string,
  durationMs: number,
  dryRun: boolean,
): TriageResponse {
  return {
    verdict: "escalate",
    confidence: 0,
    reasoning: `Triage could not complete: ${reason}`,
    evidence: [],
    recommendedActions: [
      { action: "escalate_to_analyst", reason: `Automated triage failed: ${reason}` },
    ],
    neoRunId,
    skillUsed: "none",
    durationMs,
    dryRun: dryRun || undefined,
    reason,
  };
}

export async function POST(request: NextRequest) {
  const startMs = Date.now();
  const neoRunId = `triage_${randomUUID()}`;

  // 1. Auth
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse + validate
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateTriageRequest(body);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const triageRequest = validation.request;
  const { source, context } = triageRequest;
  const dryRun = context.dryRun ?? false;

  const logIdentity: LogIdentityContext = {
    userName: identity.name,
    userIdHash: hashPii(identity.ownerId),
    role: identity.role,
    provider: identity.provider,
    channel: "triage",
    sessionId: neoRunId,
  };

  return setLogContext(logIdentity, async () => {
    logger.info("Triage request received", "api/triage", {
      alertId: source.alertId,
      product: source.product,
      alertType: source.alertType,
      severity: source.severity,
      dryRun,
    });

    // 3a. Per-caller rate limit
    if (!checkCallerRateLimit(identity.ownerId)) {
      logger.warn("Triage rate limit exceeded for caller", "api/triage", {
        callerId: hashPii(identity.ownerId),
      });
      return NextResponse.json(
        { error: "Rate limit exceeded. Maximum 100 requests per 15-minute window." },
        { status: 429 },
      );
    }

    // 3b. Circuit breaker
    const breaker = checkCircuitBreaker();
    if (breaker.open) {
      logger.warn("Circuit breaker open — returning escalate", "api/triage", { reason: breaker.reason });
      const response = buildFailSafeResponse(
        breaker.reason ?? "circuit_breaker_open",
        neoRunId,
        Date.now() - startMs,
        dryRun,
      );
      return NextResponse.json(response);
    }

    // 4. Idempotency check — scoped to this caller
    try {
      const cached = await getTriageRunByAlertId(source.alertId, identity.ownerId);
      if (cached?.response) {
        logger.info("Returning cached triage verdict (dedup)", "api/triage", {
          alertId: source.alertId,
          neoRunId: cached.response.neoRunId,
        });
        return NextResponse.json(cached.response);
      }
    } catch (err) {
      // Cosmos unavailable — proceed without dedup (fail open on reads)
      logger.warn("Dedup lookup failed — proceeding without cache", "api/triage", {
        errorMessage: (err as Error).message,
      });
    }

    // 5. Resolve skill
    const resolved = resolveTriageSkill(source);
    if (!resolved) {
      const response: TriageResponse = {
        verdict: "inconclusive",
        confidence: 0,
        reasoning: "No triage skill is registered for this alert type.",
        evidence: [],
        recommendedActions: [
          { action: "escalate_to_analyst", reason: "No automated triage skill available." },
        ],
        neoRunId,
        skillUsed: "none",
        durationMs: Date.now() - startMs,
        dryRun: dryRun || undefined,
        reason: "no_skill_registered",
      };
      return NextResponse.json(response);
    }

    const { skillId, skill } = resolved;

    // 6. Caller allowlist
    if (!checkCallerAllowlist(identity.ownerId, skillId)) {
      logger.warn("Caller blocked by skill allowlist", "api/triage", {
        callerId: hashPii(identity.ownerId),
        skillId,
      });
      return NextResponse.json({ error: "Forbidden — caller not authorized for this skill." }, { status: 403 });
    }

    // 7. Create initial triage run in Cosmos (neoRunId as document ID
    // to prevent cross-caller data leakage via alertId collisions)
    const run: TriageRun = {
      id: neoRunId,
      alertId: source.alertId,
      request: triageRequest,
      callerId: identity.ownerId,
      createdAt: new Date().toISOString(),
      ttl: TRIAGE_RUN_TTL,
    };
    try {
      await createTriageRun(run);
    } catch (err) {
      logger.warn("Failed to create triage run — proceeding without persistence", "api/triage", {
        errorMessage: (err as Error).message,
      });
    }

    // 8. Build system prompt
    const basePrompt = await getSystemPrompt("triage");
    const systemPrompt = buildTriageSystemPrompt(basePrompt, skill.instructions);

    // 9. Build user message
    const userMessage = buildTriageUserMessage(triageRequest);

    // 10. Run agent loop
    const accumulatedUsage: TokenUsage[] = [];

    try {
      const agentResult = await runAgentLoop(
        [{ role: "user", content: userMessage }],
        {
          onUsage: (usage) => {
            accumulatedUsage.push(usage);
          },
        },
        "triage",
        neoRunId,
        DEFAULT_MODEL,
        undefined,
        {
          toolAllowlist: skill.requiredTools,
          extraTools: [TRIAGE_VERDICT_TOOL],
          toolChoice: { type: "tool", name: TRIAGE_VERDICT_TOOL_NAME },
          systemPromptOverride: systemPrompt,
          nonExecutableTools: new Set([TRIAGE_VERDICT_TOOL_NAME]),
          csvAttachments: [],
        },
      );

      // 11. Parse verdict
      const durationMs = Date.now() - startMs;
      let triageResponse = parseTriageResult(agentResult, neoRunId, skillId, durationMs, dryRun);

      // 12. Apply guardrails
      triageResponse = applyGuardrails(triageResponse, source);

      // 13. Record outcome
      const success = !triageResponse.reason?.startsWith("neo_");
      recordTriageOutcome(success);

      // 14. Track usage (no budget enforcement)
      for (const usage of accumulatedUsage) {
        void recordUsage(identity.ownerId, neoRunId, DEFAULT_MODEL, usage);
      }

      // 15. Finalize triage run in Cosmos
      run.response = triageResponse;
      run.durationMs = durationMs;
      run.rawClaudeResponse = agentResult.type === "response" ? agentResult.text : undefined;
      void updateTriageRun(run);

      logger.info("Triage verdict", "api/triage", {
        alertId: source.alertId,
        verdict: triageResponse.verdict,
        confidence: triageResponse.confidence,
        skillUsed: skillId,
        durationMs,
        reason: triageResponse.reason,
      });

      // 16. Return
      return NextResponse.json(triageResponse);
    } catch (err) {
      // 17. Fail-safe
      recordTriageOutcome(false);
      const durationMs = Date.now() - startMs;
      logger.error("Triage pipeline error", "api/triage", {
        alertId: source.alertId,
        errorMessage: (err as Error).message,
      });

      const response = buildFailSafeResponse(
        "neo_internal_error",
        neoRunId,
        durationMs,
        dryRun,
      );

      run.response = response;
      run.durationMs = durationMs;
      void updateTriageRun(run);

      return NextResponse.json(response);
    }
  });
}
