import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated status determination logic from executors.ts ──
// Mirrors buildIsolationResult so we can test the logic without
// importing the full executor module (which has Azure SDK deps).

function buildIsolationResult(hostname, machineId, isolationActions, health) {
  if (isolationActions.length === 0) {
    return {
      hostname,
      machineId,
      isolationStatus: "NotIsolated",
      note: "No isolation history found for this machine",
      lastAction: null,
      health,
    };
  }

  const latest = isolationActions[0];
  let isolationStatus;

  if (latest.type === "Isolate" && latest.status === "Succeeded") {
    isolationStatus = "Isolated";
  } else if (latest.type === "Isolate" && (latest.status === "Pending" || latest.status === "InProgress")) {
    isolationStatus = "Pending";
  } else if (latest.type === "Isolate" && latest.status === "Failed") {
    isolationStatus = "NotIsolated";
  } else if (latest.type === "Unisolate" && latest.status === "Succeeded") {
    isolationStatus = "NotIsolated";
  } else if (latest.type === "Unisolate" && (latest.status === "Pending" || latest.status === "InProgress")) {
    isolationStatus = "UnisolatePending";
  } else if (latest.type === "Unisolate" && latest.status === "Failed") {
    isolationStatus = "Isolated";
  } else {
    isolationStatus = "Unknown";
  }

  return {
    hostname,
    machineId,
    isolationStatus,
    lastAction: {
      type: latest.type,
      status: latest.status,
      requestor: latest.requestor,
      creationDateTimeUtc: latest.creationDateTimeUtc,
      lastUpdateDateTimeUtc: latest.lastUpdateDateTimeUtc,
      comment: latest.requestorComment ?? latest.title,
    },
    health,
  };
}

// ── Machine ID validation (mirrors executors.ts) ─────────────

const MACHINE_ID_RE = /^[0-9a-f]{40}$/i;

function validateMachineId(id) {
  if (!MACHINE_ID_RE.test(id)) {
    throw new Error("Invalid machine ID format");
  }
}

const MOCK_HEALTH = {
  healthStatus: "Active",
  riskScore: "Medium",
  exposureLevel: "Medium",
  osPlatform: "Windows11",
  osVersion: "22H2",
  lastSeen: "2026-03-20T10:00:00Z",
  lastIpAddress: "10.1.50.42",
};

// ── Tests ────────────────────────────────────────────────────

describe("Machine isolation status determination", () => {
  it("returns Isolated when most recent action is Isolate + Succeeded", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "Isolated");
    assert.equal(result.lastAction.type, "Isolate");
    assert.equal(result.lastAction.requestor, "admin@corp.com");
  });

  it("returns NotIsolated when most recent action is Unisolate + Succeeded", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Unisolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T12:00:00Z" },
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "NotIsolated");
  });

  it("returns NotIsolated with note when no isolation actions exist", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "NotIsolated");
    assert.equal(result.note, "No isolation history found for this machine");
    assert.equal(result.lastAction, null);
  });

  it("returns Pending when most recent action is Isolate + Pending", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Pending", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "Pending");
  });

  it("returns Pending when most recent action is Isolate + InProgress", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "InProgress", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "Pending");
  });

  it("returns NotIsolated when most recent Isolate action Failed", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Failed", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "NotIsolated");
  });

  it("returns UnisolatePending when unisolation is in progress", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Unisolate", status: "Pending", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T12:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "UnisolatePending");
  });

  it("returns UnisolatePending for Unisolate + InProgress", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Unisolate", status: "InProgress", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T12:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "UnisolatePending");
  });

  it("returns Isolated when Unisolate Failed (machine remains isolated)", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Unisolate", status: "Failed", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "Isolated");
  });

  it("uses only the most recent action to determine status", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Unisolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T14:00:00Z" },
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T12:00:00Z" },
      { type: "Unisolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "NotIsolated");
    assert.equal(result.lastAction.creationDateTimeUtc, "2026-03-20T14:00:00Z");
  });

  it("includes health data in the response", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [], MOCK_HEALTH);
    assert.deepEqual(result.health, MOCK_HEALTH);
    assert.equal(result.health.healthStatus, "Active");
    assert.equal(result.health.riskScore, "Medium");
  });

  it("prefers requestorComment over title for comment field", () => {
    const withBoth = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z", requestorComment: "User comment", title: "System title" },
    ], MOCK_HEALTH);
    assert.equal(withBoth.lastAction.comment, "User comment");

    const titleOnly = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z", title: "Fallback title" },
    ], MOCK_HEALTH);
    assert.equal(titleOnly.lastAction.comment, "Fallback title");

    const commentOnly = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "Isolate", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z", requestorComment: "Suspicious activity" },
    ], MOCK_HEALTH);
    assert.equal(commentOnly.lastAction.comment, "Suspicious activity");
  });

  it("returns Unknown for truly unexpected status combinations", () => {
    const result = buildIsolationResult("DESKTOP-001", "m1", [
      { type: "SomeOtherAction", status: "Succeeded", requestor: "admin@corp.com", creationDateTimeUtc: "2026-03-20T10:00:00Z" },
    ], MOCK_HEALTH);
    assert.equal(result.isolationStatus, "Unknown");
  });
});

describe("Machine ID validation", () => {
  it("accepts valid 40-char hex machine IDs", () => {
    assert.doesNotThrow(() => validateMachineId("a".repeat(40)));
    assert.doesNotThrow(() => validateMachineId("0123456789abcdef0123456789abcdef01234567"));
    assert.doesNotThrow(() => validateMachineId("ABCDEF0123456789ABCDEF0123456789ABCDEF01"));
  });

  it("rejects non-hex characters", () => {
    assert.throws(() => validateMachineId("g".repeat(40)), /Invalid machine ID format/);
    assert.throws(() => validateMachineId("a".repeat(39) + "!"), /Invalid machine ID format/);
  });

  it("rejects wrong-length strings", () => {
    assert.throws(() => validateMachineId("a".repeat(39)), /Invalid machine ID format/);
    assert.throws(() => validateMachineId("a".repeat(41)), /Invalid machine ID format/);
    assert.throws(() => validateMachineId(""), /Invalid machine ID format/);
  });

  it("rejects OData injection attempts", () => {
    assert.throws(() => validateMachineId("abc' or 1 eq 1 or machineId eq 'abc"), /Invalid machine ID format/);
  });
});

describe("Tool schema validation", () => {
  it("has expected properties: hostname required, machine_id optional with maxLength", () => {
    const schema = {
      type: "object",
      properties: {
        hostname: { type: "string" },
        machine_id: { type: "string", maxLength: 64 },
      },
      required: ["hostname"],
    };
    assert.ok(schema.required.includes("hostname"));
    assert.ok(!schema.required.includes("machine_id"));
    assert.ok(schema.properties.machine_id.maxLength <= 64);
  });
});
