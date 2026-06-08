import Anthropic from "@anthropic-ai/sdk";
import { env, getSystemPrompt, DEFAULT_MODEL, resolveMaxTokens } from "./config";
import { DESTRUCTIVE_TOOLS, getEnabledServerTools } from "./tools";
import { executeTool } from "./executors";
import { getToolsForRole, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import { getToolIntegration } from "./integration-registry";
import {
  wrapAndMaybeOffloadToolResult,
  wrapMcpToolResultContent,
  auditWebSearchToolResultMetadata,
} from "./injection-guard";
import {
  prepareMessages,
  sanitizeEmptyUserMessages,
  CHARS_PER_TOKEN,
  materializeMcpBlocksAsText,
  unwrapLegacyWebSearchEnvelopes,
} from "./context-manager";
import {
  getMcpServers,
  enforceMcpToolAccess,
  type McpServerConfig,
} from "./mcp-servers";
import { IncompleteToolUseError, MAX_PLAN_RESUMPTION_ATTEMPTS } from "./types";
import type { Message, AgentLoopResult, AgentCallbacks, PendingTool, ModelPreference, TokenUsage, CSVReference, InProgressPlan } from "./types";

// Anthropic beta-API headers required by the MCP-connector path.
// Newer header supersedes mcp-client-2025-04-04; both still work.
const MCP_CLIENT_BETA = "mcp-client-2025-11-20" as const;
// Beta header required to unlock Opus 4.7's 1M-token context window.
// Attached ONLY when the active model id ends in `[1m]` — i.e. the
// legacy Opus 4.7 1M-context sentinel. Opus 4.8 serves 1M by default
// with no header required, so we deliberately skip the beta there
// (sending unknown betas to a model that doesn't expect them risks
// future API rejections).
const CONTEXT_1M_BETA = "context-1m-2025-08-07" as const;
// Beta header that enables 1-hour TTL on prompt-cache breakpoints
// (the default is 5 minutes). 2× write cost but dramatically better
// cache-hit rate on SOC workflows where an analyst pauses between
// turns to read findings. We attach it unconditionally — every cache
// marker in this codebase uses `ttl: "1h"`. See P4 plan.
const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11" as const;

/**
 * Compute the betas[] array for a given model + MCP state. Centralises
 * the "which beta headers should this call carry" logic so neither the
 * MCP-enabled path nor the stable path duplicates the model-id sniffing.
 */
function resolveBetas(model: string, mcpEnabled: boolean): string[] {
  const betas: string[] = [EXTENDED_CACHE_TTL_BETA];
  if (mcpEnabled) betas.push(MCP_CLIENT_BETA);
  if (model.endsWith("[1m]")) betas.push(CONTEXT_1M_BETA);
  return betas;
}

// Cheap heuristic: detect whether a turn started from a skill invocation
// so we can pick the larger MAX_TOKENS_SKILL budget. The skill handler in
// app/api/agent/route.ts prefixes the user's first message with
// `[SKILL INVOCATION: <name>]` before the loop runs — we scan the
// earliest user message (skipping tool_result plumbing) for that marker.
const SKILL_INVOCATION_PREFIX = "[SKILL INVOCATION:";

/**
 * Pull audit-relevant extras out of an executor's tool result so the
 * `tool_execution` event captures them. Today the only producer is
 * the Information Security Incident Response Logic App executors,
 * which embed `responder` (the authenticated operator, server-
 * populated — never the model's choice) and `correlationHeaders` (the
 * Azure API Management / Workflow-Run ids) in the result envelope.
 * Future executors can opt in by surfacing the same field shapes.
 *
 * The function is intentionally permissive: it picks up known fields
 * if present and ignores everything else. The downstream
 * `sanitizeMetadata` allowlist in logger.ts is the canonical filter —
 * fields not on SAFE_METADATA_FIELDS are dropped before reaching
 * Event Hub regardless of what this returns.
 */
export function extractToolAuditExtras(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const r = result as Record<string, unknown>;
  const extras: Record<string, unknown> = {};
  if (typeof r.responder === "string") {
    extras.responder = r.responder;
  }
  if (r.correlationHeaders && typeof r.correlationHeaders === "object" && !Array.isArray(r.correlationHeaders)) {
    const ch = r.correlationHeaders as Record<string, unknown>;
    if (typeof ch.apiManagementRequestId === "string") extras.apiManagementRequestId = ch.apiManagementRequestId;
    if (typeof ch.apiManagementMiddlewareRequestId === "string") extras.apiManagementMiddlewareRequestId = ch.apiManagementMiddlewareRequestId;
    if (typeof ch.workflowRunId === "string") extras.workflowRunId = ch.workflowRunId;
    if (typeof ch.mcpSessionId === "string") extras.mcpSessionId = ch.mcpSessionId;
  }
  return extras;
}

function detectSkillInvocation(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      return msg.content.startsWith(SKILL_INVOCATION_PREFIX);
    }
    if (!Array.isArray(msg.content)) continue;
    // Skip pure tool_result plumbing messages — not a user's text turn.
    const isToolResultCarrier = msg.content.every(
      (b) => typeof b === "object" && b !== null && (b as { type: string }).type === "tool_result",
    );
    if (isToolResultCarrier) continue;
    // First real user text block wins.
    const firstText = msg.content.find(
      (b): b is Anthropic.Messages.TextBlockParam =>
        typeof b === "object" && b !== null && (b as { type: string }).type === "text",
    );
    if (firstText) return firstText.text.startsWith(SKILL_INVOCATION_PREFIX);
  }
  return false;
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** Extends the SDK text block type with prompt caching support.
 *  `ttl` is optional (default 5m); set to "1h" on prefixes that
 *  should survive between user turns. Requires the
 *  `extended-cache-ttl-2025-04-11` beta header, which resolveBetas
 *  always attaches. */
interface CacheableTextBlock extends Anthropic.Messages.TextBlockParam {
  cache_control: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

/**
 * Returns a shallow-cloned messages array with a cache_control
 * breakpoint stamped on the LAST content block of the LAST message.
 * The marker creates a cache lane that the next API call (next
 * tool-use iteration within this turn, or the next user turn) can
 * hit — saving the input-token cost of replaying the whole
 * conversation history each time.
 *
 * Default 5m TTL is correct: each turn's suffix is mostly invalidated
 * by the next user turn anyway, and the system+tools 1h cache covers
 * cross-turn pauses. See P4 plan.
 *
 * Safe-no-ops on:
 *   - empty messages array
 *   - last message with no content blocks
 *   - last message whose content is already a cache_control-bearing
 *     block (idempotent across retries)
 */
export function stampCacheBreakpointOnLastMessage(
  messages: Message[],
): Message[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  // String content → wrap into a single text block we can stamp on.
  if (typeof last.content === "string") {
    if (last.content.length === 0) return messages;
    const stamped: Message = {
      ...last,
      content: [
        {
          type: "text",
          text: last.content,
          cache_control: { type: "ephemeral" },
        } as CacheableTextBlock,
      ],
    };
    return [...messages.slice(0, lastIdx), stamped];
  }

  if (!Array.isArray(last.content) || last.content.length === 0) {
    return messages;
  }

  const lastBlockIdx = last.content.length - 1;
  const lastBlock = last.content[lastBlockIdx] as { cache_control?: unknown };
  // Already stamped (e.g. by a retry that came through the same path).
  if (lastBlock.cache_control) return messages;

  const newContent = [
    ...last.content.slice(0, lastBlockIdx),
    { ...lastBlock, cache_control: { type: "ephemeral" } },
  ] as typeof last.content;
  return [
    ...messages.slice(0, lastIdx),
    { ...last, content: newContent },
  ];
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503]);

// Matches both the runtime fetch `AbortError` (name === "AbortError")
// AND the Anthropic SDK's `APIUserAbortError` class (name ===
// "APIUserAbortError"). The SDK throws the latter when `signal.aborted`
// is true at request entry or when the underlying fetch errors AND the
// signal is aborted (see `@anthropic-ai/sdk/core.js:298, 304`). Without
// matching both, SDK-originated aborts fall through to the generic
// error path and the agent loop emits a confusing "Unexpected
// stop_reason" / opaque-error response instead of the clean
// `buildInterruptedResult()` flow.
function isAbortError(err: unknown): boolean {
  const name = (err as Error | undefined)?.name;
  return name === "AbortError" || name === "APIUserAbortError";
}

async function createWithRetry(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<Anthropic.Messages.Message> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params, { signal });
    } catch (err: unknown) {
      // Never retry on abort — propagate immediately
      if (isAbortError(err)) {
        throw err;
      }
      const status = (err as { status?: number }).status;

      // 400 errors are deterministic — never retry them
      if (status === 400) {
        const msg = (err as { message?: string }).message ?? "";
        if (msg.includes("prompt is too long")) {
          logger.warn("Prompt exceeded token limit despite context management", "agent", { message: msg });
          throw new Error(
            "The conversation has grown too large for the model's context window. Please start a new session."
          );
        }
        throw new Error(`Request error: ${msg || "invalid request"}`);
      }

      const isRetryable = status !== undefined && RETRYABLE_STATUS.has(status);

      if (!isRetryable || attempt === MAX_RETRIES) {
        // Provide a friendly message for known transient errors
        if (status === 529) {
          throw new Error("Claude is temporarily overloaded. Please try again in a moment.");
        }
        if (status === 429) {
          throw new Error("Rate limit reached. Please wait a moment before sending another message.");
        }
        throw err;
      }

      const delay = Math.min(1000 * 2 ** attempt, 8000);
      logger.warn(`API call failed (${status}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`, "agent");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error("Retry loop exited unexpectedly");
}

// ─────────────────────────────────────────────────────────────
//  Beta-API retry shim — used when the call carries MCP servers
//
//  Anthropic's MCP-connector parameter lives on `beta.messages`
//  behind a `betas: ['mcp-client-2025-11-20']` header. The
//  beta response shape (BetaMessage) is structurally a superset
//  of the stable Message for every field the agent loop reads
//  (id, type, role, model, stop_reason, stop_sequence, usage,
//  content) — extra content-block types like `mcp_tool_use`
//  arrive runtime-only and are picked up by `auditMcpInvocations`.
//  We cast back to the stable type at the boundary so the rest
//  of the loop stays uniform.
// ─────────────────────────────────────────────────────────────

