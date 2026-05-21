import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated routing logic ─────────────────────────────────
// Mirrors web/lib/scheduled-task-routing.ts so we can test the
// fallback paths without spinning up the Graph helper.

async function routeOutput(task, outputText, sendTo) {
  if (task.dryRun) {
    return { routedTo: "dry-run-log", success: true };
  }

  try {
    await sendTo(task.routing.destination, task, outputText);
    return { routedTo: task.routing.destination, success: true };
  } catch (primaryErr) {
    const primaryReason = primaryErr.message;
    const fallback = task.routing.fallbackDestination ?? "cosmos-log";
    if (fallback === task.routing.destination) {
      return { routedTo: task.routing.destination, success: false, reason: primaryReason };
    }
    try {
      await sendTo(fallback, task, outputText);
      return { routedTo: fallback, success: true, reason: `primary_failed: ${primaryReason}` };
    } catch (fallbackErr) {
      return {
        routedTo: fallback,
        success: false,
        reason: `primary_failed:${primaryReason}; fallback_failed:${fallbackErr.message}`,
      };
    }
  }
}

function makeTask(routing, dryRun = false) {
  return {
    id: "t1",
    name: "Test",
    dryRun,
    routing,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("routeOutput", () => {
  it("dry-run bypasses sendTo entirely", async () => {
    const calls = [];
    const send = async (dest) => calls.push(dest);
    const out = await routeOutput(
      makeTask({ destination: "teams-channel" }, true),
      "hi",
      send,
    );
    assert.equal(out.routedTo, "dry-run-log");
    assert.equal(out.success, true);
    assert.equal(calls.length, 0);
  });

  it("primary OK is reported as success", async () => {
    const send = async () => {};
    const out = await routeOutput(
      makeTask({ destination: "teams-channel" }),
      "hi",
      send,
    );
    assert.equal(out.routedTo, "teams-channel");
    assert.equal(out.success, true);
  });

  it("primary failure falls back to cosmos-log by default", async () => {
    const calls = [];
    const send = async (dest) => {
      calls.push(dest);
      if (dest === "teams-channel") throw new Error("429 rate-limited");
    };
    const out = await routeOutput(
      makeTask({ destination: "teams-channel" }),
      "hi",
      send,
    );
    assert.deepEqual(calls, ["teams-channel", "cosmos-log"]);
    assert.equal(out.routedTo, "cosmos-log");
    assert.equal(out.success, true);
    assert.match(out.reason, /primary_failed/);
  });

  it("primary failure with custom fallback uses that fallback", async () => {
    const calls = [];
    const send = async (dest) => {
      calls.push(dest);
      if (dest === "teams-channel") throw new Error("boom");
    };
    const out = await routeOutput(
      makeTask({ destination: "teams-channel", fallbackDestination: "email" }),
      "hi",
      send,
    );
    assert.equal(out.routedTo, "email");
    assert.equal(out.success, true);
  });

  it("both primary and fallback fail → success false", async () => {
    const send = async () => {
      throw new Error("nope");
    };
    const out = await routeOutput(
      makeTask({ destination: "teams-channel", fallbackDestination: "email" }),
      "hi",
      send,
    );
    assert.equal(out.success, false);
    assert.match(out.reason, /primary_failed.*fallback_failed/);
  });

  it("primary == fallback returns success false without retry loop", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const out = await routeOutput(
      makeTask({ destination: "cosmos-log", fallbackDestination: "cosmos-log" }),
      "hi",
      send,
    );
    assert.equal(calls, 1);
    assert.equal(out.success, false);
    assert.equal(out.routedTo, "cosmos-log");
  });
});
