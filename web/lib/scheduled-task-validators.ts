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

import {
  MAX_DURATION_SECONDS_CAP,
  type ScheduledTaskDestination,
} from "./scheduled-task-types";

export const VALID_DESTINATIONS: readonly ScheduledTaskDestination[] = [
  "teams-channel",
  "cosmos-log",
  "email",
];

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
