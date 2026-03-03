import Anthropic from "@anthropic-ai/sdk";
import { env, SYSTEM_PROMPT } from "./config";
import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools";
import { executeTool } from "./executors";
import type { Message, AgentLoopResult, AgentCallbacks, PendingTool } from "./types";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function runAgentLoop(
  messages: Message[],
  callbacks: AgentCallbacks = {}
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];

  while (true) {
    if (callbacks.onThinking) callbacks.onThinking();

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: localMessages,
    });

    localMessages.push({ role: "assistant", content: response.content });

    // Done — Claude has a final response
    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
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

        // Confirmation gate for destructive actions
        if (DESTRUCTIVE_TOOLS.has(name)) {
          return {
            type: "confirmation_required",
            tool: { id, name, input: input as Record<string, unknown> },
            messages: localMessages,
          };
        }

        // Execute the tool
        let result: unknown;
        try {
          result = await executeTool(name, input as Record<string, unknown>);
        } catch (err) {
          result = { error: (err as Error).message, tool: name };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify(result, null, 2),
        });
      }

      localMessages.push({ role: "user", content: toolResults });
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }
}

export async function resumeAfterConfirmation(
  messages: Message[],
  pendingTool: PendingTool,
  confirmed: boolean,
  callbacks: AgentCallbacks = {}
): Promise<AgentLoopResult> {
  const localMessages: Message[] = [...messages];
  const { id, name, input } = pendingTool;

  let toolResult: Anthropic.Messages.ToolResultBlockParam;

  if (confirmed) {
    if (callbacks.onToolCall) callbacks.onToolCall(name, input);
    try {
      const result = await executeTool(name, input);
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify(result, null, 2),
      };
    } catch (err) {
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify({ error: (err as Error).message }),
        is_error: true,
      };
    }
  } else {
    toolResult = {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify({ cancelled: true, message: "User cancelled this action." }),
    };
  }

  localMessages.push({ role: "user", content: [toolResult] });

  return runAgentLoop(localMessages, callbacks);
}
