# Alert Triage API

## Context

Add `POST /api/triage` — a new endpoint that accepts structured security alerts from Azure Logic Apps, dispatches them through Neo's investigation skills, and returns a JSON verdict (benign / escalate / inconclusive) that the caller uses to auto-close or escalate. This is Phase 1: endpoint scaffolding, Entra service-principal auth, skill dispatch, structured output via `tool_use`, guardrails, Cosmos `triageRuns` persistence, one proof-of-concept skill (`defender-endpoint-triage`), and a generic catch-all skill.

The user's inline annotations on the spec override two items from the original Notion feature request: (1) the severity guardrail is relaxed — all severities including Medium and High are eligible for auto-close, not just Informational/Low; (2) structured output uses `tool_use` with `tool_choice` rather than prefill + stop sequence.

---

## Key Design Decisions

- **Auth: extend `resolveAuth` to accept app-only Entra bearer tokens** (service principal / Managed Identity). Today it handles user id_tokens and API keys. Add a new `"service-principal"` provider path that validates `appid`/`azp` claims instead of user-linked claims. No session needed — triage is stateless.
- **Structured output: `tool_use` with `tool_choice`** rather than prefill + stop sequence. Define a `respond_with_triage_verdict` tool whose `input_schema` IS the response contract. Force Claude to call it by setting `tool_choice: { type: "tool", name: "respond_with_triage_verdict" }`. The tool's "result" is not executed — it's the response. This gives native JSON schema validation and eliminates the parse/retry dance.
- **Skill dispatch: reuse existing `getSkill()` + synthesized slash-command pattern** for Phase 1. A versioned lookup table maps `source.product + source.alertType` → skill ID. Unrecognized types go through the generic catch-all skill.
- **No session creation**: triage runs don't create Cosmos conversation documents. The agent loop receives a standalone message array with `sessionId = "triage_{alertId}"` for logging only. Audit lives in the separate `triageRuns` container.
- **Tool filtering by skill**: each triage skill's `requiredTools` array is the tool allowlist for that run. `runAgentLoop` already accepts tools via `getToolsForRole(role)` → filtered in `agent.ts`. Add an optional `toolAllowlist` to `RunAgentLoopOptions` that intersects with role-level tools.
- **Severity guardrail relaxed**: per user feedback, all severities (including Medium and High) are eligible for auto-close. The severity check is still configurable via env var, but the default allowlist includes all levels.
- **Confidence threshold**: verdicts with confidence < 0.80 are coerced to `escalate`. Configurable via `TRIAGE_CONFIDENCE_THRESHOLD`.
- **Circuit breaker**: 30% failure over a 15-minute rolling window trips the breaker. Auto-resets after a configurable cooldown (default: 30 minutes). Admin can also manually reset via `POST /api/admin/triage/circuit-breaker/reset`.
- **Idempotency**: 24-hour dedup window keyed on `source.alertId`. Configurable via `TRIAGE_DEDUP_WINDOW_MS`.
- **Budget**: triage runs skip the per-user token budget system. Usage is tracked (via `recordUsage`) for cost visibility but never enforced/blocked.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `TriageRequest`, `TriageResponse`, `TriageVerdict`, `TriageRun`, `TriageSource`, `TriagePayload`, `TriageContext` interfaces. Add `TRIAGE_*` config constants. |
| `web/lib/auth-helpers.ts` | Add service-principal Entra token validation path inside `resolveAuth`. New `"service-principal"` provider type. |
| `web/lib/triage-store.ts` | New file. Lazy-singleton Cosmos client for `triageRuns` container. CRUD: `createTriageRun`, `getTriageRunByAlertId` (dedup lookup), `updateTriageRun`. |
| `web/lib/triage-dispatch.ts` | New file. Lookup table mapping `product + alertType` → skill ID. `resolveTriageSkill(source)` function. Per-caller skill allowlist enforcement (env-var-based). |
| `web/lib/triage-wrapper.ts` | New file. Builds the triage-mode system prompt: base Neo prompt + triage-specific preamble + JSON output contract + confidence rubric. Defines the `respond_with_triage_verdict` tool schema. Parses and validates the tool-call result. Applies guardrails (confidence threshold, severity coercion). |
| `web/lib/triage-circuit-breaker.ts` | New file. In-memory rolling-window failure counter. `checkCircuitBreaker()`, `recordTriageOutcome(success)`, `resetCircuitBreaker()`. Auto-resets after cooldown. |
| `web/lib/agent.ts` | Add optional `toolAllowlist?: string[]` to `RunAgentLoopOptions`. When present, intersect with role tools before building `cachedTools`. Add optional `toolChoice` to options for forcing structured output. |
| `web/lib/config.ts` | Add `TRIAGE_DEDUP_WINDOW_MS`, `TRIAGE_CONFIDENCE_THRESHOLD`, `TRIAGE_SEVERITY_ALLOWLIST`, `TRIAGE_CIRCUIT_BREAKER_THRESHOLD`, `TRIAGE_CIRCUIT_BREAKER_WINDOW_MS`, `TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS`, `TRIAGE_CALLER_ALLOWLIST`, `TRIAGE_RAW_PAYLOAD_MAX_BYTES` env vars to `env` object. |
| `web/app/api/triage/route.ts` | New file. The `POST` handler: validate auth (service-principal), parse + validate request body, check circuit breaker, check dedup, resolve skill, build triage wrapper, call `runAgentLoop` with tool_choice, parse verdict from tool-call result, apply guardrails, persist to Cosmos, return JSON. |
| `web/app/api/admin/triage/circuit-breaker/reset/route.ts` | New file. Admin-only `POST` to manually reset the circuit breaker. |
| `web/skills/defender-endpoint-triage.md` | New file. Phase 1 proof-of-concept triage skill. Instructions for investigating Defender endpoint alerts: check process tree, cross-reference user sign-in history, check TI on file hashes, assess lateral movement indicators, summarize findings. Declares `requiredTools`. |
| `web/skills/generic-alert-triage.md` | New file. Catch-all skill for unregistered alert types. Generic investigation: pivot on entities (users, devices, IPs), check recent Sentinel logs, check user risk profile, summarize findings. |
| `scripts/provision-cosmos-db.ps1` | Add `triageRuns` container creation (partition key: `/alertId`, TTL: 90 days, autoscale throughput). |
| `web/test/triage-endpoint.test.ts` | New file. Tests per the spec's Testing Guidelines: valid request, malformed body, unknown alertType, dedup, parse failure, unauthenticated. |
| `web/test/triage-guardrails.test.ts` | New file. Confidence coercion, dry-run flag, circuit-breaker behavior. |
| `web/test/triage-dispatch.test.ts` | New file. Skill resolution, unmapped types, per-caller allowlist, wrapper presence. |