// ─── Beta stream accumulator ──────────────────────────────────
//
// The SDK enforces a 10-minute wall-clock ceiling on every
// non-streaming `messages.create` call. Skills routinely exceed
// that on Opus 4.8 (large output budget + default effort=high +
// multi-step reasoning), surfacing as:
//   "Streaming is required for operations that may take longer
//    than 10 minutes."
// Fix: switch every call to streaming and aggregate server-side.
// The aggregated Message shape is identical to what `.create()`
// returned, so downstream consumers (cache breakpoints, content-
// block parsing, MCP audit, token-usage logging) need no changes.
//
// The beta `messages` class doesn't expose the stable API's
// `.stream()` helper — only `.create({ stream: true })` returning
// a raw event Stream — so we walk the events here.
//
// STREAM_TIMEOUT_MS is the total wall-clock budget for one stream.
// We compose it with the caller's AbortSignal via AbortSignal.any
// at the call site so the timer survives past TTFB. The SDK's
// `timeout` option alone won't cut it: `fetchWithTimeout` in
// `@anthropic-ai/sdk/core.js` clears its setTimeout in `.finally()`
// after the fetch promise resolves (i.e. at headers-received), so a
// quiet stall during body consumption would otherwise hang the
// agent until TCP keepalive. We DON'T add a per-event watchdog —
// the wall-clock budget covers stalled streams adequately, and a
// per-event timer would terminate slow-but-active long turns
// unnecessarily.
const STREAM_TIMEOUT_MS = 30 * 60 * 1000;

interface AccumulatorContentBlock {
  type: string;
  text?: string;
  input?: unknown;
  [k: string]: unknown;
}

/**
 * Accumulate a Beta message stream into a single Message-shaped
 * object. Handles text_delta, input_json_delta, and pass-through
 * for content blocks that arrive complete at content_block_start
 * (mcp_tool_use, mcp_tool_result, thinking, etc.).
 *
 * Abort handling: the Anthropic SDK's stream iterator
 * (`@anthropic-ai/sdk/streaming.js`) explicitly **returns silently**
 * when the underlying fetch is aborted — the for-await loop exits
 * normally instead of throwing. The `signal?.throwIfAborted()`
 * inside the loop only catches aborts that fire between processed
 * events; an abort during the inter-event await (the common case
 * for slow streams) would otherwise reach `return message` with
 * `stop_reason: null` and look like a successful turn. To prevent
 * that, we explicitly re-check the signal AFTER the loop and
 * require `message_stop` to have been seen — either condition
 * failing converts the silent return into a clean abort/error the
 * outer handlers route through `buildInterruptedResult()`.
 */
async function aggregateBetaStream(
  stream: AsyncIterable<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>,
  signal?: AbortSignal,
): Promise<Anthropic.Messages.Message> {
  let message: Record<string, unknown> | null = null;
  let sawMessageStop = false;
  const blocks: AccumulatorContentBlock[] = [];
  // Per-index tool_use partial-JSON buffers — joined + parsed at
  // content_block_stop.
  const toolInputBuffers = new Map<number, string>();

  for await (const event of stream) {
    signal?.throwIfAborted();

    switch (event.type) {
      case "message_start": {
        const start = event as unknown as { message: Record<string, unknown> };
        message = { ...start.message, content: blocks };
        // Seed the blocks buffer from anything the start event
        // already carries. The real Anthropic protocol always sends
        // `content: []` here and then streams content_block_*
        // events, but test wrappers (and forward-compat servers)
        // can short-circuit by delivering the complete message in
        // one event. Without seeding, that content would be lost
        // to the empty buffer.
        const startContent = start.message.content;
        if (Array.isArray(startContent)) {
          for (const block of startContent) {
            blocks.push(block as AccumulatorContentBlock);
          }
        }
        break;
      }
      case "content_block_start": {
        const e = event as unknown as { index: number; content_block: AccumulatorContentBlock };
        // Deep-ish copy so deltas mutate our buffer, not the event.
        blocks[e.index] = { ...e.content_block };
        if (e.content_block.type === "text" && typeof blocks[e.index].text !== "string") {
          blocks[e.index].text = "";
        }
        break;
      }
      case "content_block_delta": {
        const e = event as { index: number; delta: { type: string; text?: string; partial_json?: string } };
        const block = blocks[e.index];
        if (!block) break;
        if (e.delta.type === "text_delta" && typeof e.delta.text === "string") {
          block.text = (block.text ?? "") + e.delta.text;
        } else if (e.delta.type === "input_json_delta" && typeof e.delta.partial_json === "string") {
          toolInputBuffers.set(e.index, (toolInputBuffers.get(e.index) ?? "") + e.delta.partial_json);
        }
        // thinking_delta, signature_delta and other future delta
        // types pass through silently — we only accumulate the
        // fields the agent loop reads downstream.
        break;
      }
      case "content_block_stop": {
        const e = event as { index: number };
        const buf = toolInputBuffers.get(e.index);
        if (buf !== undefined && buf.length > 0) {
          try {
            blocks[e.index].input = JSON.parse(buf);
          } catch (parseErr) {
            // A non-empty buffer that fails to parse means the
            // delta stream was corrupted, truncated mid-arg, or
            // out of order. Silently defaulting to the seeded
            // `{}` would let the agent loop execute a tool call
            // with the wrong arguments — for query-scoping or
            // identity-targeting tools that's a real data-
            // integrity hazard. Fail loud so the retry path
            // engages and the failure is investigable.
            const preview = buf.length > 256 ? `${buf.slice(0, 256)}…` : buf;
            logger.warn(
              "Tool input JSON failed to parse mid-stream",
              "agent",
              { blockIndex: e.index, bufferLength: buf.length, preview },
            );
            throw new Error(
              `tool input JSON parse failed at content block ${e.index}: ${(parseErr as Error).message}`,
            );
          }
          toolInputBuffers.delete(e.index);
        }
        break;
      }
      case "message_delta": {
        const e = event as unknown as { delta: Record<string, unknown>; usage?: Record<string, unknown> };
        if (!message) break;
        // Top-level fields land in message.delta (stop_reason,
        // stop_sequence, container).
        Object.assign(message, e.delta);
        // Usage at this stage carries the FINAL output_tokens;
        // merge with the input_tokens / cache_* recorded at
        // message_start.
        if (e.usage) {
          const prior = (message.usage as Record<string, unknown> | undefined) ?? {};
          message.usage = { ...prior, ...e.usage };
        }
        break;
      }
      case "message_stop":
        sawMessageStop = true;
        break;
      default:
        // Forward-compatible: unknown event types are ignored.
        break;
    }
  }

  // Catch aborts that fired DURING the inter-event await — the SDK
  // iterator swallows AbortError and returns silently, so without
  // this re-check we'd return a partial message and the agent loop
  // would crash with "Unexpected stop_reason: null" instead of
  // surfacing as a clean interrupt.
  signal?.throwIfAborted();

  if (!message) {
    throw new Error("Stream ended without emitting a message_start event");
  }
  if (!sawMessageStop) {
    // No message_stop event means the upstream connection closed
    // before the model finished generating — e.g. a server-side
    // truncation, proxy cut, or silent network failure. The
    // partial message at this point may carry stop_reason: null
    // (no message_delta arrived) which would crash the stop-
    // reason dispatch. Throw a typed network-style error so
    // createBetaWithRetry's retry filter can decide whether to
    // try again.
    throw Object.assign(new Error("Stream ended before message_stop event (incomplete response)"), {
      name: "StreamIncompleteError",
    });
  }
  return message as unknown as Anthropic.Messages.Message;
}

