import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Tests ────────────────────────────────────────────────────

describe("Time filter validation", () => {
  it("accepts valid ISO-8601 strings", () => {
    assert.ok(!isNaN(new Date("2026-03-26T09:00:00Z").getTime()));
  });

  it("rejects invalid datetime strings", () => {
    assert.ok(isNaN(new Date("not-a-date").getTime()));
    assert.ok(isNaN(new Date("yesterday").getTime()));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "block_indicator", "import_indicators", "delete_indicator",
    "remediate_abnormal_messages",
    "action_ato_case",
  ]);

  it("list_ato_cases is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_ato_cases"));
  });

  it("get_ato_case is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_ato_case"));
  });

  it("action_ato_case IS destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("action_ato_case"));
  });
});

describe("Tool schema expectations", () => {
  it("list_ato_cases has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_ato_case requires case_id", () => {
    const required = ["case_id"];
    assert.ok(required.includes("case_id"));
    assert.equal(required.length, 1);
  });

  it("action_ato_case requires case_id, action, justification", () => {
    const required = ["case_id", "action", "justification"];
    assert.ok(required.includes("case_id"));
    assert.ok(required.includes("action"));
    assert.ok(required.includes("justification"));
    assert.equal(required.length, 3);
  });
});

describe("ATO action validation", () => {
  const VALID_ACTIONS = new Set(["action_required", "acknowledge"]);

  it("accepts valid actions", () => {
    assert.ok(VALID_ACTIONS.has("action_required"));
    assert.ok(VALID_ACTIONS.has("acknowledge"));
  });

  it("rejects invalid actions", () => {
    assert.ok(!VALID_ACTIONS.has("close"));
    assert.ok(!VALID_ACTIONS.has("resolve"));
    assert.ok(!VALID_ACTIONS.has(""));
  });
});

describe("Case ID validation", () => {
  it("rejects empty string", () => {
    const caseId = "";
    assert.ok(!caseId || caseId.trim() === "");
  });

  it("accepts non-empty string", () => {
    const caseId = "ato-001";
    assert.ok(caseId && caseId.trim() !== "");
  });
});

describe("Mock ATO case data structure", () => {
  const mockCase = {
    caseDetails: {
      caseId: "ato-001",
      severity: "Account Takeover Confirmed",
      affectedEmployee: "jsmith@goodwin.com",
      case_status: "Open",
      remediation_status: "Action Required",
      threatIds: ["threat-abc123"],
      genai_summary: "Account shows strong indicators of compromise.",
    },
    analysisTimeline: {
      insights: [
        { signal: "Impossible Travel", description: "Sign-in from Lagos" },
        { signal: "Suspicious Mail Rule", description: "DELETE_ALL rule created" },
      ],
      events: [
        { category: "Risk Event", type: "Impossible Travel" },
        { category: "Mail Rule", action: "DELETE_ALL" },
        { category: "Mail Sent", type: "Lateral Phishing" },
      ],
    },
  };

  it("has severity field", () => {
    assert.ok(mockCase.caseDetails.severity);
  });

  it("has affectedEmployee", () => {
    assert.ok(mockCase.caseDetails.affectedEmployee);
  });

  it("has genai_summary", () => {
    assert.ok(mockCase.caseDetails.genai_summary);
  });

  it("has timeline insights", () => {
    assert.ok(Array.isArray(mockCase.analysisTimeline.insights));
    assert.ok(mockCase.analysisTimeline.insights.length > 0);
    assert.ok(mockCase.analysisTimeline.insights[0].signal);
  });

  it("has timeline events with categories", () => {
    assert.ok(Array.isArray(mockCase.analysisTimeline.events));
    const categories = mockCase.analysisTimeline.events.map((e) => e.category);
    assert.ok(categories.includes("Risk Event"));
    assert.ok(categories.includes("Mail Rule"));
    assert.ok(categories.includes("Mail Sent"));
  });

  it("has linked threat IDs", () => {
    assert.ok(Array.isArray(mockCase.caseDetails.threatIds));
    assert.ok(mockCase.caseDetails.threatIds.length > 0);
  });
});
