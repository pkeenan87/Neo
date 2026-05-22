// ─────────────────────────────────────────────────────────────
//  Scheduled-task field validators
//
//  Shared by POST /api/scheduled-tasks (create) and PATCH
//  /api/scheduled-tasks/[id] (update). The PATCH route previously
//  cast the task/routing/auth fields through unchecked, letting
//  admins persist documents whose runtime invariants (allowedTools
//  is string[], maxDurationSeconds is positive and bounded,
//  teams-channel destinations carry team+channel IDs) didn't hold.
//  Centralising these here keeps the contract identical on
//  both write paths.
// ─────────────────────────────────────────────────────────────

import { DESTRUCTIVE_TOOLS } from "./tools";
import {
  MAX_DURATION_SECONDS_CAP,
  type ScheduledTaskDestination,
} from "./scheduled-task-types";

export const VALID_DESTINATIONS: readonly ScheduledTaskDestination[] = [
  "teams-channel",
  "cosmos-log",
  "email",
  "tool",
];

// Task name flows into the `title` field of the routing-path
// notification payload (which the Logic App caps at 200 chars and
// rejects control chars on). Even for non-`tool` destinations, control
// characters in the task name break audit-log readability and Teams
// card formatting downstream, so this cap is enforced unconditionally.
// Kept in sync with INFOSEC_NOTIFICATION_TITLE_MAX in executors.ts.
export const TASK_NAME_MAX = 200;
// ASCII control chars (0x00-0x1F, 0x7F) plus a small set of Unicode
// formatting attack chars: zero-width / formatting (U+200B-U+200D,
// U+FEFF), line/paragraph separators (U+2028-U+2029), and BiDi
// overrides (U+202A-U+202E, U+2066-U+2069). These don't belong in a
// task name and corrupt downstream rendering / audit lines.
const TASK_NAME_FORBIDDEN_CHARS_RE =
  /[\u0000-\u001F\u007F\u200B-\u200D\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

// Neo tools that are admissible as routing destinations. Adding a tool
// here is a deliberate code change — the routing layer dispatches these
// without an interactive confirmation gate, so the list MUST stay tight
// and non-destructive. The validator below also enforces
// !DESTRUCTIVE_TOOLS.has(name) as defence in depth.
export const ROUTING_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "send_teams_message",
  "send_email",
]);

export function validateTaskName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "name is required";
  }
  const trimmed = value.trim();
  if (trimmed.length > TASK_NAME_MAX) {
    return `name must be ${TASK_NAME_MAX} characters or fewer`;
  }
  if (TASK_NAME_FORBIDDEN_CHARS_RE.test(trimmed)) {
    return "name contains control or formatting characters that are not allowed";
  }
  return null;
}

export function validateScheduleShape(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return "schedule must be an object";
  }
  const s = value as Record<string, unknown>;
  if (typeof s.cronExpression !== "string" || !s.cronExpression.trim()) {
    return "schedule.cronExpression is required";
  }
  if (typeof s.timezone !== "string" || !s.timezone.trim()) {
    return "schedule.timezone is required";
  }
  return null;
}

export function validateTaskShape(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return "task must be an object";
  }
  const t = value as Record<string, unknown>;
  if (typeof t.promptTemplate !== "string") {
    return "task.promptTemplate must be a string";
  }
  if (!Array.isArray(t.allowedTools)) {
    return "task.allowedTools must be a string array";
  }
  for (const tool of t.allowedTools) {
    if (typeof tool !== "string") return "task.allowedTools must be string[]";
  }
  if (typeof t.maxDurationSeconds !== "number" || t.maxDurationSeconds <= 0) {
    return "task.maxDurationSeconds must be a positive number";
  }
  if (t.maxDurationSeconds > MAX_DURATION_SECONDS_CAP) {
    return `task.maxDurationSeconds cannot exceed ${MAX_DURATION_SECONDS_CAP}`;
  }
  if (t.variables !== undefined) {
    if (typeof t.variables !== "object" || t.variables === null || Array.isArray(t.variables)) {
      return "task.variables must be an object";
    }
  }
  if (t.skillSlug !== undefined && typeof t.skillSlug !== "string") {
    return "task.skillSlug must be a string when provided";
  }
  return null;
}

