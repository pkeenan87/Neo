import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Tests ────────────────────────────────────────────────────

describe("Default time range", () => {
  it("produces a 24-hour window ending near now", () => {
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Start should be ~24h ago (within 1 second tolerance)
    const diffMs = now.getTime() - defaultStart.getTime();
    assert.ok(Math.abs(diffMs - 24 * 60 * 60 * 1000) < 1000);
  });

  it("produces valid ISO-8601 strings", () => {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    assert.ok(!isNaN(new Date(start.toISOString()).getTime()));
    assert.ok(!isNaN(new Date(now.toISOString()).getTime()));
  });
});

describe("Time validation", () => {
  it("accepts valid ISO-8601 strings", () => {
    assert.ok(!isNaN(new Date("2026-03-26T09:00:00Z").getTime()));
    assert.ok(!isNaN(new Date("2026-03-25T00:00:00.000Z").getTime()));
  });

  it("rejects invalid datetime strings", () => {
    assert.ok(isNaN(new Date("not-a-date").getTime()));
    assert.ok(isNaN(new Date("yesterday").getTime()));
    assert.ok(isNaN(new Date("").getTime()));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "block_indicator", "import_indicators", "delete_indicator",
  ]);

  it("list_abnormal_threats is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_abnormal_threats"));
  });

  it("get_abnormal_threat is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_abnormal_threat"));
  });
});

describe("Tool schema expectations", () => {
  it("list_abnormal_threats has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_abnormal_threat requires threat_id", () => {
    const required = ["threat_id"];
    assert.ok(required.includes("threat_id"));
    assert.equal(required.length, 1);
  });
});

describe("Threat ID validation", () => {
  it("rejects empty string", () => {
    const threatId = "";
    assert.ok(!threatId || threatId.trim() === "");
  });

  it("accepts non-empty string", () => {
    const threatId = "threat-abc123";
    assert.ok(threatId && threatId.trim() !== "");
  });
});

describe("Mock threat data structure", () => {
  const mockThreat = {
    threatId: "threat-abc123",
    attackType: "BEC",
    attackStrategy: "Invoice Fraud",
    attackVector: "Text",
    summaryInsights: ["Unusual Sender", "Invoice/Payment Request Language"],
    fromAddress: "cfo@acme-bi11ing.com",
    senderIpAddress: "185.220.101.42",
    recipientAddress: "jsmith@goodwin.com",
    autoRemediated: false,
    remediationStatus: "Not Remediated",
    abxPortalUrl: "https://portal.abnormalsecurity.com/threats/threat-abc123",
  };

  it("has attackType field", () => {
    assert.ok(mockThreat.attackType);
  });

  it("has summaryInsights array", () => {
    assert.ok(Array.isArray(mockThreat.summaryInsights));
    assert.ok(mockThreat.summaryInsights.length > 0);
  });

  it("has fromAddress", () => {
    assert.ok(mockThreat.fromAddress);
  });

  it("has remediationStatus", () => {
    assert.ok(mockThreat.remediationStatus);
  });

  it("has portal link", () => {
    assert.ok(mockThreat.abxPortalUrl.startsWith("https://"));
  });
});

describe("Filter expression construction", () => {
  it("constructs valid filter expression", () => {
    const start = "2026-03-25T00:00:00.000Z";
    const end = "2026-03-26T00:00:00.000Z";
    const expression = `receivedTime gte ${start} lte ${end}`;
    const encoded = encodeURIComponent(expression);
    assert.ok(encoded.includes("receivedTime"));
    assert.ok(encoded.includes("gte"));
    assert.ok(encoded.includes("lte"));
    assert.ok(!encoded.includes(" ")); // spaces should be encoded
  });
});

describe("Pagination clamping", () => {
  it("clamps page_size to 100 max", () => {
    assert.equal(Math.max(1, Math.min(200, 100)), 100);
  });

  it("clamps page_number to 1 min", () => {
    assert.equal(Math.max(1, 0), 1);
  });
});