async function createBetaWithRetry(
  params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<Anthropic.Messages.Message> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Compose the caller's signal with a wall-clock timeout so the
    // 30-min budget actually fires during body consumption. The
    // SDK's `timeout` option only covers up to TTFB (its setTimeout
    // is cleared when the fetch promise resolves at headers-
    // received). AbortSignal.any rolls up to whichever fires first.
    // We build a fresh composite per attempt so retries get a full
    // fresh budget rather than sharing one stale timer.
    const composite = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)])
      : AbortSignal.timeout(STREAM_TIMEOUT_MS);
    try {
      // Always stream. The non-streaming path is capped at 10
      // minutes by the SDK; skills + deep Opus 4.8 turns routinely
      // exceed that. We then aggregate to the same Message shape
      // the rest of the loop already consumes.
      const streamParams = {
        ...params,
        stream: true as const,
      } as Anthropic.Beta.Messages.MessageCreateParamsStreaming;
      const stream = await client.beta.messages.create(streamParams, {
        signal: composite,
      });
      return await aggregateBetaStream(stream, composite);
    } catch (err: unknown) {
      if (isAbortError(err)) throw err;
      const status = (err as { status?: number }).status;

      if (status === 400) {
        const msg = (err as { message?: string }).message ?? "";
        if (msg.includes("prompt is too long")) {
          logger.warn("Prompt exceeded token limit despite context management", "agent", { message: msg });
          throw new Error(
            "The conversation has grown too large for the model's context window. Please start a new session.",
          );
        }
        throw new Error(`Request error: ${msg || "invalid request"}`);
      }

      const isRetryable = status !== undefined && RETRYABLE_STATUS.has(status);
      if (!isRetryable || attempt === MAX_RETRIES) {
        if (status === 529) throw new Error("Claude is temporarily overloaded. Please try again in a moment.");
        if (status === 429) throw new Error("Rate limit reached. Please wait a moment before sending another message.");
        throw err;
      }
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      logger.warn(
        `Beta API call failed (${status}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        "agent",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Retry loop exited unexpectedly");
}

/**
 * Fetch the role-scoped MCP server list, swallowing any backing-store
 * error so a Cosmos / Key Vault blip never crashes the agent loop.
 * Empty array = no MCP, take the stable-API path.
 *
 * AbortError is re-thrown — user cancellation must propagate and
 * not be silently degraded to "continue without MCP".
 */
async function getMcpServersSafely(role: Role): Promise<McpServerConfig[]> {
  try {
    return await getMcpServers(role);
  } catch (err) {
    if (isAbortError(err)) throw err;
    logger.warn(
      "agent: MCP server lookup failed — continuing without MCP for this turn",
      "agent",
      { role, errorMessage: err instanceof Error ? err.message : String(err) },
    );
    return [];
  }
}

/**
 * Single entry-point the agent loop uses. Routes through the
 * beta API only when MCP servers are configured for the role,
 * keeping the existing stable-API call surface untouched for
 * every turn that doesn't need MCP. Returns both the response
 * and the wall-clock duration so the MCP audit emission can
 * include a faithful durationMs in its metadata.
 */
async function createWithOptionalMcp(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  mcpServers: McpServerConfig[],
  signal?: AbortSignal,
): Promise<{ message: Anthropic.Messages.Message; durationMs: number }> {
  const start = Date.now();
  const modelId = typeof params.model === "string" ? params.model : "";
  const needsMcp = mcpServers.length > 0;

  // The `[1m]` suffix on the model id is a Neo-internal sentinel for
  // the legacy Opus 4.7 1M-context tier; the Anthropic API only knows
  // the bare `claude-opus-4-7` id and unlocks the 1M context via the
  // `context-1m-2025-08-07` beta header (attached by resolveBetas
  // when the sentinel matches). Strip the suffix at the API boundary
  // so the upstream call doesn't 404. The sentinel still drives
  // beta-header selection upstream because resolveBetas is called
  // with the original `modelId` before stripping.
  //
  // Opus 4.8 (`claude-opus-4-8`) does NOT carry the sentinel and is
  // passed through unchanged — 4.8 serves 1M by default, no header,
  // no strip.
  const apiModelId = modelId.endsWith("[1m]") ? modelId.slice(0, -4) : modelId;

  // Every call routes through the beta API now — we always attach
  // `extended-cache-ttl-2025-04-11` to enable the 1-hour cache TTL
  // on system + tools breakpoints. The beta endpoint is a strict
  // superset of the stable one for messages.create; non-MCP /
  // non-1M-context turns are unaffected except for the betas[] header.
  // Pre-flight materialises any MCP blocks in history into text stubs
  // when MCP isn't active for this turn, so MCP→non-MCP transitions
  // (mid-conversation role swap, secret rotation) don't 400.
  const safeMessages = !needsMcp && hasAnyMcpBlocks(params.messages)
    ? (materializeMcpBlocksAsText(params.messages as Message[]) as typeof params.messages)
    : params.messages;

  const betaParams: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    ...params,
    model: apiModelId,
    messages: safeMessages,
    ...(needsMcp ? { mcp_servers: mcpServers } : {}),
    betas: resolveBetas(modelId, needsMcp),
  } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  const message = await createBetaWithRetry(betaParams, signal);
  return { message, durationMs: Date.now() - start };
}

/**
 * Walk the response's content blocks for `mcp_tool_use` entries
 * and emit one `mcp_invocation` audit event per invocation.
 *
 * IMPORTANT: this is AUDIT-ONLY, not enforcement. By the time
 * this function runs, Anthropic has already called the upstream
 * MCP server and the data is back in `contentBlocks`. The
 * `result: "blocked"` discriminator means "our local allow-list
 * says no but Anthropic let the call through anyway" — that is a
 * divergence between Anthropic's server-side enforcement of
 * `tool_configuration.allowed_tools` and our local mirror in
 * `mcp-servers.ts`. The data has already flowed. The
 * `logger.warn` below escalates that divergence above the routine
 * audit event so ops actually sees it.
 *
 * Active enforcement (intercept-and-deny by injecting an error
 * tool_result back into the next turn) is intentionally deferred
 * to a follow-up. See _specs/wiz-mcp-server-integration.md.
 */
function auditMcpInvocations(
  contentBlocks: unknown[],
  role: Role,
  sessionId: string,
  ownerIdHash: string | undefined,
  // Whole-turn wall-clock duration. Anthropic executes every MCP
  // tool serially inside one API call, so we cannot meaningfully
  // attribute time per individual tool from outside the SDK. The
  // value is identical across all events emitted for the same turn
  // — the field name `turnDurationMs` makes that explicit so
  // downstream dashboards don't read it as per-tool latency. See
  // review N1.
  turnDurationMs: number,
): void {
  const resultsByToolUseId = new Map<string, { is_error: boolean }>();
  for (const block of contentBlocks) {
    if (!isMcpToolResult(block)) continue;
    if (resultsByToolUseId.has(block.tool_use_id)) {
      // Anthropic guarantees unique IDs in practice; if we see a
      // duplicate, the audit picture is ambiguous. Flag rather than
      // silently overwrite.
      logger.warn(
        "agent: duplicate mcp_tool_result id in response — audit may misclassify",
        "agent",
        { toolUseId: block.tool_use_id, sessionId },
      );
    }
    resultsByToolUseId.set(block.tool_use_id, {
      is_error: Boolean(block.is_error),
    });
  }
  for (const block of contentBlocks) {
    if (!isMcpToolUse(block)) continue;
    const result = resultsByToolUseId.get(block.id);
    const allowed = enforceMcpToolAccess(role, block.server_name, block.name);
    let auditResult: "success" | "blocked" | "error" | "orphan";
    if (!allowed) {
      auditResult = "blocked";
      // Allow-list divergence is operationally serious — escalate
      // above the routine audit event. Anthropic just executed a
      // tool we believed should be denied; either our catalogue is
      // stale or the SDK / beta semantics shifted.
      logger.warn(
        "agent: MCP allow-list divergence — Anthropic invoked a tool our local mirror denies",
        "agent",
        {
          mcpServer: block.server_name,
          toolName: block.name,
          role,
          sessionId,
        },
      );
    } else if (!result) {
      // Anthropic's beta normally returns mcp_tool_use and its
      // paired mcp_tool_result in the same response. An orphan
      // tool_use (no result block) means the response was
      // truncated or the SDK shape drifted — either way, we have
      // no evidence the call actually succeeded. Don't silently
      // upgrade to "success". Surface as a distinct state and
      // warn so the orphan condition is investigable.
      auditResult = "orphan";
      logger.warn(
        "agent: mcp_tool_use without paired mcp_tool_result — audit grading as orphan",
        "agent",
        {
          mcpServer: block.server_name,
          toolName: block.name,
          role,
          sessionId,
          toolUseId: block.id,
        },
      );
    } else if (result.is_error) {
      auditResult = "error";
    } else {
      auditResult = "success";
    }

    // Truncate the JSON-stringified input — Wiz tool arguments are
    // GraphQL queries or filter objects that can be a few KB. The
    // SAFE_METADATA_FIELDS allowlist already includes `toolInput`
    // (parity with the tool_execution event for local tools).
    let toolInput = "";
    try {
      toolInput = JSON.stringify(block.input ?? null).slice(0, 2000);
    } catch {
      toolInput = "[unserializable]";
    }

    logger.emitEvent("mcp_invocation", "MCP tool invoked", "agent", {
      mcpServer: block.server_name,
      toolName: block.name,
      role,
      sessionId,
      result: auditResult,
      turnDurationMs,
      ownerIdHash,
      toolUseId: block.id,
      toolInput,
    });
  }
}

interface McpToolUseBlock {
  type: "mcp_tool_use";
  id: string;
  server_name: string;
  name: string;
  // Model-supplied arguments. Anthropic's mcp_tool_use block carries
  // this just like a regular tool_use; we declare it here so the
  // audit pipeline can surface it without an `as unknown` cast.
  input?: unknown;
}
interface McpToolResultBlock {
  type: "mcp_tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: string | unknown[];
}

/**
 * `server_tool_use` is Anthropic's analogue of `tool_use` for server-
 * executed tools (web_search). It carries the name + input the model
 * decided on; the result lands in a sibling `web_search_tool_result`
 * block in the same assistant response.
 */
interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input?: unknown;
}
interface WebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content?: unknown;
}

/**
 * Wrap every `mcp_tool_result` block's `content` field in a
 * trust-marked envelope before the assistant message is appended to
 * conversation history. This is the seam where MCP results — which
 * Anthropic executes server-side and returns inline — get scanned for
 * prompt-injection patterns and tagged with `_neo_trust_boundary` so
 * downstream readers (model on next turn, context-manager, persistence
 * layer) treat them the same way local tool results are treated.
 *
 * Always returns a new content array when MCP results are present so
 * the caller can push the rewritten version to history without
 * mutating Anthropic's response object. Non-MCP blocks pass through
 * unchanged.
 *
 * The replacement is intentionally lossless from an API perspective:
 * the block keeps `type: "mcp_tool_result"`, `tool_use_id`, and
 * `is_error`, so subsequent turns can echo it back to Anthropic
 * without API rejection.
 */
function sanitizeMcpResultsForHistory(
  content: unknown[],
  sessionId: string,
): unknown[] {
  // Map tool_use_id → { server, tool } so each mcp_tool_result knows
  // which MCP server/tool it came from for logging.
  const toolUseById = new Map<string, { server: string; tool: string }>();
  for (const block of content) {
    if (isMcpToolUse(block)) {
      toolUseById.set(block.id, { server: block.server_name, tool: block.name });
    }
  }

  let mutated = false;
  const out = content.map((block) => {
    if (isMcpToolResult(block)) {
      const meta = toolUseById.get(block.tool_use_id);
      const wrapped = wrapMcpToolResultContent(block.content, {
        sessionId,
        serverName: meta?.server ?? "unknown",
        toolName: meta?.tool ?? "unknown",
      });
      mutated = true;
      return {
        ...block,
        content: wrapped,
      };
    }
    if (isWebSearchToolResult(block)) {
      // Audit only — DO NOT replace content. Anthropic's API rejects
      // string content on web_search_tool_result blocks (schema
      // requires Array<WebSearchResultBlock> | WebSearchToolResultError),
      // so any history-side wrapping would 400 on the next turn. The
      // block.type itself already labels the source for the model; the
      // EXTERNAL ENRICHMENT section in the system prompt instructs it
      // to treat web content as untrusted. We just scan the visible
      // metadata (title + URL) and warn-log so SOC can correlate.
      auditWebSearchToolResultMetadata(block.content, {
        sessionId,
        toolUseId: block.tool_use_id,
      });
      return block;
    }
    return block;
  });

  return mutated ? out : content;
}

interface WebSearchCitation {
  type: "web_search_result_location";
  url: string;
  title?: string;
  encrypted_index?: string;
  cited_text?: string;
}

function isWebSearchCitation(c: unknown): c is WebSearchCitation {
  if (typeof c !== "object" || c === null) return false;
  const candidate = c as { type?: unknown; url?: unknown; title?: unknown };
  if (candidate.type !== "web_search_result_location") return false;
  if (typeof candidate.url !== "string") return false;
  // Title is optional but, when present, must be a string. Optional
  // chaining (`?.trim`) would still crash on a non-string title at the
  // call site, so enforce the type here.
  if (candidate.title !== undefined && typeof candidate.title !== "string") {
    return false;
  }
  return true;
}

/**
 * Build a Markdown "Sources" footer from any web_search citations
 * attached to assistant text blocks. Returns "" when the response has
 * no citations (i.e. the model didn't use web_search this turn).
 *
 * URLs are deduped by their normalized form; titles fall back to the
 * URL when missing. The footer is intentionally a plain Markdown
 * heading + bullets so the existing renderers (web MarkdownRenderer,
 * CLI marked-terminal) format it without any new wiring.
 */
/**
 * Pull web_search citations out of a list of assistant text blocks and
 * merge them into the supplied url→title map. Dedupes by URL; later
 * sightings of the same URL do not overwrite the first title.
 *
 * Exported so tests can exercise it directly without spinning up the
 * full agent loop.
 */
export function collectCitationsInto(
  textBlocks: Anthropic.Messages.TextBlock[],
  into: Map<string, string>,
): void {
  for (const block of textBlocks) {
    const citations = (block as unknown as { citations?: unknown[] }).citations;
    if (!Array.isArray(citations)) continue;
    for (const c of citations) {
      if (!isWebSearchCitation(c)) continue;
      if (into.has(c.url)) continue;
      const titleStr = typeof c.title === "string" ? c.title.trim() : "";
      into.set(c.url, titleStr || c.url);
    }
  }
}

/**
 * Build a Markdown "Sources" footer from a deduped url→title map.
 * Returns "" when the map is empty. URLs are validated to be http or
 * https and wrapped in angle brackets so unescaped parentheses (common
 * in Wikipedia / vendor doc URLs) don't break the Markdown link
 * syntax. URLs that fail parse or carry a disallowed scheme
 * (javascript:, data:, file:, etc.) are skipped — they shouldn't
 * reach the user's chat regardless of upstream behaviour.
 */
export function buildCitationsFooter(
  citations: Map<string, string> | Anthropic.Messages.TextBlock[],
): string {
  let seen: Map<string, string>;
  if (citations instanceof Map) {
    seen = citations;
  } else {
    seen = new Map<string, string>();
    collectCitationsInto(citations, seen);
  }
  if (seen.size === 0) return "";
  const lines: string[] = ["", "", "**Sources:**"];
  for (const [url, title] of seen) {
    if (!isSafeCitationUrl(url)) continue;
    lines.push(`- [${escapeMarkdownLinkText(title)}](<${url}>)`);
  }
  // If every URL failed validation the footer would degenerate to just
  // the heading; treat that as "no usable citations" and omit entirely.
  if (lines.length === 3) return "";
  return lines.join("\n");
}

const MAX_CITATION_URL_LENGTH = 2000;

function isSafeCitationUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url.length === 0 || url.length > MAX_CITATION_URL_LENGTH) return false;
  // Whitespace, angle brackets, and control chars don't belong in a
  // URL and would break the angle-bracket-wrapped Markdown link.
  if (/[\s<>\x00-\x1f]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

function escapeMarkdownLinkText(text: string): string {
  // Backslash-escape characters that would distort Markdown rendering
  // around the link text: brackets close the link, backticks open code
  // spans, and angle brackets can be parsed as HTML. We escape `\`
  // FIRST (by including it in the char class) so a pre-existing
  // backslash in the title can't combine with our added escape to
  // re-introduce an unescaped meta-char — e.g. title `\]inject]` would
  // otherwise become `\\]inject\]`, where the literal `\\` collapses
  // to one backslash and the trailing `]` is unescaped, breaking out
  // of the link text. Title is fully attacker-controlled (any web
  // page can set <title>).
  return text.replace(/[\\[\]`<>]/g, "\\$&");
}

