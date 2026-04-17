import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config";
import {
  TRIM_TRIGGER_THRESHOLD,
  PER_TOOL_RESULT_TOKEN_CAP,
  PRESERVED_RECENT_MESSAGES,
  HAIKU_MODEL,
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
  const cappedMiddle = middle.slice(safeCapStart);

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

  // Emergency progressive truncation: if the result still exceeds the
  // threshold, drop the oldest messages from the recent window (pair-aware)
  // until the estimate is under budget. This prevents the "prompt is too
  // long" error that killed sessions during the 2026-04-16 incident.
  //
  // Minimum viable shape: anchor (0) + summary placeholder (1) + at least
  // one recent message (2). Below this floor we cannot drop further.
  const MIN_RESULT_LENGTH = 3;
  let emergencyEstimate = estimateTokens(result) + systemPromptTokenEstimate;
  while (emergencyEstimate > TRIM_TRIGGER_THRESHOLD && result.length > MIN_RESULT_LENGTH) {
    // Use the same pair-aware helper as the outer slicing code
    const rawDropIndex = 2;
    const safeDropIndex = findSafeSliceStart(result, rawDropIndex);
    let dropEnd = safeDropIndex + 1;
    if (dropEnd < result.length && result[safeDropIndex].role === "assistant" &&
        hasToolUseBlocks(result[safeDropIndex]) && result[dropEnd].role === "user" &&
        hasToolResultBlocks(result[dropEnd])) {
      dropEnd = safeDropIndex + 2;
    }

    logger.warn("Emergency truncation: dropping messages to fit context", "context-manager", {
      droppedFromIndex: safeDropIndex,
      droppedCount: dropEnd - safeDropIndex,
      estimatedTokens: emergencyEstimate,
      threshold: TRIM_TRIGGER_THRESHOLD,
    });

    result = [...result.slice(0, safeDropIndex), ...result.slice(dropEnd)];
    emergencyEstimate = estimateTokens(result) + systemPromptTokenEstimate;
  }

  if (emergencyEstimate > TRIM_TRIGGER_THRESHOLD) {
    logger.error(
      "Emergency truncation exhausted: minimum conversation still exceeds threshold",
      "context-manager",
      {
        estimatedTokens: emergencyEstimate,
        threshold: TRIM_TRIGGER_THRESHOLD,
        remainingMessages: result.length,
      },
    );
  }

  // Validate shape after emergency loop (catches any orphans introduced by drops)
  result = validateAndRepairConversationShape(result);

  return result;
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

export async function prepareMessages(
  messages: Message[],
  lastInputTokens: number | null,
  systemPromptTokenEstimate: number,
): Promise<PrepareResult> {
  // Step 1: Truncate individual oversized tool results
  const { messages: truncatedMessages, anyTruncated } = truncateToolResults(messages);

  // Step 2: Estimate total context size
  // When lastInputTokens comes from response.usage.input_tokens, it already
  // includes the system prompt, so we use it directly. On the first call
  // (null), we fall back to the char÷4 heuristic plus system prompt estimate.
  const messageTokens = lastInputTokens ?? estimateTokens(truncatedMessages);
  const totalEstimate = lastInputTokens != null
    ? messageTokens
    : messageTokens + systemPromptTokenEstimate;

  // Step 3: Compress if over threshold
  if (totalEstimate > TRIM_TRIGGER_THRESHOLD) {
    logger.info("Context trimming triggered", "context-manager", {
      estimatedTokens: totalEstimate,
      threshold: TRIM_TRIGGER_THRESHOLD,
      messageCount: truncatedMessages.length,
    });

    // compressOlderMessages() handles shape validation and emergency
    // truncation internally — no need to re-validate here.
    const compressed = await compressOlderMessages(
      truncatedMessages,
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

  if (anyTruncated) {
    const sanitized = sanitizeEmptyUserMessages(truncatedMessages);
    const newTokens = estimateTokens(sanitized) + systemPromptTokenEstimate;
    return {
      messages: sanitized,
      trimmed: true,
      method: "truncation",
      originalTokens: totalEstimate,
      newTokens,
    };
  }

  const sanitized = sanitizeEmptyUserMessages(truncatedMessages);
  return {
    messages: sanitized,
    trimmed: false,
    originalTokens: totalEstimate,
    newTokens: totalEstimate,
  };
}
