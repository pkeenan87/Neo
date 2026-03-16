import Anthropic from "@anthropic-ai/sdk";
import { env, getSystemPrompt, DEFAULT_MODEL, HAIKU_MODEL } from "./config";
import { DESTRUCTIVE_TOOLS } from "./tools";
import { executeTool } from "./executors";
import { getToolsForRole, type Role } from "./permissions";
import { logger } from "./logger";
import { wrapToolResult } from "./injection-guard";
import { prepareMessages, CHARS_PER_TOKEN } from "./context-manager";
import type { Message, AgentLoopResult, AgentCallbacks, PendingTool, ModelPreference, TokenUsage } from "./types";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** Extends the SDK text block type with prompt caching support. */
interface CacheableTextBlock extends Anthropic.Messages.TextBlockParam {
  cache_control: { type: "ephemeral" };
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503]);

async function createWithRetry(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err: unknown) {
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

export async function runAgentLoop(
  messages: Message[],
  callbacks: AgentCallbacks = {},
  role: Role = "reader",
  sessionId: string = "unknown",
  model: ModelPreference = DEFAULT_MODEL,
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];
  logger.info("Agent loop started", "agent", { role, model });

  const systemPrompt = getSystemPrompt(role);
  const systemPromptTokenEstimate = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  let lastInputTokens: number | null = null;

  // Build tools with cache_control on the last item so the entire prefix is cached
  const roleTools = getToolsForRole(role);
  const cachedTools = roleTools.map((tool, i) =>
    i === roleTools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool
  );

  while (true) {
    if (callbacks.onThinking) callbacks.onThinking();

    // Prepare messages: truncate oversized tool results, compress if near limit
    const prepared = await prepareMessages(localMessages, lastInputTokens, systemPromptTokenEstimate);

    if (prepared.trimmed && callbacks.onContextTrimmed) {
      callbacks.onContextTrimmed(prepared.originalTokens, prepared.newTokens, prepared.method!);
    }

    const systemBlock: CacheableTextBlock = {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    };

    const response = await createWithRetry({
      model,
      max_tokens: 4096,
      system: [systemBlock] as Anthropic.Messages.TextBlockParam[],
      tools: cachedTools as Anthropic.Messages.Tool[],
      messages: prepared.messages,
    });

    lastInputTokens = response.usage.input_tokens;

    // Track usage
    const usageRaw = response.usage as unknown as Record<string, number | undefined>;
    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: usageRaw.cache_creation_input_tokens,
      cache_read_input_tokens: usageRaw.cache_read_input_tokens,
    };
    logger.info("API usage", "agent", {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      model,
    });
    if (callbacks.onUsage) callbacks.onUsage(usage, model);

    localMessages.push({ role: "assistant", content: response.content });

    // Done — Claude has a final response
    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      logger.info("Agent loop completed", "agent");
      return { type: "response", text, messages: localMessages };
    }

    // Tool use — process all tool_use blocks in this turn
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const { id, name, input } = block;

        if (callbacks.onToolCall) {
          callbacks.onToolCall(name, input as Record<string, unknown>);
        }
        logger.info(`Tool call: ${name}`, "agent", { toolName: name, toolId: id });

        // Confirmation gate for destructive actions
        if (DESTRUCTIVE_TOOLS.has(name)) {
          logger.info("Confirmation gate triggered", "agent", { toolName: name, toolId: id });
          return {
            type: "confirmation_required",
            tool: { id, name, input: input as Record<string, unknown> },
            messages: localMessages,
          };
        }

        // Execute the tool
        try {
          const result = await executeTool(name, input as Record<string, unknown>, {
            sessionMessages: localMessages,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: wrapToolResult(name, result, { sessionId }),
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: wrapToolResult(name, { error: (err as Error).message, tool: name }, { sessionId }),
            is_error: true,
          });
        }
      }

      localMessages.push({ role: "user", content: toolResults });
      continue;
    }

    logger.warn(`Unexpected stop_reason: ${response.stop_reason}`, "agent");
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
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
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];
  const { id, name, input } = pendingTool;

  let toolResult: Anthropic.Messages.ToolResultBlockParam;

  if (confirmed) {
    logger.info("Tool confirmed", "agent", { toolName: name, toolId: id });
    if (callbacks.onToolCall) callbacks.onToolCall(name, input);
    try {
      const result = await executeTool(name, input, { sessionMessages: localMessages });
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: wrapToolResult(name, result, { sessionId }),
      };
    } catch (err) {
      logger.error("Tool execution error after confirmation", "agent", {
        toolName: name,
        errorMessage: (err as Error).message,
      });
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: wrapToolResult(name, { error: (err as Error).message }, { sessionId }),
        is_error: true,
      };
    }
  } else {
    logger.info("Tool cancelled", "agent", { toolName: name, toolId: id });
    toolResult = {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify({ cancelled: true, message: "User cancelled this action." }),
    };
  }

  localMessages.push({ role: "user", content: [toolResult] });

  return runAgentLoop(localMessages, callbacks, role, sessionId, model);
}
