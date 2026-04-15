import { describe, it, expect, vi } from "vitest";

// context-manager eagerly instantiates an Anthropic client at module load.
// Mock the SDK so the import doesn't blow up in the test environment.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    constructor(_opts?: unknown) {}
  },
}));

import { sanitizeEmptyUserMessages } from "../lib/context-manager";
import type { Message } from "../lib/types";

const PLACEHOLDER = "[system: empty message placeholder — not user input]";

describe("sanitizeEmptyUserMessages", () => {
  it("coerces an empty string user message to a placeholder text block", () => {
    const input: Message[] = [
      { role: "user", content: "" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const out = sanitizeEmptyUserMessages(input);
    expect(out[0].content).toBe(PLACEHOLDER);
  });

  it("coerces whitespace-only user content to a placeholder", () => {
    const input: Message[] = [{ role: "user", content: "   \n\t  " }];
    const out = sanitizeEmptyUserMessages(input);
    expect(out[0].content).toBe(PLACEHOLDER);
  });

  it("coerces an empty-array user message to a placeholder text block", () => {
    const input: Message[] = [{ role: "user", content: [] }];
    const out = sanitizeEmptyUserMessages(input);
    const content = out[0].content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: PLACEHOLDER });
  });

  it("coerces an array of empty-text-only blocks to a placeholder", () => {
    const input: Message[] = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "  " }] },
    ];
    const out = sanitizeEmptyUserMessages(input);
    const content = out[0].content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe(PLACEHOLDER);
  });

  it("leaves non-empty string content unchanged (no false positives)", () => {
    const input: Message[] = [{ role: "user", content: "hello world" }];
    const out = sanitizeEmptyUserMessages(input);
    expect(out).toBe(input); // referential equality when nothing changed
    expect(out[0].content).toBe("hello world");
  });

  it("leaves array content with at least one non-text block unchanged (e.g. tool_result)", () => {
    const toolResult = {
      type: "tool_result" as const,
      tool_use_id: "tu_1",
      content: "result",
    };
    const input: Message[] = [{ role: "user", content: [toolResult] }];
    const out = sanitizeEmptyUserMessages(input);
    expect(out).toBe(input);
  });

  it("leaves array content with a mix of empty-text + real text blocks alone", () => {
    const input: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real content" },
        ],
      },
    ];
    const out = sanitizeEmptyUserMessages(input);
    expect(out).toBe(input);
  });

  it("does not touch assistant messages even when empty", () => {
    const input: Message[] = [
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
    ];
    const out = sanitizeEmptyUserMessages(input);
    expect(out).toBe(input);
    expect(out[0].content).toBe("");
  });
});
