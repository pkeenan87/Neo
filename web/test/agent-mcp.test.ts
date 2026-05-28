import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../lib/types";

// ─────────────────────────────────────────────────────────────
//  Agent loop ↔ MCP integration:
//    1. Routing — when getMcpServers returns empty, the stable
//       client.messages.create is used; when it returns at
//       least one server, the beta path is used with
//       mcp_servers + betas in the params.
//    2. Audit — every mcp_tool_use block in the beta response
//       triggers a single mcp_invocation log event with the
//       documented shape, including blocked / success / error
//       discrimination based on the paired mcp_tool_result.
// ─────────────────────────────────────────────────────────────

const {
  capturedStableCalls,
  capturedBetaCalls,
  stableCreateMock,
  betaCreateMock,
  mcpServersReturn,
  enforceMock,
  loggerEvents,
} = vi.hoisted(() => {
  const capturedStableCalls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  // Beta type isn't easy to import in a hoisted block without circular
  // wrangling; use `unknown` and assert at the matcher boundary.
  const capturedBetaCalls: unknown[] = [];
  // The agent loop will read this on every iteration via the
  // getMcpServers mock. Tests rewrite it before each case.
  const mcpServersReturn: { current: unknown[] } = { current: [] };
  // Mocked response content — also reset per case.
  const responseContent: { current: unknown[] } = { current: [{ type: "text", text: "ok." }] };
  const stop: { current: string } = { current: "end_turn" };

  const buildResponse = (params: { model: string }) => ({
    id: "msg_01",
    type: "message" as const,
    role: "assistant" as const,
    model: params.model,
    content: responseContent.current,
    stop_reason: stop.current,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  });

  const stableCreateMock = vi.fn(async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
    capturedStableCalls.push(params);
    return buildResponse(params);
  });
  const betaCreateMock = vi.fn(async (params: { model: string }) => {
    capturedBetaCalls.push(params);
    return buildResponse(params);
  });

  const enforceMock = vi.fn((_role: string, _server: string, _tool: string) => true);

  const loggerEvents: Array<{ type: string; metadata?: Record<string, unknown> }> = [];

  return {
    capturedStableCalls,
    capturedBetaCalls,
    stableCreateMock,
    betaCreateMock,
    mcpServersReturn,
    responseContent,
    stop,
    enforceMock,
    loggerEvents,
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: stableCreateMock };
      beta = { messages: { create: betaCreateMock } };
    },
  };
});

vi.mock("../lib/mcp-servers", () => ({
  getMcpServers: vi.fn(async () => mcpServersReturn.current),
  enforceMcpToolAccess: enforceMock,
}));

vi.mock("../lib/context-manager", () => ({
  prepareMessages: vi.fn(async (messages: Message[]) => ({
    messages,
    trimmed: false,
    method: undefined,
    originalTokens: 0,
    newTokens: 0,
  })),
  sanitizeEmptyUserMessages: (messages: Message[]) => messages,
  CHARS_PER_TOKEN: 4,
  // Lightweight materialiser used by createWithOptionalMcp's
  // stable-API path (M1) when persisted MCP blocks are present.
  // Mirrors the real function's contract: convert mcp_tool_use /
  // mcp_tool_result blocks to text stubs, leave others alone.
  materializeMcpBlocksAsText: (messages: Message[]) =>
    messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const newContent = msg.content.map((block) => {
        const t = (block as { type: string }).type;
        if (t === "mcp_tool_use") {
          const b = block as { server_name?: string; name?: string; input?: unknown };
          return {
            type: "text" as const,
            text: `[MCP tool call ${b.server_name}.${b.name} input=${JSON.stringify(b.input ?? {})}]`,
          };
        }
        if (t === "mcp_tool_result") {
          const b = block as { content?: unknown };
          return {
            type: "text" as const,
            text: `[MCP tool result: ${typeof b.content === "string" ? b.content : ""}]`,
          };
        }
        return block;
      });
      return { ...msg, content: newContent };
    }),
}));

vi.mock("../lib/session-factory", () => ({
  sessionStore: {
    getInProgressPlan: vi.fn(async () => null),
    setInProgressPlan: vi.fn(async () => {}),
  },
}));

vi.mock("../lib/skill-store", () => ({
  getSkillsForRole: vi.fn(async () => []),
}));

vi.mock("../lib/logger", async () => {
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      emitEvent: vi.fn((type: string, _msg: string, _component: string, metadata?: Record<string, unknown>) => {
        loggerEvents.push({ type, metadata });
      }),
    },
    hashPii: actual.hashPii,
  };
});

