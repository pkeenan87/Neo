// ─────────────────────────────────────────────────────────────
//  Scheduled-task runner
//
//  Executes one already-claimed task through the existing
//  runAgentLoop, with per-task timeout, tool-allowlist intersection
//  (read-only only — destructive tools are structurally unavailable
//  to scheduled tasks since they can't satisfy the human confirmation
//  gate), output routing, run-history persistence, and circuit
//  breaker.
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import { runAgentLoop } from "./agent";
import { DEFAULT_MODEL } from "./config";
import { getSystemPrompt } from "./config";
import { logger } from "./logger";
import { computeNextRunTime } from "./cron-helpers";
import { ALL_TOOL_NAMES, DESTRUCTIVE_TOOLS } from "./tools";
import { recordRunResult } from "./scheduled-task-store";
import { dispatchRoutingTool, routeOutput } from "./scheduled-task-routing";
import { ROUTING_ALLOWED_TOOLS } from "./scheduled-task-validators";
import { summarize } from "./scheduled-task-summary";
import { postToChannel } from "./teams-channel";
import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  MAX_DURATION_SECONDS_CAP,
  type ScheduledTask,
  type ScheduledTaskRunHistoryEntry,
  type ScheduledTaskRunResult,
  type ScheduledTaskState,
} from "./scheduled-task-types";
import type { Message } from "./types";

const SCHEDULED_TASK_PREFIX = `
## SCHEDULED-TASK MODE
You are running headlessly on a cron schedule, not in a conversation. Rules:
- Produce a single self-contained written summary at the end of your run. Lead with the most important finding.
- Do not ask follow-up questions — there is no user to answer.
- Do not call destructive tools (password reset, machine isolation, etc.) — they are unavailable in this context.
- If a tool returns no results, say so explicitly rather than ending with a question.
- If a tool result is truncated (look for "[Result truncated from N to M characters...]") or returns a blob-offload envelope (truncation_hint / _neo_blob_ref), call get_full_tool_result yourself — there is no human in the loop to follow up. Do NOT guess at the truncated tail.
`;

export function computeAllowedTools(taskAllowedTools: string[]): string[] {
  // ALL_TOOL_NAMES covers both custom tools and Anthropic-hosted
  // server tools (web_search) — using TOOLS alone here would silently
  // drop web_search from a task's allowedTools even after a typecheck-
  // clean save. This is only the persistence-side recognition filter;
  // whether a server tool is actually advertised to Claude on the API
  // call still goes through getEnabledServerTools(toolAllowlist) in
  // the agent loop, which additionally enforces MOCK_MODE.
  //
  // Strip destructive tools (no human gate available in a scheduled
  // run) and routing-destination tools (the routing layer is the only
  // legitimate dispatch site for those — letting the agent loop also
  // call them would produce duplicate notifications with inconsistent
  // audit attribution). See ultra-review F2.
  return taskAllowedTools.filter(
    (name) =>
      ALL_TOOL_NAMES.has(name) &&
      !DESTRUCTIVE_TOOLS.has(name) &&
      !ROUTING_ALLOWED_TOOLS.has(name),
  );
}

function substituteVariables(
  template: string,
  variables: Record<string, string | number | boolean> | undefined,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const merged: Record<string, string | number | boolean> = {
    today,
    ...(variables ?? {}),
  };

  const placeholders = template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  for (const match of placeholders) {
    const key = match[1];
    if (!(key in merged)) {
      throw new Error(`unknown_template_variable: ${key}`);
    }
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key) => {
    return String(merged[key]);
  });
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface RunOutcome {
  result: ScheduledTaskRunResult;
  routedTo: string;
  reason?: string;
  durationMs: number;
  outputSummary: string;
}

/**
 * Execute one claimed task end-to-end. The task MUST have been
 * claimed (state.status === "running" with a fresh etag) before
 * calling. On return, recordRunResult has been called to persist
 * the outcome and compute nextRunTime.
 */