/**
 * Quick scan over assistant response content to decide whether sanitisation
 * needs to run. Cheap O(n) negative path keeps the no-server-tool turn cost
 * near-zero.
 */
function hasUntrustedServerBlocks(content: unknown[]): boolean {
  for (const block of content) {
    const t = (block as { type?: unknown }).type;
    if (
      t === "mcp_tool_result" ||
      t === "web_search_tool_result"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Quick scan over a message array to decide whether the stable-API
 * path needs to materialise persisted MCP blocks before calling the
 * Anthropic SDK. Most stable-API turns have no MCP blocks (the user
 * has never used MCP, or this session has not yet), so the fast
 * negative path keeps the cost near-zero.
 */
function hasAnyMcpBlocks(messages: { content: unknown }[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const t = (block as { type?: unknown }).type;
      if (t === "mcp_tool_use" || t === "mcp_tool_result") return true;
    }
  }
  return false;
}

function isMcpToolUse(block: unknown): block is McpToolUseBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "mcp_tool_use" &&
    typeof (block as { id?: unknown }).id === "string" &&
    typeof (block as { server_name?: unknown }).server_name === "string" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}
function isMcpToolResult(block: unknown): block is McpToolResultBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "mcp_tool_result" &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
  );
}
function isServerToolUse(block: unknown): block is ServerToolUseBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "server_tool_use" &&
    typeof (block as { id?: unknown }).id === "string" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}
function isWebSearchToolResult(block: unknown): block is WebSearchToolResultBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "web_search_tool_result" &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
  );
}

export interface RunAgentLoopOptions {
  /**
   * CSV reference-mode attachments available to this conversation. When
   * non-empty, the query_csv tool is registered in the tools list and
   * passed through to the executor context so the tool can look up
   * csv_ids scoped to this conversation.
   */
  csvAttachments?: CSVReference[];
  /**
   * When present, the tools list is intersected with this allowlist.
   * Only tools whose name appears in the list (plus `get_full_tool_result`)
   * are sent to Claude. Used by the triage endpoint to scope tools per skill.
   */
  toolAllowlist?: string[];
  /**
   * Additional tools to include in the request that are NOT in the global
   * TOOLS array. Used by the triage endpoint to inject the
   * `respond_with_triage_verdict` tool. These are appended AFTER the
   * role/allowlist filter so they're always available.
   */
  extraTools?: Anthropic.Messages.Tool[];
  /**
   * Force Claude to call a specific tool. Used by the triage endpoint
   * to ensure structured JSON output via `respond_with_triage_verdict`.
   */
  toolChoice?: Anthropic.Messages.MessageCreateParamsNonStreaming["tool_choice"];
  /**
   * Override the system prompt for this run. When present, replaces the
   * default system prompt from getSystemPrompt(role). Used by the triage
   * endpoint to inject the triage-mode wrapper.
   */
  systemPromptOverride?: string;
  /**
   * Tool names that should NOT be executed by the agent loop even if
   * Claude calls them. The tool-use block is preserved in the messages
   * and the result is returned directly so the caller can extract the
   * structured input. Used for "respond" tools that produce output
   * via their input schema.
   */
  nonExecutableTools?: Set<string>;
  /**
   * When true, this turn uses the larger MAX_TOKENS_SKILL budget instead
   * of MAX_TOKENS_DEFAULT. When false, explicitly forces the default
   * budget (e.g. triage). When undefined, the loop auto-detects by
   * scanning the first user message for the `[SKILL INVOCATION:` prefix.
   */
  skillInvocation?: boolean;
  /**
   * Authenticated user's stable identifier (Entra AAD object id, or a
   * synthetic id for Teams threads / service-principal API keys). When
   * present, the loop forwards `metadata: { user_id: hashPii(ownerId) }`
   * on every Anthropic `messages.create` call so vendor-side trust-and-
   * safety enforcement can be user-scoped. Optional for backwards
   * compatibility — older callers that don't pass it omit the metadata.
   */
  ownerId?: string;
}

