import { NextRequest, NextResponse } from "next/server";

import { resolveAuth } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { claimTask, getTask } from "@/lib/scheduled-task-store";
import { executeTask } from "@/lib/scheduled-task-runner";
import { ScheduledTaskClaimConflict } from "@/lib/scheduled-task-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Out-of-band "Run now" trigger. Claims the task via the same etag
 * path the poller uses so it can't run concurrently with a scheduled
 * fire. Returns 202 immediately and runs the agent loop in the
 * background — the response includes the runId so the UI can poll
 * /runs for the result.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });

  let claimed;
  try {
    claimed = await claimTask(task);
  } catch (err) {
    if (err instanceof ScheduledTaskClaimConflict) {
      return NextResponse.json(
        { error: "Task is already running or was just claimed by the poller" },
        { status: 409 },
      );
    }
    throw err;
  }

  logger.info("scheduled_task.run_triggered", "scheduled-tasks-api", {
    taskId: id,
    triggeredBy: identity.ownerId,
    mode: "out-of-band",
  });

  // Fire-and-forget execution. We don't await — the caller gets a 202
  // and can poll /runs for the result.
  void executeTask(claimed).catch((err) => {
    logger.warn("scheduled_task.run_now_failed", "scheduled-tasks-api", {
      taskId: id,
      errorMessage: (err as Error).message,
    });
  });

  return NextResponse.json({ accepted: true, taskId: id }, { status: 202 });
}
