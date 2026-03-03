import Anthropic from "@anthropic-ai/sdk";
import { env, SYSTEM_PROMPT } from "./config.js";
import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools.js";
import { executeTool } from "./executors.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────
//  The Agentic Loop
//  Runs until Claude either:
//    (a) returns a final text response (stop_reason: "end_turn")
//    (b) hits a destructive tool that needs confirmation
// ─────────────────────────────────────────────────────────────

export async function runAgentLoop(messages, { onToolCall, onConfirmationNeeded, onThinking } = {}) {
  const localMessages = [...messages];

  while (true) {
    if (onThinking) onThinking();

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: localMessages
    });

    // Append Claude's full response to message history
    localMessages.push({ role: "assistant", content: response.content });

    // ── Done — Claude has a final response ──────────────────
    if (response.stop_reason === "end_turn") {
      const text = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      return { type: "response", text, messages: localMessages };
    }

    // ── Tool use — process all tool_use blocks in this turn ──
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = [];

      for (const block of toolUseBlocks) {
        const { id, name, input } = block;

        // Notify caller what tool is being called
        if (onToolCall) onToolCall(name, input);

        // ── CONFIRMATION GATE for destructive actions ────────
        if (DESTRUCTIVE_TOOLS.has(name)) {
          return {
            type: "confirmation_required",
            tool: { id, name, input },
            messages: localMessages
          };
        }

        // ── Execute the tool ─────────────────────────────────
        let result;
        try {
          result = await executeTool(name, input);
        } catch (err) {
          result = { error: err.message, tool: name };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify(result, null, 2)
        });
      }

      // Feed all results back to Claude in one user turn
      localMessages.push({ role: "user", content: toolResults });
      // Loop continues → Claude will process results and respond or call more tools
      continue;
    }

    // Unexpected stop reason — surface the error
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  Resume after user confirms (or cancels) a destructive action
// ─────────────────────────────────────────────────────────────

export async function resumeAfterConfirmation(messages, pendingTool, confirmed, { onToolCall, onConfirmationNeeded, onThinking } = {}) {
  const localMessages = [...messages];
  const { id, name, input } = pendingTool;

  let toolResult;

  if (confirmed) {
    if (onToolCall) onToolCall(name, input, true);
    try {
      const result = await executeTool(name, input);
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify(result, null, 2)
      };
    } catch (err) {
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify({ error: err.message }),
        is_error: true
      };
    }
  } else {
    // User cancelled — tell Claude the action was not taken
    toolResult = {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify({ cancelled: true, message: "User cancelled this action." })
    };
  }

  localMessages.push({ role: "user", content: [toolResult] });

  // Continue the loop
  return runAgentLoop(localMessages, { onToolCall, onConfirmationNeeded, onThinking });
}
