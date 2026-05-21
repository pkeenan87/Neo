import { NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { claimTask, findDueTasks } from "@/lib/scheduled-task-store";
import { executeTask } from "@/lib/scheduled-task-runner";
import { verifyInternalPollRequest } from "@/lib/scheduled-task-internal-auth";
import {
  DEFAULT_POLL_LIMIT,
  ScheduledTaskClaimConflict,
} from "@/lib/scheduled-task-types";

/**
 * Invoked only by the scheduledTaskPoller Azure Function. Caller is
 * authenticated via its system-assigned Managed Identity bearer token.
 *
 * Performs one polling pass: query for due tasks, claim each, execute
 * sequentially. Returns a summary so the Function can log to App
 * Insights.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const authResult = await verifyInternalPollRequest(authHeader);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.reason ?? "unauthorized" },
      { status: authResult.status ?? 401 },
    );
  }

  const startedAt = new Date().toISOString();
  const limit = Number(process.env.SCHEDULED_TASK_POLL_LIMIT ?? DEFAULT_POLL_LIMIT) || DEFAULT_POLL_LIMIT;
  const due = await findDueTasks(startedAt, limit);

  let claimedCount = 0;
  let executedCount = 0;
  const results: Array<{ taskId: string; result?: string; reason?: string; durationMs?: number }> = [];

  for (const task of due) {
    let claimed;
    try {
      claimed = await claimTask(task);
    } catch (err) {
      if (err instanceof ScheduledTaskClaimConflict) {
        results.push({ taskId: task.id, result: "skipped_claim_conflict" });
        continue;
      }
      logger.warn("scheduled_task.poll_claim_error", "scheduled-tasks-poll", {
        taskId: task.id,
        errorMessage: (err as Error).message,
      });
      results.push({ taskId: task.id, result: "claim_error", reason: (err as Error).message });
      continue;
    }
    claimedCount += 1;

    try {
      const outcome = await executeTask(claimed);
      executedCount += 1;
      results.push({
        taskId: task.id,
        result: outcome.result,
        reason: outcome.reason,
        durationMs: outcome.durationMs,
      });
    } catch (err) {
      logger.warn("scheduled_task.poll_execute_error", "scheduled-tasks-poll", {
        taskId: task.id,
        errorMessage: (err as Error).message,
      });
      results.push({ taskId: task.id, result: "execute_error", reason: (err as Error).message });
    }
  }

  logger.info("scheduled_task.poll_cycle", "scheduled-tasks-poll", {
    startedAt,
    scanned: due.length,
    claimed: claimedCount,
    executed: executedCount,
  });

  return NextResponse.json({
    startedAt,
    scanned: due.length,
    claimed: claimedCount,
    executed: executedCount,
    results,
  });
}
