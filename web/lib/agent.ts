import Anthropic from "@anthropic-ai/sdk";
import { env, getSystemPrompt } from "./config";
import { DESTRUCTIVE_TOOLS } from "./tools";
import { executeTool } from "./executors";
import { getToolsForRole, type Role } from "./permissions";
import { logger } from "./logger";
import { wrapToolResult } from "./injection-guard";
import type { Message, AgentLoopResult, AgentCallbacks, PendingTool } from "./types";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

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
  sessionId: string = "unknown"
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];
  logger.info("Agent loop started", "agent", { role });

  while (true) {
    if (callbacks.onThinking) callbacks.onThinking();

    const response = await createWithRetry({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: getSystemPrompt(role),
      tools: getToolsForRole(role),
      messages: localMessages,
    });

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
          const result = await executeTool(name, input as Record<string, unknown>);
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
      model: "claude-sonnet-4-5-20250514",
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
  sessionId: string = "unknown"
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];
  const { id, name, input } = pendingTool;

  let toolResult: Anthropic.Messages.ToolResultBlockParam;

  if (confirmed) {
    logger.info("Tool confirmed", "agent", { toolName: name, toolId: id });
    if (callbacks.onToolCall) callbacks.onToolCall(name, input);
    try {
      const result = await executeTool(name, input);
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

  return runAgentLoop(localMessages, callbacks, role, sessionId);
}
