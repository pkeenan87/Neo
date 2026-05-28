import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config";
import {
  PER_TOOL_RESULT_TOKEN_CAP,
  PRESERVED_RECENT_MESSAGES,
  HAIKU_MODEL,
  HAIKU_INPUT_MAX_TOKENS,
  getContextBudget,
} from "./config";
import type { ContextBudget } from "./config";
import { logger, hashPii } from "./logger";
import type { Message } from "./types";

export const CHARS_PER_TOKEN = 3.5;

const anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Compression prompt — explicitly demands a verbatim IDENTIFIERS
// section so Haiku doesn't aggregate specific IPs/UPNs/alertIDs/hashes
// into vague phrases ("investigated several TOR-related sign-ins"),
// which was the primary source of post-compaction hallucinations.
// Marked uncertainty with "(unverified)" so the parent model knows
// which findings have direct evidence vs. inferred conclusions.
const HAIKU_COMPRESSION_SYSTEM_PROMPT =
  "You are summarising a security-investigation conversation so it fits within a downstream " +
  "model's context window. Faithfulness matters more than brevity — a missing IP or alert ID " +
  "can cause the next turn to hallucinate.\n\n" +
  "OUTPUT FORMAT (two sections, in this order):\n\n" +
  "## IDENTIFIERS\n" +
  "List every distinct identifier observed in the conversation, one per line, with a short context label. " +
  "Include ALL of:\n" +
  "- IP addresses (v4 and v6)\n" +
  "- Hostnames / device names / FQDNs\n" +
  "- User principal names (UPNs) / email addresses\n" +
  "- Alert IDs, incident IDs, case IDs\n" +
  "- File hashes (MD5/SHA1/SHA256)\n" +
  "- Process names + command lines (full, not summarised)\n" +
  "- URLs and domains\n" +
  "- KQL table names referenced\n" +
  "- Tool names invoked (e.g. run_sentinel_kql, isolate_machine)\n" +
  "Do NOT aggregate (\"several IPs\") — list each one individually. If a tool returned a table, " +
  "list every row's primary identifier.\n\n" +
  "## NARRATIVE\n" +
  "In up to 10 bullets, summarise what was investigated, what was found, what tools ran, and any " +
  "actions taken or recommended. Mark any finding whose evidence you cannot point to directly " +
  "in the conversation with \"(unverified)\".\n\n" +
  "If you reach the output token limit mid-IDENTIFIERS section, stop there and skip NARRATIVE — " +
  "identifiers are more valuable than narrative for downstream correctness.";

// Helper for the hard-truncation fallback message. The text is
// rewritten as an explicit "the agent has NO record" instruction
// instead of the old bare "key findings may need to be re-investigated"
// hint, which the parent model treated as a casual aside and proceeded
// past confidently. See P2 review.
function buildCompressionFailureNotice(droppedMessagesCount: number): Message {
  return {
    role: "user",
    content:
      `<system_notice type="context_compression_failed" dropped_messages="${droppedMessagesCount}">\n` +
      `${droppedMessagesCount} earlier conversation messages were dropped to fit the context window, ` +
      `and the automatic summariser failed. You have NO record of what was discussed before this point.\n\n` +
      `Before answering anything that depends on earlier turns, ASK THE USER to restate the relevant findings ` +
      `(specific IPs, hosts, alert IDs, etc.). Do NOT infer or invent details from this gap.\n` +
      `</system_notice>`,
  };
}

export interface PrepareResult {
  messages: Message[];
  trimmed: boolean;
  method?: "truncation" | "summary";
  originalTokens: number;
  newTokens: number;
}

// ── Token estimation ─────────────────────────────────────────

// Claude charges ~1600 tokens per 1024x1024 image tile.
// Convert to char equivalent for the chars-based estimator.
const IMAGE_TOKEN_ESTIMATE = 1600;
const IMAGE_CHAR_ESTIMATE = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;

// Rough estimate for PDF document blocks (~2000 tokens per page, assume 3 pages average)
const DOCUMENT_CHAR_ESTIMATE = 2000 * 3 * CHARS_PER_TOKEN;

function contentCharCount(content: Message["content"]): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (block.type === "text") {
      total += (block as { text: string }).text.length;
    } else if (block.type === "tool_use") {
      total += JSON.stringify((block as { input: unknown }).input).length;
    } else if (block.type === "tool_result") {
      const c = (block as { content?: string | unknown[] }).content;
      if (typeof c === "string") {
        total += c.length;
      } else if (Array.isArray(c)) {
        total += JSON.stringify(c).length;
      }
    } else if ((block as { type: string }).type === "mcp_tool_use") {
      // MCP tool calls returned inline from Anthropic's beta API.
      // Without this branch the ~200K context budget would not see
      // the input payload, and very-large MCP calls (e.g. queries
      // with long parameter lists) would silently bypass trim.
      total += JSON.stringify((block as { input?: unknown }).input ?? null).length;
    } else if ((block as { type: string }).type === "mcp_tool_result") {
      // MCP tool results live inline in the assistant message; the
      // content field can be a string OR an array of content blocks
      // per the MCP-connector spec. Both shapes must be counted or
      // a single oversized Wiz response will overflow the prompt
      // and hit a hard 400 from the API instead of triggering
      // graceful truncation / offload.
      const c = (block as { content?: string | unknown[] }).content;
      if (typeof c === "string") {
        total += c.length;
      } else if (Array.isArray(c)) {
        total += JSON.stringify(c).length;
      }
    } else if (block.type === "image") {
      total += IMAGE_CHAR_ESTIMATE;
    } else if ((block as { type: string }).type === "document") {
      total += DOCUMENT_CHAR_ESTIMATE;
    }
  }
  return total;
}

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += contentCharCount(msg.content);
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ── Tool result truncation ───────────────────────────────────

// How far back from the cap we're willing to look for a clean
// boundary. ~2% of the cap keeps the cost negligible while
// catching almost every JSON / CSV row boundary near the cut.
const BOUNDARY_LOOKBACK_CHARS = 2_000;

/**
 * Find a clean truncation point at-or-before `index` for JSON / CSV /
 * line-structured content. Cutting `content.slice(0, charCap)` mid-key
 * or mid-cell produces invalid output that the model interprets as
 * "the tool returned malformed data" — strictly worse than truncating
 * one entry earlier at a sane boundary. We look back up to
 * BOUNDARY_LOOKBACK_CHARS for a closing brace/bracket, a JSON-row
 * comma, or a newline (CSV / line-delimited output), and cut there.
 * Falls through to the original char-cap when no boundary is found.
 */
