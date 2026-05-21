import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated etag-claim logic ──────────────────────────────
// Simulates Cosmos IfMatch behavior with an in-memory fake. Two
// concurrent claimers against the same task — exactly one must win.

class FakeCosmos {
  constructor() {
    this.items = new Map();
  }

  put(id, body) {
    const etag = `etag-${Math.random().toString(36).slice(2, 10)}`;
    this.items.set(id, { ...body, _etag: etag });
    return this.items.get(id);
  }

  read(id) {
    const v = this.items.get(id);
    if (!v) return null;
    return { ...v };
  }

  replace(id, body, expectedEtag) {
    const current = this.items.get(id);
    if (!current) throw Object.assign(new Error("not found"), { code: 404 });
    if (current._etag !== expectedEtag) {
      throw Object.assign(new Error("etag mismatch"), { code: 412 });
    }
    const etag = `etag-${Math.random().toString(36).slice(2, 10)}`;
    this.items.set(id, { ...body, _etag: etag });
    return this.items.get(id);
  }
}

class ScheduledTaskClaimConflict extends Error {
  constructor(taskId) {
    super(`Scheduled task ${taskId} was claimed by another worker`);
    this.name = "ScheduledTaskClaimConflict";
    this.taskId = taskId;
  }
}

const MAX_DURATION_SECONDS_CAP = 600;
const STUCK_RUNNING_CUTOFF_MS = MAX_DURATION_SECONDS_CAP * 2 * 1000;

async function claimTask(cosmos, task) {
  // Refuse to re-claim a task that is actively running. The watchdog path
  // (status='running' with lastRunTime older than the stuck cutoff) is the
  // only legitimate way to re-claim a running task.
  if (task.state.status === "running") {
    const lastRunMs = task.state.lastRunTime
      ? new Date(task.state.lastRunTime).getTime()
      : 0;
    if (Date.now() - lastRunMs < STUCK_RUNNING_CUTOFF_MS) {
      throw new ScheduledTaskClaimConflict(task.id);
    }
  }

  const claimed = {
    ...task,
    state: {
      ...task.state,
      status: "running",
      lastRunTime: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  try {
    return cosmos.replace(task.id, claimed, task._etag);
  } catch (err) {
    if (err.code === 412) throw new ScheduledTaskClaimConflict(task.id);
    throw err;
  }
}

const RUN_HISTORY_MAX = 50;
const RECORD_RUN_RESULT_MAX_RETRIES = 3;

async function recordRunResult(cosmos, task, runEntry, newState, newEnabled) {
  let current = task;
  for (let attempt = 0; attempt < RECORD_RUN_RESULT_MAX_RETRIES; attempt += 1) {
    const history = [...current.runHistory, runEntry];
    if (history.length > RUN_HISTORY_MAX) {
      history.splice(0, history.length - RUN_HISTORY_MAX);
    }
    const updated = {
      ...current,
      enabled: newEnabled ?? current.enabled,
      state: newState,
      runHistory: history,
      updatedAt: new Date().toISOString(),
    };
    try {
      return cosmos.replace(current.id, updated, current._etag);
    } catch (err) {
      if (err.code !== 412) throw err;
      const fresh = cosmos.read(current.id);
      if (!fresh) throw new Error("not_found");
      current = fresh;
    }
  }
  throw new ScheduledTaskClaimConflict(task.id);
}

// ── Tests ────────────────────────────────────────────────────

describe("etag-conditional claim", () => {
  it("first claim wins, second claim sees 412 → ScheduledTaskClaimConflict", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-1", {
      id: "task-1",
      enabled: true,
      state: { status: "idle", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });

    const initial = cosmos.read("task-1");
    const aliceView = { ...initial };
    const bobView = { ...initial };

    // Both Alice and Bob hold the same etag and try to claim.
    const aliceResult = await claimTask(cosmos, aliceView);
    assert.equal(aliceResult.state.status, "running");
    assert.notEqual(aliceResult._etag, initial._etag);

    await assert.rejects(
      () => claimTask(cosmos, bobView),
      (err) => err instanceof ScheduledTaskClaimConflict && err.taskId === "task-1",
    );
  });

  it("after a winning claim, a fresh read sees status=running", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-2", {
      id: "task-2",
      state: { status: "idle", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });
    const initial = cosmos.read("task-2");
    await claimTask(cosmos, initial);

    const fresh = cosmos.read("task-2");
    assert.equal(fresh.state.status, "running");
  });

  it("a claim retried with the refreshed etag succeeds", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-3", {
      id: "task-3",
      state: { status: "idle", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });

    // First claim flips to running with a new etag.
    let view = cosmos.read("task-3");
    await claimTask(cosmos, view);

    // Caller "releases" by writing status=idle with the new etag (mimics
    // recordRunResult). A fresh claim using the new etag must succeed.
    const afterFirst = cosmos.read("task-3");
    cosmos.replace(
      "task-3",
      { ...afterFirst, state: { ...afterFirst.state, status: "idle" } },
      afterFirst._etag,
    );

    view = cosmos.read("task-3");
    const second = await claimTask(cosmos, view);
    assert.equal(second.state.status, "running");
  });
});

