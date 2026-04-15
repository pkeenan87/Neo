import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { CSVReference, Message } from "../lib/types";

// Mock the Anthropic SDK so we can spy on the tool list passed to messages.create.
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: (params: unknown) => createMock(params) };
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (x: string) => x,
  setLogContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
}));

vi.mock("../lib/context-manager", () => ({
  prepareMessages: async (messages: unknown[]) => ({
    messages,
    trimmed: false,
    originalTokens: 0,
    newTokens: 0,
  }),
  sanitizeEmptyUserMessages: (messages: Message[]) => messages,
  CHARS_PER_TOKEN: 4,
}));

import { runAgentLoop } from "../lib/agent";

function endTurnResponse(): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done", citations: null }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Messages.Message;
}

describe("query_csv conditional tool registration", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(endTurnResponse());
  });

  it("does NOT include query_csv when csvAttachments is undefined", async () => {
    await runAgentLoop([{ role: "user", content: "hi" }], {}, "reader", "s1");
    expect(createMock).toHaveBeenCalledOnce();
    const params = createMock.mock.calls[0][0] as { tools: { name: string }[] };
    const names = params.tools.map((t) => t.name);
    expect(names).not.toContain("query_csv");
  });

  it("does NOT include query_csv when csvAttachments is empty", async () => {
    await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s1",
      undefined,
      undefined,
      { csvAttachments: [] },
    );
    const params = createMock.mock.calls[0][0] as { tools: { name: string }[] };
    const names = params.tools.map((t) => t.name);
    expect(names).not.toContain("query_csv");
  });

  it("includes query_csv when the conversation has at least one CSV reference", async () => {
    const ref: CSVReference = {
      csvId: "abc",
      filename: "big.csv",
      blobUrl: "https://example.blob/csv/abc",
      rowCount: 1000,
      columns: ["id", "name"],
      sampleRows: [],
      createdAt: "2026-04-11T00:00:00Z",
    };
    await runAgentLoop(
      [{ role: "user", content: "hi" }],
      {},
      "reader",
      "s1",
      undefined,
      undefined,
      { csvAttachments: [ref] },
    );
    const params = createMock.mock.calls[0][0] as { tools: { name: string }[] };
    const names = params.tools.map((t) => t.name);
    expect(names).toContain("query_csv");
  });
});