function findCleanTruncationPoint(content: string, charCap: number): number {
  const minSearch = Math.max(0, charCap - BOUNDARY_LOOKBACK_CHARS);
  // Prefer JSON object/array boundaries first (most common shape for
  // tool results in this codebase). Then JSON row separators. Then
  // newlines as the last resort.
  for (let i = charCap - 1; i >= minSearch; i--) {
    const ch = content[i];
    if (ch === "}" || ch === "]") {
      // Include the closing brace/bracket so the visible slice is a
      // syntactically-complete fragment.
      return i + 1;
    }
  }
  for (let i = charCap - 1; i >= minSearch; i--) {
    const ch = content[i];
    // Comma followed by a newline / whitespace = a row boundary in
    // pretty-printed JSON. Cut AFTER the comma so the model sees a
    // valid array element ended.
    if (ch === "," && /[\s\n]/.test(content[i + 1] ?? "")) {
      return i + 1;
    }
  }
  for (let i = charCap - 1; i >= minSearch; i--) {
    if (content[i] === "\n") {
      return i + 1;
    }
  }
  return charCap;
}

export function truncateToolResult(content: string, capTokens: number): string {
  const charCap = capTokens * CHARS_PER_TOKEN;
  if (content.length <= charCap) return content;

  const cutPoint = findCleanTruncationPoint(content, charCap);
  const truncated = content.slice(0, cutPoint);
  return (
    truncated +
    `\n\n[Result truncated from ${content.length} to ${cutPoint} characters. ` +
    `Use get_full_tool_result with the tool_use_id to retrieve the complete output.]`
  );
}

// ── Deep copy + per-result truncation ────────────────────────

export function truncateToolResults(
  messages: Message[],
  capTokens: number = PER_TOOL_RESULT_TOKEN_CAP,
): { messages: Message[]; anyTruncated: boolean } {
  let anyTruncated = false;

  const out: Message[] = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg };

    const newContent = msg.content.map((block) => {
      const blockType = (block as { type: string }).type;
      // Local tool_result and inline mcp_tool_result are both
      // truncated against the same per-result cap. The sanitize
      // step in agent.ts coerces mcp_tool_result content to a
      // string envelope before history-append, so the string-only
      // path below handles both consistently.
      if (blockType !== "tool_result" && blockType !== "mcp_tool_result") {
        return block;
      }

      const tr = block as { content?: unknown };
      if (typeof tr.content !== "string") return block;

      // Skip truncation when the content is already a
      // _neo_trust_boundary envelope. Slicing the envelope JSON
      // mid-stream produces a malformed string and corrupts the
      // trust marker — downstream parsers in
      // offloadLargeToolResultsInPrompt silently swallow the
      // parse error and lose the injection_detected flag. Applies
      // to BOTH local tool_result envelopes (from
      // wrapAndMaybeOffloadToolResult, which can fall back to
      // inlining when blob storage is unavailable) and inline
      // mcp_tool_result envelopes. See review N4.
      if (tr.content.includes("_neo_trust_boundary")) {
        return block;
      }

      const truncated = truncateToolResult(tr.content, capTokens);
      if (truncated !== tr.content) {
        anyTruncated = true;
        return { ...block, content: truncated } as typeof block;
      }
      return block;
    });

    return { ...msg, content: newContent };
  });

  return { messages: out, anyTruncated };
}

// ── Tool-pair-aware slicing ──────────────────────────────────

/**
 * Check if a message contains tool_use blocks (assistant message that
 * called tools and expects tool_result blocks in the next message).
 */
function hasToolUseBlocks(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b.type === "tool_use");
}

/**
 * Check if a message contains tool_result blocks (user message that
 * carries results for tool_use blocks from the previous message).
 */
function hasToolResultBlocks(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b.type === "tool_result");
}

/**
 * Check if a message contains mcp_tool_result blocks (assistant
 * message — MCP results from Anthropic's beta connector live inline
 * with the assistant message, not in a following user message).
 */
function hasMcpToolResultBlocks(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => (b as { type: string }).type === "mcp_tool_result");
}

/**
 * Check if a message contains mcp_tool_use blocks. Used by the
 * orphan-strip pass in {@link validateAndRepairConversationShape}
 * so that an mcp_tool_use without its paired mcp_tool_result in the
 * same message doesn't cause an API 400 on the next turn.
 */
function hasMcpToolUseBlocks(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => (b as { type: string }).type === "mcp_tool_use");
}

/**
 * Find a safe slice boundary that does not split a tool_use→tool_result
 * pair. The Claude API requires every tool_use block in an assistant
 * message to have a matching tool_result in the immediately following
 * user message. Slicing between them produces an invalid conversation.
 *
 * Given a target index for `messages.slice(targetIndex)`, this returns
 * an adjusted index that avoids splitting pairs:
 * - If messages[targetIndex] is a user message with tool_result blocks,
 *   move backward to include the preceding assistant tool_use message.
 * - If messages[targetIndex-1] is an assistant message with tool_use
 *   blocks and messages[targetIndex] is NOT its matching tool_result,
 *   also move backward.
 */
function findSafeSliceStart(messages: Message[], targetIndex: number): number {
  if (targetIndex <= 0) return 0;
  if (targetIndex >= messages.length) return messages.length;

  // If we're about to start at a tool_result message, include the
  // preceding assistant message that holds the matching tool_use blocks.
  const msg = messages[targetIndex];
  if (msg.role === "user" && hasToolResultBlocks(msg) && targetIndex > 0) {
    const prev = messages[targetIndex - 1];
    if (prev.role === "assistant" && hasToolUseBlocks(prev)) {
      return targetIndex - 1;
    }
  }

  return targetIndex;
}

// ── Conversation shape validation ────────────────────────────

/**
 * Validate and repair the conversation shape so every tool_use block
 * has a matching tool_result in the next message and vice versa.
 * Removes orphaned blocks that would cause a 400 error from the API.
 */
