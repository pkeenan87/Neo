import { describe, it, expect } from "vitest";
import { validateRemediateInput } from "../lib/abnormal-helpers";
import { BatchTooLargeError } from "../lib/types";

const sampleMessage = (i: number) => ({
  message_id: `msg_${i}`,
  recipient_email: `user${i}@corp.com`,
});

describe("validateRemediateInput — batch preflight", () => {
  it("accepts batches at the cap boundary", () => {
    const messages = Array.from({ length: 20 }, (_, i) => sampleMessage(i));
    expect(() =>
      validateRemediateInput({ messages }, { maxExplicitMessages: 20 }),
    ).not.toThrow();
  });

  it("rejects batches over the cap with BatchTooLargeError", () => {
    const messages = Array.from({ length: 21 }, (_, i) => sampleMessage(i));
    try {
      validateRemediateInput({ messages }, { maxExplicitMessages: 20 });
      expect.fail("expected BatchTooLargeError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BatchTooLargeError);
      const e = err as BatchTooLargeError;
      expect(e.actual).toBe(21);
      expect(e.limit).toBe(20);
      expect(e.message).toMatch(/chunk/i);
    }
  });

  it("accepts remediate_all without a messages array when search_filters are provided", () => {
    expect(() =>
      validateRemediateInput({
        remediate_all: true,
        search_filters: { sender: "bad@example.com" },
      }),
    ).not.toThrow();
  });

  it("rejects remediate_all with no search_filters", () => {
    expect(() =>
      validateRemediateInput({ remediate_all: true }),
    ).toThrow(/search_filters/);
  });

  it("rejects empty messages when remediate_all is false", () => {
    expect(() =>
      validateRemediateInput({ messages: [] }),
    ).toThrow(/non-empty messages/);
  });

  it("skips the cap when maxExplicitMessages is not provided (backwards-compatible)", () => {
    const messages = Array.from({ length: 1000 }, (_, i) => sampleMessage(i));
    expect(() => validateRemediateInput({ messages })).not.toThrow();
  });
});
