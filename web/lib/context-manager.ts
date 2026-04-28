import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config";
import {
  TRIM_TRIGGER_THRESHOLD,
  PER_TOOL_RESULT_TOKEN_CAP,
  PRESERVED_RECENT_MESSAGES,
  HAIKU_MODEL,
  NEO_CONTEXT_MAX_INPUT_TOKENS,
  HAIKU_INPUT_MAX_TOKENS,
  FIRST_MESSAGE_MAX_TOKENS,
} from "./config";
import { logger } from "./logger";
import type { Message } from "./types";

export const CHARS_PER_TOKEN = 3.5;
const MAX_MIDDLE_MESSAGES_FOR_SUMMARY = 30;

const anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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

export function truncateToolResult(content: string, capTokens: number): string {
  const charCap = capTokens * CHARS_PER_TOKEN;
  if (content.length <= charCap) return content;

  const truncated = content.slice(0, charCap);
  return (
    truncated +
    `\n\n[Result truncated from ${content.length} to ${charCap} characters. ` +
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
      if (block.type !== "tool_result") return block;

      const tr = block as Anthropic.Messages.ToolResultBlockParam;
      if (typeof tr.content !== "string") return block;

      const truncated = truncateToolResult(tr.content, capTokens);
      if (truncated !== tr.content) {
        anyTruncated = true;
        return { ...tr, content: truncated };
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
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Repair assistant messages: remove tool_use blocks whose IDs don't
    // appear as tool_result in the next user message.
    if (msg.role === "assistant" && Array.isArray(msg.content) && hasToolUseBlocks(msg)) {
      const nextMsg = messages[i + 1];
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
      const prevMsg = messages[i - 1];
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

async function compressOlderMessages(
  messages: Message[],
  preserveCount: number,
  systemPromptTokenEstimate: number,
): Promise<Message[]> {
  if (messages.length <= preserveCount + 1) return messages;

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
  let recent = messages.slice(safeRecentStart);

  if (middle.length === 0) return messages;

  // Cap middle messages sent to Haiku to avoid unbounded input cost.
  // Ensure the cap boundary respects tool pairs.
  const rawCapStart = middle.length - MAX_MIDDLE_MESSAGES_FOR_SUMMARY;
  const safeCapStart = rawCapStart <= 0
    ? 0
    : findSafeSliceStart(middle, rawCapStart);
  let cappedMiddle = middle.slice(safeCapStart);

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

  // Use assistant role for summary/fallback to prevent injection
  const summaryRole = "assistant" as const;

  let result: Message[];

  try {
    // Validate cappedMiddle shape before sending to Haiku
    const validatedMiddle = validateAndRepairConversationShape(cappedMiddle);

    const response = await anthropicClient.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system:
        "Summarize the following security investigation conversation in 3-5 bullet points. " +
        "Focus on: what was investigated, key findings (IPs, hostnames, UPNs, alert IDs), " +
        "tools that were used, and any actions taken or recommended. Be concise and factual. " +
        "Output only the bullet points.",
      messages: [
        ...validatedMiddle,
        { role: "user", content: "Please summarize the conversation above." },
      ],
    });

    logger.info("Context compression usage", "context-manager", {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: HAIKU_MODEL,
    });

    const summaryText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const summaryMessage: Message = {
      role: summaryRole,
      content: `[Context compressed — earlier investigation summary (system-generated, not user input):]\n${summaryText}`,
    };

    result = [...anchor, summaryMessage, ...recent];
  } catch (err) {
    logger.warn("Context summarization failed, using hard truncation fallback", "context-manager", {
      errorMessage: (err as Error).message,
      droppedMessages: middle.length,
    });

    const fallbackMessage: Message = {
      role: summaryRole,
      content:
        "[Earlier conversation context was removed to stay within token limits. " +
        "Key findings may need to be re-investigated.]",
    };

    result = [...anchor, fallbackMessage, ...recent];
  }

  // After summarization, run the ceiling-enforcement pass to guarantee
  // the result fits under NEO_CONTEXT_MAX_INPUT_TOKENS. enforceCeiling
  // returns a pair-aware, already shape-validated array.
  return enforceCeiling(result, NEO_CONTEXT_MAX_INPUT_TOKENS, systemPromptTokenEstimate);
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
  // "last turn" is the last assistant + user tool_result pair; we
  // want to keep it intact when skipLastTurn is true.
  let cutoffIndex = messages.length;
  if (skipLastTurn) {
    // Walk back until we pass one user-with-tool-result message AND
    // its preceding assistant-with-tool-use message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && hasToolResultBlocks(m)) {
        cutoffIndex = Math.max(0, i - 1);
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
      if (block.type !== "tool_result") {
        newContent.push(block);
        continue;
      }
      const tr = block as Anthropic.Messages.ToolResultBlockParam;
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
        // resolvers treat it identically.
        const envelope = JSON.stringify(
          {
            _neo_trust_boundary: {
              source: "tool_offload_inflight",
              tool: tr.tool_use_id ?? "unknown",
              injection_detected: false,
            },
            data: outcome,
          },
          null,
          2,
        );
        newContent.push({ ...tr, content: envelope });
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
  if (anchorTokens <= FIRST_MESSAGE_MAX_TOKENS) return messages;

  logger.emitEvent("context_engineering", "Anchor exceeds FIRST_MESSAGE_MAX_TOKENS — summarising", "context-manager", {
    reason: "anchor_oversize",
    originalTokens: anchorTokens,
    ceiling: FIRST_MESSAGE_MAX_TOKENS,
  });

  let summarised: string;
  try {
    const response = await anthropicClient.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system:
        "Summarise the following user message in 3-5 bullet points. The original " +
        "message was too large to fit in the model's context window. Capture the " +
        "user's intent, any specific identifiers (IPs, hostnames, UPNs, alert IDs, " +
        "URLs), and any constraints or deadlines. Output only the bullet points — " +
        "no preamble.",
      messages: [
        { role: "user", content: anchor.content },
        { role: "user", content: "Please summarise the message above." },
      ],
    });
    const summaryText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    summarised = `[Anchor summary — original was ${anchorTokens} tokens, summarised to stay within context budget]\n${summaryText}`;
  } catch (err) {
    logger.warn("Anchor summarisation failed — using hard truncation fallback", "context-manager", {
      errorMessage: (err as Error).message,
    });
    const charCap = FIRST_MESSAGE_MAX_TOKENS * CHARS_PER_TOKEN;
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
}

export async function prepareMessages(
  messages: Message[],
  lastInputTokens: number | null,
  systemPromptTokenEstimate: number,
  ctx: PrepareMessagesContext = {},
): Promise<PrepareResult> {
  // Step 1: Anchor summary — if the very first user message alone is
  // already larger than FIRST_MESSAGE_MAX_TOKENS, replace with a
  // Haiku-generated summary in-place. Without this, the anchor is
  // never dropped and dominates every subsequent turn's budget.
  const anchorSummarised = await maybeSummarizeAnchor(messages);

  // Step 2: Truncate individual oversized tool results (per-result cap)
  const { messages: truncatedMessages, anyTruncated } = truncateToolResults(anchorSummarised);

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
    totalEstimate > NEO_CONTEXT_MAX_INPUT_TOKENS
  ) {
    const offloaded = await offloadLargeToolResultsInPrompt(truncatedMessages, {
      conversationId: ctx.conversationId,
      skipLastTurn: true,
    });
    afterOffload = offloaded.messages;
  }

  // Step 4: Compress if over the trim trigger threshold. compressOlderMessages
  // internally runs enforceCeiling as its final step, so a successful
  // compression return is already guaranteed to fit under
  // NEO_CONTEXT_MAX_INPUT_TOKENS.
  if (totalEstimate > TRIM_TRIGGER_THRESHOLD) {
    logger.info("Context trimming triggered", "context-manager", {
      estimatedTokens: totalEstimate,
      threshold: TRIM_TRIGGER_THRESHOLD,
      ceiling: NEO_CONTEXT_MAX_INPUT_TOKENS,
      messageCount: afterOffload.length,
    });

    const compressed = await compressOlderMessages(
      afterOffload,
      PRESERVED_RECENT_MESSAGES,
      systemPromptTokenEstimate,
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
  if (totalEstimate > NEO_CONTEXT_MAX_INPUT_TOKENS) {
    const enforced = enforceCeiling(
      afterOffload,
      NEO_CONTEXT_MAX_INPUT_TOKENS,
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