export function validateAndRepairConversationShape(messages: Message[]): Message[] {
  let repaired = false;

  // Pre-pass: within each assistant message, strip orphan mcp_tool_use
  // or mcp_tool_result blocks (their paired counterpart is missing in
  // the same message). MCP pairs live inline in a single assistant
  // message; our own truncation / offload paths preserve pairs, but
  // this defends against any future code path that could split them.
  const mcpRepaired: Message[] = messages.map((msg, idx) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
    if (!hasMcpToolUseBlocks(msg) && !hasMcpToolResultBlocks(msg)) return msg;

    const mcpUseIds = new Set<string>();
    const mcpResultUseIds = new Set<string>();
    for (const b of msg.content) {
      const t = (b as { type: string }).type;
      if (t === "mcp_tool_use") {
        mcpUseIds.add((b as { id: string }).id);
      } else if (t === "mcp_tool_result") {
        mcpResultUseIds.add((b as { tool_use_id: string }).tool_use_id);
      }
    }

    const filtered = msg.content.filter((b) => {
      const t = (b as { type: string }).type;
      if (t === "mcp_tool_use") {
        const id = (b as { id: string }).id;
        if (mcpResultUseIds.has(id)) return true;
        repaired = true;
        logger.warn("Removed orphaned mcp_tool_use block", "context-manager", {
          toolUseId: id,
          messageIndex: idx,
        });
        return false;
      }
      if (t === "mcp_tool_result") {
        const id = (b as { tool_use_id: string }).tool_use_id;
        if (mcpUseIds.has(id)) return true;
        repaired = true;
        logger.warn("Removed orphaned mcp_tool_result block", "context-manager", {
          toolUseId: id,
          messageIndex: idx,
        });
        return false;
      }
      return true;
    });

    if (filtered.length === msg.content.length) return msg;
    if (filtered.length === 0) {
      return { ...msg, content: "[MCP tool calls removed during context compression]" };
    }
    return { ...msg, content: filtered };
  });

  const result: Message[] = [];

  for (let i = 0; i < mcpRepaired.length; i++) {
    const msg = mcpRepaired[i];

    // Repair assistant messages: remove tool_use blocks whose IDs don't
    // appear as tool_result in the next user message.
    if (msg.role === "assistant" && Array.isArray(msg.content) && hasToolUseBlocks(msg)) {
      const nextMsg = mcpRepaired[i + 1];
      const nextToolResultIds = new Set<string>();
      if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
        for (const b of nextMsg.content) {
          if (b.type === "tool_result") {
            nextToolResultIds.add((b as Anthropic.Messages.ToolResultBlockParam).tool_use_id);
          }
        }
      }

      const filtered = msg.content.filter((b) => {
        if (b.type !== "tool_use") return true;
        const id = (b as Anthropic.Messages.ToolUseBlockParam).id;
        if (nextToolResultIds.has(id)) return true;
        repaired = true;
        logger.warn("Removed orphaned tool_use block", "context-manager", {
          toolUseId: id,
          messageIndex: i,
        });
        return false;
      });

      if (filtered.length === 0) {
        result.push({ ...msg, content: "[tool calls removed during context compression]" });
      } else if (filtered.length !== msg.content.length) {
        result.push({ ...msg, content: filtered });
      } else {
        result.push(msg);
      }
      continue;
    }

    // Repair user messages: remove tool_result blocks whose IDs don't
    // appear as tool_use in the previous assistant message.
    if (msg.role === "user" && Array.isArray(msg.content) && hasToolResultBlocks(msg)) {
      const prevMsg = mcpRepaired[i - 1];
      const prevToolUseIds = new Set<string>();
      if (prevMsg?.role === "assistant" && Array.isArray(prevMsg.content)) {
        for (const b of prevMsg.content) {
          if (b.type === "tool_use") {
            prevToolUseIds.add((b as Anthropic.Messages.ToolUseBlockParam).id);
          }
        }
      }

      const filtered = msg.content.filter((b) => {
        if (b.type !== "tool_result") return true;
        const id = (b as Anthropic.Messages.ToolResultBlockParam).tool_use_id;
        if (prevToolUseIds.has(id)) return true;
        repaired = true;
        logger.warn("Removed orphaned tool_result block", "context-manager", {
          toolUseId: id,
          messageIndex: i,
        });
        return false;
      });

      if (filtered.length === 0) {
        result.push({ ...msg, content: "[tool results removed during context compression]" });
      } else if (filtered.length !== msg.content.length) {
        result.push({ ...msg, content: filtered });
      } else {
        result.push(msg);
      }
      continue;
    }

    result.push(msg);
  }

  if (repaired) {
    logger.info("Conversation shape repaired", "context-manager", {
      messageCount: messages.length,
    });
  }

  return result;
}

// ── Conversation compression ─────────────────────────────────

/**
 * Replace mcp_tool_use / mcp_tool_result blocks with plain text
 * blocks describing their content. Two callers depend on this:
 *
 *   1. `compressOlderMessages` — Haiku's stable-API endpoint does
 *      not recognise MCP block types and rejects the call. Haiku
 *      only needs readable text for the summary, so a lossy stub
 *      is acceptable.
 *   2. `createWithOptionalMcp` (stable-API path) — when a session
 *      that earlier ran with MCP servers configured runs a turn
 *      without them (secrets rotated, MOCK_MODE flipped, role
 *      changed), persisted MCP blocks in history would otherwise
 *      crash the stable API. Materialising them keeps the
 *      conversation coherent without leaking the original payload
 *      back to the model.
 *
 * Adversarial-payload handling: when `mcp_tool_result.content` is
 * already a `_neo_trust_boundary` envelope (the production state
 * after `sanitizeMcpResultsForHistory`), the envelope is parsed and
 *
 *   - if `injection_detected: true`, the `data` field is replaced
 *     with a quarantine marker so Haiku (a smaller model with a
 *     weaker injection posture) never sees the raw adversarial
 *     content,
 *   - if `injection_detected: false`, the `data` field is included
 *     but truncated to a safe length.
 *
 * See review M4.
 */
// 16K chars (~4.5K tokens) is enough for Wiz issue payloads and Infosec
// Logic App responses to retain their entity tables. The previous 2K
// cap erased MCP results to a short head and made Haiku summaries that
// hallucinated about what the workflow actually returned.
const HAIKU_MCP_DATA_PREVIEW_CHARS = 16_000;

