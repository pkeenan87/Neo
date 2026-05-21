// ─────────────────────────────────────────────────────────────
//  Scheduled-task output routing
//
//  Sends the agent loop's final text to the configured destination.
//  Falls back to routing.fallbackDestination on primary failure
//  (default cosmos-log). Dry-run bypasses the primary destination
//  entirely and records `routedTo: "dry-run-log"`.
// ─────────────────────────────────────────────────────────────

import { logger } from "./logger";
import { postToChannel } from "./teams-channel";
import type { ScheduledTask, ScheduledTaskDestination } from "./scheduled-task-types";

export interface RoutingOutcome {
  routedTo: string;
  success: boolean;
  reason?: string;
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
    default:
      throw new Error(`Unknown destination: ${destination}`);
  }
}

export async function routeOutput(
  task: ScheduledTask,
  outputText: string,
): Promise<RoutingOutcome> {
  if (task.dryRun) {
    logger.info("scheduled_task.dry_run_routed", "scheduled-task-routing", {
      taskId: task.id,
      destination: task.routing.destination,
      previewLength: outputText.length,
    });
    return { routedTo: "dry-run-log", success: true };
  }

  try {
    await sendTo(task.routing.destination, task, outputText);
    return { routedTo: task.routing.destination, success: true };
  } catch (primaryErr) {
    const primaryReason = (primaryErr as Error).message;
    logger.warn("scheduled_task.routing_primary_failed", "scheduled-task-routing", {
      taskId: task.id,
      destination: task.routing.destination,
      errorMessage: primaryReason,
    });

    const fallback = task.routing.fallbackDestination ?? "cosmos-log";
    if (fallback === task.routing.destination) {
      return { routedTo: task.routing.destination, success: false, reason: primaryReason };
    }

    try {
      await sendTo(fallback, task, outputText);
      return { routedTo: fallback, success: true, reason: `primary_failed: ${primaryReason}` };
    } catch (fallbackErr) {
      const fallbackReason = (fallbackErr as Error).message;
      logger.warn("scheduled_task.routing_fallback_failed", "scheduled-task-routing", {
        taskId: task.id,
        fallback,
        errorMessage: fallbackReason,
      });
      return {
        routedTo: fallback,
        success: false,
        reason: `primary_failed:${primaryReason}; fallback_failed:${fallbackReason}`,
      };
    }
  }
}
