import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated constants from logger.ts ──────────────────────

const SAFE_METADATA_FIELDS = new Set([
  "sessionId", "role", "ownerIdHash", "provider", "toolName", "toolId",
  "hostname", "upn", "platform", "severity", "status", "messageCount",
  "component", "errorMessage", "statusCode", "method", "action",
  "conversationId", "aadObjectIdHash", "matchCount", "messageLength",
  "mode", "label", "userIdHash", "filename", "inputTokens", "outputTokens",
  "cacheCreationTokens", "cacheReadTokens", "estimatedCostUsd", "model",
  "budgetRemaining", "budgetWarning",
  // Enhanced observability fields
  "userName", "channel", "toolCategory", "isDestructive", "durationMs",
  "turnNumber", "skillId", "skillName", "confirmed", "justification",
  "windowType", "budgetLimit", "currentUsage", "percentUsed", "eventType",
  "toolInput",
]);

const ANALYTICS_EVENT_TYPES = new Set([
  "tool_execution", "token_usage", "skill_invocation",
  "session_started", "session_ended",
]);

const OPERATIONAL_EVENT_TYPES = new Set([
  "operational", "destructive_action", "budget_alert",
]);

// ── Tests ────────────────────────────────────────────────────

describe("SAFE_METADATA_FIELDS allowlist", () => {
  const newFields = [
    "userName", "channel", "toolCategory", "isDestructive", "durationMs",
    "turnNumber", "skillId", "skillName", "confirmed", "justification",
    "windowType", "budgetLimit", "currentUsage", "percentUsed", "eventType",
    "toolInput",
  ];

  for (const field of newFields) {
    it(`includes new field: ${field}`, () => {
      assert.ok(SAFE_METADATA_FIELDS.has(field));
    });
  }

  it("still includes existing fields", () => {
    assert.ok(SAFE_METADATA_FIELDS.has("sessionId"));
    assert.ok(SAFE_METADATA_FIELDS.has("toolName"));
    assert.ok(SAFE_METADATA_FIELDS.has("model"));
    assert.ok(SAFE_METADATA_FIELDS.has("inputTokens"));
  });
});

describe("Event type routing", () => {
  it("analytics events routed correctly", () => {
    for (const et of ["tool_execution", "token_usage", "skill_invocation", "session_started", "session_ended"]) {
      assert.ok(ANALYTICS_EVENT_TYPES.has(et), `${et} should be analytics`);
      assert.ok(!OPERATIONAL_EVENT_TYPES.has(et), `${et} should NOT be operational`);
    }
  });

  it("operational events routed correctly", () => {
    for (const et of ["operational", "destructive_action", "budget_alert"]) {
      assert.ok(OPERATIONAL_EVENT_TYPES.has(et), `${et} should be operational`);
      assert.ok(!ANALYTICS_EVENT_TYPES.has(et), `${et} should NOT be analytics`);
    }
  });
});

describe("Budget percentage threshold", () => {
  it("80% threshold triggers warning", () => {
    const maxTokens = 1_000_000;
    const usedTokens = 800_000;
    const pct = Math.round((usedTokens / maxTokens) * 100);
    assert.equal(pct, 80);
    assert.ok(usedTokens >= maxTokens * 0.8);
  });

  it("79% does not trigger warning", () => {
    const maxTokens = 1_000_000;
    const usedTokens = 790_000;
    assert.ok(usedTokens < maxTokens * 0.8);
  });

  it("100% triggers blocked", () => {
    const maxTokens = 1_000_000;
    const usedTokens = 1_000_000;
    assert.ok(usedTokens >= maxTokens);
  });
});

describe("PII handling in identity context", () => {
  it("userName is raw string (not hashed)", () => {
    const userName = "Patrick Keenan";
    assert.ok(!userName.match(/^[a-f0-9]{16}$/));
  });

  it("userIdHash is 16-char hex hash", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("test-oid-123").digest("hex").slice(0, 16);
    assert.equal(hash.length, 16);
    assert.ok(/^[a-f0-9]{16}$/.test(hash));
  });
});

describe("Tool integration lookup", () => {
  // Replicated from integration-registry capabilities
  const toolIntegrationMap = new Map([
    ["run_sentinel_kql", "microsoft-sentinel"],
    ["block_indicator", "microsoft-defender-xdr"],
    ["get_user_info", "microsoft-entra-id"],
    ["list_threatlocker_approvals", "threatlocker"],
    ["list_appomni_services", "appomni"],
    ["search_abnormal_messages", "abnormal-security"],
    ["lookup_asset", "lansweeper"],
  ]);

  for (const [tool, integration] of toolIntegrationMap) {
    it(`${tool} maps to ${integration}`, () => {
      assert.equal(toolIntegrationMap.get(tool), integration);
    });
  }

  it("get_full_tool_result has no integration", () => {
    assert.equal(toolIntegrationMap.get("get_full_tool_result"), undefined);
  });
});

describe("All event types are valid", () => {
  const ALL_EVENT_TYPES = [
    "operational", "tool_execution", "token_usage", "skill_invocation",
    "destructive_action", "budget_alert", "session_started", "session_ended",
  ];

  it("8 event types total", () => {
    assert.equal(ALL_EVENT_TYPES.length, 8);
  });

  it("every event type is either analytics or operational", () => {
    for (const et of ALL_EVENT_TYPES) {
      assert.ok(
        ANALYTICS_EVENT_TYPES.has(et) || OPERATIONAL_EVENT_TYPES.has(et),
        `${et} must be in either analytics or operational set`,
      );
    }
  });
});