export function materializeMcpBlocksAsText(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let mutated = false;
    const newContent = msg.content.map((block) => {
      const t = (block as { type: string }).type;
      if (t === "mcp_tool_use") {
        mutated = true;
        const b = block as {
          server_name?: string;
          name?: string;
          input?: unknown;
        };
        const inputJson = JSON.stringify(b.input ?? {});
        return {
          type: "text" as const,
          text: `[MCP tool call ${b.server_name ?? "?"}.${b.name ?? "?"} input=${inputJson}]`,
        };
      }
      if (t === "mcp_tool_result") {
        mutated = true;
        const b = block as { content?: string | unknown[]; is_error?: boolean };
        let text = "";
        if (typeof b.content === "string") {
          // If the content is an envelope, parse it and gate by
          // injection_detected. Quarantine on positive scans,
          // truncate-preview otherwise. Non-envelope strings (e.g.
          // pre-sanitize content) get truncate-only treatment.
          if (b.content.includes("_neo_trust_boundary")) {
            try {
              const env = JSON.parse(b.content) as {
                _neo_trust_boundary?: { injection_detected?: unknown };
                data?: unknown;
              };
              if (env?._neo_trust_boundary?.injection_detected === true) {
                text = "[content quarantined: injection patterns detected]";
              } else {
                const dataStr =
                  typeof env?.data === "string"
                    ? env.data
                    : JSON.stringify(env?.data ?? "");
                text =
                  dataStr.length > HAIKU_MCP_DATA_PREVIEW_CHARS
                    ? dataStr.slice(0, HAIKU_MCP_DATA_PREVIEW_CHARS) +
                      "…[truncated for compression]"
                    : dataStr;
              }
            } catch {
              text = b.content.slice(0, HAIKU_MCP_DATA_PREVIEW_CHARS);
            }
          } else {
            text =
              b.content.length > HAIKU_MCP_DATA_PREVIEW_CHARS
                ? b.content.slice(0, HAIKU_MCP_DATA_PREVIEW_CHARS) +
                  "…[truncated]"
                : b.content;
          }
        } else if (Array.isArray(b.content)) {
          const serialized = JSON.stringify(b.content);
          text =
            serialized.length > HAIKU_MCP_DATA_PREVIEW_CHARS
              ? serialized.slice(0, HAIKU_MCP_DATA_PREVIEW_CHARS) +
                "…[truncated]"
              : serialized;
        }
        return {
          type: "text" as const,
          text: `[MCP tool result${b.is_error ? " (error)" : ""}: ${text}]`,
        };
      }
      return block;
    });
    return mutated ? { ...msg, content: newContent } : msg;
  });
}

async function compressOlderMessages(
  messages: Message[],
  preserveCount: number,
  systemPromptTokenEstimate: number,
  budget: ContextBudget,
  ownerId?: string,
): Promise<Message[]> {
  // Both early-return paths below skip the summarization branch but
  // MUST still enforce the ceiling. Without that, a small-but-bloated
  // conversation (e.g. 9 messages each ~21K tokens) that trips the
  // trim trigger lands back in prepareMessages unchanged and ships
  // over NEO_CONTEXT_MAX_INPUT_TOKENS → 400 from Anthropic with
  // `prompt is too long`. See review M4 + verified finding.
  if (messages.length <= preserveCount + 1) {
    return enforceCeiling(messages, budget.neoContextMaxInputTokens, systemPromptTokenEstimate);
  }

  // Find the first user message to use as the anchor (may not be messages[0]
  // after Cosmos session reconstruction).
  let anchorIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      anchorIndex = i;
      break;
    }
  }

  // Compute the recent slice boundary, respecting tool pairs
  const rawRecentStart = messages.length - preserveCount;
  const safeRecentStart = findSafeSliceStart(messages, rawRecentStart);

  const anchor = messages.slice(0, anchorIndex + 1);
  const middle = messages.slice(anchorIndex + 1, safeRecentStart);
  const recent = messages.slice(safeRecentStart);

  if (middle.length === 0) {
    return enforceCeiling(messages, budget.neoContextMaxInputTokens, systemPromptTokenEstimate);
  }

  // The token-based pre-trim loop below is the source of truth for
  // Haiku input bounding — the old MAX_MIDDLE_MESSAGES_FOR_SUMMARY=30
  // count cap silently dropped half-hour-old turns even when they fit
  // comfortably in Haiku's window, costing fidelity for no benefit.
  // Start with the full middle slice; rely on HAIKU_INPUT_MAX_TOKENS.
  let cappedMiddle = [...middle];

  // Pre-trim the Haiku input itself so the compression call never 400s
  // with "prompt is too long: N > 200000". The middle slice can exceed
  // 200K tokens when a single conversation has repeatedly appended
  // oversized tool results. Drop pair-aware from the start of
  // cappedMiddle until its own estimated tokens are under
  // HAIKU_INPUT_MAX_TOKENS. See _plans/output-budget.md.
  let haikuInputEstimate = estimateTokens(cappedMiddle);
  let haikuPreTrimmed = 0;
  while (haikuInputEstimate > HAIKU_INPUT_MAX_TOKENS && cappedMiddle.length > 2) {
    const safeStart = findSafeSliceStart(cappedMiddle, 1);
    let dropEnd = safeStart + 1;
    if (
      dropEnd < cappedMiddle.length &&
      cappedMiddle[safeStart].role === "assistant" &&
      hasToolUseBlocks(cappedMiddle[safeStart]) &&
      cappedMiddle[dropEnd].role === "user" &&
      hasToolResultBlocks(cappedMiddle[dropEnd])
    ) {
      dropEnd = safeStart + 2;
    }
    cappedMiddle = [
      ...cappedMiddle.slice(0, safeStart),
      ...cappedMiddle.slice(dropEnd),
    ];
    haikuPreTrimmed += dropEnd - safeStart;
    haikuInputEstimate = estimateTokens(cappedMiddle);
  }
  if (haikuPreTrimmed > 0) {
    logger.emitEvent("context_engineering", "Pre-trimmed Haiku compression input", "context-manager", {
      reason: "haiku_pretrim",
      droppedMessages: haikuPreTrimmed,
      afterEnforcementTokens: haikuInputEstimate,
      ceiling: HAIKU_INPUT_MAX_TOKENS,
    });
  }

  // Inject the synthetic summary as a `user` turn wrapped in a
  // <system_notice> XML envelope. The previous design used `role:
  // "assistant"` to "prevent injection", but it had a worse failure
  // mode: the parent model read the bullet summary as its OWN earlier
  // reasoning, treated it as ground truth, and confidently
  // extrapolated specifics that weren't in the summary — the
  // root cause of post-compaction hallucinations reported by
  // operators. The XML envelope is the same trust-boundary pattern
  // used for organizational context (see config.ts ORG_CONTEXT
  // injection) and the system prompt explicitly teaches the model
  // to treat <system_notice> contents as lossy reminders, not
  // authoritative evidence.
  const summaryRole = "user" as const;
  const droppedMessagesCount = middle.length;

  let result: Message[];

  // If the pre-trim loop exited because cappedMiddle is down to its
  // floor (≤2 messages) but the estimate is still above Haiku's
  // ceiling, the upcoming messages.create would 400 with
  // `prompt is too long` for Haiku's 200K window. Skip the wasted
  // API call and go straight to the hard-truncation fallback so
  // operators see the cause at error level instead of a swallowed
  // 400 buried in the warn at the catch site below.
  if (haikuInputEstimate > HAIKU_INPUT_MAX_TOKENS) {
    logger.error(
      "Skipping Haiku compression: pre-trim floor still exceeds HAIKU_INPUT_MAX_TOKENS — using hard truncation fallback",
      "context-manager",
      {
        estimatedTokens: haikuInputEstimate,
        ceiling: HAIKU_INPUT_MAX_TOKENS,
        remainingMessages: cappedMiddle.length,
      },
    );
    result = [...anchor, buildCompressionFailureNotice(droppedMessagesCount), ...recent];
    return enforceCeiling(result, budget.neoContextMaxInputTokens, systemPromptTokenEstimate);
  }

  try {
    // Validate cappedMiddle shape before sending to Haiku
    const validatedMiddle = validateAndRepairConversationShape(cappedMiddle);
    // The stable messages.create endpoint rejects mcp_tool_use /
    // mcp_tool_result blocks (those are part of the MCP-connector
    // beta). Replace them with text stubs so Haiku can still
    // summarise the conversation. Lossy but safer than 400-ing the
    // entire compression call.
    const haikuReady = materializeMcpBlocksAsText(validatedMiddle);

    const response = await anthropicClient.messages.create({
      model: HAIKU_MODEL,
      // 4K output budget (vs the old 1K cap) so Haiku can list every
      // identifier verbatim instead of aggregating to a vague
      // "investigated several TOR-related sign-ins". 1K was the
      // primary source of post-compaction hallucinations.
      max_tokens: 4096,
      system: HAIKU_COMPRESSION_SYSTEM_PROMPT,
      messages: [
        ...haikuReady,
        { role: "user", content: "Please summarise the conversation above using the IDENTIFIERS-first format from the system prompt." },
      ],
      ...(ownerId ? { metadata: { user_id: hashPii(ownerId) } } : {}),
    });

    logger.info("Context compression usage", "context-manager", {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: HAIKU_MODEL,
      droppedMessages: droppedMessagesCount,
    });

    const summaryText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const summaryMessage: Message = {
      role: summaryRole,
      content:
        `<system_notice type="context_compressed" dropped_messages="${droppedMessagesCount}">\n` +
        `This block is a system-generated lossy summary of ${droppedMessagesCount} earlier conversation messages that were dropped to fit the context window. ` +
        `It is NOT the user's words. Treat it as a reminder of what was investigated, NOT as authoritative evidence. ` +
        `If the user asks for specifics that aren't listed verbatim below (e.g. a specific IP, alert ID, or hash), ` +
        `say so and offer to re-run the investigation rather than infer.\n\n` +
        summaryText +
        `\n</system_notice>`,
    };

    result = [...anchor, summaryMessage, ...recent];
  } catch (err) {
    logger.warn("Context summarization failed, using hard truncation fallback", "context-manager", {
      errorMessage: (err as Error).message,
      droppedMessages: droppedMessagesCount,
    });

    result = [...anchor, buildCompressionFailureNotice(droppedMessagesCount), ...recent];
  }

  // After summarization, run the ceiling-enforcement pass to guarantee
  // the result fits under NEO_CONTEXT_MAX_INPUT_TOKENS. enforceCeiling
  // returns a pair-aware, already shape-validated array.
  return enforceCeiling(result, budget.neoContextMaxInputTokens, systemPromptTokenEstimate);
}

