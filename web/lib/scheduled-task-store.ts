// ─────────────────────────────────────────────────────────────
//  Scheduled-task Cosmos store
//
//  Lazy-initializes the `scheduledTasks` container the same way
//  triage-store.ts does. All writes that move the document forward
//  (claim, recordRunResult, patch) use etag-conditional IfMatch
//  so concurrent Function pollers can't double-fire the same task.
// ─────────────────────────────────────────────────────────────

import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";

import { env } from "./config";
import { logger } from "./logger";
import { computeNextRunTime } from "./cron-helpers";
import {
  MAX_DURATION_SECONDS_CAP,
  RUN_HISTORY_MAX,
  ScheduledTaskClaimConflict,
  ScheduledTaskNotFound,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskRunHistoryEntry,
  type ScheduledTaskState,
  type UpdateScheduledTaskInput,
} from "./scheduled-task-types";

// A task is considered "stuck running" if its status has been 'running'
// for longer than 2× the max possible run duration. The watchdog path
// in findDueTasks resurfaces such tasks so they can be re-claimed.
const STUCK_RUNNING_CUTOFF_MS = MAX_DURATION_SECONDS_CAP * 2 * 1000;

const RECORD_RUN_RESULT_MAX_RETRIES = 3;

// ── Lazy-singleton Cosmos container ──────────────────────────

let _container: Container | null = null;

function getContainer(): Container | null {
  if (_container) return _container;
  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint) return null;
  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database("neo-db").container("scheduledTasks");
  return _container;
}

// ── Create ───────────────────────────────────────────────────

export async function createTask(
  input: CreateScheduledTaskInput,
  createdBy: string,
  createdByEmail?: string,
): Promise<ScheduledTask> {
  const container = getContainer();
  if (!container) {
    throw new Error("Scheduled task store not configured — COSMOS_ENDPOINT is unset");
  }

  const nowIso = new Date().toISOString();
  const nextRunTime = computeNextRunTime(
    input.schedule.cronExpression,
    input.schedule.timezone,
    nowIso,
  );

  const task: ScheduledTask = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    createdBy,
    createdByEmail,
    enabled: input.enabled ?? false,
    dryRun: input.dryRun ?? false,
    circuitBreakerThreshold: input.circuitBreakerThreshold,
    schedule: input.schedule,
    task: input.task,
    routing: input.routing,
    auth: {
      executionIdentity: "managed-identity",
      scopedPermissions: input.auth?.scopedPermissions ?? [],
      keyVaultSecretRefs: input.auth?.keyVaultSecretRefs,
    },
    state: {
      status: "idle",
      nextRunTime,
      consecutiveFailures: 0,
    },
    runHistory: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const { resource } = await container.items.create(task);
  return (resource ?? task) as ScheduledTask;
}

// ── Read ─────────────────────────────────────────────────────

export async function listTasks(): Promise<ScheduledTask[]> {
  const container = getContainer();
  if (!container) return [];
  const { resources } = await container.items
    .query<ScheduledTask>("SELECT * FROM c ORDER BY c.createdAt DESC")
    .fetchAll();
  return resources;
}

export async function getTask(id: string): Promise<ScheduledTask | null> {
  const container = getContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(id, id).read<ScheduledTask>();
    return resource ?? null;
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
    if (code === 404) return null;
    throw err;
  }
}

// ── Update (admin patch) ─────────────────────────────────────

export async function patchTask(
  id: string,
  patch: UpdateScheduledTaskInput,
): Promise<ScheduledTask> {
  const container = getContainer();
  if (!container) {
    throw new Error("Scheduled task store not configured");
  }

  const existing = await getTask(id);
  if (!existing) throw new ScheduledTaskNotFound(id);

  const { expectedEtag, ...changes } = patch;

  const next: ScheduledTask = {
    ...existing,
    ...changes,
    schedule: changes.schedule ?? existing.schedule,
    task: changes.task ?? existing.task,
    routing: changes.routing ?? existing.routing,
    auth: changes.auth
      ? { ...existing.auth, ...changes.auth, executionIdentity: "managed-identity" }
      : existing.auth,
    updatedAt: new Date().toISOString(),
  };

  // If the schedule changed, recompute nextRunTime from now.
  if (changes.schedule) {
    next.state = {
      ...existing.state,
      nextRunTime: computeNextRunTime(
        next.schedule.cronExpression,
        next.schedule.timezone,
        new Date().toISOString(),
      ),
    };
  }

  try {
    const { resource } = await container
      .item(id, id)
      .replace(next, { accessCondition: { type: "IfMatch", condition: expectedEtag } });
    return (resource ?? next) as ScheduledTask;
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
    if (code === 412) throw new ScheduledTaskClaimConflict(id);
    throw err;
  }
}

// ── Delete ───────────────────────────────────────────────────

export async function deleteTask(id: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  try {
    await container.item(id, id).delete();
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
    if (code === 404) throw new ScheduledTaskNotFound(id);
    throw err;
  }
}

// ── Poll / claim / record ────────────────────────────────────