export async function runAgentLoop(
  messages: Message[],
  callbacks: AgentCallbacks = {},
  role: Role = "reader",
  sessionId: string = "unknown",
  model: ModelPreference = DEFAULT_MODEL,
  signal?: AbortSignal,
  options: RunAgentLoopOptions = {},
): Promise<AgentLoopResult> {
  // Recover any legacy web_search trust-boundary envelopes from a
  // prior buggy version. Anthropic's API rejects string content on
  // web_search_tool_result blocks; unwrap before any downstream code
  // (prepareMessages, the API call, onTurnComplete persistence) sees
  // them. unwrapLegacyWebSearchEnvelopes is a no-op when the input has
  // no envelopes, so this is cheap on the hot path.
  const localMessages: Message[] = unwrapLegacyWebSearchEnvelopes([...messages]);
  logger.info("Agent loop started", "agent", { role, model });

  // Citations from web_search results are attached to text blocks in
  // the iteration that GENERATED them — typically an earlier iteration
  // where the model researched something before calling a local tool
  // and continuing. Without this loop-scoped accumulator, citations
  // would only be picked up from the FINAL response's text blocks and
  // every intermediate citation would be silently dropped from the
  // user-visible "Sources" footer. The Map is keyed by URL to dedupe
  // across iterations.
  const citationsAcrossLoop = new Map<string, string>();

  /**
   * Append a synthetic [interrupted] text block to the last assistant message
   * so the next turn sees coherent context, and return an interrupted response.
   * If the last assistant message contains unmatched tool_use blocks (mid-tool
   * abort), strip those blocks so the persisted history is structurally valid
   * for the next turn's API call.
   */
  function buildInterruptedResult(): AgentLoopResult {
    // If the last message is an assistant message with a dangling tool_use
    // block (no paired tool_result), strip tool_use blocks to prevent an
    // invalid conversation shape on the next turn.
    const last = localMessages[localMessages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const hasDanglingToolUse = last.content.some(
        (b) => (b as { type: string }).type === "tool_use"
      );
      if (hasDanglingToolUse) {
        last.content = last.content.filter(
          (b) => (b as { type: string }).type !== "tool_use"
        );
      }
      // Guard against double-appending if called twice
      const alreadyMarked = last.content.some(
        (b) => (b as { type: string; text?: string }).type === "text" &&
               (b as { type: string; text?: string }).text === "[interrupted]"
      );
      if (!alreadyMarked) {
        last.content.push({ type: "text", text: "[interrupted]" });
      }
    } else {
      localMessages.push({
        role: "assistant",
        content: [{ type: "text", text: "[interrupted]" }],
      });
    }
    logger.info("Agent loop interrupted", "agent", { role });
    return { type: "response", text: "[interrupted]", messages: localMessages, interrupted: true };
  }

  const systemPrompt = options.systemPromptOverride ?? await getSystemPrompt(role);
  const systemPromptTokenEstimate = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  let lastInputTokens: number | null = null;

  // Pick the output budget once for this entire loop run. Skill invocations
  // need more room than plain chat (multi-step investigations, tables),
  // so the skill-prefix check lifts them to MAX_TOKENS_SKILL. Callers
  // can force the flag (e.g. triage uses false to keep the default) via
  // options.skillInvocation; otherwise we auto-detect from the messages.
  const skillInvocation =
    options.skillInvocation !== undefined
      ? options.skillInvocation
      : detectSkillInvocation(localMessages);
  const maxTokens = resolveMaxTokens(model, { skillInvocation });

  // Build tools with cache_control on the last item so the entire prefix is cached.
  const csvAttachments = options.csvAttachments ?? [];
  const hasCsvAttachments = csvAttachments.length > 0;
  const toolAllowlist = options.toolAllowlist
    ? new Set([...options.toolAllowlist, "get_full_tool_result"])
    : null;

  let filteredTools = getToolsForRole(role).filter((tool) => {
    // query_csv is registered conditionally
    if (tool.name === "query_csv" && !hasCsvAttachments) return false;
    // Tool allowlist narrows the set when present
    if (toolAllowlist && !toolAllowlist.has(tool.name)) return false;
    return true;
  });

  // Append extra tools (e.g., respond_with_triage_verdict)
  if (options.extraTools?.length) {
    filteredTools = [...filteredTools, ...options.extraTools];
  }

  const cachedTools = filteredTools.map((tool, i) =>
    i === filteredTools.length - 1
      ? {
          ...tool,
          // 1h TTL on the tools breakpoint: tool schemas are stable
          // for the role's whole session, and an analyst pausing
          // between turns shouldn't lose the cache. See P4.
          cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
        }
      : tool
  );

  // Server-side tools (web_search) are executed by Anthropic. They're
  // appended AFTER the cache_control marker so the custom-tool prefix
  // cache stays stable — server-tool toggling (e.g. MOCK_MODE on/off)
  // doesn't invalidate the cached schemas of the local tools. The
  // resulting array carries both shapes; we cast at the SDK boundary
  // because the pinned SDK's BetaToolUnion doesn't yet model
  // web_search_20250305.
  //
  // toolAllowlist gates server tools the same way it gates custom
  // tools above. Without this a scheduled task scoped to e.g.
  // ['run_sentinel_kql'] would still get web_search exposed, because
  // server_tool_use blocks bypass the dispatch-time allowlist check
  // (Anthropic executes them server-side, never entering the local
  // tool_use loop where the allowlist is enforced).
  const serverTools = getEnabledServerTools(toolAllowlist);
  const toolsForApi: unknown[] = [...cachedTools, ...serverTools];

  // Load any in-progress plan for this conversation — present when the
  // previous turn was truncated mid-tool-use. On the first iteration of
  // this turn we append a plan-resumption addendum to the system prompt
  // so the model resumes from the unexecuted steps instead of starting
  // fresh. See _plans/output-budget.md.
  let inProgressPlan: InProgressPlan | null = null;
  try {
    const { sessionStore } = await import("./session-factory");
    inProgressPlan = await sessionStore.getInProgressPlan(sessionId);
  } catch (err) {
    // Non-fatal — continue without the plan. Resumption is a soft
    // feature; the user can always re-type what they want.
    logger.warn("getInProgressPlan failed — continuing without resumption hint", "agent", {
      sessionId,
      errorMessage: (err as Error).message,
    });
  }

  // Circuit breaker: if the plan has been resumed too many times
  // without reaching end_turn, halt. Prevents an infinite loop where
  // the agent keeps exhausting its output budget on the same step
  // (e.g. a malformed giant tool input that gets retried on every
  // turn). Clear the plan AND surface a visible error so the user
  // knows to narrow the request.
  if (inProgressPlan && (inProgressPlan.resumptionCount ?? 0) >= MAX_PLAN_RESUMPTION_ATTEMPTS) {
    logger.warn("Plan resumption circuit breaker tripped — halting auto-resume", "agent", {
      sessionId,
      resumptionCount: inProgressPlan.resumptionCount,
      limit: MAX_PLAN_RESUMPTION_ATTEMPTS,
    });
    try {
      const { sessionStore } = await import("./session-factory");
      await sessionStore.setInProgressPlan(sessionId, null);
    } catch {
      // best effort — the user will see the error regardless
    }
    return {
      type: "response",
      // planText is wrapped in a fenced code block — this prevents any
      // adversarial Markdown that may have landed in the persisted plan
      // (headers, links, blockquotes) from rendering as formatting in
      // the client. See security review S8.
      text:
        `I hit my per-turn output budget ${MAX_PLAN_RESUMPTION_ATTEMPTS} times in a row ` +
        `trying to complete this workflow, so I've stopped auto-resuming to avoid looping. ` +
        `The plan so far:\n\n\`\`\`\n${inProgressPlan.planText}\n\`\`\`\n\n` +
        `Please narrow the request (e.g. ask me to do a smaller slice: "just steps 1-3" or ` +
        `"only the alice@corp.com messages"), and I'll start fresh.`,
      messages: localMessages,
      truncated: true,
    };
  }

  let iterationCount = 0;

  try {
  while (true) {
    // Check abort signal between iterations
    if (signal?.aborted) return buildInterruptedResult();

    if (callbacks.onThinking) callbacks.onThinking();

    // Prepare messages: truncate oversized tool results, compress if near limit.
    // Pass the active model so prepareMessages picks the right context budget
    // (standard 200K thresholds vs 1M-tier overrides for `claude-opus-4-7[1m]`).
    const prepared = await prepareMessages(localMessages, lastInputTokens, systemPromptTokenEstimate, {
      conversationId: sessionId,
      ownerId: options.ownerId,
      model,
    });

    if (prepared.trimmed && callbacks.onContextTrimmed) {
      callbacks.onContextTrimmed(prepared.originalTokens, prepared.newTokens, prepared.method!);
    }

    const systemBlock: CacheableTextBlock = {
      type: "text",
      text: systemPrompt,
      // 1h TTL: the system prompt + org context is stable for the
      // whole role/session. The default 5m TTL evicts during typical
      // SOC pauses (analyst reads findings, types follow-up) and the
      // next turn pays full input-cache cost on ~6K tokens of prompt.
      // See P4 plan.
      cache_control: { type: "ephemeral", ttl: "1h" },
    };

    // Plan-resumption addendum — only on the first iteration so the
    // model doesn't see the hint repeatedly in the same turn. Separate
    // block with its own ephemeral cache so it doesn't invalidate the
    // main system-prompt cache on clean (no-plan) turns. Default 5m
    // TTL here is correct: plan resumption is conditional and short-
    // lived; a 1h cache would write a per-conversation lane we'd
    // rarely hit again.
    const systemBlocks: CacheableTextBlock[] = [systemBlock];
    if (iterationCount === 0 && inProgressPlan) {
      systemBlocks.push({
        type: "text",
        text:
          "\n\n[Resumption hint — the previous turn was truncated mid-execution by the per-turn output budget. " +
          `The plan you committed to (${inProgressPlan.toolCallsRemaining} tool calls remaining):\n` +
          inProgressPlan.planText +
          "\n\nContinue from the unexecuted steps. Do NOT re-prompt the user for confirmation on steps " +
          "they already approved, and do NOT repeat completed steps. If the user's most recent message " +
          "explicitly redirects the plan (e.g. 'stop', 'cancel', 'do X instead'), follow that instead.]",
        cache_control: { type: "ephemeral" },
      });
    }

    // Belt-and-suspenders: sanitize empty user messages again before hitting
    // the SDK. prepareMessages already sanitizes, but this catches any path
    // that might produce empty content after prepareMessages returns
    // (e.g., future mid-loop mutations) and guarantees the Anthropic API
    // never sees an empty user message.
    const sanitizedMessages = sanitizeEmptyUserMessages(prepared.messages);

    // 4th cache_control breakpoint — stamped on the last block of the
    // last message so successive iterations within this turn's
    // tool-use loop hit the cache on everything up to (and including)
    // the previous iteration. Default 5m TTL is correct here: each
    // turn's suffix is mostly invalidated by the next user turn
    // anyway, and the system+tools 1h cache already covers cross-turn
    // pauses. Anthropic permits up to 4 cache_control markers per
    // request — system block + plan-resumption addendum + tools last
    // item + this one = 4 (or 3 on clean turns without a plan). See
    // P4 plan.
    const sdkMessages = stampCacheBreakpointOnLastMessage(sanitizedMessages);

    const apiParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: systemBlocks as Anthropic.Messages.TextBlockParam[],
      tools: toolsForApi as Anthropic.Messages.Tool[],
      messages: sdkMessages,
    };
    if (options.toolChoice) {
      apiParams.tool_choice = options.toolChoice;
    }
    if (options.ownerId) {
      apiParams.metadata = { user_id: hashPii(options.ownerId) };
    }
    // Resolve role-scoped MCP servers for this turn. Empty array
    // ⇒ stable-API path. Non-empty ⇒ beta API + mcp_servers param.
    // Fetched per-iteration so a token-cache refresh between turns
    // is picked up without a process restart.
    const mcpServers = await getMcpServersSafely(role);
    const { message: response, durationMs: mcpTurnDurationMs } =
      await createWithOptionalMcp(apiParams, mcpServers, signal);
    iterationCount += 1;

    if (mcpServers.length > 0) {
      auditMcpInvocations(
        response.content as unknown[],
        role,
        sessionId,
        options.ownerId ? hashPii(options.ownerId) : undefined,
        mcpTurnDurationMs,
      );
    }

    // Scan + wrap any inline server-tool result content before the
    // assistant message hits history. This is the only seam where
    // results from Anthropic-executed server tools pass through Neo's
    // injection guard — they bypass the local-tool
    // wrapAndMaybeOffloadToolResult path entirely. Covers both:
    //   - mcp_tool_result blocks (MCP-connector beta)
    //   - web_search_tool_result blocks (web_search server tool)
    // No-op when the response contains neither (the common case).
    // CONTRACT: `sanitizedAssistantContent` MUST preserve every block
    // emitted by Anthropic — including `server_tool_use`,
    // `mcp_tool_use`, and other future block types — so subsequent
    // turns can echo them back without API rejection.
    const responseContent = response.content as unknown[];
    const sanitizedAssistantContent =
      mcpServers.length > 0 || hasUntrustedServerBlocks(responseContent)
        ? sanitizeMcpResultsForHistory(responseContent, sessionId)
        : responseContent;

    // Harvest citations from this iteration's text blocks BEFORE the
    // loop terminates. Earlier iterations are where web_search results
    // get cited — text in the final end_turn iteration is usually a
    // summary that no longer carries citations attached.
    collectCitationsInto(
      responseContent.filter(
        (b): b is Anthropic.Messages.TextBlock =>
          (b as { type?: unknown }).type === "text",
      ),
      citationsAcrossLoop,
    );

    lastInputTokens = response.usage.input_tokens;

    // Track usage
    const usageRaw = response.usage as unknown as Record<string, number | undefined>;
    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: usageRaw.cache_creation_input_tokens,
      cache_read_input_tokens: usageRaw.cache_read_input_tokens,
    };
    // Derived cache-hit rate so operators can monitor cache health
    // directly off the token_usage event without re-computing in
    // every dashboard query. Denominator is the FULL set of input
    // tokens for the call (cache-read + cache-write + un-cached
    // input). Returns 0 when nothing is cached so the field never
    // contains NaN. See P4 plan.
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    const cacheTotalIn = cacheReadTokens + cacheCreationTokens + usage.input_tokens;
    const cacheHitRate = cacheTotalIn > 0 ? cacheReadTokens / cacheTotalIn : 0;
    logger.emitEvent("token_usage", "API usage", "agent", {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheHitRate,
      model,
    });
    if (callbacks.onUsage) callbacks.onUsage(usage, model);

    localMessages.push({
      role: "assistant",
      content: sanitizedAssistantContent as Message["content"],
    });

    // Surface server-tool activity. web_search is executed by Anthropic
    // and returned inline in the same response, so the regular tool_use
    // dispatch path below never runs for it. We do three things per turn:
    //   1) Build a tool_use_id → { name, input } map from server_tool_use
    //      blocks so paired web_search_tool_result blocks carry the
    //      original input forward into onToolResult and audit events.
    //   2) Fire onToolCall / onToolResult for the chat UI's tool-trace
    //      pipeline.
    //   3) Emit a structured `tool_execution` audit event per pair so
    //      SOC operators have parity with local-tool and MCP audit
    //      coverage in Log Analytics / App Insights.
    const serverToolInputsById = new Map<
      string,
      { name: string; input: Record<string, unknown> }
    >();
    for (const block of responseContent) {
      if (isServerToolUse(block)) {
        serverToolInputsById.set(block.id, {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
        if (callbacks.onToolCall) {
          callbacks.onToolCall(
            block.name,
            (block.input ?? {}) as Record<string, unknown>,
          );
        }
      } else if (isWebSearchToolResult(block)) {
        // Summarise the raw payload for the trace — full citation
        // details flow to the model through history, but the UI only
        // needs result count + top URLs.
        const items = Array.isArray(block.content) ? block.content : [];
        const resultCount = items.filter(
          (i) =>
            typeof i === "object" &&
            i !== null &&
            (i as { type?: unknown }).type === "web_search_result",
        ).length;
        const errorEnvelope =
          !Array.isArray(block.content) &&
          typeof block.content === "object" &&
          block.content !== null &&
          (block.content as { type?: unknown }).type ===
            "web_search_tool_result_error"
            ? (block.content as { error_code?: unknown })
            : null;
        const isError = errorEnvelope !== null;
        const paired = serverToolInputsById.get(block.tool_use_id);
        const toolName = paired?.name ?? "web_search";
        const toolInput = paired?.input ?? {};
        if (callbacks.onToolResult) {
          callbacks.onToolResult({
            name: toolName,
            input: toolInput,
            output: { result_count: resultCount },
            durationMs: 0,
            isError,
          });
        }
        // Audit event — mirrors the tool_execution shape used by local
        // tools (line ~1571) so operators can query a single event type
        // for "every external tool invocation in this session". Query
        // text is truncated defensively in case the model emits an
        // unusually long string. The toolInput field is the same JSON
        // shape mcp_invocation uses; downstream parsers can read it
        // uniformly.
        try {
          const queryStr =
            typeof (toolInput as { query?: unknown }).query === "string"
              ? ((toolInput as { query: string }).query).slice(0, 500)
              : "";
          logger.emitEvent(
            isError ? "tool_execution" : "tool_execution",
            isError
              ? `Tool failed: ${toolName}`
              : `Tool completed: ${toolName}`,
            "agent",
            {
              toolName,
              toolCategory: "web",
              isDestructive: false,
              durationMs: 0,
              status: isError ? "error" : "success",
              sessionId,
              role,
              ownerIdHash: options.ownerId ? hashPii(options.ownerId) : undefined,
              toolUseId: block.tool_use_id,
              toolInput: JSON.stringify(toolInput).slice(0, 2000),
              query: queryStr,
              resultCount,
              ...(errorEnvelope
                ? { errorCode: String(errorEnvelope.error_code ?? "") }
                : {}),
            },
          );
        } catch (err) {
          // Audit-emit failure must never crash the agent loop. Log
          // and continue — the UI callback already fired.
          logger.warn("web_search audit emit failed", "agent", {
            errorMessage: (err as Error).message,
          });
        }
      }
    }

    // Done — Claude has a final response
    if (response.stop_reason === "end_turn") {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      const baseText = textBlocks.map((b) => b.text).join("\n");
      // Strip trailing whitespace from the model output before appending
      // the Sources footer to avoid triple-newline gaps when the last
      // text block already ends with "\n".
      const text =
        baseText.replace(/\s+$/, "") + buildCitationsFooter(citationsAcrossLoop);
      // Clear the in-progress plan — the agent reached end_turn which
      // means either (a) the plan completed, or (b) the model decided
      // to wrap up (user changed direction, etc). Either way the plan
      // no longer applies to subsequent turns. AWAIT the clear so a
      // back-to-back turn for the same sessionId (Teams bot, triage,
      // automated re-fire) cannot read the stale plan before this
      // write commits — that race would mis-attach a resumption hint
      // to a completed conversation, or trip the resumption circuit
      // breaker against the wrong plan. Errors are still soft —
      // worst case the next turn sees stale state and the user can
      // recover, but at least no race-amplified false positive.
      if (inProgressPlan) {
        const { sessionStore } = await import("./session-factory");
        try {
          await sessionStore.setInProgressPlan(sessionId, null);
        } catch (err) {
          logger.warn("clear in-progress plan failed (best-effort)", "agent", {
            sessionId,
            errorMessage: (err as Error).message,
          });
        }
      }
      logger.info("Agent loop completed", "agent");
      return { type: "response", text, messages: localMessages };
    }

    // Tool use — process all tool_use blocks in this turn
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );

      // Non-executable tools (e.g., respond_with_triage_verdict) — the
      // tool_use block IS the output. Check BEFORE the execution loop so
      // we never partially execute tools if Claude emits a mix of regular
      // and non-executable tool calls in the same turn.
      const nonExecBlock = toolUseBlocks.find(
        (b) => options.nonExecutableTools?.has(b.name),
      );
      if (nonExecBlock) {
        if (callbacks.onToolCall) {
          callbacks.onToolCall(nonExecBlock.name, nonExecBlock.input as Record<string, unknown>);
        }
        logger.info("Non-executable tool called — returning result", "agent", { toolName: nonExecBlock.name });
        const baseText = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const text =
          baseText.replace(/\s+$/, "") + buildCitationsFooter(citationsAcrossLoop);
        return { type: "response", text, messages: localMessages };
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const { id, name, input } = block;

        if (callbacks.onToolCall) {
          callbacks.onToolCall(name, input as Record<string, unknown>);
        }

        // Confirmation gate for destructive actions
        if (DESTRUCTIVE_TOOLS.has(name)) {
          logger.info("Confirmation gate triggered", "agent", { toolName: name, toolId: id });

          // Rewrite the last assistant message to drop any tool_use blocks
          // that appear AFTER this destructive one. Without this, those
          // trailing tool_use blocks would be persisted with no matching
          // tool_result, and the next API call would fail with
          // "tool_use ids were found without tool_result blocks".
          //
          // We operate on response.content's index space, not toolUseBlocks',
          // because interleaved text blocks must be preserved.
          // Safe to mutate localMessages[lastAssistantIdx] because
          // localMessages is a shallow copy of the caller's array (see
          // `const localMessages = [...messages]` at function entry).
          const lastAssistantIdx = localMessages.length - 1;
          const destructiveContentIdx = response.content.findIndex(
            (b) => b.type === "tool_use" && b.id === id,
          );
          if (destructiveContentIdx >= 0) {
            // CRITICAL: slice the sanitized content, not the raw
            // response. `sanitizedAssistantContent` is the
            // injection-guard-wrapped version of `response.content`
            // produced by `sanitizeMcpResultsForHistory` above.
            // `sanitizeMcpResultsForHistory` is a shape-preserving
            // map (one input block → one output block, index-for-
            // index), so `destructiveContentIdx` computed against
            // `response.content` is also valid against the
            // sanitized array. Slicing `response.content` directly
            // here would re-introduce un-wrapped mcp_tool_result
            // blocks into history on any turn that combines an MCP
            // result with a destructive tool call — the exact
            // injection-bypass surface the sanitize step exists to
            // close. See review B1.
            const sanitizedArray = sanitizedAssistantContent as unknown[];
            localMessages[lastAssistantIdx] = {
              role: "assistant",
              content: sanitizedArray.slice(0, destructiveContentIdx + 1) as Message["content"],
            };

            // Audit: surface any additional destructive tools that were
            // silently dropped by the slice. Conservative by design — we
            // never auto-execute more than one destructive tool per turn —
            // but operators need to see this happened.
            const droppedDestructiveIds = response.content
              .slice(destructiveContentIdx + 1)
              .filter(
                (b): b is Anthropic.Messages.ToolUseBlock =>
                  b.type === "tool_use" && DESTRUCTIVE_TOOLS.has(b.name),
              )
              .map((b) => ({ id: b.id, name: b.name }));
            if (droppedDestructiveIds.length > 0) {
              logger.warn(
                "Multiple destructive tools in one turn — dropping trailing ones",
                "agent",
                { confirmedToolId: id, confirmedToolName: name, dropped: droppedDestructiveIds },
              );
            }
          } else {
            // Defensive: if the destructive tool's ID isn't found in
            // response.content, we can't rewrite safely. This would leave
            // trailing tool_use blocks unpaired and reproduce the original
            // bug — so surface it loudly rather than silently proceeding.
            logger.error(
              "Destructive tool id not found in response.content — cannot rewrite assistant message",
              "agent",
              {
                toolId: id,
                toolName: name,
                contentBlockCount: response.content.length,
                contentTypes: response.content.map((b) => b.type),
              },
            );
          }

          return {
            type: "confirmation_required",
            tool: {
              id,
              name,
              input: input as Record<string, unknown>,
              // Capture pre-destructive tool results so resumeAfterConfirmation
              // can emit them alongside the confirmed/cancelled result.
              preExecutedResults: [...toolResults],
            },
            messages: localMessages,
          };
        }

        // Allowlist enforcement at the dispatch site. `toolAllowlist`
        // already narrows the tool list announced to Claude — but Claude
        // can still emit a tool_use for a tool name it knows from training
        // or via in-context drift. Without this guard a scheduled task
        // that scoped itself to read-only Sentinel queries could execute
        // an arbitrary other read-only tool (knowledge-base search,
        // user lookup, etc.) without ever appearing in task.allowedTools.
        if (toolAllowlist && !toolAllowlist.has(name)) {
          logger.warn(
            "Tool call rejected — not in toolAllowlist for this run",
            "agent",
            { toolName: name, toolId: id, allowlist: [...toolAllowlist] },
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: JSON.stringify({
              error: `Tool '${name}' is not in the allowlist for this run`,
              tool: name,
            }),
            is_error: true,
          });
          continue;
        }

        // Execute the tool with timing
        const toolStart = Date.now();
        try {
          const result = await executeTool(name, input as Record<string, unknown>, {
            sessionMessages: localMessages,
            csvAttachments,
            sessionId,
            turnNumber: localMessages.length,
            role,
          });
          const durationMs = Date.now() - toolStart;
          logger.emitEvent("tool_execution", `Tool completed: ${name}`, "agent", {
            toolName: name,
            toolCategory: getToolIntegration(name) ?? undefined,
            isDestructive: false,
            durationMs,
            status: "success",
            // Pick up responder / Azure correlation IDs from any
            // executor that surfaces them in its result envelope.
            // See extractToolAuditExtras at the top of this file.
            ...extractToolAuditExtras(result),
          });
          if (callbacks.onToolResult) {
            callbacks.onToolResult({
              name,
              input: input as Record<string, unknown>,
              output: result,
              durationMs,
              isError: false,
            });
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: await wrapAndMaybeOffloadToolResult(name, result, {
              sessionId,
              conversationId: sessionId,
            }),
          });
        } catch (err) {
          const durationMs = Date.now() - toolStart;
          logger.emitEvent("tool_execution", `Tool failed: ${name}`, "agent", {
            toolName: name,
            toolCategory: getToolIntegration(name) ?? undefined,
            isDestructive: false,
            durationMs,
            status: "error",
            errorMessage: (err as Error).message?.slice(0, 500),
          });
          const errorOutput = { error: (err as Error).message, tool: name };
          if (callbacks.onToolResult) {
            callbacks.onToolResult({
              name,
              input: input as Record<string, unknown>,
              output: errorOutput,
              durationMs,
              isError: true,
            });
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: await wrapAndMaybeOffloadToolResult(name, errorOutput, {
              sessionId,
              conversationId: sessionId,
            }),
            is_error: true,
          });
        }
      }

      localMessages.push({ role: "user", content: toolResults });
      if (callbacks.onTurnComplete) callbacks.onTurnComplete(localMessages);

      // Check abort signal after tool execution phase completes
      if (signal?.aborted) return buildInterruptedResult();
      continue;
    }

    // Output budget exhausted. Handle gracefully instead of throwing: if the
    // model ran out mid-tool-call we can't continue safely (would leave an
    // orphan tool_use), so surface that as a distinct error; otherwise we
    // return the partial text as a truncated response so the user still
    // sees what was generated and can ask Neo to continue.
    if (response.stop_reason === "max_tokens") {
      const lastBlock = response.content[response.content.length - 1];
      const lastIsToolUse = lastBlock?.type === "tool_use";
      logger.emitEvent("max_tokens_reached", "Output budget exhausted", "agent", {
        sessionId,
        skillInvocation,
        requestedMaxTokens: maxTokens,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        phase: lastIsToolUse ? "tool_use" : "text",
        model,
      });
      if (lastIsToolUse) {
        const toolName = (lastBlock as Anthropic.Messages.ToolUseBlock).name;
        // Persist best-effort plan snapshot so the next user turn can
        // resume. If emit_plan was called earlier in this conversation
        // the plan is already on the root; we just leave it in place
        // and attach its current state to the error. If no plan is
        // available, derive a minimal fallback from the last assistant
        // message's text content so resumption still has some
        // structure to hand the next turn.
        let planForError: InProgressPlan | null = inProgressPlan;
        if (!planForError) {
          const lastAssistant = localMessages[localMessages.length - 1];
          let fallbackText = Array.isArray(lastAssistant?.content)
            ? lastAssistant.content
                .filter((b): b is Anthropic.Messages.TextBlock => (b as { type: string }).type === "text")
                .map((b) => b.text)
                .join("\n")
                .slice(0, 4000)
            : typeof lastAssistant?.content === "string"
              ? lastAssistant.content.slice(0, 4000)
              : "";
          // Scan fallback text — the model may have echoed tool-result
          // content (Sentinel alerts, email bodies) that carry indirect
          // prompt injection. Without the scan on persistence, the
          // resumption hint on the next turn promotes user-trust data
          // to system-trust scope. Strip-and-continue: neutralise the
          // most common directive patterns, log the detection.
          if (fallbackText.trim()) {
            const { scanUserInput } = await import("./injection-guard");
            const scanResult = scanUserInput(fallbackText, {
              sessionId,
              userId: sessionId,
              role: "agent_plan_fallback",
            });
            if (scanResult.flagged) {
              logger.warn("Injection patterns in fallback planText — stripping", "agent", {
                sessionId,
                matchCount: scanResult.matchCount,
                label: scanResult.label,
              });
              fallbackText = fallbackText
                .replace(/ignore (?:all )?previous instructions?/gi, "[redacted]")
                .replace(/you are now (?:in )?developer mode/gi, "[redacted]")
                .replace(/system:?/gi, "[redacted]:");
            }
            planForError = {
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              planText: fallbackText,
              toolCallsRemaining: 1,
              originalTurnNumber: localMessages.length,
              resumptionCount: 0,
            };
          }
        }
        // Bump the resumption counter so the circuit breaker at the
        // top of the next turn can detect a loop. Persist the updated
        // plan (either the newly-derived fallback or the existing one
        // with the counter incremented).
        if (planForError) {
          planForError = {
            ...planForError,
            resumptionCount: (planForError.resumptionCount ?? 0) + 1,
          };
          try {
            const { sessionStore } = await import("./session-factory");
            await sessionStore.setInProgressPlan(sessionId, planForError);
          } catch (persistErr) {
            logger.warn("Plan persistence failed on IncompleteToolUseError", "agent", {
              sessionId,
              errorMessage: (persistErr as Error).message,
            });
          }
        }
        const err = new IncompleteToolUseError(toolName) as IncompleteToolUseError & {
          remainingPlan: InProgressPlan | null;
        };
        err.remainingPlan = planForError ?? null;
        throw err;
      }

      const baseText = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const text =
        baseText.replace(/\s+$/, "") + buildCitationsFooter(citationsAcrossLoop);

      // Mark the assistant message as truncated in-place so the persisted
      // copy survives a reload. Mirrors the `[interrupted]` pattern above.
      const lastAssistantIdx = localMessages.length - 1;
      const lastAssistant = localMessages[lastAssistantIdx];
      if (lastAssistant && lastAssistant.role === "assistant") {
        if (typeof lastAssistant.content === "string") {
          lastAssistant.content = `${lastAssistant.content}\n[truncated]`;
        } else if (Array.isArray(lastAssistant.content)) {
          const alreadyMarked = lastAssistant.content.some(
            (b) =>
              typeof b === "object" &&
              b !== null &&
              (b as { type: string }).type === "text" &&
              /\[truncated\]\s*$/.test((b as { text?: string }).text ?? ""),
          );
          if (!alreadyMarked) {
            lastAssistant.content.push({ type: "text", text: "[truncated]" });
          }
        }
      }

      if (callbacks.onTurnComplete) callbacks.onTurnComplete(localMessages);

      logger.info("Agent loop completed (truncated)", "agent");
      return { type: "response", text, messages: localMessages, truncated: true };
    }

    // Beta-API-only stop reasons surfaced by the MCP-connector path
    // (Anthropic.Beta.BetaStopReason adds these on top of the stable
    // union). Treat them as graceful terminations instead of letting
    // the catch-all below throw and crash the session.
    if ((response.stop_reason as string) === "compaction") {
      logger.warn(
        "Beta API returned stop_reason=compaction — Anthropic compacted context server-side; treating as end_turn",
        "agent",
        { sessionId, model },
      );
      const baseText = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => (b as { type: string }).type === "text")
        .map((b) => b.text)
        .join("\n");
      const text =
        baseText.replace(/\s+$/, "") + buildCitationsFooter(citationsAcrossLoop);
      // Mirror the end_turn path: a compaction-terminated turn is
      // also a terminal state for the in-progress plan (no further
      // tool calls coming in this turn). Without this, the plan
      // persists and stale-resumes on the next user message. AWAIT
      // the clear (same race rationale as the end_turn path above).
      // See review M2.
      if (inProgressPlan) {
        const { sessionStore } = await import("./session-factory");
        try {
          await sessionStore.setInProgressPlan(sessionId, null);
        } catch (err) {
          logger.warn("clear in-progress plan failed (best-effort)", "agent", {
            sessionId,
            errorMessage: (err as Error).message,
          });
        }
      }
      if (callbacks.onTurnComplete) callbacks.onTurnComplete(localMessages);
      return { type: "response", text, messages: localMessages };
    }
    if ((response.stop_reason as string) === "model_context_window_exceeded") {
      logger.warn(
        "Beta API returned stop_reason=model_context_window_exceeded — context window exhausted mid-turn",
        "agent",
        { sessionId, model },
      );
      throw new Error(
        "The conversation has grown too large for the model's context window. Please start a new session.",
      );
    }

    logger.warn(`Unexpected stop_reason: ${response.stop_reason}`, "agent");
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }
  } catch (err) {
    // AbortError / APIUserAbortError: return interrupted result
    // instead of rethrowing so the route can persist partial state
    // cleanly. isAbortError() covers both the runtime fetch
    // `AbortError` and the Anthropic SDK's `APIUserAbortError`.
    if (isAbortError(err)) {
      return buildInterruptedResult();
    }
    throw err;
  }
}