describe("claimTask refuses currently-running tasks (H2)", () => {
  it("rejects a claim when status='running' and lastRunTime is recent", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-running", {
      id: "task-running",
      runHistory: [],
      state: {
        status: "running",
        nextRunTime: "2026-01-01T00:00:00Z",
        lastRunTime: new Date().toISOString(),
        consecutiveFailures: 0,
      },
    });
    const view = cosmos.read("task-running");
    await assert.rejects(
      () => claimTask(cosmos, view),
      (err) => err instanceof ScheduledTaskClaimConflict,
    );
  });

  it("allows a claim when status='running' but lastRunTime is past the stuck cutoff", async () => {
    const cosmos = new FakeCosmos();
    const longAgo = new Date(Date.now() - STUCK_RUNNING_CUTOFF_MS - 60_000).toISOString();
    cosmos.put("task-stuck", {
      id: "task-stuck",
      runHistory: [],
      state: {
        status: "running",
        nextRunTime: "2026-01-01T00:00:00Z",
        lastRunTime: longAgo,
        consecutiveFailures: 0,
      },
    });
    const view = cosmos.read("task-stuck");
    const claimed = await claimTask(cosmos, view);
    assert.equal(claimed.state.status, "running");
    // lastRunTime was refreshed to now
    const lastRunMs = new Date(claimed.state.lastRunTime).getTime();
    assert.ok(Date.now() - lastRunMs < 5000);
  });

  it("allows a claim when status='running' but lastRunTime is undefined (defensive)", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-no-lastrun", {
      id: "task-no-lastrun",
      runHistory: [],
      state: {
        status: "running",
        nextRunTime: "2026-01-01T00:00:00Z",
        consecutiveFailures: 0,
      },
    });
    const view = cosmos.read("task-no-lastrun");
    const claimed = await claimTask(cosmos, view);
    assert.equal(claimed.state.status, "running");
  });
});

describe("recordRunResult retry on 412 (C2)", () => {
  it("succeeds on first attempt when no concurrent writer", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-r1", {
      id: "task-r1",
      enabled: true,
      runHistory: [],
      state: { status: "running", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });
    const claimed = await claimTask(cosmos, cosmos.read("task-r1"));
    const result = await recordRunResult(
      cosmos,
      claimed,
      { runId: "run-1", startTime: "x", endTime: "y", result: "success", outputSummary: "", routedTo: "cosmos-log" },
      { status: "idle", nextRunTime: "2026-01-02T00:00:00Z", consecutiveFailures: 0 },
    );
    assert.equal(result.state.status, "idle");
    assert.equal(result.runHistory.length, 1);
  });

  it("retries with fresh etag when a concurrent admin patch lands between claim and finalize", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-r2", {
      id: "task-r2",
      enabled: true,
      runHistory: [],
      state: { status: "running", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });
    const claimed = await claimTask(cosmos, cosmos.read("task-r2"));

    // Concurrent admin patch: rename the task. This invalidates `claimed._etag`.
    const fresh = cosmos.read("task-r2");
    cosmos.replace("task-r2", { ...fresh, name: "Renamed" }, fresh._etag);

    // recordRunResult should retry with the new etag and succeed.
    const result = await recordRunResult(
      cosmos,
      claimed,
      { runId: "run-2", startTime: "x", endTime: "y", result: "success", outputSummary: "", routedTo: "cosmos-log" },
      { status: "idle", nextRunTime: "2026-01-02T00:00:00Z", consecutiveFailures: 0 },
    );
    assert.equal(result.state.status, "idle");
    assert.equal(result.name, "Renamed");
    assert.equal(result.runHistory.length, 1);
  });

  it("exhausts retries and throws when every attempt sees a 412", async () => {
    const cosmos = new FakeCosmos();
    cosmos.put("task-r3", {
      id: "task-r3",
      enabled: true,
      runHistory: [],
      state: { status: "running", nextRunTime: "2026-01-01T00:00:00Z", consecutiveFailures: 0 },
    });
    const claimed = await claimTask(cosmos, cosmos.read("task-r3"));

    // Monkey-patch replace to always return 412.
    const realReplace = cosmos.replace.bind(cosmos);
    cosmos.replace = () => {
      throw Object.assign(new Error("etag mismatch"), { code: 412 });
    };

    await assert.rejects(
      () => recordRunResult(
        cosmos,
        claimed,
        { runId: "run-3", startTime: "x", endTime: "y", result: "success", outputSummary: "", routedTo: "cosmos-log" },
        { status: "idle", nextRunTime: "2026-01-02T00:00:00Z", consecutiveFailures: 0 },
      ),
      (err) => err instanceof ScheduledTaskClaimConflict,
    );

    cosmos.replace = realReplace;
  });
});