/**
 * Pair-aware, progressive truncation that drops the oldest turn pairs
 * (starting past the anchor + summary placeholder) until the estimated
 * input size fits under `ceiling + systemPromptTokenEstimate`. Extracted
 * from `compressOlderMessages` so it can also run as the final
 * enforcement pass from `prepareMessages` after compression (the
 * compression path alone isn't guaranteed to land under the ceiling
 * when the recent window itself is oversized).
 *
 * Minimum viable shape preserved: anchor (0) + summary placeholder (1)
 * + at least one recent message (2). If the floor still exceeds the
 * ceiling, logs `Emergency truncation exhausted` at error level and
 * returns the minimum-shape array regardless — the caller's alternative
 * (send over ceiling) is strictly worse.
 */
export function enforceCeiling(
  messages: Message[],
  ceiling: number,
  systemPromptTokenEstimate: number,
): Message[] {
  const MIN_RESULT_LENGTH = 3;
  let result = messages;
  let estimate = estimateTokens(result) + systemPromptTokenEstimate;
  let dropped = 0;
  const startEstimate = estimate;

  while (estimate > ceiling && result.length > MIN_RESULT_LENGTH) {
    const rawDropIndex = 2;
    const safeDropIndex = findSafeSliceStart(result, rawDropIndex);
    let dropEnd = safeDropIndex + 1;
    if (
      dropEnd < result.length &&
      result[safeDropIndex].role === "assistant" &&
      hasToolUseBlocks(result[safeDropIndex]) &&
      result[dropEnd].role === "user" &&
      hasToolResultBlocks(result[dropEnd])
    ) {
      dropEnd = safeDropIndex + 2;
    }

    logger.warn("Emergency truncation: dropping messages to fit context", "context-manager", {
      droppedFromIndex: safeDropIndex,
      droppedCount: dropEnd - safeDropIndex,
      estimatedTokens: estimate,
      ceiling,
    });

    result = [...result.slice(0, safeDropIndex), ...result.slice(dropEnd)];
    dropped += dropEnd - safeDropIndex;
    estimate = estimateTokens(result) + systemPromptTokenEstimate;
  }

  if (estimate > ceiling) {
    logger.error(
      "Emergency truncation exhausted: minimum conversation still exceeds ceiling",
      "context-manager",
      {
        estimatedTokens: estimate,
        ceiling,
        remainingMessages: result.length,
      },
    );
  }

  if (dropped > 0) {
    logger.emitEvent("context_engineering", "Enforced input-token ceiling via emergency truncation", "context-manager", {
      reason: "enforce_ceiling",
      originalTokens: startEstimate,
      afterEnforcementTokens: estimate,
      droppedMessages: dropped,
      ceiling,
    });
  }

  // Validate shape after loop (catches any orphans introduced by drops)
  return validateAndRepairConversationShape(result);
}

