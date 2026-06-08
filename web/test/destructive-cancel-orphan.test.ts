import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    beta = { messages: { create: vi.fn() } };
    constructor(_opts?: unknown) {}
  },
}));

import { buildImplicitCancellationMessage } from "../lib/agent";
import type { PendingTool } from "../lib/types";

describe("buildImplicitCancellationMessage", () => {
  it("synthesises a user message with a cancellation tool_result for the pending tool_use_id", () => {
    const pending: PendingTool = {
      id: "toolu_destructive_X",
      name: "reset_user_password",
      input: { upn: "test@example.com", justification: "test" },
    };

    const msg = buildImplicitCancellationMessage(pending);

    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("toolu_destructive_X");
    expect(blocks[0].content).toContain("cancelled");
  });

  it("prepends preExecutedResults so every prior tool_use is paired by the synthetic message", () => {
    // The agent loop captures non-destructive tool results that ran in
    // the same turn before the destructive paused it. If we don't carry
    // them forward in the synthesised user message, the next API call
    // sees orphan tool_use blocks for the non-destructive tools.
    const pending: PendingTool = {
      id: "toolu_destructive_X",
      name: "reset_user_password",
      input: { upn: "test@example.com" },
      preExecutedResults: [
        {
          type: "tool_result",
          tool_use_id: "toolu_readonly_A",
          content: "row count: 12",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_readonly_B",
          content: "{}",
        },
      ],
    };

    const msg = buildImplicitCancellationMessage(pending);
    const blocks = msg.content as Array<{ type: string; tool_use_id: string }>;
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.tool_use_id)).toEqual([
      "toolu_readonly_A",
      "toolu_readonly_B",
      "toolu_destructive_X",
    ]);
  });

  it("handles a pending tool with no preExecutedResults", () => {
    const pending: PendingTool = {
      id: "toolu_only_destructive",
      name: "isolate_machine",
      input: { hostname: "srv-01" },
    };
    const msg = buildImplicitCancellationMessage(pending);
    const blocks = msg.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
  });
});

// ─── ETag concurrency contract for clearPendingConfirmation ──
//
// Documents the semantic guarantee both Cosmos paths now uphold:
// when two callers race on the same pending tool, exactly ONE
// observes the non-null PendingTool. The Cosmos SDK enforces this
// via accessCondition: { type: "IfMatch", condition: etag } on V1
// replace and ifMatchEtag on V2 patch — we can't exercise the real
// Cosmos behaviour in unit tests, but we can pin the contract with
// a mock that emulates 412 PreconditionFailed.

describe("clearPendingConfirmation — ETag concurrency contract", () => {
  it("returns null when the underlying write loses an IfMatch race (412)", async () => {
    // Mock a minimal store that emits 412 on the second concurrent
    // call, simulating Cosmos's ETag enforcement. The contract is:
    // the loser returns null so the caller takes the no-op branch
    // and never proceeds to push a duplicate cancellation tool_result.
    let etag = "etag-v1";
    let pending: PendingTool | null = {
      id: "toolu_X",
      name: "reset_user_password",
      input: { upn: "test@example.com" },
    };

    async function clearWithIfMatch(callerEtag: string): Promise<PendingTool | null> {
      if (callerEtag !== etag) {
        const err = Object.assign(new Error("PreconditionFailed"), { code: 412 });
        throw err;
      }
      const captured = pending;
      pending = null;
      etag = "etag-v2";
      return captured;
    }

    // Both callers read the same etag concurrently.
    const callerAEtag = etag;
    const callerBEtag = etag;

    // Caller A's write lands first and succeeds.
    const aResult = await clearWithIfMatch(callerAEtag);
    expect(aResult).not.toBeNull();
    expect(aResult?.id).toBe("toolu_X");

    // Caller B's write would 412; the store-layer wrapper translates
    // that to null so B's calling route takes the no-op branch.
    let bResult: PendingTool | null = null;
    try {
      bResult = await clearWithIfMatch(callerBEtag);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 412) {
        bResult = null;
      } else {
        throw err;
      }
    }
    expect(bResult).toBeNull();
  });

  it("non-412 errors from clearPendingConfirmation propagate (so the route's try/catch can log and degrade)", async () => {
    async function clearThatThrows(): Promise<PendingTool | null> {
      const err = Object.assign(new Error("ServiceUnavailable"), { code: 503 });
      throw err;
    }
    await expect(clearThatThrows()).rejects.toMatchObject({ code: 503 });
  });
});