const MAX_SUMMARY_MESSAGES = 50;

/**
 * Summarize an expired conversation's messages into a compact context
 * suitable for seeding a new session. Returns a single-element message
 * array with the summary as a user message.
 */
export async function summarizeConversation(
  messages: Message[],
): Promise<Message[]> {
  // Cap input to avoid excessive token usage
  const recent = messages.slice(-MAX_SUMMARY_MESSAGES);

  try {
    const response = await createWithRetry({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system:
        "Summarize the following security investigation conversation in 3-5 bullet points. " +
        "Focus on: what was investigated, key findings, tools that were used, and any actions taken or recommended. " +
        "Be concise and factual. Output only the bullet points.",
      messages: [
        ...recent,
        {
          role: "user",
          content: "Please summarize our conversation so far.",
        },
      ],
    });

    const summaryText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return [
      {
        role: "user",
        content:
          "Conversation resumed. Summary of previous session:\n" + summaryText,
      },
    ];
  } catch (err) {
    logger.error("Failed to summarize conversation", "agent", {
      errorMessage: (err as Error).message,
    });
    // Fallback: return a minimal context note
    return [
      {
        role: "user",
        content:
          "Conversation resumed. A previous session existed but could not be summarized. " +
          "The user is continuing a prior security investigation.",
      },
    ];
  }
}