// ── In-flight tool-result offload ────────────────────────────

/**
 * Walk older tool_result blocks and replace oversized string payloads
 * with the same trust-marked blob envelope string that the runtime
 * persistence path (`injection-guard.ts#wrapAndMaybeOffloadToolResult`)
 * produces. The agent can re-fetch the full payload via
 * `get_full_tool_result` when it needs to — but in the meantime the
 * prompt stays under ceiling.
 *
 * Contract:
 *  - `skipLastTurn: true` protects the most recent tool_result blocks
 *    (current agent turn) from being offloaded; otherwise the agent
 *    would immediately round-trip `get_full_tool_result` to read what
 *    it just received, which is pure overhead.
 *  - `thresholdTokens` (default PER_TOOL_RESULT_TOKEN_CAP) is the
 *    per-result cut-off — below it, the result stays inline.
 *  - Already-envelope content (detected via `_neo_trust_boundary`
 *    substring) is left untouched — idempotent.
 *  - Blob storage failures are swallowed with a warn; the inline
 *    result is preserved as a fallback so the prompt still works, even
 *    if it risks the 200K ceiling for that turn.
 */
export async function offloadLargeToolResultsInPrompt(
  messages: Message[],
  ctx: {
    conversationId: string;
    skipLastTurn?: boolean;
    thresholdTokens?: number;
  },
): Promise<{ messages: Message[]; offloadedCount: number }> {
  const threshold = ctx.thresholdTokens ?? PER_TOOL_RESULT_TOKEN_CAP;
  const charThreshold = threshold * CHARS_PER_TOKEN;
  const skipLastTurn = ctx.skipLastTurn ?? true;

  // Identify the end of the region we're allowed to rewrite. The
  // "last turn" is either:
  //   - the last assistant + user tool_result pair (local tools), or
  //   - the last assistant message containing mcp_tool_result blocks
  //     (MCP tools execute server-side and the result lives inline
  //     in the same assistant message).
  // Walk back from the end and use whichever appears first. When
  // skipLastTurn is true, we keep the matched region intact.
  let cutoffIndex = messages.length;
  if (skipLastTurn) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && hasToolResultBlocks(m)) {
        // Local pair: protect both the user-result and its preceding
        // assistant-tool-use message.
        cutoffIndex = Math.max(0, i - 1);
        break;
      }
      if (m.role === "assistant" && hasMcpToolResultBlocks(m)) {
        // MCP pair lives entirely inside this assistant message; just
        // protect this single message.
        cutoffIndex = i;
        break;
      }
    }
  }

  let offloadedCount = 0;
  const { maybeOffloadToolResult } = await import("./tool-result-blob-store");

  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i >= cutoffIndex || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    let mutated = false;
    const newContent: typeof msg.content = [];
    for (const block of msg.content) {
      const blockType = (block as { type: string }).type;
      const isLocal = blockType === "tool_result";
      const isMcp = blockType === "mcp_tool_result";
      if (!isLocal && !isMcp) {
        newContent.push(block);
        continue;
      }
      const tr = block as { content?: unknown; tool_use_id?: string };
      const content = tr.content;
      if (typeof content !== "string" || content.length <= charThreshold) {
        newContent.push(block);
        continue;
      }
      // Already-envelope content — parse-based check so a legitimate
      // tool result that happens to contain the internal marker
      // substrings (e.g., a Sentinel alert mentioning Neo internals)
      // doesn't get skipped as if it were already offloaded. Fast-path
      // with a cheap substring check to avoid JSON.parse on the common
      // non-envelope case.
      if (
        content.includes("_neo_trust_boundary") &&
        content.includes("_neo_blob_ref")
      ) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = null;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { _neo_trust_boundary?: unknown })._neo_trust_boundary === "object" &&
          (parsed as { data?: { _neo_blob_ref?: unknown } }).data?._neo_blob_ref === true
        ) {
          newContent.push(block);
          continue;
        }
      }

      try {
        // Before offloading, if the existing content is already a
        // trust-boundary envelope (from a prior wrap step), preserve
        // its `injection_detected` flag. Without this, the outer
        // offload envelope below would hardcode `injection_detected:
        // false` and silently launder away a `true` flag from the
        // inner scan. See review B2.
        let preservedInjectionFlag = false;
        if (content.includes("_neo_trust_boundary")) {
          try {
            const inner = JSON.parse(content) as {
              _neo_trust_boundary?: { injection_detected?: unknown };
            };
            if (
              inner &&
              typeof inner._neo_trust_boundary === "object" &&
              inner._neo_trust_boundary?.injection_detected === true
            ) {
              preservedInjectionFlag = true;
            }
          } catch {
            // Not parseable as JSON — fall through with default false.
          }
        }

        // Attempt to offload the raw payload. `maybeOffloadToolResult`
        // expects the full wrapper JSON so it can compute a stable
        // content-hash; we pass the tool_result's string content as-is
        // (already the serialized payload).
        const outcome = await maybeOffloadToolResult(content, {
          conversationId: ctx.conversationId,
          sourceTool: tr.tool_use_id ?? "unknown",
        });
        if (typeof outcome === "string") {
          // Below blob-store threshold or storage unavailable — inline.
          newContent.push(block);
          continue;
        }
        // Above threshold — wrap in the trust-marked envelope. Same
        // shape as wrapAndMaybeOffloadToolResult so downstream
        // resolvers treat it identically. MCP-sourced blocks tag
        // `source: "mcp_offload_inflight"` so audit / debug can
        // distinguish them from local tool offloads.
        //
        // truncation_hint is surfaced as a top-level string so the
        // model can act on it without parsing _neo_blob_ref. The
        // system prompt's "## TRUNCATED TOOL RESULTS" section
        // teaches the model what to do when this field is present.
        const envelope = JSON.stringify(
          {
            _neo_trust_boundary: {
              source: isMcp ? "mcp_offload_inflight" : "tool_offload_inflight",
              tool: tr.tool_use_id ?? "unknown",
              injection_detected: preservedInjectionFlag,
            },
            truncation_hint:
              `Full tool result was offloaded to blob storage. ` +
              `If the question depends on details not visible in this envelope, ` +
              `call get_full_tool_result with tool_use_id "${tr.tool_use_id ?? "unknown"}" ` +
              `to retrieve the complete payload.`,
            data: outcome,
          },
          null,
          2,
        );
        newContent.push({ ...block, content: envelope } as typeof block);
        offloadedCount += 1;
        mutated = true;
      } catch (err) {
        logger.warn("In-flight tool-result offload failed (preserving inline)", "context-manager", {
          errorMessage: (err as Error).message,
          conversationId: ctx.conversationId,
        });
        newContent.push(block);
      }
    }

    out.push(mutated ? { ...msg, content: newContent } : msg);
  }

  if (offloadedCount > 0) {
    logger.emitEvent("context_engineering", "Offloaded in-flight tool results to blob", "context-manager", {
      reason: "inflight_offload",
      offloadedCount,
      conversationId: ctx.conversationId,
    });
  }

  return { messages: out, offloadedCount };
}

