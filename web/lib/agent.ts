import Anthropic from "@anthropic-ai/sdk";
import { env, getSystemPrompt, DEFAULT_MODEL, HAIKU_MODEL } from "./config";
import { DESTRUCTIVE_TOOLS } from "./tools";
import { executeTool } from "./executors";
import { getToolsForRole, type Role } from "./permissions";
import { logger } from "./logger";
import { getToolIntegration } from "./integration-registry";
import { wrapToolResult } from "./injection-guard";
import { prepareMessages, sanitizeEmptyUserMessages, CHARS_PER_TOKEN } from "./context-manager";
import type { Message, AgentLoopResult, AgentCallbacks, PendingTool, ModelPreference, TokenUsage, CSVReference } from "./types";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/** Extends the SDK text block type with prompt caching support. */
interface CacheableTextBlock extends Anthropic.Messages.TextBlockParam {
  cache_control: { type: "ephemeral" };
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503]);

async function createWithRetry(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<Anthropic.Messages.Message> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params, { signal });
    } catch (err: unknown) {
      // Never retry on abort — propagate immediately
      if ((err as Error).name === "AbortError") {
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
  const localMessages: Message[] = [...messages];
  logger.info("Agent loop started", "agent", { role, model });

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
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool
  );

  try {
  while (true) {
    // Check abort signal between iterations
    if (signal?.aborted) return buildInterruptedResult();

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

    // Belt-and-suspenders: sanitize empty user messages again before hitting
    // the SDK. prepareMessages already sanitizes, but this catches any path
    // that might produce empty content after prepareMessages returns
    // (e.g., future mid-loop mutations) and guarantees the Anthropic API
    // never sees an empty user message.
    const sdkMessages = sanitizeEmptyUserMessages(prepared.messages);

    const apiParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 4096,
      system: [systemBlock] as Anthropic.Messages.TextBlockParam[],
      tools: cachedTools as Anthropic.Messages.Tool[],
      messages: sdkMessages,
    };
    if (options.toolChoice) {
      apiParams.tool_choice = options.toolChoice;
    }
    const response = await createWithRetry(apiParams, signal);

    lastInputTokens = response.usage.input_tokens;

    // Track usage
    const usageRaw = response.usage as unknown as Record<string, number | undefined>;
    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: usageRaw.cache_creation_input_tokens,
      cache_read_input_tokens: usageRaw.cache_read_input_tokens,
    };
    logger.emitEvent("token_usage", "API usage", "agent", {
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
        const text = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
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
            localMessages[lastAssistantIdx] = {
              role: "assistant",
              content: response.content.slice(0, destructiveContentIdx + 1),
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

        // Execute the tool with timing
        const toolStart = Date.now();
        try {
          const result = await executeTool(name, input as Record<string, unknown>, {
            sessionMessages: localMessages,
            csvAttachments,
          });
          const durationMs = Date.now() - toolStart;
          logger.emitEvent("tool_execution", `Tool completed: ${name}`, "agent", {
            toolName: name,
            toolCategory: getToolIntegration(name) ?? undefined,
            isDestructive: false,
            durationMs,
            status: "success",
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
            content: wrapToolResult(name, result, { sessionId }),
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
            content: wrapToolResult(name, errorOutput, { sessionId }),
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

    logger.warn(`Unexpected stop_reason: ${response.stop_reason}`, "agent");
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }
  } catch (err) {
    // AbortError: return interrupted result instead of rethrowing so the route
    // can persist partial state cleanly
    if ((err as Error).name === "AbortError") {
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
  const localMessages: Message[] = [...messages];
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
      });
      const durationMs = Date.now() - toolStart;
      logger.emitEvent("tool_execution", `Tool completed: ${name}`, "agent", {
        toolName: name,
        toolCategory: getToolIntegration(name) ?? undefined,
        isDestructive: true,
        durationMs,
        status: "success",
      });
      if (callbacks.onToolResult) {
        callbacks.onToolResult({ name, input, output: result, durationMs, isError: false });
      }
      toolResult = {
        type: "tool_result",
        tool_use_id: id,
        content: wrapToolResult(name, result, { sessionId }),
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
        content: wrapToolResult(name, errorOutput, { sessionId }),
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