beforeEach(() => {
  capturedStableCalls.length = 0;
  capturedBetaCalls.length = 0;
  stableCreateMock.mockClear();
  betaCreateMock.mockClear();
  enforceMock.mockClear();
  loggerEvents.length = 0;
  mcpServersReturn.current = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

import { runAgentLoop } from "../lib/agent";

// ── Routing ──────────────────────────────────────────────────

describe("agent loop — MCP routing", () => {
  it("always uses the beta messages.create path (extended-cache-ttl beta is always attached)", async () => {
    // P4: every call now routes through the beta API because we
    // unconditionally attach `extended-cache-ttl-2025-04-11` to enable
    // 1h TTL on cache breakpoints. Previously the stable path was used
    // when no MCP servers were configured.
    mcpServersReturn.current = [];
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1");
    expect(betaCreateMock).toHaveBeenCalledTimes(1);
    expect(stableCreateMock).not.toHaveBeenCalled();
  });

  it("uses the beta messages.create path when MCP servers are configured", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1");
    expect(betaCreateMock).toHaveBeenCalledTimes(1);
    expect(stableCreateMock).not.toHaveBeenCalled();
  });

  it("forwards mcp_servers and merges mcp-client + extended-cache-ttl betas on the beta call", async () => {
    const servers = [
      { type: "url" as const, name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    mcpServersReturn.current = servers;
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1");
    expect(capturedBetaCalls).toHaveLength(1);
    const params = capturedBetaCalls[0] as { mcp_servers?: unknown[]; betas?: string[] };
    expect(params.mcp_servers).toEqual(servers);
    // resolveBetas always prepends extended-cache-ttl, then mcp-client
    // when MCP is in scope. See P4.
    expect(params.betas).toContain("extended-cache-ttl-2025-04-11");
    expect(params.betas).toContain("mcp-client-2025-11-20");
  });

  it("attaches extended-cache-ttl beta even on non-MCP turns", async () => {
    mcpServersReturn.current = [];
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1");
    const params = capturedBetaCalls[capturedBetaCalls.length - 1] as { betas?: string[] };
    expect(params.betas).toContain("extended-cache-ttl-2025-04-11");
  });
});

// ── Audit ────────────────────────────────────────────────────

describe("agent loop — MCP audit emission", () => {
  function makeBetaResponseWithMcpBlocks(blocks: unknown[]): void {
    // The beta mock returns the shared response wrapper; rewrite its
    // content to inject the MCP blocks for this case.
    betaCreateMock.mockImplementationOnce(async (params: { model: string }) => ({
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: blocks,
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
  }

  it("emits one mcp_invocation event per mcp_tool_use block with result=success", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    makeBetaResponseWithMcpBlocks([
      {
        type: "mcp_tool_use",
        id: "tool_use_1",
        server_name: "wiz",
        name: "wiz_get_issues",
        input: {},
      },
      {
        type: "mcp_tool_result",
        tool_use_id: "tool_use_1",
        is_error: false,
        content: "ok",
      },
    ]);
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1", undefined, undefined, {
      ownerId: "alice",
    });
    const mcpEvents = loggerEvents.filter((e) => e.type === "mcp_invocation");
    expect(mcpEvents).toHaveLength(1);
    expect(mcpEvents[0].metadata).toMatchObject({
      mcpServer: "wiz",
      toolName: "wiz_get_issues",
      role: "admin",
      sessionId: "session-1",
      result: "success",
    });
    // turnDurationMs is the whole-turn wall-clock time of the
    // underlying createWithOptionalMcp call (not per-tool — see
    // review N1). The field name makes that explicit so downstream
    // dashboards don't read it as per-tool latency. We can't pin
    // an exact value but it must be present and non-negative.
    expect(typeof mcpEvents[0].metadata?.turnDurationMs).toBe("number");
    expect((mcpEvents[0].metadata?.turnDurationMs as number) >= 0).toBe(true);
    expect(mcpEvents[0].metadata?.durationMs).toBeUndefined();
  });

  it("emits result=error when the paired mcp_tool_result has is_error: true", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    makeBetaResponseWithMcpBlocks([
      {
        type: "mcp_tool_use",
        id: "tool_use_2",
        server_name: "wiz",
        name: "wiz_get_compliance",
        input: {},
      },
      {
        type: "mcp_tool_result",
        tool_use_id: "tool_use_2",
        is_error: true,
        content: "upstream Wiz API returned 500",
      },
    ]);
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1");
    const mcpEvents = loggerEvents.filter((e) => e.type === "mcp_invocation");
    expect(mcpEvents).toHaveLength(1);
    expect(mcpEvents[0].metadata?.result).toBe("error");
  });

  it("emits result=blocked when enforceMcpToolAccess says no", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    enforceMock.mockImplementationOnce(() => false);
    makeBetaResponseWithMcpBlocks([
      {
        type: "mcp_tool_use",
        id: "tool_use_3",
        server_name: "wiz",
        name: "wiz_get_blast_radius",
        input: {},
      },
      {
        type: "mcp_tool_result",
        tool_use_id: "tool_use_3",
        is_error: false,
        content: "(unexpected — Anthropic should have refused)",
      },
    ]);
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "session-1");
    const mcpEvents = loggerEvents.filter((e) => e.type === "mcp_invocation");
    expect(mcpEvents).toHaveLength(1);
    expect(mcpEvents[0].metadata?.result).toBe("blocked");
  });

  it("never emits raw ownerId in mcp_invocation metadata", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    makeBetaResponseWithMcpBlocks([
      {
        type: "mcp_tool_use",
        id: "tool_use_4",
        server_name: "wiz",
        name: "wiz_get_issues",
        input: {},
      },
      {
        type: "mcp_tool_result",
        tool_use_id: "tool_use_4",
        is_error: false,
        content: "ok",
      },
    ]);
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-1", undefined, undefined, {
      ownerId: "alice@example.com",
    });
    const mcpEvents = loggerEvents.filter((e) => e.type === "mcp_invocation");
    expect(JSON.stringify(mcpEvents[0].metadata)).not.toContain("alice@example.com");
    expect(mcpEvents[0].metadata?.ownerIdHash).toBeDefined();
  });
});