// ── Anchor summarisation ─────────────────────────────────────

/**
 * When the very first user message on its own already exceeds
 * FIRST_MESSAGE_MAX_TOKENS, replace it in-place with a Haiku-generated
 * summary. Without this, `compressOlderMessages` preserves the anchor
 * verbatim and the bloated first message dominates every subsequent
 * prompt. A hard character-level truncation is the fallback if Haiku
 * fails — strictly worse than a summary but still fits under the
 * budget. See _plans/output-budget.md.
 *
 * Only touches string-content user messages; array-content first
 * messages (images, attached docs) are left alone because character-
 * counting on structured content is unreliable and the offload /
 * truncation paths downstream already handle oversized tool results.
 */
async function maybeSummarizeAnchor(
  messages: Message[],
  firstMessageMaxTokens: number,
  ownerId?: string,
): Promise<Message[]> {
  if (messages.length === 0) return messages;

  // Find the first user message (anchor).
  let anchorIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) return messages;

  const anchor = messages[anchorIndex];
  if (typeof anchor.content !== "string") return messages;

  const anchorTokens = Math.ceil(anchor.content.length / CHARS_PER_TOKEN);
  if (anchorTokens <= firstMessageMaxTokens) return messages;

  logger.emitEvent("context_engineering", "Anchor exceeds FIRST_MESSAGE_MAX_TOKENS — summarising", "context-manager", {
    reason: "anchor_oversize",
    originalTokens: anchorTokens,
    ceiling: firstMessageMaxTokens,
  });

  let summarised: string;
  try {
    const response = await anthropicClient.messages.create({
      model: HAIKU_MODEL,
      // 4K output budget — same reasoning as compressOlderMessages: a
      // 1K cap forced Haiku to aggregate identifiers and lose details
      // the downstream model needed.
      max_tokens: 4096,
      system:
        "You are summarising the user's opening message because it was too large for the model's context window. " +
        "Faithfulness matters — a missing identifier can derail the investigation.\n\n" +
        "OUTPUT FORMAT (two sections):\n\n" +
        "## IDENTIFIERS\n" +
        "List every distinct identifier in the message, one per line, with a short context label. Include ALL of: " +
        "IP addresses, hostnames/FQDNs, UPNs/emails, alert/incident/case IDs, file hashes, " +
        "process names + command lines, URLs, domains, and any KQL table or tool names mentioned. " +
        "Do not aggregate.\n\n" +
        "## INTENT & CONSTRAINTS\n" +
        "In up to 8 bullets, capture the user's intent, what they want done, and any constraints " +
        "(deadlines, scope, off-limits actions). Mark any uncertainty with \"(unclear from message)\".",
      messages: [
        { role: "user", content: anchor.content },
        { role: "user", content: "Please summarise the message above using the IDENTIFIERS-first format from the system prompt." },
      ],
      ...(ownerId ? { metadata: { user_id: hashPii(ownerId) } } : {}),
    });
    const summaryText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    summarised =
      `<system_notice type="anchor_summarised" original_tokens="${anchorTokens}">\n` +
      `This block is a lossy summary of the user's opening message (the original was too large for the context window). ` +
      `Treat the IDENTIFIERS section as authoritative quotation; treat the INTENT section as a reminder, not the user's exact words. ` +
      `If the user follows up about specifics not listed here, ASK them to restate rather than inferring.\n\n` +
      summaryText +
      `\n</system_notice>`;
  } catch (err) {
    logger.warn("Anchor summarisation failed — using hard truncation fallback", "context-manager", {
      errorMessage: (err as Error).message,
    });
    const charCap = firstMessageMaxTokens * CHARS_PER_TOKEN;
    summarised =
      anchor.content.slice(0, charCap) +
      `\n\n[anchor truncated — original was ${anchor.content.length} chars]`;
  }

  const out = [...messages];
  out[anchorIndex] = { ...anchor, content: summarised };
  return out;
}

// ── Empty-content sanitizer ──────────────────────────────────

// System-attributed placeholder so Claude does not treat the coerced
// content as a directive from the user. Defense in depth — the sanitizer
// only fires for empty content that would otherwise fail the API, but the
// wording clarifies that this is a system-generated placeholder.
const EMPTY_USER_PLACEHOLDER = "[system: empty message placeholder — not user input]";

/**
 * Coerce any `role: "user"` messages with empty content to a placeholder
 * text block. Anthropic's API rejects user messages whose content is `""`
 * or `[]` with a 400 "user messages must have non-empty content" error,
 * which can brick a conversation if an empty message gets persisted or
 * produced by context trimming.
 *
 * Returns a new array only if any coercion happened; otherwise returns
 * the input array unchanged. Logs a warn for every coercion so the
 * upstream cause can be investigated.
 */
export function sanitizeEmptyUserMessages(messages: Message[]): Message[] {
  let changed = false;
  const result = messages.map((msg, idx) => {
    if (msg.role !== "user") return msg;

    // String content: empty or whitespace-only
    if (typeof msg.content === "string") {
      if (msg.content.trim() === "") {
        changed = true;
        logger.warn("Coerced empty user message to placeholder", "context-manager", {
          messageIndex: idx,
          contentType: "string",
        });
        return { ...msg, content: EMPTY_USER_PLACEHOLDER };
      }
      return msg;
    }

    // Array content: empty array, or all blocks are empty-text with no
    // non-text blocks.
    if (Array.isArray(msg.content)) {
      if (msg.content.length === 0) {
        changed = true;
        logger.warn("Coerced empty user message to placeholder", "context-manager", {
          messageIndex: idx,
          contentType: "array-empty",
        });
        return {
          ...msg,
          content: [{ type: "text" as const, text: EMPTY_USER_PLACEHOLDER }],
        };
      }

      const hasNonText = msg.content.some((b) => b.type !== "text");
      const allTextEmpty = msg.content.every(
        (b) => b.type === "text" && (!b.text || b.text.trim() === ""),
      );
      if (!hasNonText && allTextEmpty) {
        changed = true;
        logger.warn("Coerced empty user message to placeholder", "context-manager", {
          messageIndex: idx,
          contentType: "array-all-empty-text",
        });
        return {
          ...msg,
          content: [{ type: "text" as const, text: EMPTY_USER_PLACEHOLDER }],
        };
      }
    }

    return msg;
  });

  return changed ? result : messages;
}