function validateTeamsRoutingIds(routing: Record<string, unknown>, prefix: string): string | null {
  if (typeof routing.teamsTeamId !== "string" || !routing.teamsTeamId.trim()) {
    return `${prefix} requires teamsTeamId`;
  }
  if (typeof routing.teamsChannelId !== "string" || !routing.teamsChannelId.trim()) {
    return `${prefix} requires teamsChannelId`;
  }
  return null;
}

function validateToolRouting(routing: Record<string, unknown>, prefix: string): string | null {
  const toolName = routing.toolName;
  if (typeof toolName !== "string" || !toolName.trim()) {
    return `${prefix} requires toolName`;
  }
  if (!ROUTING_ALLOWED_TOOLS.has(toolName)) {
    const allowed = Array.from(ROUTING_ALLOWED_TOOLS).join(", ");
    return `${prefix} toolName "${toolName}" is not in ROUTING_ALLOWED_TOOLS (allowed: ${allowed})`;
  }
  // Defence in depth: even if a future change added a destructive tool
  // to ROUTING_ALLOWED_TOOLS by mistake, refuse to persist it.
  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    return `${prefix} toolName "${toolName}" is destructive and cannot be used as a routing destination`;
  }
  return null;
}

export function validateRoutingShape(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return "routing must be an object";
  }
  const r = value as Record<string, unknown>;
  if (typeof r.destination !== "string") {
    return "routing.destination is required";
  }
  if (!VALID_DESTINATIONS.includes(r.destination as ScheduledTaskDestination)) {
    return `routing.destination must be one of: ${VALID_DESTINATIONS.join(", ")}`;
  }
  if (r.destination === "teams-channel") {
    const err = validateTeamsRoutingIds(r, "teams-channel destination");
    if (err) return err;
  }
  if (r.destination === "tool") {
    const err = validateToolRouting(r, "tool destination");
    if (err) return err;
  }
  if (r.fallbackDestination !== undefined) {
    if (typeof r.fallbackDestination !== "string") {
      return "routing.fallbackDestination must be a string when provided";
    }
    if (!VALID_DESTINATIONS.includes(r.fallbackDestination as ScheduledTaskDestination)) {
      return `routing.fallbackDestination must be one of: ${VALID_DESTINATIONS.join(", ")}`;
    }
    if (r.fallbackDestination === "teams-channel") {
      const err = validateTeamsRoutingIds(r, "teams-channel fallback");
      if (err) return err;
    }
    // "tool" as a fallback would invite recursion (tool fails → fall
    // back to another tool fails → …). The fallback path is meant for
    // simple, low-dependency sinks — keep it that way.
    if (r.fallbackDestination === "tool") {
      return "routing.fallbackDestination cannot be \"tool\" — use cosmos-log as the fallback instead";
    }
  }
  return null;
}

export function validateAuthShape(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") {
    return "auth must be an object";
  }
  const a = value as Record<string, unknown>;
  if (a.scopedPermissions !== undefined) {
    if (!Array.isArray(a.scopedPermissions)) {
      return "auth.scopedPermissions must be a string array";
    }
    for (const p of a.scopedPermissions) {
      if (typeof p !== "string") return "auth.scopedPermissions must be string[]";
    }
  }
  if (a.keyVaultSecretRefs !== undefined) {
    if (!Array.isArray(a.keyVaultSecretRefs)) {
      return "auth.keyVaultSecretRefs must be a string array";
    }
    for (const r of a.keyVaultSecretRefs) {
      if (typeof r !== "string") return "auth.keyVaultSecretRefs must be string[]";
    }
  }
  return null;
}

export function validateCircuitBreakerThreshold(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "circuitBreakerThreshold must be a finite number";
  }
  if (value < 1) {
    return "circuitBreakerThreshold must be >= 1";
  }
  return null;
}