export async function resumeAfterConfirmation(
  messages: Message[],
  pendingTool: PendingTool,
  confirmed: boolean,
  callbacks: AgentCallbacks = {},
  role: Role = "reader",
  sessionId: string = "unknown",
  model: ModelPreference = DEFAULT_MODEL,
  options: RunAgentLoopOptions = {},
): Promise<AgentLoopResult> {
  // Same legacy-envelope unwrap as runAgentLoop — see that callsite
  // for rationale. resumeAfterConfirmation is the second entry point
  // to the agent loop and must apply the same recovery.
  const localMessages: Message[] = unwrapLegacyWebSearchEnvelopes([...messages]);
  const { id, name, input } = pendingTool;

  let toolResult: Anthropic.Messages.ToolResultBlockParam;

  if (confirmed) {
    logger.info("Tool confirmed", "agent", { toolName: name, toolId: id });
    if (callbacks.onToolCall) callbacks.onToolCall(name, input);
    const toolStart = Date.now();
    try {
      const result = await executeTool(name, input, {
        sessionMessages: localMessages,
        csvAttachments: options.csvAttachments,
        sessionId,
        turnNumber: localMessages.length,
        role,
      });
      const durationMs = Date.now() - toolStart;
      logger.emitEvent("tool_execution", `Tool completed: ${name}`, "agent", {
        toolName: name,
        toolCategory: getToolIntegration(name) ?? undefined,
        isDestructive: true,
        durationMs,
        status: "success",
        // Pick up responder / Azure correlation IDs from any
        // executor that surfaces them. For Infosec Logic App tools
        // this is the field that records WHO authorised the
        // destructive remediation — see ultra-review HIGH #3.
        ...extractToolAuditExtras(result),
      });
      if (callbacks.onToolResult) {
        callbacks.onToolResult({ name, input, output: result, durationMs, isError: false });
      }
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: await wrapAndMaybeOffloadToolResult(name, result, {
          sessionId,
          conversationId: sessionId,
        }),
      };
    } catch (err) {
      const durationMs = Date.now() - toolStart;
      logger.emitEvent("tool_execution", `Tool failed: ${name}`, "agent", {
        toolName: name,
        toolCategory: getToolIntegration(name) ?? undefined,
        isDestructive: true,
        durationMs,
        status: "error",
        errorMessage: (err as Error).message?.slice(0, 500),
      });
      const errorOutput = { error: (err as Error).message };
      if (callbacks.onToolResult) {
        callbacks.onToolResult({ name, input, output: errorOutput, durationMs, isError: true });
      }
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: await wrapAndMaybeOffloadToolResult(name, errorOutput, {
          sessionId,
          conversationId: sessionId,
        }),
        is_error: true,
      };
    }
  } else {
    logger.info("Tool cancelled", "agent", { toolName: name, toolId: id });
    const cancelOutput = { cancelled: true, message: "User cancelled this action." };
    // Emit a synthetic tool_result event so the live UI sees the cancelled
    // trace. Without this, pendingToolUse on the client accumulates an
    // unmatched entry and the UI shows a tool_use with no paired result.
    // durationMs: 0 since no work was done. isError: true so the trace
    // renders with the failure badge.
    if (callbacks.onToolResult) {
      callbacks.onToolResult({
        name,
        input,
        output: cancelOutput,
        durationMs: 0,
        isError: true,
      });
    }
    toolResult = {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify(cancelOutput),
    };
  }

  // Include pre-executed results (from non-destructive tools that ran in
  // the same turn before the destructive one paused the loop) so every
  // tool_use block in the assistant message has a matching tool_result.
  const preExecuted = pendingTool.preExecutedResults ?? [];
  localMessages.push({
    role: "user",
    content: [...preExecuted, toolResult],
  });

  return runAgentLoop(localMessages, callbacks, role, sessionId, model, undefined, options);
}

