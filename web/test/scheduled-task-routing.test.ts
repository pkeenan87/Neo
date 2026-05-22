import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock executeTool so the routing layer dispatches to a stub. The
// real executeTool lives in executors.ts and would try to call
// ./mcp-client + ./infosec-auth — mocking at this seam keeps the
// tests focused on the routing layer's behaviour.
const { executeToolMock } = vi.hoisted(() => ({
  executeToolMock: vi.fn(),
}));
vi.mock("../lib/executors", () => ({
  executeTool: executeToolMock,
}));

// Mock postToChannel so the teams-channel destination tests don't
// hit Graph. Not needed for the tool tests but kept for parity.
const { postToChannelMock } = vi.hoisted(() => ({
  postToChannelMock: vi.fn(),
}));
vi.mock("../lib/teams-channel", () => ({
  postToChannel: postToChannelMock,
}));

// Mock the agent module — the routing layer imports
// `extractToolAuditExtras` from it for tool_execution emission.
// We don't want to load the full agent loop here.
vi.mock("../lib/agent", () => ({
  extractToolAuditExtras: vi.fn((result: unknown) => {
    if (!result || typeof result !== "object") return {};
    const r = result as Record<string, unknown>;
    return typeof r.responder === "string" ? { responder: r.responder } : {};
  }),
}));

// Mock integration registry for getToolIntegration.
vi.mock("../lib/integration-registry", () => ({
  getToolIntegration: vi.fn((toolName: string) =>
    toolName === "send_teams_message" || toolName === "send_email"
      ? "infosec-incident-response"
      : null,
  ),
}));

// Capture the log identity active inside executeTool so we can
// assert the routing layer wraps the dispatch with task.createdBy.
const logContextCapture: { last?: Record<string, unknown> } = {};
const { emitEventMock } = vi.hoisted(() => ({ emitEventMock: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: emitEventMock,
  },
  hashPii: (s: string) => `hashed-${s}`,
  // setLogContext: record the active context, run the callback
  // synchronously. The real impl uses AsyncLocalStorage; for the
  // routing tests we just need the args to be observable.
  setLogContext: vi.fn(<T,>(ctx: Record<string, unknown>, fn: () => T) => {
    logContextCapture.last = ctx;
    return fn();
  }),
  getLogContext: () => logContextCapture.last,
}));

import { routeOutput } from "../lib/scheduled-task-routing";
import type { ScheduledTask } from "../lib/scheduled-task-types";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Weekly lateral movement hunt",
    description: "test",
    createdBy: "owner@example.com",
    enabled: true,
    dryRun: false,
    schedule: { cronExpression: "0 8 * * 1", timezone: "UTC" },
    task: {
      promptTemplate: "x",
      variables: {},
      allowedTools: [],
      maxDurationSeconds: 60,
    },
    routing: {
      destination: "tool",
      toolName: "send_teams_message",
      fallbackDestination: "cosmos-log",
    },
    auth: { executionIdentity: "managed-identity", scopedPermissions: [] },
    state: {
      status: "idle",
      nextRunTime: "2026-06-01T00:00:00Z",
      consecutiveFailures: 0,
    },
    runHistory: [],
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  executeToolMock.mockReset();
  postToChannelMock.mockReset();
  emitEventMock.mockReset();
  logContextCapture.last = undefined;
  executeToolMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("routeOutput — tool destination happy path", () => {
  it("dispatches send_teams_message with title=task.name, status=success, body=output", async () => {
    const task = makeTask();
    const outcome = await routeOutput(task, "Found 0 indicators.");
    expect(outcome.success).toBe(true);
    expect(outcome.routedTo).toBe("send_teams_message");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const [toolName, args] = executeToolMock.mock.calls[0];
    expect(toolName).toBe("send_teams_message");
    expect(args).toEqual({
      title: "Weekly lateral movement hunt",
      status: "success",
      body: "Found 0 indicators.",
    });
  });

  it("wraps the dispatch in a log-context envelope rooted at createdByEmail when present", async () => {
    const task = makeTask({
      createdBy: "5a2c1d4e-9f01-4a55-b66a-7c3c1c9f0001",
      createdByEmail: "alice@example.com",
    });
    await routeOutput(task, "ok");
    expect(logContextCapture.last).toMatchObject({
      userEmail: "alice@example.com",
      userName: "alice@example.com",
      role: "admin",
    });
  });

  it("omits userEmail when createdBy is a GUID and createdByEmail is absent (F7)", async () => {
    const task = makeTask({
      createdBy: "5a2c1d4e-9f01-4a55-b66a-7c3c1c9f0001",
      createdByEmail: undefined,
    });
    await routeOutput(task, "ok");
    // userEmail must not be a GUID — it should be absent rather than
    // populated with a non-email value.
    expect(logContextCapture.last).toBeDefined();
    expect((logContextCapture.last as Record<string, unknown>).userEmail).toBeUndefined();
  });

  it("falls back to createdBy when it IS email-shaped and createdByEmail is absent", async () => {
    const task = makeTask({ createdBy: "legacy@example.com", createdByEmail: undefined });
    await routeOutput(task, "ok");
    expect(logContextCapture.last).toMatchObject({ userEmail: "legacy@example.com" });
  });

  it("summarises long output to OUTPUT_SUMMARY_MAX (2000) chars with truncation marker", async () => {
    const task = makeTask();
    const longText = "x".repeat(4000);
    await routeOutput(task, longText);
    const args = executeToolMock.mock.calls[0][1] as Record<string, string>;
    expect(args.body.endsWith("…[truncated]")).toBe(true);
    // 2000 chars + "\n…[truncated]" suffix.
    expect(args.body.length).toBe(2000 + "\n…[truncated]".length);
  });
});

