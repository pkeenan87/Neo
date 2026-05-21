import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated validators from web/lib/scheduled-task-validators.ts ──
// These mirror the centralised validators that both POST and PATCH use.
// Replicating in-process keeps node:test free of the TS resolver.

const MAX_DURATION_SECONDS_CAP = 600;
const VALID_DESTINATIONS = ["teams-channel", "cosmos-log", "email"];

function validateScheduleShape(value) {
  if (!value || typeof value !== "object") return "schedule must be an object";
  const s = value;
  if (typeof s.cronExpression !== "string" || !s.cronExpression.trim()) {
    return "schedule.cronExpression is required";
  }
  if (typeof s.timezone !== "string" || !s.timezone.trim()) {
    return "schedule.timezone is required";
  }
  return null;
}

function validateTaskShape(value) {
  if (!value || typeof value !== "object") return "task must be an object";
  const t = value;
  if (typeof t.promptTemplate !== "string") return "task.promptTemplate must be a string";
  if (!Array.isArray(t.allowedTools)) return "task.allowedTools must be a string array";
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

function validateTeamsRoutingIds(routing, prefix) {
  if (typeof routing.teamsTeamId !== "string" || !routing.teamsTeamId.trim()) {
    return `${prefix} requires teamsTeamId`;
  }
  if (typeof routing.teamsChannelId !== "string" || !routing.teamsChannelId.trim()) {
    return `${prefix} requires teamsChannelId`;
  }
  return null;
}

function validateRoutingShape(value) {
  if (!value || typeof value !== "object") return "routing must be an object";
  const r = value;
  if (typeof r.destination !== "string") return "routing.destination is required";
  if (!VALID_DESTINATIONS.includes(r.destination)) {
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
    if (!VALID_DESTINATIONS.includes(r.fallbackDestination)) {
      return `routing.fallbackDestination must be one of: ${VALID_DESTINATIONS.join(", ")}`;
    }
    if (r.fallbackDestination === "teams-channel") {
      const err = validateTeamsRoutingIds(r, "teams-channel fallback");
      if (err) return err;
    }
  }
  return null;
}

function validateAuthShape(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") return "auth must be an object";
  const a = value;
  if (a.scopedPermissions !== undefined) {
    if (!Array.isArray(a.scopedPermissions)) return "auth.scopedPermissions must be a string array";
    for (const p of a.scopedPermissions) if (typeof p !== "string") return "auth.scopedPermissions must be string[]";
  }
  if (a.keyVaultSecretRefs !== undefined) {
    if (!Array.isArray(a.keyVaultSecretRefs)) return "auth.keyVaultSecretRefs must be a string array";
    for (const r of a.keyVaultSecretRefs) if (typeof r !== "string") return "auth.keyVaultSecretRefs must be string[]";
  }
  return null;
}

function validateCircuitBreakerThreshold(value) {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "circuitBreakerThreshold must be a finite number";
  }
  if (value < 1) return "circuitBreakerThreshold must be >= 1";
  return null;
}

// ── Tests ────────────────────────────────────────────────────

describe("validateTaskShape (H3)", () => {
  const valid = {
    promptTemplate: "Hello {{today}}",
    allowedTools: ["run_sentinel_kql"],
    maxDurationSeconds: 60,
  };

  it("accepts a well-formed task", () => {
    assert.equal(validateTaskShape(valid), null);
  });

  it("rejects allowedTools that is not an array", () => {
    assert.match(validateTaskShape({ ...valid, allowedTools: "oops" }), /string array/);
  });

  it("rejects allowedTools with non-string entries", () => {
    assert.match(validateTaskShape({ ...valid, allowedTools: ["ok", 123] }), /string\[\]/);
  });

  it("rejects maxDurationSeconds <= 0", () => {
    assert.match(validateTaskShape({ ...valid, maxDurationSeconds: 0 }), /positive number/);
    assert.match(validateTaskShape({ ...valid, maxDurationSeconds: -5 }), /positive number/);
  });

  it("rejects maxDurationSeconds > cap", () => {
    assert.match(validateTaskShape({ ...valid, maxDurationSeconds: MAX_DURATION_SECONDS_CAP + 1 }), /cannot exceed/);
  });

  it("rejects variables that is not an object", () => {
    assert.match(validateTaskShape({ ...valid, variables: "x" }), /must be an object/);
    assert.match(validateTaskShape({ ...valid, variables: [] }), /must be an object/);
    assert.match(validateTaskShape({ ...valid, variables: null }), /must be an object/);
  });

  it("accepts undefined variables", () => {
    assert.equal(validateTaskShape({ ...valid, variables: undefined }), null);
  });
});