---

## Implementation Steps

### 1. Add types and config constants

- In `web/lib/types.ts`, define all triage-related interfaces: `TriageSource` (product, alertType, severity, tenantId, alertId, detectionTime), `TriageEssentials` (title, description, entities, mitreTactics, evidence), `TriagePayload` (essentials, raw, links), `TriageContext` (requesterId, playbookRunId, dryRun, analystNotes), `TriageRequest` (source, payload, context). Response types: `TriageVerdict` enum (`"benign" | "escalate" | "inconclusive"`), `TriageEvidence` (source, query, finding), `TriageRecommendedAction` (action, reason), `TriageResponse` (verdict, confidence, reasoning, evidence, recommendedActions, neoRunId, skillUsed, durationMs, dryRun). Persistence type: `TriageRun` (id, alertId, request, response, rawClaudeResponse, toolCallTrace, callerId, createdAt, durationMs, ttl).
- In `web/lib/config.ts`, add the `TRIAGE_*` env vars to the `env` object, all with sensible defaults: dedup window 24h, confidence 0.80, severity allowlist `"Informational,Low,Medium,High"` (all levels per user feedback), circuit breaker 30%/15min/30min cooldown, raw payload max 500KB. Add them to the `EnvConfig` interface in `types.ts`.

### 2. Extend auth for service principals

- In `web/lib/auth-helpers.ts`, inside `resolveAuth`, add a new code path for Entra app-only tokens. These tokens have `appid` (v1) or `azp` (v2) claims instead of `preferred_username`. Check for the absence of `scp` (delegated scope) or presence of `roles` (app-level scope) to distinguish from user tokens. Map the `appid` / `azp` claim to a new identity shape with `provider: "service-principal"`, `ownerId` set to the app ID, `name` set to the app display name or app ID, and `role` set to `"admin"` (triage callers need full tool access).
- The existing `verifyEntraToken` function validates audience and issuer. Confirm it works with app-only tokens — the audience should match Neo's app registration client ID. If not, add a separate audience for app-only callers configured via `TRIAGE_APP_AUDIENCE` env var.

### 3. Create the triage Cosmos store

- New file `web/lib/triage-store.ts`. Follow the lazy-singleton pattern from `conversation-store.ts`: module-level `let _container: Container | null = null`, `getTriageContainer()` that initializes via `ManagedIdentityCredential` → `CosmosClient` → `database("neo-db").container("triageRuns")`.
- Implement `createTriageRun(run: TriageRun): Promise<void>` — writes the full run document.
- Implement `getTriageRunByAlertId(alertId: string): Promise<TriageRun | null>` — point read using alertId as both the ID and partition key. If found and within the dedup window (`createdAt + TRIAGE_DEDUP_WINDOW_MS > now`), return it; otherwise return null.
- Implement `updateTriageRun(run: TriageRun): Promise<void>` — replace the document (used to finalize the run after the agent loop completes).

