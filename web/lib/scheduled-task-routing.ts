// ─────────────────────────────────────────────────────────────
//  Scheduled-task output routing
//
//  Sends the agent loop's final text to the configured destination.
//  Falls back to routing.fallbackDestination on primary failure
//  (default cosmos-log). Dry-run bypasses the primary destination
//  entirely and records `routedTo: "dry-run-log"`.
// ─────────────────────────────────────────────────────────────

import { extractToolAuditExtras } from "./agent";
import { executeTool } from "./executors";
import { getToolIntegration } from "./integration-registry";
import { hashPii, logger, setLogContext } from "./logger";
import { ROUTING_ALLOWED_TOOLS } from "./scheduled-task-validators";
import { summarize } from "./scheduled-task-summary";
import { postToChannel } from "./teams-channel";
import { DESTRUCTIVE_TOOLS } from "./tools";
import type { ScheduledTask, ScheduledTaskDestination } from "./scheduled-task-types";
import type { LogIdentityContext } from "./types";

// Lightweight email-shape check. Used to gate setting `userEmail` in
// the routing log-context envelope — task.createdBy is the AAD object
// ID (a GUID) for browser-session admins, not an email. See
// ultra-review F7.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RoutingOutcome {
  routedTo: string;
  success: boolean;
  reason?: string;
}

/**
 * Dispatch the task's configured routing tool with arbitrary
 * notification args. Handles allowlist validation, destructive-tool
 * defence in depth, log-context establishment for audit attribution,
 * and `tool_execution` event emission on both success and error.
 *
 * Exported so non-routing callers (e.g. notifyCircuitBreaker in the
 * runner) can reuse the same dispatch + audit machinery without
 * duplicating logic. The caller is responsible for building the args
 * that match the tool's schema.
 */
export async function dispatchRoutingTool(
  task: ScheduledTask,
  args: { title: string; status: string; body: string },
): Promise<void> {
  const toolName = task.routing.toolName;
  if (!toolName) {
    // Validator should have caught this at write time — defence in depth.
    throw new Error("tool destination requires toolName");
  }
  // Allowlist may have shrunk since the task was persisted, or the
  // operator hand-edited the document. Re-check on every dispatch.
  if (!ROUTING_ALLOWED_TOOLS.has(toolName)) {
    throw new Error(
      `tool destination toolName "${toolName}" is not in ROUTING_ALLOWED_TOOLS`,
    );
  }
  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    throw new Error(
      `tool destination toolName "${toolName}" is destructive and cannot be used as a routing destination`,
    );
  }

  // Establish a log-context envelope so any logs emitted by the
  // executor + the `tool_execution` audit event below carry the task
  // creator's identity. Without this the dispatch would run with
  // whatever ambient context the runner inherited (typically none,
  // since executeTask is invoked from the poller without a request
  // envelope).
  //
  // userEmail: only set if createdByEmail is email-shaped. Browser
  // sessions persist `createdBy = AAD object ID` (a GUID), which is
  // NOT a valid email — writing it into userEmail would corrupt
  // downstream audit consumers and break any future routing tool
  // that reads `responder` from log context. See ultra-review F7.
  const email = pickEmailIdentity(task);
  const logIdentity: LogIdentityContext = {
    userName: task.createdByEmail ?? task.createdBy,
    userIdHash: hashPii(task.createdBy),
    role: "admin",
    provider: "service-principal",
    channel: "scheduled-task",
    sessionId: `schedtask-${task.id}-routing`,
    ...(email ? { userEmail: email } : {}),
  };

  // Audit emission: the agent loop is the only producer of
  // `tool_execution` for the chat path. The routing layer is now a
  // second producer — without this emit, every scheduled-task
  // notification dispatch would silently bypass the audit pipeline
  // even though SIEM consumers key off tool_execution. Mirror the
  // shape used in agent.ts (lines 1004–1014 and 1346–1356). See
  // ultra-review F1.
  await setLogContext(logIdentity, async () => {
    const toolStart = Date.now();
    try {
      const result = await executeTool(toolName, args, { role: "admin" });
      logger.emitEvent("tool_execution", `Tool completed: ${toolName}`, "scheduled-task-routing", {
        toolName,
        toolCategory: getToolIntegration(toolName) ?? undefined,
        isDestructive: false,
        durationMs: Date.now() - toolStart,
        status: "success",
        ...extractToolAuditExtras(result),
      });
    } catch (err) {
      logger.emitEvent("tool_execution", `Tool failed: ${toolName}`, "scheduled-task-routing", {
        toolName,
        toolCategory: getToolIntegration(toolName) ?? undefined,
        isDestructive: false,
        durationMs: Date.now() - toolStart,
        status: "error",
        errorMessage: (err as Error).message?.slice(0, 500),
      });
      throw err;
    }
  });
}