describe("validateRoutingShape (H3)", () => {
  it("rejects unknown destinations", () => {
    assert.match(validateRoutingShape({ destination: "pager" }), /must be one of/);
  });

  it("teams-channel destination requires both team and channel ids", () => {
    assert.match(validateRoutingShape({ destination: "teams-channel" }), /requires teamsTeamId/);
    assert.match(
      validateRoutingShape({ destination: "teams-channel", teamsTeamId: "x" }),
      /requires teamsChannelId/,
    );
    assert.equal(
      validateRoutingShape({
        destination: "teams-channel",
        teamsTeamId: "00000000-0000-0000-0000-000000000001",
        teamsChannelId: "19:abc@thread.tacv2",
      }),
      null,
    );
  });

  it("rejects unknown fallbackDestination", () => {
    assert.match(
      validateRoutingShape({ destination: "cosmos-log", fallbackDestination: "garbage" }),
      /must be one of/,
    );
  });

  it("teams-channel fallback requires team and channel ids", () => {
    assert.match(
      validateRoutingShape({ destination: "cosmos-log", fallbackDestination: "teams-channel" }),
      /teams-channel fallback requires teamsTeamId/,
    );
    assert.equal(
      validateRoutingShape({
        destination: "cosmos-log",
        fallbackDestination: "teams-channel",
        teamsTeamId: "00000000-0000-0000-0000-000000000001",
        teamsChannelId: "19:abc@thread.tacv2",
      }),
      null,
    );
  });
});

describe("validateAuthShape (H3)", () => {
  it("accepts undefined auth", () => {
    assert.equal(validateAuthShape(undefined), null);
  });

  it("rejects auth with non-array scopedPermissions", () => {
    assert.match(validateAuthShape({ scopedPermissions: "x" }), /string array/);
  });

  it("rejects auth with non-string entries in scopedPermissions", () => {
    assert.match(validateAuthShape({ scopedPermissions: ["ok", 1] }), /string\[\]/);
  });
});

describe("validateCircuitBreakerThreshold (H6)", () => {
  it("accepts undefined (uses default)", () => {
    assert.equal(validateCircuitBreakerThreshold(undefined), null);
  });

  it("rejects 0", () => {
    assert.match(validateCircuitBreakerThreshold(0), />= 1/);
  });

  it("rejects negative numbers", () => {
    assert.match(validateCircuitBreakerThreshold(-1), />= 1/);
  });

  it("accepts 1", () => {
    assert.equal(validateCircuitBreakerThreshold(1), null);
  });

  it("rejects NaN and Infinity", () => {
    assert.match(validateCircuitBreakerThreshold(NaN), /finite/);
    assert.match(validateCircuitBreakerThreshold(Infinity), /finite/);
  });
});

describe("validateScheduleShape (H3)", () => {
  it("requires both cronExpression and timezone as non-empty strings", () => {
    assert.match(validateScheduleShape({}), /cronExpression is required/);
    assert.match(validateScheduleShape({ cronExpression: "0 8 * * 1" }), /timezone is required/);
    assert.match(validateScheduleShape({ cronExpression: "", timezone: "UTC" }), /cronExpression is required/);
    assert.equal(validateScheduleShape({ cronExpression: "0 8 * * 1", timezone: "UTC" }), null);
  });
});