### 4. Create the skill dispatch module

- New file `web/lib/triage-dispatch.ts`. Define a `TRIAGE_SKILL_MAP: Record<string, string>` that maps `"DefenderXDR:DefenderEndpoint.SuspiciousProcess"` → `"defender-endpoint-triage"`, etc. Phase 1 ships with one specific mapping and the catch-all.
- Implement `resolveTriageSkill(source: TriageSource): { skillId: string; skill: Skill } | null`. Lookup key is `${source.product}:${source.alertType}`. If no match, try the generic catch-all skill (`generic-alert-triage`). If that also fails (shouldn't — it's always registered), return null.
- Implement `checkCallerAllowlist(callerId: string, skillId: string): boolean`. Parse `TRIAGE_CALLER_ALLOWLIST` env var (format: `"appId1:skill1,skill2;appId2:*"` where `*` means all skills). If the env var is empty, all callers are allowed.

### 5. Create the triage-mode wrapper

- New file `web/lib/triage-wrapper.ts`. This is the bridge between the triage endpoint and the agent loop.
- Define the `respond_with_triage_verdict` tool schema as an Anthropic `Tool` object. The `input_schema` IS the response contract: verdict (enum), confidence (number 0–1), reasoning (string), evidence (array), recommendedActions (array). This tool is never "executed" — its input IS the structured response.
- Implement `buildTriageSystemPrompt(basePrompt: string, skillInstructions: string, alertPayload: TriageRequest): string`. Layers: base Neo prompt → triage preamble (defining the verdict rubric, confidence calibration, and the instruction to call `respond_with_triage_verdict`) → the resolved skill instructions → the alert payload formatted as the user message.
- Implement `parseTriageResult(agentResult: AgentLoopResult): TriageResponse`. Extract the `respond_with_triage_verdict` tool-call from the agent loop's response content blocks. Validate the tool input against the schema. On success, return the parsed verdict. On failure (no tool call, malformed input), return the fail-safe escalate response with `neo_parse_failure`.
- Implement `applyGuardrails(response: TriageResponse, source: TriageSource): TriageResponse`. Check confidence threshold — if below `TRIAGE_CONFIDENCE_THRESHOLD`, override verdict to `escalate`. Check severity against `TRIAGE_SEVERITY_ALLOWLIST` — this is now permissive by default (all levels allowed) but if a level is NOT in the allowlist, coerce to `escalate`. Preserve original verdict and confidence in the evidence for auditability.

### 6. Create the circuit breaker

- New file `web/lib/triage-circuit-breaker.ts`. In-memory implementation (not Cosmos-backed — resets on deploy, which is acceptable for Phase 1).
- Maintain a rolling array of `{ timestamp: number; success: boolean }` entries. Configurable window (`TRIAGE_CIRCUIT_BREAKER_WINDOW_MS`) and threshold (`TRIAGE_CIRCUIT_BREAKER_THRESHOLD` as a fraction, e.g., 0.30).
- `checkCircuitBreaker(): { open: boolean; reason?: string }` — prune entries outside the window, calculate failure rate, return open if rate exceeds threshold AND the cooldown hasn't elapsed since the trip time.
- `recordTriageOutcome(success: boolean): void` — push an entry.
- `resetCircuitBreaker(): void` — clear the array and the trip timestamp.
- Auto-reset: track `trippedAt` timestamp. If `now - trippedAt > TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS`, the breaker auto-resets on the next `checkCircuitBreaker` call.

### 7. Extend the agent loop for tool_choice and tool allowlist

- In `web/lib/agent.ts`, add `toolAllowlist?: string[]` and `toolChoice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" }` to `RunAgentLoopOptions`.
- In `runAgentLoop`, after `getToolsForRole(role)` and the existing `query_csv` conditional filter, add: if `toolAllowlist` is present, filter `roleTools` to only include tools whose `name` is in the allowlist (always include `get_full_tool_result` so truncation recovery works). Then add the `respond_with_triage_verdict` tool to the list if it's not already present (it's not in `TOOLS` — it's a triage-only tool).
- Pass `toolChoice` to `createWithRetry` params if present (add it to the `Anthropic.Messages.MessageCreateParamsNonStreaming` object).
- When `toolChoice` forces a specific tool, the agent loop must handle the case where `stop_reason === "tool_use"` and the tool is `respond_with_triage_verdict` — which should NOT be executed. Return the result immediately as `{ type: "response", text: "", messages: localMessages }` with the tool-use block intact so the caller can extract it.

### 8. Create the triage endpoint

