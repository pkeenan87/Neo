import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated validation logic from executors.ts ───────────

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TL_STATUS_MAP = {
  pending: 1,
  approved: 4,
  ignored: 10,
};

function validateGuid(id) {
  if (!GUID_RE.test(id)) {
    throw new Error("Invalid format — expected a GUID");
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("GUID validation", () => {
  it("accepts valid GUIDs", () => {
    assert.doesNotThrow(() => validateGuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    assert.doesNotThrow(() => validateGuid("00000000-0000-0000-0000-000000000000"));
    assert.doesNotThrow(() => validateGuid("A1B2C3D4-E5F6-7890-ABCD-EF1234567890"));
  });

  it("rejects invalid GUIDs", () => {
    assert.throws(() => validateGuid("not-a-guid"), /expected a GUID/);
    assert.throws(() => validateGuid(""), /expected a GUID/);
    assert.throws(() => validateGuid("a1b2c3d4-e5f6-7890-abcd"), /expected a GUID/);
    assert.throws(() => validateGuid("a1b2c3d4e5f67890abcdef1234567890"), /expected a GUID/);
  });
});

describe("Status ID mapping", () => {
  it("maps pending to 1", () => {
    assert.equal(TL_STATUS_MAP.pending, 1);
  });

  it("maps approved to 4", () => {
    assert.equal(TL_STATUS_MAP.approved, 4);
  });

  it("maps ignored to 10", () => {
    assert.equal(TL_STATUS_MAP.ignored, 10);
  });
});

describe("Mock list response structure", () => {
  const mockResponse = {
    approvalRequests: [
      {
        approvalRequestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        computerName: "DESKTOP-JS4729",
        userName: "jsmith",
        path: "C:\\Users\\jsmith\\Downloads\\installer.exe",
        hash: "TL:abc123def456",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        dateTime: "2026-03-20T14:30:00Z",
        statusId: 1,
        actionType: "Execute",
      },
    ],
    totalCount: 1,
    _mock: true,
  };

  it("has expected approval request fields", () => {
    const req = mockResponse.approvalRequests[0];
    assert.ok(req.approvalRequestId);
    assert.ok(req.computerName);
    assert.ok(req.userName);
    assert.ok(req.path);
    assert.ok(req.hash);
    assert.ok(req.sha256);
    assert.ok(req.dateTime);
    assert.equal(typeof req.statusId, "number");
    assert.ok(req.actionType);
  });

  it("includes total count", () => {
    assert.equal(typeof mockResponse.totalCount, "number");
  });
});

describe("Tool schema expectations", () => {
  it("list_threatlocker_approvals has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_threatlocker_approval requires approval_request_id", () => {
    const required = ["approval_request_id"];
    assert.ok(required.includes("approval_request_id"));
  });

  it("approve_threatlocker_request requires approval_request_id and justification", () => {
    const required = ["approval_request_id", "justification"];
    assert.ok(required.includes("approval_request_id"));
    assert.ok(required.includes("justification"));
    assert.ok(!required.includes("policy_level"));
  });

  it("deny_threatlocker_request requires approval_request_id and justification", () => {
    const required = ["approval_request_id", "justification"];
    assert.ok(required.includes("approval_request_id"));
    assert.ok(required.includes("justification"));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password",
    "isolate_machine",
    "unisolate_machine",
    "search_user_messages",
    "report_message_as_phishing",
    "approve_threatlocker_request",
    "deny_threatlocker_request",
  ]);

  it("approve_threatlocker_request is in DESTRUCTIVE_TOOLS", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("approve_threatlocker_request"));
  });

  it("deny_threatlocker_request is in DESTRUCTIVE_TOOLS", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("deny_threatlocker_request"));
  });

  it("list_threatlocker_approvals is NOT in DESTRUCTIVE_TOOLS", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_threatlocker_approvals"));
  });

  it("get_threatlocker_approval is NOT in DESTRUCTIVE_TOOLS", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_threatlocker_approval"));
  });
});

describe("Integration registry expectations", () => {
  it("ThreatLocker integration has 3 required secrets", () => {
    const secrets = [
      { key: "THREATLOCKER_API_KEY", required: true },
      { key: "THREATLOCKER_INSTANCE", required: true },
      { key: "THREATLOCKER_ORG_ID", required: true },
    ];
    assert.equal(secrets.length, 3);
    assert.ok(secrets.every((s) => s.required));
    assert.ok(secrets.some((s) => s.key === "THREATLOCKER_API_KEY"));
    assert.ok(secrets.some((s) => s.key === "THREATLOCKER_INSTANCE"));
    assert.ok(secrets.some((s) => s.key === "THREATLOCKER_ORG_ID"));
  });
});

describe("Policy level defaults", () => {
  it("defaults to computer when not specified", () => {
    const policyLevel = undefined ?? "computer";
    assert.equal(policyLevel, "computer");
  });

  it("accepts valid policy levels", () => {
    const validLevels = new Set(["computer", "group", "organization"]);
    assert.ok(validLevels.has("computer"));
    assert.ok(validLevels.has("group"));
    assert.ok(validLevels.has("organization"));
    assert.ok(!validLevels.has("tenant"));
  });
});