async function dispatchToolDestination(
  task: ScheduledTask,
  outputText: string,
): Promise<void> {
  // Build the args from task context. The Neo-side tool schema uses
  // title/status/body; the executor maps to the Logic App's
  // taskName/status/summary. `status` is hardcoded "success" because
  // routeOutput is only reached on agent-loop success today —
  // failure-path notifications are intentionally out of scope.
  //
  // Sentinel body: when the agent produces no narrative text (only
  // tool_use blocks at end_turn, or whitespace), summarize().trim()
  // yields "" and validateNotificationInput would reject it as
  // missing — silently dead-lettering the run via the fallback even
  // though the agent itself succeeded. Substitute a placeholder so
  // the notification still fires and operators see *something*. See
  // ultra-review F5.
  const summarised = summarize(outputText).trim();
  await dispatchRoutingTool(task, {
    title: task.name,
    status: "success",
    body: summarised || "(no narrative output produced by scheduled task run)",
  });
}

function pickEmailIdentity(task: ScheduledTask): string | undefined {
  const candidate = task.createdByEmail ?? task.createdBy;
  if (candidate && EMAIL_SHAPE_RE.test(candidate)) return candidate;
  return undefined;
}

async function sendTo(
  destination: ScheduledTaskDestination,
  task: ScheduledTask,
  outputText: string,
): Promise<void> {
  switch (destination) {
    case "teams-channel": {
      if (!task.routing.teamsTeamId || !task.routing.teamsChannelId) {
        throw new Error("teams-channel destination requires teamsTeamId and teamsChannelId");
      }
      await postToChannel({
        teamId: task.routing.teamsTeamId,
        channelId: task.routing.teamsChannelId,
        text: `**${task.name}**\n\n${outputText}`,
      });
      return;
    }
    case "cosmos-log":
      // No external send — the run-history entry IS the log.
      return;
    case "email":
      // Phase 2 — not yet implemented.
      throw new Error("email_routing_not_yet_implemented");
    case "tool":
      await dispatchToolDestination(task, outputText);
      return;
    default:
      throw new Error(`Unknown destination: ${destination}`);
  }
}

function describeDestination(task: ScheduledTask, destination: ScheduledTaskDestination): string {
  // For "tool" we surface the specific tool name in routedTo / logs so
  // the UI and audit don't all collapse to the bare "tool" string.
  if (destination === "tool" && task.routing.toolName) {
    return task.routing.toolName;
  }
  return destination;
}

export async function routeOutput(
  task: ScheduledTask,
  outputText: string,
): Promise<RoutingOutcome> {
  if (task.dryRun) {
    const summary = task.routing.destination === "tool" ? summarize(outputText) : outputText;
    logger.info("scheduled_task.dry_run_routed", "scheduled-task-routing", {
      taskId: task.id,
      destination: task.routing.destination,
      toolName: task.routing.destination === "tool" ? task.routing.toolName : undefined,
      titleLength: task.routing.destination === "tool" ? task.name.length : undefined,
      bodyLength: task.routing.destination === "tool" ? summary.length : undefined,
      previewLength: outputText.length,
    });
    return { routedTo: "dry-run-log", success: true };
  }

  try {
    await sendTo(task.routing.destination, task, outputText);
    return { routedTo: describeDestination(task, task.routing.destination), success: true };
  } catch (primaryErr) {
    const primaryReason = (primaryErr as Error).message;
    logger.warn("scheduled_task.routing_primary_failed", "scheduled-task-routing", {
      taskId: task.id,
      destination: task.routing.destination,
      toolName: task.routing.destination === "tool" ? task.routing.toolName : undefined,
      errorMessage: primaryReason,
    });

    const fallback = task.routing.fallbackDestination ?? "cosmos-log";
    if (fallback === task.routing.destination) {
      return {
        routedTo: describeDestination(task, task.routing.destination),
        success: false,
        reason: primaryReason,
      };
    }

    try {
      await sendTo(fallback, task, outputText);
      return {
        routedTo: describeDestination(task, fallback),
        success: true,
        reason: `primary_failed: ${primaryReason}`,
      };
    } catch (fallbackErr) {
      const fallbackReason = (fallbackErr as Error).message;
      logger.warn("scheduled_task.routing_fallback_failed", "scheduled-task-routing", {
        taskId: task.id,
        fallback,
        errorMessage: fallbackReason,
      });
      return {
        routedTo: describeDestination(task, fallback),
        success: false,
        reason: `primary_failed:${primaryReason}; fallback_failed:${fallbackReason}`,
      };
    }
  }
}
