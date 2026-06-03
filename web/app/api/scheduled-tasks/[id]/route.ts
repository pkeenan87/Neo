import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { resolveAuth } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { validateCronExpression, CronValidationError } from "@/lib/cron-helpers";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import {
  deleteTask,
  getTask,
  patchTask,
} from "@/lib/scheduled-task-store";
import {
  ScheduledTaskClaimConflict,
  ScheduledTaskNotFound,
  type UpdateScheduledTaskInput,
} from "@/lib/scheduled-task-types";
import {
  validateAuthShape,
  validateCircuitBreakerThreshold,
  validateRoutingShape,
  validateScheduleShape,
  validateTaskName,
  validateTaskShape,
} from "@/lib/scheduled-task-validators";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function validatePatchPayload(body: unknown): UpdateScheduledTaskInput | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (typeof b.expectedEtag !== "string" || !b.expectedEtag) {
    return "expectedEtag is required";
  }

  const out: UpdateScheduledTaskInput = { expectedEtag: b.expectedEtag };

  if (b.name !== undefined) {
    const nameErr = validateTaskName(b.name);
    if (nameErr) return nameErr;
    out.name = (b.name as string).trim();
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") return "description must be a string";
    out.description = b.description;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return "enabled must be a boolean";
    out.enabled = b.enabled;
  }
  if (b.dryRun !== undefined) {
    if (typeof b.dryRun !== "boolean") return "dryRun must be a boolean";
    out.dryRun = b.dryRun;
  }
  if (b.circuitBreakerThreshold !== undefined) {
    const err = validateCircuitBreakerThreshold(b.circuitBreakerThreshold);
    if (err) return err;
    out.circuitBreakerThreshold = b.circuitBreakerThreshold as number;
  }
  if (b.schedule !== undefined) {
    const err = validateScheduleShape(b.schedule);
    if (err) return err;
    const s = b.schedule as Record<string, unknown>;
    out.schedule = { cronExpression: s.cronExpression as string, timezone: s.timezone as string };
  }
  if (b.task !== undefined) {
    const err = validateTaskShape(b.task);
    if (err) return err;
    out.task = b.task as UpdateScheduledTaskInput["task"];
  }
  if (b.routing !== undefined) {
    const err = validateRoutingShape(b.routing);
    if (err) return err;
    out.routing = b.routing as UpdateScheduledTaskInput["routing"];
  }
  if (b.auth !== undefined) {
    const err = validateAuthShape(b.auth);
    if (err) return err;
    out.auth = b.auth as UpdateScheduledTaskInput["auth"];
  }

  return out;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });

  return NextResponse.json({ task });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  const parsed = validatePatchPayload(body);
  if (typeof parsed === "string") return badRequest(parsed);

  // Injection guard on any new promptTemplate / description text —
  // matches the POST path. Skip when the patch doesn't touch the
  // text fields so a routine enabled/disabled toggle isn't scanned.
  if (parsed.task?.promptTemplate || parsed.description) {
    const scanTarget = `${parsed.task?.promptTemplate ?? ""}\n\n${parsed.description ?? ""}`;
    const scan = scanUserInput(scanTarget, {
      sessionId: "scheduled-task-write",
      userId: identity.ownerId,
      role: identity.role,
    });
    if (shouldBlock(scan)) {
      return NextResponse.json(
        {
          error:
            "Scheduled-task prompt tripped the injection guard. Rephrase the prompt template and retry.",
        },
        { status: 400 },
      );
    }
  }

  if (parsed.schedule) {
    try {
      validateCronExpression(parsed.schedule.cronExpression, parsed.schedule.timezone);
    } catch (err) {
      if (err instanceof CronValidationError) return badRequest(err.message);
      throw err;
    }
  }

  // Snapshot the prior task so the audit log can record a content-
  // sensitive diff (changed-field names + sha256(promptTemplate)
  // before/after). Without this, governance can't reconstruct which
  // admin changed which high-blast-radius field — pre-fix the log
  // captured only { taskId, updatedBy }.
  const prior = await getTask(id);
  const priorPromptHash = prior
    ? createHash("sha256").update(prior.task.promptTemplate).digest("hex")
    : undefined;

  try {
    const updated = await patchTask(id, parsed);
    const updatedPromptHash = createHash("sha256")
      .update(updated.task.promptTemplate)
      .digest("hex");
    // Compute the set of top-level fields the admin actually
    // requested to change. Comparing against `prior` would be more
    // precise but the validator already drops fields the admin
    // didn't send; the keys of `parsed` reflect intent.
    const changedFields = Object.keys(parsed).filter((k) => k !== "expectedEtag");
    logger.info("scheduled_task.updated", "scheduled-tasks-api", {
      taskId: id,
      updatedBy: identity.ownerId,
      changedFields,
      promptHashChanged: priorPromptHash !== updatedPromptHash,
      priorPromptHash,
      newPromptHash: updatedPromptHash,
    });
    return NextResponse.json({ task: updated });
  } catch (err) {
    if (err instanceof ScheduledTaskNotFound) {
      return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
    }
    if (err instanceof ScheduledTaskClaimConflict) {
      return NextResponse.json({ error: "etag conflict — refetch and retry" }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;
  try {
    await deleteTask(id);
    logger.info("scheduled_task.deleted", "scheduled-tasks-api", {
      taskId: id,
      deletedBy: identity.ownerId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ScheduledTaskNotFound) {
      return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });
    }
    throw err;
  }
}