// ── Main entry point ─────────────────────────────────────────

export interface PrepareMessagesContext {
  /** Conversation / session id, used by in-flight tool-result offload
   *  to key blob uploads. Optional — when absent, the offload pass is
   *  skipped and only summary compression + emergency truncation run. */
  conversationId?: string;
  /** Authenticated user's stable identifier. Forwarded to Anthropic
   *  on the Haiku compression and anchor-summarisation calls as
   *  hashed `metadata.user_id` so vendor-side trust-and-safety
   *  enforcement can be user-scoped. Optional. */
  ownerId?: string;
  /** Active model id. When the model is the 1M-context Opus 4.7
   *  variant (suffix `[1m]`), prepareMessages switches its internal
   *  thresholds (trim trigger, ceiling, per-tool-result cap, anchor
   *  cap) to the 1M-tier overrides defined in config.ts. Standard-
   *  tier models keep the existing 200K-window thresholds. Defaults
   *  to the standard tier when omitted. */
  model?: string;
}

export async function prepareMessages(
  messages: Message[],
  lastInputTokens: number | null,
  systemPromptTokenEstimate: number,
  ctx: PrepareMessagesContext = {},
): Promise<PrepareResult> {
  // Compute the effective budget once. For standard-tier models this
  // returns the existing constants; for [1m] it returns the
  // ONE_MILLION_CONTEXT_BUDGET overrides. Threading a budget value
  // through every helper avoids the alternative of either (a)
  // making the consts mutable globals or (b) duplicating the
  // const-vs-budget branching at every callsite.
  const budget = getContextBudget(ctx.model ?? "");

  // Step 1: Anchor summary — if the very first user message alone is
  // already larger than budget.firstMessageMaxTokens, replace with a
  // Haiku-generated summary in-place. Without this, the anchor is
  // never dropped and dominates every subsequent turn's budget.
  const anchorSummarised = await maybeSummarizeAnchor(messages, budget.firstMessageMaxTokens, ctx.ownerId);

  // Step 2: Truncate individual oversized tool results (per-result cap)
  const { messages: truncatedMessages, anyTruncated } = truncateToolResults(anchorSummarised, budget.perToolResultTokenCap);

  // Step 3: Estimate total context size
  // When lastInputTokens comes from response.usage.input_tokens, it already
  // includes the system prompt, so we use it directly. On the first call
  // (null), we fall back to the char÷4 heuristic plus system prompt estimate.
  const messageTokens = lastInputTokens ?? estimateTokens(truncatedMessages);
  const totalEstimate = lastInputTokens != null
    ? messageTokens
    : messageTokens + systemPromptTokenEstimate;

  // Step 3b: In-flight offload — only when projected prompt exceeds the
  // ceiling. Replaces oversized OLDER tool results (skipping the last
  // turn) with trust-marked envelope strings so the current turn
  // remains under budget without forcing an immediate re-fetch of
  // just-arrived results.
  let afterOffload = truncatedMessages;
  if (
    ctx.conversationId &&
    totalEstimate > budget.neoContextMaxInputTokens
  ) {
    const offloaded = await offloadLargeToolResultsInPrompt(truncatedMessages, {
      conversationId: ctx.conversationId,
      skipLastTurn: true,
      thresholdTokens: budget.perToolResultTokenCap,
    });
    afterOffload = offloaded.messages;
  }

  // Step 4: Compress if over the trim trigger threshold. compressOlderMessages
  // internally runs enforceCeiling as its final step, so a successful
  // compression return is already guaranteed to fit under
  // budget.neoContextMaxInputTokens.
  if (totalEstimate > budget.trimTriggerThreshold) {
    logger.info("Context trimming triggered", "context-manager", {
      estimatedTokens: totalEstimate,
      threshold: budget.trimTriggerThreshold,
      ceiling: budget.neoContextMaxInputTokens,
      messageCount: afterOffload.length,
    });

    const compressed = await compressOlderMessages(
      afterOffload,
      PRESERVED_RECENT_MESSAGES,
      systemPromptTokenEstimate,
      budget,
      ctx.ownerId,
    );
    const sanitized = sanitizeEmptyUserMessages(compressed);
    const newTokens = estimateTokens(sanitized) + systemPromptTokenEstimate;

    return {
      messages: sanitized,
      trimmed: true,
      method: "summary",
      originalTokens: totalEstimate,
      newTokens,
    };
  }

  // Step 5: Defensive ceiling enforcement even below the trim trigger.
  // Catches the edge case where compression has already run on a prior
  // turn and the current estimate is close to (but below) the threshold,
  // AND the anchor + recent window still exceeds the hard ceiling.
  // Rarely fires in practice but cheap when it doesn't.
  if (totalEstimate > budget.neoContextMaxInputTokens) {
    const enforced = enforceCeiling(
      afterOffload,
      budget.neoContextMaxInputTokens,
      systemPromptTokenEstimate,
    );
    const sanitized = sanitizeEmptyUserMessages(enforced);
    const newTokens = estimateTokens(sanitized) + systemPromptTokenEstimate;
    return {
      messages: sanitized,
      trimmed: true,
      method: "truncation",
      originalTokens: totalEstimate,
      newTokens,
    };
  }

  if (anyTruncated) {
    const sanitized = sanitizeEmptyUserMessages(afterOffload);
    const newTokens = estimateTokens(sanitized) + systemPromptTokenEstimate;
    return {
      messages: sanitized,
      trimmed: true,
      method: "truncation",
      originalTokens: totalEstimate,
      newTokens,
    };
  }

  const sanitized = sanitizeEmptyUserMessages(afterOffload);
  return {
    messages: sanitized,
    trimmed: false,
    originalTokens: totalEstimate,
    newTokens: totalEstimate,
  };
}
