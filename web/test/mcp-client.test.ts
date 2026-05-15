import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy, errorSpy, infoSpy, debugSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy,
    emitEvent: vi.fn(),
  },
}));

import {
  McpClient,
  getMcpClient,
  __resetMcpClientCache,
  INFOSEC_LOGIC_APP_URL_ALLOWLIST,
} from "../lib/mcp-client";

const ALLOWED_URL = Array.from(INFOSEC_LOGIC_APP_URL_ALLOWLIST)[0]!;

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = global.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  debugSpy.mockClear();
  __resetMcpClientCache();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonRpcSuccess(id: number, content: unknown[]): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, result: { content } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function initializeOk(sessionId = "session-123"): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "test-server", version: "1.0" },
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
    },
  );
}

function initializedAck(): Response {
  return new Response(null, { status: 202 });
}

function makeClient(): McpClient {
  return new McpClient({
    url: ALLOWED_URL,
    authStrategy: {
      type: "bearer",
      tokenFactory: async () => "test-bearer",
    },
    clientInfo: { name: "neo-test", version: "1.0.0" },
  });
}

// ── Construction ─────────────────────────────────────────────

describe("McpClient construction", () => {
  it("throws when the URL is not in the allowlist", () => {
    expect(
      () =>
        new McpClient({
          url: "https://attacker.example.com/mcp",
          authStrategy: { type: "bearer", tokenFactory: async () => "x" },
          clientInfo: { name: "neo-test", version: "1.0.0" },
        }),
    ).toThrow(/not in INFOSEC_LOGIC_APP_URL_ALLOWLIST/);
  });
});

// ── Handshake ────────────────────────────────────────────────

describe("McpClient handshake", () => {
  it("runs initialize → notifications/initialized → tools/call in that order", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-1"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, [{ type: "text", text: "ok" }]));

    const client = makeClient();
    await client.callTool("noop", { foo: "bar" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(initBody.method).toBe("initialize");
    expect(initBody.params.protocolVersion).toBe("2025-06-18");
    const ackBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(ackBody.method).toBe("notifications/initialized");
    const callBody = JSON.parse(fetchMock.mock.calls[2][1]?.body as string);
    expect(callBody.method).toBe("tools/call");
    expect(callBody.params.name).toBe("noop");
    expect(callBody.params.arguments).toEqual({ foo: "bar" });
  });

  it("propagates the Mcp-Session-Id on every post-initialize request", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-2"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, []));

    await makeClient().callTool("noop", {});

    const ackHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    const callHeaders = fetchMock.mock.calls[2][1]?.headers as Record<string, string>;
    expect(ackHeaders["Mcp-Session-Id"]).toBe("S-2");
    expect(callHeaders["Mcp-Session-Id"]).toBe("S-2");
    const initHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(initHeaders["Mcp-Session-Id"]).toBeUndefined();
  });

  it("throws when initialize succeeds but Mcp-Session-Id is absent from the response", async () => {
    const noSession = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    fetchMock.mockResolvedValueOnce(noSession);

    await expect(makeClient().callTool("noop", {})).rejects.toThrow(
      /did not return an Mcp-Session-Id/,
    );
  });

  it("concurrent first-turn callers share one handshake", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-3"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, []));
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(100, []));

    const client = makeClient();
    await Promise.all([client.callTool("a", {}), client.callTool("b", {})]);

    // 1 initialize + 1 ack + 2 tools/call = 4 fetches
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const initializeCalls = fetchMock.mock.calls.filter((c) => {
      const body = JSON.parse(c[1]?.body as string);
      return body.method === "initialize";
    });
    expect(initializeCalls).toHaveLength(1);
  });
});

// ── Auth strategies ──────────────────────────────────────────

describe("McpClient auth strategies", () => {
  it("bearer strategy sets Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk());
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, []));

    await makeClient().callTool("noop", {});
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-bearer");
  });

  it("customHeaders strategy applies the header map and omits Authorization", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk());
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, []));

    const client = new McpClient({
      url: ALLOWED_URL,
      authStrategy: {
        type: "customHeaders",
        headerFactory: async () => ({
          "X-Custom-A": "alpha",
          "X-Custom-B": "beta",
        }),
      },
      clientInfo: { name: "neo-test", version: "1.0.0" },
    });
    await client.callTool("noop", {});

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Custom-A"]).toBe("alpha");
    expect(headers["X-Custom-B"]).toBe("beta");
    expect(headers.Authorization).toBeUndefined();
  });
});

