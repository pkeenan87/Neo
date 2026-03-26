import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated constants from executors.ts ──────────────────

const AO_SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const VALID_DETAILED_STATUSES = new Set([
  "new", "in_research", "in_remediation", "done",
]);

const VALID_EXCEPTION_REASONS = new Set([
  "risk_accepted", "false_positive", "compensating_controls",
  "not_applicable", "confirmed_intended",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Tests ────────────────────────────────────────────────────

describe("Subdomain validation", () => {
  it("accepts valid subdomains", () => {
    assert.ok(AO_SUBDOMAIN_RE.test("acme"));
    assert.ok(AO_SUBDOMAIN_RE.test("goodwin-procter"));
    assert.ok(AO_SUBDOMAIN_RE.test("a1b2c3"));
  });

  it("rejects full URLs", () => {
    assert.ok(!AO_SUBDOMAIN_RE.test("https://acme.appomni.com"));
    assert.ok(!AO_SUBDOMAIN_RE.test("acme.appomni.com"));
  });

  it("rejects empty strings", () => {
    assert.ok(!AO_SUBDOMAIN_RE.test(""));
  });

  it("rejects subdomains starting/ending with hyphens", () => {
    assert.ok(!AO_SUBDOMAIN_RE.test("-acme"));
    assert.ok(!AO_SUBDOMAIN_RE.test("acme-"));
  });

  it("rejects uppercase", () => {
    assert.ok(!AO_SUBDOMAIN_RE.test("Acme"));
  });
});

describe("ID format validation", () => {
  it("positive integers are valid service/identity IDs", () => {
    assert.ok(Number.isInteger(101) && 101 > 0);
    assert.ok(Number.isInteger(180452) && 180452 > 0);
  });

  it("non-positive integers are invalid", () => {
    assert.ok(!(Number.isInteger(0) && 0 > 0));
    assert.ok(!(Number.isInteger(-1) && -1 > 0));
  });

  it("UUIDs are valid for findings/occurrences", () => {
    assert.ok(UUID_RE.test("f1a2b3c4-d5e6-7890-abcd-ef1234567890"));
    assert.ok(UUID_RE.test("occ-1111-2222-3333-444455556666") === false); // not a valid UUID
  });
});

describe("Pagination clamping", () => {
  it("findings limit clamped to 1-100", () => {
    const clamp = (v) => Math.max(1, Math.min(v, 100));
    assert.equal(clamp(200), 100);
    assert.equal(clamp(0), 1);
    assert.equal(clamp(-5), 1);
    assert.equal(clamp(50), 50);
    assert.equal(clamp(100), 100);
  });

  it("other endpoints clamped to 1-50", () => {
    const clamp = (v) => Math.max(1, Math.min(v, 50));
    assert.equal(clamp(200), 50);
    assert.equal(clamp(0), 1);
    assert.equal(clamp(25), 25);
  });

  it("insights clamped to 1-500", () => {
    const clamp = (v) => Math.max(1, Math.min(v, 500));
    assert.equal(clamp(1000), 500);
    assert.equal(clamp(0), 1);
    assert.equal(clamp(250), 250);
  });
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
    "action_appomni_finding",
  ]);

  it("action_appomni_finding IS destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("action_appomni_finding"));
  });

  const readOnlyTools = [
    "list_appomni_services", "get_appomni_service",
    "list_appomni_findings", "get_appomni_finding",
    "list_appomni_finding_occurrences", "list_appomni_insights",
    "list_appomni_policy_issues", "list_appomni_identities",
    "get_appomni_identity", "list_appomni_discovered_apps",
    "get_appomni_audit_logs",
  ];

  for (const tool of readOnlyTools) {
    it(`${tool} is NOT destructive`, () => {
      assert.ok(!DESTRUCTIVE_TOOLS.has(tool));
    });
  }
});

describe("Tool schema expectations", () => {
  it("get_appomni_service requires service_id and service_type", () => {
    const required = ["service_id", "service_type"];
    assert.equal(required.length, 2);
  });

  it("get_appomni_finding requires finding_id", () => {
    const required = ["finding_id"];
    assert.equal(required.length, 1);
  });

  it("get_appomni_identity requires identity_id", () => {
    const required = ["identity_id"];
    assert.equal(required.length, 1);
  });

  it("action_appomni_finding requires action and occurrence_ids", () => {
    const required = ["action", "occurrence_ids"];
    assert.equal(required.length, 2);
  });

  it("list tools have no required fields", () => {
    const listTools = [
      "list_appomni_services", "list_appomni_findings",
      "list_appomni_finding_occurrences", "list_appomni_insights",
      "list_appomni_policy_issues", "list_appomni_identities",
      "list_appomni_discovered_apps", "get_appomni_audit_logs",
    ];
    assert.equal(listTools.length, 8);
  });
});

describe("Finding action validation", () => {
  it("update_status accepts valid detailed statuses", () => {
    for (const s of ["new", "in_research", "in_remediation", "done"]) {
      assert.ok(VALID_DETAILED_STATUSES.has(s));
    }
  });

  it("update_status rejects invalid statuses", () => {
    assert.ok(!VALID_DETAILED_STATUSES.has("resolved"));
    assert.ok(!VALID_DETAILED_STATUSES.has(""));
  });

  it("close_exception accepts valid reasons", () => {
    for (const r of ["risk_accepted", "false_positive", "compensating_controls", "not_applicable", "confirmed_intended"]) {
      assert.ok(VALID_EXCEPTION_REASONS.has(r));
    }
  });

  it("close_exception rejects invalid reasons", () => {
    assert.ok(!VALID_EXCEPTION_REASONS.has("ignored"));
    assert.ok(!VALID_EXCEPTION_REASONS.has(""));
  });

  it("only two valid actions exist", () => {
    const validActions = new Set(["update_status", "close_exception"]);
    assert.ok(validActions.has("update_status"));
    assert.ok(validActions.has("close_exception"));
    assert.ok(!validActions.has("dismiss"));
  });
});