- New file `web/app/api/triage/route.ts`. This is the main handler.
- `POST` handler flow:
  1. `resolveAuth(request)` — require service-principal provider. Return 401 if missing or invalid.
  2. Parse and validate the request body against `TriageRequest` shape. Return 400 on missing required fields.
  3. `checkCircuitBreaker()` — if open, return `verdict: escalate`, reason `circuit_breaker_open`, 200.
  4. `getTriageRunByAlertId(source.alertId)` — if found within dedup window, return the cached response, 200.
  5. `resolveTriageSkill(source)` — if null (no skill AND no catch-all), return `verdict: inconclusive`, reason `no_skill_registered`, 200.
  6. `checkCallerAllowlist(callerId, skillId)` — if blocked, return 403.
  7. Create an initial `TriageRun` document in Cosmos (status: `running`).
  8. Build the triage system prompt via `buildTriageSystemPrompt`.
  9. Truncate `payload.raw` to `TRIAGE_RAW_PAYLOAD_MAX_BYTES` before injecting into the prompt. Store the full payload in the Cosmos run document.
  10. Call `runAgentLoop` with: the triage system prompt, empty callbacks (no streaming — this is synchronous JSON-in/JSON-out), `"admin"` role (full tool access), the triage session ID, the configured model, no signal, `{ toolAllowlist: skill.requiredTools, toolChoice: { type: "tool", name: "respond_with_triage_verdict" }, csvAttachments: [] }`.
  11. `parseTriageResult(agentResult)` — extract the verdict from the tool-use block.
  12. `applyGuardrails(parsedResponse, source)` — apply confidence + severity checks.
  13. `recordTriageOutcome(true)` on the circuit breaker (or `false` if parsing failed).
  14. Track usage via `recordUsage` (cost tracking only, no enforcement).
  15. Finalize the `TriageRun` in Cosmos with the full response, tool-call trace, and timing.
  16. Return the `TriageResponse` as JSON, 200.
  17. Wrap the entire pipeline in try/catch. On any unhandled error: `recordTriageOutcome(false)`, return `verdict: escalate`, reason `neo_internal_error`, 200 (never 500 — the caller must always get a verdict).

### 9. Create the circuit-breaker admin reset endpoint

- New file `web/app/api/admin/triage/circuit-breaker/reset/route.ts`.
- `POST` handler: `resolveAuth` → require admin role → `resetCircuitBreaker()` → return `{ ok: true }`.

### 10. Create the triage skills

- New file `web/skills/defender-endpoint-triage.md`. Markdown following the existing skill format (see `web/skills/` for examples). Instructions walk through: extract entities from the alert, query Defender XDR for the alert's process tree and evidence, check the user's recent sign-in anomalies in Entra, look up file hashes against TI, assess lateral movement via Sentinel KQL, summarize findings with confidence and verdict reasoning. `requiredTools`: `search_xdr_by_host`, `get_xdr_alert`, `run_sentinel_kql`, `get_user_info`, `get_machine_isolation_status`.
- New file `web/skills/generic-alert-triage.md`. Generic catch-all: extract entities, pivot on users (get_user_info, Sentinel sign-in logs), pivot on devices (Sentinel device logs), pivot on IPs (Sentinel network logs), summarize. `requiredTools`: `run_sentinel_kql`, `get_user_info`.

### 11. Update the Cosmos provisioning script

- In `scripts/provision-cosmos-db.ps1`, add a new step to create the `triageRuns` container with partition key `/alertId`, default TTL 90 days, and autoscale max throughput (start at 1000 RU/s autoscale).

### 12. Write tests

- `web/test/triage-endpoint.test.ts`: Mock `resolveAuth` to return a service-principal identity, mock `runAgentLoop` to return a tool-use response matching the verdict schema, mock the Cosmos store. Test: valid request → correct verdict JSON shape; malformed body → 400; unknown alertType → inconclusive; dedup → cached response; parse failure → escalate with `neo_parse_failure`; unauthenticated → 401.
- `web/test/triage-guardrails.test.ts`: Unit-test `applyGuardrails` directly. Confidence below threshold → escalate; dry-run flag passes through; circuit breaker open → escalate with `circuit_breaker_open`.
- `web/test/triage-dispatch.test.ts`: Unit-test `resolveTriageSkill` and `checkCallerAllowlist`. Mapped type → correct skill; unmapped → generic catch-all; allowlist block → false.

---

## Verification

1. `npx tsc --noEmit` — must be clean after all changes.
2. `npx vitest run` — all existing tests + new triage tests pass.
3. Manual test with `MOCK_MODE=true`: `curl -X POST http://localhost:3000/api/triage` with a valid service-principal-like token and a sample Defender alert payload. Verify 200 with a well-formed verdict JSON.
4. Manual test: submit the same `alertId` twice within 24 hours and confirm the second response returns the cached verdict with the same `neoRunId`.
5. Manual test: submit a request with an invalid/missing bearer token and confirm 401.
6. Manual test: confirm `POST /api/admin/triage/circuit-breaker/reset` resets the breaker (requires admin auth).
