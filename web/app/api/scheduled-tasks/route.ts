import { NextRequest, NextResponse } from "next/server";

import { resolveAuth } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { validateCronExpression, CronValidationError } from "@/lib/cron-helpers";
import { createTask, listTasks } from "@/lib/scheduled-task-store";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskDestination,
} from "@/lib/scheduled-task-types";
import {
  validateAuthShape,
  validateCircuitBreakerThreshold,
  validateRoutingShape,
  validateScheduleShape,
  validateTaskShape,
} from "@/lib/scheduled-task-validators";

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function validateCreatePayload(body: unknown): CreateScheduledTaskInput | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || !b.name.trim()) return "name is required";
  if (typeof b.description !== "string") return "description is required";

  const scheduleErr = validateScheduleShape(b.schedule);
  if (scheduleErr) return scheduleErr;

  const taskErr = validateTaskShape(b.task);
  if (taskErr) return taskErr;

  const routingErr = validateRoutingShape(b.routing);
  if (routingErr) return routingErr;

  const authErr = validateAuthShape(b.auth);
  if (authErr) return authErr;

  const thresholdErr = validateCircuitBreakerThreshold(b.circuitBreakerThreshold);
  if (thresholdErr) return thresholdErr;

  const schedule = b.schedule as Record<string, unknown>;
  const task = b.task as Record<string, unknown>;
  const routing = b.routing as Record<string, unknown>;

  return {
    name: b.name.trim(),
    description: b.description,
    enabled: b.enabled === true,
    dryRun: b.dryRun === true,
    circuitBreakerThreshold:
      typeof b.circuitBreakerThreshold === "number" ? b.circuitBreakerThreshold : undefined,
    schedule: {
      cronExpression: schedule.cronExpression as string,
      timezone: schedule.timezone as string,
    },
    task: {
      promptTemplate: task.promptTemplate as string,
      variables: (task.variables as Record<string, string | number | boolean>) ?? undefined,
      allowedTools: task.allowedTools as string[],
      maxDurationSeconds: task.maxDurationSeconds as number,
      skillSlug: typeof task.skillSlug === "string" ? task.skillSlug : undefined,
    },
    routing: {
      destination: routing.destination as ScheduledTaskDestination,
      teamsTeamId: routing.teamsTeamId as string | undefined,
      teamsChannelId: routing.teamsChannelId as string | undefined,
      emailTo: routing.emailTo as string | undefined,
      fallbackDestination: routing.fallbackDestination as ScheduledTaskDestination | undefined,
    },
    auth: (b.auth as { scopedPermissions?: string[]; keyVaultSecretRefs?: string[] }) ?? undefined,
  };
}

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const tasks = await listTasks();
  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  const parsed = validateCreatePayload(body);
  if (typeof parsed === "string") return badRequest(parsed);

  try {
    validateCronExpression(parsed.schedule.cronExpression, parsed.schedule.timezone);
  } catch (err) {
    if (err instanceof CronValidationError) return badRequest(err.message);
    throw err;
  }

  const created = await createTask(parsed, identity.ownerId);
  logger.info("scheduled_task.created", "scheduled-tasks-api", {
    taskId: created.id,
    name: created.name,
    createdBy: identity.ownerId,
  });

  return NextResponse.json({ task: created }, { status: 201 });
}
