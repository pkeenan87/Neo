import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated logic from web/lib/scheduled-task-runner.ts ───
// In-process replicas so node:test doesn't need to import the TS
// executor surface. The runner's actual logic is small and worth
// testing on its own; mirror the helpers verbatim.

const DESTRUCTIVE_TOOLS = new Set([
  "reset_user_password",
  "isolate_machine",
  "unisolate_machine",
]);

const KNOWN_TOOLS = new Set([
  "run_sentinel_kql",
  "run_defender_hunting_query",
  "get_user_info",
  "reset_user_password",
  "isolate_machine",
  "unisolate_machine",
]);

function computeAllowedTools(taskAllowedTools) {
  return taskAllowedTools.filter(
    (name) => KNOWN_TOOLS.has(name) && !DESTRUCTIVE_TOOLS.has(name),
  );
}

function substituteVariables(template, variables) {
  const today = new Date().toISOString().slice(0, 10);
  const merged = { today, ...(variables ?? {}) };

  const placeholders = template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  for (const match of placeholders) {
    const key = match[1];
    if (!(key in merged)) {
      throw new Error(`unknown_template_variable: ${key}`);
    }
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key) => {
    return String(merged[key]);
  });
}

const OUTPUT_SUMMARY_MAX = 2000;
function summarize(text) {
  if (text.length <= OUTPUT_SUMMARY_MAX) return text;
  return text.slice(0, OUTPUT_SUMMARY_MAX) + "\n…[truncated]";
}

const RUN_HISTORY_MAX = 50;
function appendCapped(history, entry) {
  const next = [...history, entry];
  if (next.length > RUN_HISTORY_MAX) {
    next.splice(0, next.length - RUN_HISTORY_MAX);
  }
  return next;
}

const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
function shouldTripBreaker(consecutiveFailures, threshold) {
  return consecutiveFailures >= (threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
}

// ── Tests ────────────────────────────────────────────────────

describe("computeAllowedTools", () => {
  it("strips destructive tools", () => {
    const out = computeAllowedTools(["run_sentinel_kql", "reset_user_password"]);
    assert.deepEqual(out, ["run_sentinel_kql"]);
  });

  it("strips unknown tools", () => {
    const out = computeAllowedTools(["run_sentinel_kql", "nonexistent_tool"]);
    assert.deepEqual(out, ["run_sentinel_kql"]);
  });

  it("returns empty array when nothing survives intersection", () => {
    const out = computeAllowedTools(["reset_user_password", "isolate_machine"]);
    assert.deepEqual(out, []);
  });

  it("preserves order and dedups nothing (caller's responsibility)", () => {
    const out = computeAllowedTools([
      "run_defender_hunting_query",
      "run_sentinel_kql",
      "get_user_info",
    ]);
    assert.deepEqual(out, [
      "run_defender_hunting_query",
      "run_sentinel_kql",
      "get_user_info",
    ]);
  });
});

describe("substituteVariables", () => {
  it("substitutes {{today}} automatically", () => {
    const out = substituteVariables("Run the report for {{today}}", undefined);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(out, `Run the report for ${today}`);
  });

  it("substitutes user-supplied variables", () => {
    const out = substituteVariables(
      "Look back {{lookbackDays}} days at user {{upn}}",
      { lookbackDays: 7, upn: "jsmith@goodwin.com" },
    );
    assert.equal(out, "Look back 7 days at user jsmith@goodwin.com");
  });

  it("throws on unknown placeholder", () => {
    assert.throws(
      () => substituteVariables("Use {{missingVar}}", { other: 1 }),
      /unknown_template_variable: missingVar/,
    );
  });

  it("does not match malformed placeholders", () => {
    // {single braces}, {{ no close, etc.
    const out = substituteVariables("Plain {placeholder} text", undefined);
    assert.equal(out, "Plain {placeholder} text");
  });

  it("handles repeated placeholders", () => {
    const out = substituteVariables("{{name}} and {{name}}", { name: "Alice" });
    assert.equal(out, "Alice and Alice");
  });
});

describe("summarize", () => {
  it("returns short text unchanged", () => {
    assert.equal(summarize("short"), "short");
  });

  it("truncates long text with a marker", () => {
    const long = "x".repeat(OUTPUT_SUMMARY_MAX + 500);
    const out = summarize(long);
    assert.equal(out.length, OUTPUT_SUMMARY_MAX + "\n…[truncated]".length);
    assert.ok(out.endsWith("…[truncated]"));
  });

  it("preserves text exactly at the cap", () => {
    const exact = "x".repeat(OUTPUT_SUMMARY_MAX);
    assert.equal(summarize(exact), exact);
  });
});

describe("run history cap", () => {
  it("drops the oldest when exceeding RUN_HISTORY_MAX", () => {
    let history = [];
    for (let i = 0; i < RUN_HISTORY_MAX; i += 1) {
      history = appendCapped(history, { runId: `r${i}` });
    }
    assert.equal(history.length, RUN_HISTORY_MAX);
    history = appendCapped(history, { runId: "r50" });
    assert.equal(history.length, RUN_HISTORY_MAX);
    assert.equal(history[0].runId, "r1");
    assert.equal(history[history.length - 1].runId, "r50");
  });

  it("does not modify the input array", () => {
    const a = [{ runId: "a" }];
    const b = appendCapped(a, { runId: "b" });
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
  });
});

describe("circuit breaker threshold", () => {
  it("trips at exactly the threshold", () => {
    assert.equal(shouldTripBreaker(3, 3), true);
    assert.equal(shouldTripBreaker(2, 3), false);
  });

  it("uses default threshold when not configured", () => {
    assert.equal(shouldTripBreaker(3, undefined), true);
    assert.equal(shouldTripBreaker(2, undefined), false);
  });
});

// ── Interrupted/timeout classification (C1) ──────────────────
// Mirrors the runner's check: if agentResult.type === 'response' AND
// agentResult.interrupted, the result is a timeout, not a success.

function classifyAgentResult(agentResult, agentError) {
  if (agentError) {
    return isTimeoutError(agentError) ? "timeout" : "failure";
  }
  if (!agentResult || agentResult.type !== "response") {
    return "failure";
  }
  if (agentResult.interrupted) {
    return "timeout";
  }
  return "success";
}

function isTimeoutError(err) {
  if (!err || typeof err !== "object") return false;
  const name = err.name;
  return name === "TimeoutError" || name === "AbortError";
}

describe("agent result classification (C1)", () => {
  it("marks an interrupted response as timeout, not success", () => {
    const agentResult = { type: "response", text: "[interrupted]", interrupted: true };
    assert.equal(classifyAgentResult(agentResult, null), "timeout");
  });

  it("marks a normal response as success", () => {
    const agentResult = { type: "response", text: "Done.", interrupted: false };
    assert.equal(classifyAgentResult(agentResult, null), "success");
  });

  it("marks a confirmation_required response as failure (shouldn't happen for scheduled tasks but be safe)", () => {
    const agentResult = { type: "confirmation_required" };
    assert.equal(classifyAgentResult(agentResult, null), "failure");
  });

  it("classifies AbortError thrown by agent loop as timeout", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    assert.equal(classifyAgentResult(null, err), "timeout");
  });

  it("classifies TimeoutError as timeout", () => {
    const err = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    assert.equal(classifyAgentResult(null, err), "timeout");
  });

  it("classifies other errors as failure", () => {
    const err = new Error("boom");
    assert.equal(classifyAgentResult(null, err), "failure");
  });
});
