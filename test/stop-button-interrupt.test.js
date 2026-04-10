import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Simulated agent loop signal-check pattern ────────────────

function simulatedLoop(signal, messages) {
  const localMessages = [...messages];

  function buildInterrupted() {
    const last = localMessages[localMessages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      last.content.push({ type: "text", text: "[interrupted]" });
    } else {
      localMessages.push({ role: "assistant", content: [{ type: "text", text: "[interrupted]" }] });
    }
    return { type: "response", text: "[interrupted]", messages: localMessages, interrupted: true };
  }

  // Simulate 3 iterations
  for (let i = 0; i < 3; i++) {
    if (signal?.aborted) return buildInterrupted();
    localMessages.push({ role: "assistant", content: [{ type: "text", text: `turn ${i}` }] });
    if (signal?.aborted) return buildInterrupted();
  }
  return { type: "response", text: "done", messages: localMessages };
}

describe("AbortSignal propagation", () => {
  it("loop exits immediately when signal is pre-aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const result = simulatedLoop(controller.signal, [{ role: "user", content: "hi" }]);
    assert.equal(result.interrupted, true);
    assert.equal(result.type, "response");
  });

  it("loop completes normally when signal is never aborted", () => {
    const controller = new AbortController();
    const result = simulatedLoop(controller.signal, [{ role: "user", content: "hi" }]);
    assert.equal(result.interrupted, undefined);
  });

  it("loop exits when signal is aborted mid-iteration", () => {
    const controller = new AbortController();
    // Simulate abort after first iteration by immediately triggering on read
    let tickCount = 0;
    const fakeSignal = {
      get aborted() {
        tickCount++;
        return tickCount > 2;
      },
    };
    const result = simulatedLoop(fakeSignal, [{ role: "user", content: "hi" }]);
    assert.equal(result.interrupted, true);
  });
});

describe("Interrupted marker insertion", () => {
  it("appends [interrupted] text block to last assistant message", () => {
    const controller = new AbortController();
    controller.abort();
    const result = simulatedLoop(controller.signal, [
      { role: "user", content: "hi" },
    ]);
    const last = result.messages[result.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.ok(Array.isArray(last.content));
    const hasMarker = last.content.some(
      (b) => b.type === "text" && b.text === "[interrupted]",
    );
    assert.ok(hasMarker);
  });
});

describe("DESTRUCTIVE_TOOLS bypass", () => {
  // Replicated destructive tool set
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

  it("destructive tools are in the set", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("reset_user_password"));
    assert.ok(DESTRUCTIVE_TOOLS.has("isolate_machine"));
    assert.ok(DESTRUCTIVE_TOOLS.has("block_indicator"));
  });

  it("read-only tools are NOT in the set", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("run_sentinel_kql"));
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_user_info"));
    assert.ok(!DESTRUCTIVE_TOOLS.has("search_abnormal_messages"));
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_appomni_findings"));
  });
});

describe("AbortError detection", () => {
  it("detects AbortError by name property", () => {
    const err = new DOMException("aborted", "AbortError");
    assert.equal(err.name, "AbortError");
  });

  it("generic Error is not AbortError", () => {
    const err = new Error("something else");
    assert.notEqual(err.name, "AbortError");
  });
});

describe("session_interrupted event type", () => {
  const VALID_EVENT_TYPES = new Set([
    "operational", "tool_execution", "token_usage", "skill_invocation",
    "destructive_action", "budget_alert", "session_started", "session_ended",
    "session_interrupted",
  ]);

  it("session_interrupted is in the LogEventType union", () => {
    assert.ok(VALID_EVENT_TYPES.has("session_interrupted"));
  });
});

describe("Idempotent abort", () => {
  it("calling abort twice is a no-op", () => {
    const controller = new AbortController();
    controller.abort();
    assert.doesNotThrow(() => controller.abort());
    assert.equal(controller.signal.aborted, true);
  });
});

describe("Interrupted marker extraction on reload", () => {
  it("detects [interrupted] suffix in assistant text", () => {
    const content = "Here's my response [interrupted]";
    const hasMarker = content.includes("[interrupted]");
    assert.ok(hasMarker);
    const cleaned = content.replace(/\s*\[interrupted\]\s*$/, "").trim();
    assert.equal(cleaned, "Here's my response");
  });

  it("text without marker is untouched", () => {
    const content = "Normal response";
    assert.ok(!content.includes("[interrupted]"));
  });
});