// ── 401 retry ────────────────────────────────────────────────

describe("McpClient 401 retry", () => {
  it("re-handshakes on 401 and retries the tools/call once", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-A"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    fetchMock.mockResolvedValueOnce(initializeOk("S-B"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, [{ type: "text", text: "retry-ok" }]));

    const result = await makeClient().callTool("noop", {});
    expect(result.content).toEqual([{ type: "text", text: "retry-ok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("401 on tools/call"),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("a second 401 surfaces as a tool error", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-A"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(new Response("u", { status: 401 }));
    fetchMock.mockResolvedValueOnce(initializeOk("S-B"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(new Response("still-u", { status: 401 }));

    await expect(makeClient().callTool("noop", {})).rejects.toThrow(/rejected after retry/);
  });

  // 403 means the bearer is valid but the caller lacks permission. A
  // retry won't fix that — it just doubles the request volume. The
  // earlier impl retried 401 || 403; the fix narrows it to 401 only.
  // See ultra-review MEDIUM #6.
  it("does NOT retry on 403 — surfaces the original error immediately", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-A"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(makeClient().callTool("noop", {})).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initialize + ack + 403 only
  });
});

// ── Correlation headers ──────────────────────────────────────

describe("McpClient correlation header capture", () => {
  it("returns the Azure API Management correlation headers from the tools/call response", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-XYZ"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { content: [] } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-ms-request-id": "amreq-42",
          "x-ms-middleware-request-id": "midware-7",
          "Workflow-Run-Id": "wf-run-99",
        },
      }),
    );

    const result = await makeClient().callTool("noop", {});
    expect(result.correlationHeaders).toEqual({
      apiManagementRequestId: "amreq-42",
      apiManagementMiddlewareRequestId: "midware-7",
      workflowRunId: "wf-run-99",
      mcpSessionId: "S-XYZ",
    });
  });
});

// ── SSE response handling ────────────────────────────────────

describe("McpClient SSE response handling", () => {
  it("consumes the last data: event from a text/event-stream response", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk());
    fetchMock.mockResolvedValueOnce(initializedAck());
    const sseBody = [
      "event: progress",
      "data: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"content\":[]}}",
      "",
      "event: complete",
      "data: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"final\"}]}}",
      "",
    ].join("\n");
    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const result = await makeClient().callTool("noop", {});
    expect(result.content).toEqual([{ type: "text", text: "final" }]);
  });
});

// ── JSON-RPC error envelope ──────────────────────────────────

describe("McpClient JSON-RPC error envelope", () => {
  it("throws when the response carries a JSON-RPC error object", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk());
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          error: { code: -32602, message: "Invalid params" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(makeClient().callTool("noop", {})).rejects.toThrow(/-32602.*Invalid params/);
  });
});

// ── reset() and registry ─────────────────────────────────────

describe("McpClient.reset and getMcpClient", () => {
  it("reset() forces a fresh handshake on the next call", async () => {
    fetchMock.mockResolvedValueOnce(initializeOk("S-A"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(99, []));
    fetchMock.mockResolvedValueOnce(initializeOk("S-B"));
    fetchMock.mockResolvedValueOnce(initializedAck());
    fetchMock.mockResolvedValueOnce(jsonRpcSuccess(100, []));

    const client = makeClient();
    await client.callTool("noop", {});
    client.reset();
    await client.callTool("noop", {});

    const initCalls = fetchMock.mock.calls.filter((c) => {
      const body = JSON.parse(c[1]?.body as string);
      return body.method === "initialize";
    });
    expect(initCalls).toHaveLength(2);
  });

  it("getMcpClient memoises one client per URL", () => {
    const a = getMcpClient(ALLOWED_URL, {
      type: "bearer",
      tokenFactory: async () => "t",
    });
    const b = getMcpClient(ALLOWED_URL, {
      type: "bearer",
      tokenFactory: async () => "t",
    });
    expect(a).toBe(b);
  });
});