export async function executeTask(task: ScheduledTask): Promise<RunOutcome> {
  const runId = randomUUID();
  const startTime = new Date().toISOString();
  const startMs = Date.now();

  logger.info("scheduled_task.run_started", "scheduled-task-runner", {
    taskId: task.id,
    runId,
    dryRun: task.dryRun,
  });

  const allowedTools = computeAllowedTools(task.task.allowedTools);
  if (allowedTools.length === 0) {
    return await finalize(task, runId, startTime, startMs, "failure", {
      outputText: "",
      routedTo: "none",
      reason: "no_allowed_tools",
    });
  }

  let promptText: string;
  try {
    promptText = substituteVariables(task.task.promptTemplate, task.task.variables);
  } catch (err) {
    return await finalize(task, runId, startTime, startMs, "failure", {
      outputText: "",
      routedTo: "none",
      reason: (err as Error).message,
    });
  }

  const maxSec = Math.min(
    Math.max(task.task.maxDurationSeconds, 1),
    MAX_DURATION_SECONDS_CAP,
  );
  const signal = AbortSignal.timeout(maxSec * 1000);

  // Fail-closed: if getSystemPrompt throws (transient Cosmos / Key Vault
  // failure in loadOrgContext or getSkillsForRole), do NOT degrade to an
  // empty base prompt — that would strip the trust-boundary text the model
  // needs to safely consume attacker-influenced tool results. Surface as a
  // failure so the circuit breaker trips on persistent issues.
  let basePrompt: string;
  try {
    basePrompt = await getSystemPrompt("admin");
  } catch (err) {
    return await finalize(task, runId, startTime, startMs, "failure", {
      outputText: "",
      routedTo: "none",
      reason: `system_prompt_unavailable: ${(err as Error).message ?? String(err)}`,
    });
  }
  const systemPromptOverride = `${basePrompt}\n${SCHEDULED_TASK_PREFIX}`;

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: promptText }] },
  ];

  let agentResult: Awaited<ReturnType<typeof runAgentLoop>> | null = null;
  let agentError: unknown = null;
  try {
    agentResult = await runAgentLoop(
      messages,
      {},
      "admin",
      `schedtask-${task.id}-${runId}`,
      DEFAULT_MODEL,
      signal,
      {
        toolAllowlist: allowedTools,
        systemPromptOverride,
        ownerId: task.createdBy,
      },
    );
  } catch (err) {
    agentError = err;
  }

  if (agentError) {
    const isTimeout = isTimeoutError(agentError);
    return await finalize(task, runId, startTime, startMs, isTimeout ? "timeout" : "failure", {
      outputText: "",
      routedTo: "none",
      reason: (agentError as Error).message ?? String(agentError),
    });
  }

  if (!agentResult || agentResult.type !== "response") {
    return await finalize(task, runId, startTime, startMs, "failure", {
      outputText: "",
      routedTo: "none",
      reason: agentResult?.type ?? "no_result",
    });
  }

  // The agent loop swallows AbortError and returns a synthetic
  // { type: "response", text: "[interrupted]", interrupted: true }
  // result on timeout/abort (agent.ts:1228-1230). Without this branch the
  // runner would route the literal "[interrupted]" string to Teams and
  // record the run as success, never tripping the circuit breaker.
  if (agentResult.interrupted) {
    return await finalize(task, runId, startTime, startMs, "timeout", {
      outputText: "",
      routedTo: "none",
      reason: "aborted_or_timeout",
    });
  }

  const outputText = agentResult.text ?? "";
  const routing = await routeOutput(task, outputText);

  return await finalize(
    task,
    runId,
    startTime,
    startMs,
    routing.success ? "success" : "failure",
    {
      outputText,
      routedTo: routing.routedTo,
      reason: routing.reason,
    },
  );
}

