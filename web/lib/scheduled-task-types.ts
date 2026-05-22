// ─────────────────────────────────────────────────────────────
//  Scheduled-task types
//
//  One document per task in the Cosmos `scheduledTasks` container.
//  Partition key is `/id`. Run history is embedded and capped at
//  RUN_HISTORY_MAX (older entries roll off into the audit log).
// ─────────────────────────────────────────────────────────────

export const RUN_HISTORY_MAX = 50;
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
export const DEFAULT_POLL_INTERVAL_SECONDS = 120;
export const DEFAULT_POLL_LIMIT = 10;
export const MAX_DURATION_SECONDS_CAP = 600;

export type ScheduledTaskStatus = "idle" | "running" | "failed";
export type ScheduledTaskRunResult = "success" | "failure" | "timeout";
export type ScheduledTaskDestination = "teams-channel" | "cosmos-log" | "email" | "tool";

export interface ScheduledTaskSchedule {
  cronExpression: string;
  timezone: string;
}

export interface ScheduledTaskTask {
  promptTemplate: string;
  variables?: Record<string, string | number | boolean>;
  allowedTools: string[];
  maxDurationSeconds: number;
  skillSlug?: string;
}

export interface ScheduledTaskRouting {
  destination: ScheduledTaskDestination;
  teamsTeamId?: string;
  teamsChannelId?: string;
  emailTo?: string;
  // Name of the Neo tool to invoke when destination === "tool".
  // The routing layer auto-populates the tool's args from task context
  // ({ title: task.name, status: "success", body: <summarised output> }),
  // so there is no per-task toolArgs field. Allowlist + non-destructive
  // checks live in scheduled-task-validators.ts (ROUTING_ALLOWED_TOOLS).
  toolName?: string;
  fallbackDestination?: ScheduledTaskDestination;
}

export interface ScheduledTaskAuth {
  executionIdentity: "managed-identity";
  scopedPermissions: string[];
  keyVaultSecretRefs?: string[];
}

export interface ScheduledTaskState {
  status: ScheduledTaskStatus;
  nextRunTime: string;
  lastRunTime?: string;
  lastRunResult?: ScheduledTaskRunResult;
  lastRunDurationMs?: number;
  consecutiveFailures: number;
}

export interface ScheduledTaskRunHistoryEntry {
  runId: string;
  startTime: string;
  endTime: string;
  result: ScheduledTaskRunResult;
  outputSummary: string;
  routedTo: string;
  reason?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  // Internal owner identifier. For Entra ID users (browser session,
  // CLI PKCE, bearer token) this is the AAD object ID (a GUID), not
  // an email. For API-key callers, this is the key label. Use
  // `createdByEmail` (below) when you need an email/UPN.
  createdBy: string;
  // Entra UPN / email of the creator, captured at task-create time
  // from identity.email. Optional because:
  //   (a) legacy tasks created before this field was introduced
  //       won't have it.
  //   (b) API-key and service-principal callers may not have an
  //       email-shaped identity.
  // The routing layer populates LogIdentityContext.userEmail from
  // this field so audit attribution carries an email when one is
  // available, never the bare GUID. See ultra-review F7.
  createdByEmail?: string;
  enabled: boolean;
  dryRun: boolean;
  circuitBreakerThreshold?: number;
  schedule: ScheduledTaskSchedule;
  task: ScheduledTaskTask;
  routing: ScheduledTaskRouting;
  auth: ScheduledTaskAuth;
  state: ScheduledTaskState;
  runHistory: ScheduledTaskRunHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  _etag?: string;
}

export interface CreateScheduledTaskInput {
  name: string;
  description: string;
  enabled?: boolean;
  dryRun?: boolean;
  circuitBreakerThreshold?: number;
  schedule: ScheduledTaskSchedule;
  task: ScheduledTaskTask;
  routing: ScheduledTaskRouting;
  auth?: Partial<ScheduledTaskAuth>;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  dryRun?: boolean;
  circuitBreakerThreshold?: number;
  schedule?: ScheduledTaskSchedule;
  task?: ScheduledTaskTask;
  routing?: ScheduledTaskRouting;
  auth?: Partial<ScheduledTaskAuth>;
  expectedEtag: string;
}

export class ScheduledTaskClaimConflict extends Error {
  constructor(public readonly taskId: string) {
    super(`Scheduled task ${taskId} was claimed by another worker`);
    this.name = "ScheduledTaskClaimConflict";
  }
}

export class ScheduledTaskNotFound extends Error {
  constructor(public readonly taskId: string) {
    super(`Scheduled task ${taskId} not found`);
    this.name = "ScheduledTaskNotFound";
  }
}