describe("routeOutput — tool destination guardrails", () => {
  it("falls back to cosmos-log when toolName is not in ROUTING_ALLOWED_TOOLS", async () => {
    const task = makeTask({
      routing: {
        destination: "tool",
        toolName: "delete_indicator",
        fallbackDestination: "cosmos-log",
      },
    });
    const outcome = await routeOutput(task, "ok");
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(outcome.success).toBe(true); // cosmos-log fallback succeeds
    expect(outcome.routedTo).toBe("cosmos-log");
    expect(outcome.reason).toMatch(/primary_failed/);
    expect(outcome.reason).toMatch(/ROUTING_ALLOWED_TOOLS/);
  });

  it("falls back to cosmos-log when toolName is missing", async () => {
    const task = makeTask({
      routing: {
        destination: "tool",
        fallbackDestination: "cosmos-log",
      },
    });
    const outcome = await routeOutput(task, "ok");
    expect(executeToolMock).not.toHaveBeenCalled();
    expect(outcome.routedTo).toBe("cosmos-log");
    expect(outcome.reason).toMatch(/requires toolName/);
  });

  it("falls back to cosmos-log when executeTool throws", async () => {
    executeToolMock.mockRejectedValue(new Error("Logic App 503"));
    const task = makeTask();
    const outcome = await routeOutput(task, "ok");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(outcome.routedTo).toBe("cosmos-log");
    expect(outcome.success).toBe(true);
    expect(outcome.reason).toMatch(/primary_failed: Logic App 503/);
  });
});

describe("routeOutput — dry run", () => {
  it("skips executeTool entirely and records routedTo: dry-run-log", async () => {
    const task = makeTask({ dryRun: true });
    const outcome = await routeOutput(task, "ok");
    expect(outcome.routedTo).toBe("dry-run-log");
    expect(executeToolMock).not.toHaveBeenCalled();
  });
});

describe("routeOutput — empty agent output (F5)", () => {
  it("substitutes a sentinel body when summarised output is empty", async () => {
    const task = makeTask();
    await routeOutput(task, "");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const args = executeToolMock.mock.calls[0][1] as Record<string, string>;
    expect(args.body).toBe("(no narrative output produced by scheduled task run)");
  });

  it("substitutes a sentinel body when output is only whitespace", async () => {
    const task = makeTask();
    await routeOutput(task, "   \n\t\n  ");
    const args = executeToolMock.mock.calls[0][1] as Record<string, string>;
    expect(args.body).toBe("(no narrative output produced by scheduled task run)");
  });
});

describe("routeOutput — tool_execution audit emission (F1)", () => {
  it("emits a tool_execution event with status:success after a successful dispatch", async () => {
    executeToolMock.mockResolvedValue({
      status: "submitted",
      responder: "alice@example.com",
    });
    const task = makeTask();
    await routeOutput(task, "ok");
    expect(emitEventMock).toHaveBeenCalledWith(
      "tool_execution",
      expect.stringContaining("Tool completed"),
      "scheduled-task-routing",
      expect.objectContaining({
        toolName: "send_teams_message",
        toolCategory: "infosec-incident-response",
        isDestructive: false,
        status: "success",
        responder: "alice@example.com",
      }),
    );
  });

  it("emits a tool_execution event with status:error when the dispatch throws", async () => {
    executeToolMock.mockRejectedValue(new Error("Logic App 503"));
    const task = makeTask();
    await routeOutput(task, "ok");
    expect(emitEventMock).toHaveBeenCalledWith(
      "tool_execution",
      expect.stringContaining("Tool failed"),
      "scheduled-task-routing",
      expect.objectContaining({
        toolName: "send_teams_message",
        status: "error",
        errorMessage: expect.stringContaining("Logic App 503"),
      }),
    );
  });

  it("does NOT emit tool_execution on dry-run (no real dispatch)", async () => {
    const task = makeTask({ dryRun: true });
    await routeOutput(task, "ok");
    expect(emitEventMock).not.toHaveBeenCalledWith(
      "tool_execution",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