export async function findDueTasks(
  nowIso: string,
  limit: number,
): Promise<ScheduledTask[]> {
  const container = getContainer();
  if (!container) return [];
  const stuckCutoffIso = new Date(
    new Date(nowIso).getTime() - STUCK_RUNNING_CUTOFF_MS,
  ).toISOString();
  const { resources } = await container.items
    .query<ScheduledTask>({
      query: `
        SELECT TOP @limit *
        FROM c
        WHERE c.enabled = true
          AND (
            (c.state.nextRunTime <= @now AND c.state.status != 'running')
            OR
            (c.state.status = 'running'
              AND (NOT IS_DEFINED(c.state.lastRunTime) OR c.state.lastRunTime < @stuckCutoff))
          )
        ORDER BY c.state.nextRunTime ASC
      `,
      parameters: [
        { name: "@now", value: nowIso },
        { name: "@limit", value: limit },
        { name: "@stuckCutoff", value: stuckCutoffIso },
      ],
    })
    .fetchAll();
  return resources;
}

/**
 * Atomically flip a task to status=running via IfMatch on _etag.
 * Returns the updated task (with fresh etag). Throws
 * ScheduledTaskClaimConflict if another worker beat us to it.
 */
export async function claimTask(task: ScheduledTask): Promise<ScheduledTask> {
  const container = getContainer();
  if (!container) throw new Error("Scheduled task store not configured");
  if (!task._etag) {
    throw new Error(`claimTask called on task ${task.id} without an _etag — read from Cosmos before claiming`);
  }

  // Refuse to re-claim a task that is actively running. The watchdog path
  // (findDueTasks resurfaces a task whose lastRunTime is older than the
  // stuck cutoff) is the only legitimate way to re-claim a 'running' task —
  // we let that through. Without this guard, the "/run" route can read the
  // current etag of a task the poller just claimed and double-claim it,
  // producing two concurrent agent loops for the same task.
  if (task.state.status === "running") {
    const lastRunMs = task.state.lastRunTime
      ? new Date(task.state.lastRunTime).getTime()
      : 0;
    if (Date.now() - lastRunMs < STUCK_RUNNING_CUTOFF_MS) {
      throw new ScheduledTaskClaimConflict(task.id);
    }
  }

  const claimed: ScheduledTask = {
    ...task,
    state: {
      ...task.state,
      status: "running",
      lastRunTime: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    const { resource } = await container
      .item(task.id, task.id)
      .replace(claimed, { accessCondition: { type: "IfMatch", condition: task._etag } });
    return (resource ?? claimed) as ScheduledTask;
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
    if (code === 412) throw new ScheduledTaskClaimConflict(task.id);
    throw err;
  }
}

/**
 * Append a run-history entry (cap RUN_HISTORY_MAX) and write the new
 * state. Retries with a fresh etag on 412 (concurrent admin PATCH between
 * claim and finalize) so a transient conflict doesn't strand the task in
 * status='running' forever.
 */
export async function recordRunResult(
  task: ScheduledTask,
  runEntry: ScheduledTaskRunHistoryEntry,
  newState: ScheduledTaskState,
  newEnabled?: boolean,
): Promise<ScheduledTask> {
  const container = getContainer();
  if (!container) throw new Error("Scheduled task store not configured");
  if (!task._etag) {
    throw new Error(`recordRunResult called on task ${task.id} without an _etag — claimTask must precede this call`);
  }

  let current = task;
  for (let attempt = 0; attempt < RECORD_RUN_RESULT_MAX_RETRIES; attempt += 1) {
    if (!current._etag) {
      throw new Error(`recordRunResult retry on task ${current.id} read back without an _etag`);
    }

    const history = [...current.runHistory, runEntry];
    if (history.length > RUN_HISTORY_MAX) {
      history.splice(0, history.length - RUN_HISTORY_MAX);
    }

    const updated: ScheduledTask = {
      ...current,
      enabled: newEnabled ?? current.enabled,
      state: newState,
      runHistory: history,
      updatedAt: new Date().toISOString(),
    };

    try {
      const { resource } = await container
        .item(current.id, current.id)
        .replace(updated, { accessCondition: { type: "IfMatch", condition: current._etag } });
      return (resource ?? updated) as ScheduledTask;
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
      if (code !== 412) throw err;

      logger.warn(
        "recordRunResult etag conflict — re-reading and retrying",
        "scheduled-task-store",
        { taskId: current.id, attempt },
      );

      const fresh = await getTask(current.id);
      if (!fresh) throw new ScheduledTaskNotFound(current.id);
      current = fresh;
      // Loop and retry with fresh etag (and fresh runHistory baseline).
    }
  }

  // Exhausted retries — the document was being repeatedly mutated by another
  // writer. Surface this as an error rather than warn so observability pages.
  logger.error(
    "recordRunResult exhausted retries — task may be stuck in status='running'",
    "scheduled-task-store",
    { taskId: task.id, maxRetries: RECORD_RUN_RESULT_MAX_RETRIES },
  );
  throw new ScheduledTaskClaimConflict(task.id);
}
