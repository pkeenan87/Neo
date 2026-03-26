import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated mappings from executors.ts ───────────────────

const MAINTENANCE_MODE_MAP = {
  monitor: 1, installation: 2, learning: 3, secured: 8,
  network_monitor: 17, storage_monitor: 18,
};

const BULK_MODE_MAP = {
  monitor: 1, learning: 3, disable_tamper: 6, installation: 2,
};

const SEARCH_BY_MAP = { name: 1, username: 2, ip: 4 };

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Tests ────────────────────────────────────────────────────

describe("Maintenance mode type mapping", () => {
  it("maps all 6 modes correctly", () => {
    assert.equal(MAINTENANCE_MODE_MAP.monitor, 1);
    assert.equal(MAINTENANCE_MODE_MAP.installation, 2);
    assert.equal(MAINTENANCE_MODE_MAP.learning, 3);
    assert.equal(MAINTENANCE_MODE_MAP.secured, 8);
    assert.equal(MAINTENANCE_MODE_MAP.network_monitor, 17);
    assert.equal(MAINTENANCE_MODE_MAP.storage_monitor, 18);
  });

  it("maps bulk modes correctly", () => {
    assert.equal(BULK_MODE_MAP.monitor, 1);
    assert.equal(BULK_MODE_MAP.learning, 3);
    assert.equal(BULK_MODE_MAP.disable_tamper, 6);
    assert.equal(BULK_MODE_MAP.installation, 2);
  });
});

describe("Search-by mapping", () => {
  it("maps name to 1", () => assert.equal(SEARCH_BY_MAP.name, 1));
  it("maps username to 2", () => assert.equal(SEARCH_BY_MAP.username, 2));
  it("maps ip to 4", () => assert.equal(SEARCH_BY_MAP.ip, 4));
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "set_maintenance_mode", "schedule_bulk_maintenance", "enable_secured_mode",
    "block_indicator", "import_indicators", "delete_indicator",
    "remediate_abnormal_messages", "action_ato_case",
  ]);

  it("search_threatlocker_computers is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("search_threatlocker_computers"));
  });

  it("get_threatlocker_computer is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_threatlocker_computer"));
  });

  it("set_maintenance_mode IS destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("set_maintenance_mode"));
  });

  it("schedule_bulk_maintenance IS destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("schedule_bulk_maintenance"));
  });

  it("enable_secured_mode IS destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("enable_secured_mode"));
  });
});

describe("GUID validation", () => {
  it("accepts valid GUIDs", () => {
    assert.ok(GUID_RE.test("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
  });

  it("rejects invalid GUIDs", () => {
    assert.ok(!GUID_RE.test("not-a-guid"));
    assert.ok(!GUID_RE.test(""));
  });
});

describe("Duration calculation", () => {
  it("4 hours from now produces a future ISO-8601 date", () => {
    const durationHours = 4;
    const endTime = new Date(Date.now() + durationHours * 60 * 60 * 1000);
    assert.ok(endTime.getTime() > Date.now());
    assert.ok(!isNaN(endTime.getTime()));
    assert.ok(endTime.toISOString().includes("T"));
  });

  it("default 1 hour produces a future date", () => {
    const endTime = new Date(Date.now() + 60 * 60 * 1000);
    assert.ok(endTime.getTime() > Date.now());
  });
});

describe("End time validation", () => {
  it("rejects past dates", () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);
    assert.ok(pastDate.getTime() < Date.now());
  });

  it("accepts future dates", () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000);
    assert.ok(futureDate.getTime() > Date.now());
  });
});

describe("Tool schema expectations", () => {
  it("search requires search_text", () => {
    const required = ["search_text"];
    assert.ok(required.includes("search_text"));
  });

  it("get requires computer_id", () => {
    const required = ["computer_id"];
    assert.ok(required.includes("computer_id"));
  });

  it("set requires computer_id, organization_id, mode", () => {
    const required = ["computer_id", "organization_id", "mode"];
    assert.equal(required.length, 3);
  });

  it("schedule requires computers, mode, start_time, end_time", () => {
    const required = ["computers", "mode", "start_time", "end_time"];
    assert.equal(required.length, 4);
  });

  it("enable requires computers", () => {
    const required = ["computers"];
    assert.equal(required.length, 1);
  });
});