async function finalize(
  task: ScheduledTask,
  runId: string,
  startTime: string,
  startMs: number,
  result: ScheduledTaskRunResult,
  outcome: { outputText: string; routedTo: string; reason?: string },
): Promise<RunOutcome> {
  const endIso = new Date().toISOString();
  const durationMs = Date.now() - startMs;
  const outputSummary = summarize(outcome.outputText);

  const runEntry: ScheduledTaskRunHistoryEntry = {
    runId,
    startTime,
    endTime: endIso,
    result,
    outputSummary,
    routedTo: outcome.routedTo,
    reason: outcome.reason,
  };

  const nextRunTime = computeNextRunTime(
    task.schedule.cronExpression,
    task.schedule.timezone,
    endIso,
  );

  const consecutiveFailures =
    result === "success"
      ? 0
      : task.state.consecutiveFailures + 1;

  const threshold =
    task.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  const tripBreaker = consecutiveFailures >= threshold;

  const newState: ScheduledTaskState = {
    status: tripBreaker ? "failed" : "idle",
    nextRunTime,
    lastRunTime: startTime,
    lastRunResult: result,
    lastRunDurationMs: durationMs,
    consecutiveFailures,
  };

  const newEnabled = tripBreaker ? false : task.enabled;

  try {
    await recordRunResult(task, runEntry, newState, newEnabled);
  } catch (err) {
    // recordRunResult retries internally on 412; reaching here means either
    // a non-retriable Cosmos failure or repeated conflicts. The task may now
    // be stuck in status='running' until the findDueTasks watchdog resurfaces
    // it (after 2× MAX_DURATION_SECONDS_CAP). Log at error level so the
    // observability sink alerts on it.
    logger.error("scheduled_task.persist_failed", "scheduled-task-runner", {
      taskId: task.id,
      errorMessage: (err as Error).message,
    });
  }

  logger.info("scheduled_task.run_completed", "scheduled-task-runner", {
    taskId: task.id,
    runId,
    result,
    durationMs,
    routedTo: outcome.routedTo,
    consecutiveFailures,
    tripBreaker,
  });

  if (tripBreaker) {
    await notifyCircuitBreaker(task, consecutiveFailures, outcome.reason);
  }

  return { result, routedTo: outcome.routedTo, reason: outcome.reason, durationMs, outputSummary };
}

async function notifyCircuitBreaker(
  task: ScheduledTask,
  consecutiveFailures: number,
  lastReason: string | undefined,
): Promise<void> {
  logger.warn("scheduled_task.circuit_breaker_tripped", "scheduled-task-runner", {
    taskId: task.id,
    consecutiveFailures,
    lastReason,
  });

  // Notify via the task's own destination so the operator sees the
  // auto-disable on the same surface they normally watch.
  //   - teams-channel: post directly via Graph
  //   - tool: dispatch via the same routing tool (send_teams_message
  //     / send_email) the task uses on a successful run, but with
  //     status=failure and a clear breaker body. This won't help if
  //     the Logic App is itself the failing dependency, but neither
  //     does the teams-channel path when Graph is the failing
  //     dependency — symmetric trade-off. See ultra-review F6.
  //   - cosmos-log / email: no external channel to post to today;
  //     operator must watch run history.
  if (
    task.routing.destination === "teams-channel" &&
    task.routing.teamsTeamId &&
    task.routing.teamsChannelId
  ) {
    try {
      await postToChannel({
        teamId: task.routing.teamsTeamId,
        channelId: task.routing.teamsChannelId,
        text: `**Scheduled task auto-disabled**\n\nTask "${task.name}" has been disabled after ${consecutiveFailures} consecutive failures. Last error: ${lastReason ?? "unknown"}.`,
      });
    } catch (err) {
      logger.warn("scheduled_task.circuit_breaker_notify_failed", "scheduled-task-runner", {
        taskId: task.id,
        errorMessage: (err as Error).message,
      });
    }
  } else if (task.routing.destination === "tool" && task.routing.toolName) {
    try {
      // Title is just task.name so it can't exceed the 200-char cap
      // enforced by the notification executor. The "auto-disabled"
      // framing lives in the body where length is permissive.
      await dispatchRoutingTool(task, {
        title: task.name,
        status: "failure",
        body: `Scheduled task auto-disabled.\n\nTask "${task.name}" has been disabled after ${consecutiveFailures} consecutive failures. Last error: ${lastReason ?? "unknown"}.`,
      });
    } catch (err) {
      logger.warn("scheduled_task.circuit_breaker_notify_failed", "scheduled-task-runner", {
        taskId: task.id,
        errorMessage: (err as Error).message,
      });
    }
  }
}