// ── Sanitize: mcp_tool_result content goes through injection guard ──

describe("agent loop — MCP sanitize on history-append", () => {
  it("wraps mcp_tool_result content in a trust-marked envelope before persisting", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    // Response with one MCP pair — content is plain (no injection
    // markers); envelope should still wrap it because the trust
    // boundary tag is informational, not gated on `flagged`.
    betaCreateMock.mockImplementationOnce(async (params: { model: string }) => ({
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: [
        {
          type: "mcp_tool_use",
          id: "tu_sanitize_1",
          server_name: "wiz",
          name: "wiz_get_issues",
          input: {},
        },
        {
          type: "mcp_tool_result",
          tool_use_id: "tu_sanitize_1",
          is_error: false,
          content: "A benign Wiz issue summary",
        },
      ],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "admin",
      "session-sanitize-1",
    );
    if (result.type !== "response") throw new Error("expected response");

    const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant")!;
    const content = lastAssistant.content as unknown as Array<Record<string, unknown>>;
    const mcpResult = content.find((b) => b.type === "mcp_tool_result")!;
    // Block type stays mcp_tool_result so future-turn round-trips
    // back to Anthropic remain API-valid.
    expect(mcpResult.type).toBe("mcp_tool_result");
    expect(typeof mcpResult.content).toBe("string");
    expect(mcpResult.content).toContain("_neo_trust_boundary");
    expect(mcpResult.content).toContain("mcp_external");
    expect(mcpResult.content).toContain("wiz");
    expect(mcpResult.content).toContain("wiz_get_issues");
    // The original data is preserved inside the envelope.
    expect(mcpResult.content).toContain("A benign Wiz issue summary");
  });

  it("does not wrap the response when no MCP servers are configured (stable-API path)", async () => {
    mcpServersReturn.current = [];
    stableCreateMock.mockImplementationOnce(async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => ({
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: [{ type: "text", text: "hi back" }],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    const result = await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "admin",
      "session-sanitize-2",
    );
    if (result.type !== "response") throw new Error("expected response");

    const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant")!;
    const content = lastAssistant.content as unknown as Array<Record<string, unknown>>;
    // Pure text response — no MCP blocks, no envelopes, no rewrite.
    expect(content[0].type).toBe("text");
    expect(JSON.stringify(content)).not.toContain("_neo_trust_boundary");
  });
});

// ── B1: destructive-tool slice preserves sanitized envelope ──────────

describe("agent loop — MCP sanitize survives destructive-tool slice (B1)", () => {
  it("when an MCP result and a destructive tool_use both appear in one turn, the persisted assistant message keeps the wrapped MCP envelope", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    // Response contains: mcp_tool_use, mcp_tool_result, then a
    // destructive tool_use. The destructive-tool path rewrites
    // localMessages with a slice up to the destructive block.
    // Before B1, the slice was taken from raw `response.content`,
    // throwing away the sanitized MCP envelope. After B1, it
    // slices the sanitized content so the envelope survives.
    betaCreateMock.mockImplementationOnce(async (params: { model: string }) => ({
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: [
        {
          type: "mcp_tool_use",
          id: "tu_mcp_1",
          server_name: "wiz",
          name: "wiz_get_issues",
          input: {},
        },
        {
          type: "mcp_tool_result",
          tool_use_id: "tu_mcp_1",
          is_error: false,
          content: "Wiz issue summary content",
        },
        {
          type: "tool_use",
          id: "tu_destructive",
          name: "isolate_machine",
          input: { machineId: "m1" },
        },
      ],
      stop_reason: "tool_use" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    const result = await runAgentLoop(
      [{ role: "user", content: "isolate m1 using wiz context" }],
      {},
      "admin",
      "session-b1-1",
    );
    if (result.type !== "confirmation_required") {
      throw new Error(`expected confirmation_required (destructive gate), got ${result.type}`);
    }

    const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant")!;
    const content = lastAssistant.content as unknown as Array<Record<string, unknown>>;
    // mcp_tool_result block survives the slice AND carries the
    // trust-boundary envelope (this is the B1 regression check).
    const mcpResult = content.find((b) => b.type === "mcp_tool_result");
    expect(mcpResult).toBeDefined();
    expect(typeof mcpResult!.content).toBe("string");
    expect(mcpResult!.content).toContain("_neo_trust_boundary");
    expect(mcpResult!.content).toContain("mcp_external");
  });
});

// ── M1: stable-API path materializes persisted MCP blocks ────────────

describe("agent loop — non-MCP turn coexists with stale MCP history (M1)", () => {
  it("converts mcp_tool_use / mcp_tool_result blocks to text when this turn has no MCP servers", async () => {
    // First turn — MCP configured, sets the history with MCP blocks.
    // Simulate by passing a history that already contains them.
    mcpServersReturn.current = [];
    // P4: every call now routes through the beta API (extended-cache-ttl
    // beta is unconditional). The MCP-blocks-to-text pre-flight still
    // runs when MCP isn't active for this turn — see
    // createWithOptionalMcp in agent.ts. The default betaCreateMock
    // pushes to capturedBetaCalls and returns an end_turn response,
    // so we don't need a one-shot override here.

    const messages = [
      { role: "user", content: "first message" },
      {
        role: "assistant",
        content: [
          { type: "mcp_tool_use", id: "tu_x", server_name: "wiz", name: "wiz_get_issues", input: {} },
          { type: "mcp_tool_result", tool_use_id: "tu_x", content: "earlier wiz result" },
        ],
      },
      { role: "user", content: "follow-up" },
    ] as Message[];

    await runAgentLoop(messages, {}, "admin", "session-m1");

    // The beta client should have been called with messages where
    // the MCP blocks have been materialized as text — otherwise the
    // API would 400 on unknown block types when MCP isn't active.
    expect(betaCreateMock).toHaveBeenCalledTimes(1);
    const calledParams = capturedBetaCalls[0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    const sentAssistantMsg = calledParams.messages.find((m) => m.role === "assistant");
    expect(sentAssistantMsg).toBeDefined();
    const sentContent = sentAssistantMsg!.content as unknown as Array<Record<string, unknown>>;
    // No MCP block types should reach the API when MCP servers aren't
    // configured for this turn.
    for (const block of sentContent) {
      expect(block.type).not.toBe("mcp_tool_use");
      expect(block.type).not.toBe("mcp_tool_result");
    }
    // The text stubs should mention the MCP origin so the model
    // still has context (lossy but coherent).
    const allText = sentContent
      .filter((b) => b.type === "text")
      .map((b) => b.text as string)
      .join("\n");
    expect(allText).toContain("MCP tool call");
    expect(allText).toContain("wiz_get_issues");
  });
});

// ── M2: compaction stop_reason clears inProgressPlan ─────────────────

describe("agent loop — compaction stop_reason clears inProgressPlan (M2)", () => {
  it("calls setInProgressPlan(null) when stop_reason is compaction", async () => {
    mcpServersReturn.current = [
      { type: "url", name: "wiz", url: "https://wiz.example.com/mcp", authorization_token: "tok" },
    ];
    // sessionStore is mocked at the top of this file — re-import to
    // grab the setInProgressPlan spy. The mock returns a Plan to
    // simulate an active plan being present.
    const { sessionStore } = await import("../lib/session-factory");
    (sessionStore.getInProgressPlan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planText: "step 1\nstep 2",
      resumptionCount: 0,
    });
    const setSpy = sessionStore.setInProgressPlan as ReturnType<typeof vi.fn>;
    setSpy.mockClear();

    betaCreateMock.mockImplementationOnce(async (params: { model: string }) => ({
      id: "msg_01",
      type: "message" as const,
      role: "assistant" as const,
      model: params.model,
      content: [{ type: "text", text: "compacted" }],
      stop_reason: "compaction" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    await runAgentLoop([{ role: "user", content: "hi" }], {}, "admin", "session-m2");

    // Plan should be cleared on compaction (was previously leaked).
    expect(setSpy).toHaveBeenCalledWith("session-m2", null);
  });
});