/**
 * Build the user-role message that pairs an implicitly-cancelled
 * destructive tool with its `tool_result`. When a destructive tool is
 * pending and the user sends a NEW chat message instead of clicking
 * Confirm or Cancel, callers must inject this synthetic block at the
 * top of the new turn — otherwise the still-unpaired `tool_use` at the
 * end of the prior assistant message either (a) trips Anthropic's
 * `tool_use ids were found without tool_result blocks` 400 on the next
 * API call, or (b) gets silently stripped by the conversation-shape
 * repair, which in turn makes any later /api/confirm Cancel append an
 * orphan `tool_result` and reproduce the same 400 on the turn after
 * that.
 *
 * Pure helper — caller is responsible for `sessionStore.clearPendingConfirmation`,
 * `session.messages.push`, persistence, and audit logging. Keeping the
 * I/O at the call site lets the chat (/api/agent) and Teams routes
 * each emit their own destructive_action event in their own logger
 * context without us reaching into either.
 */
export function buildImplicitCancellationMessage(
  pendingTool: PendingTool,
): Message {
  const cancelOutput = {
    cancelled: true,
    message:
      "User sent a new message instead of confirming this action — treating as a cancellation.",
  };
  const cancelResultBlock: Anthropic.Messages.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: pendingTool.id,
    content: JSON.stringify(cancelOutput),
  };
  // Include any non-destructive tool results captured before the
  // destructive paused the loop, so every tool_use in the preceding
  // assistant message is paired by THIS one user message.
  const preExecuted = pendingTool.preExecutedResults ?? [];
  return {
    role: "user",
    content: [...preExecuted, cancelResultBlock],
  };
}
