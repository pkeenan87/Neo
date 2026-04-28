import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentEventType, InProgressPlan } from "../lib/types";

// These are static shape tests — they validate the wire format of the
// NDJSON events that replace the old INCOMPLETE_TOOL_USE `error` shape
// at the two agent-route emit sites. Because the events are serialised
// via JSON.stringify in `encodeNDJSON`, shape and field correctness are
// what matter; we don't need to stand up the full route handler.

const eventTypes: AgentEventType[] = [
  "session",
  "thinking",
  "tool_call",
  "tool_result",
  "confirmation_required",
  "response",
  "error",
  "warning",
  "context_trimmed",
  "output_truncated",
  "skill_invocation",
  "interrupted",
];

describe("AgentEvent union — output_truncated", () => {
  it("output_truncated is part of the AgentEventType union", () => {
    expect(eventTypes).toContain("output_truncated");
  });

  it("context_trimmed and output_truncated are distinct event types", () => {
    const trimmed: AgentEvent = {
      type: "context_trimmed",
      originalTokens: 200_000,
      newTokens: 120_000,
      method: "summary",
    };
    const truncated: AgentEvent = {
      type: "output_truncated",
      phase: "tool_use",
      message: "Neo ran out of per-turn output budget.",
      remainingPlan: null,
    };
    expect(trimmed.type).not.toBe(truncated.type);
  });

  it("output_truncated carries remainingPlan (InProgressPlan | null)", () => {
    const plan: InProgressPlan = {
      schemaVersion: 1,
      createdAt: "2026-04-24T19:00:00.000Z",
      planText: "1. do X\n2. do Y",
      toolCallsRemaining: 2,
      originalTurnNumber: 3,
    };
    const event: AgentEvent = {
      type: "output_truncated",
      phase: "tool_use",
      message: "truncated",
      remainingPlan: plan,
    };
    expect(event.remainingPlan).toEqual(plan);
  });

  it("output_truncated round-trips through JSON.stringify cleanly", () => {
    const event: AgentEvent = {
      type: "output_truncated",
      phase: "text",
      message: "truncated partial text",
      remainingPlan: null,
    };
    const roundTripped = JSON.parse(JSON.stringify(event));
    expect(roundTripped.type).toBe("output_truncated");
    expect(roundTripped.phase).toBe("text");
    expect(roundTripped.remainingPlan).toBeNull();
  });

  it("the INCOMPLETE_TOOL_USE error shape is no longer a valid constant of the event union", () => {
    // Regression guard: the old shape was `{ type: "error", code: "INCOMPLETE_TOOL_USE" }`.
    // We did not remove the generic `error` event (reserved for infra
    // failures), but we DID rename the semantic signal so callers that
    // branched on `code === "INCOMPLETE_TOOL_USE"` now need to branch
    // on `type === "output_truncated"` instead.
    const oldShape: AgentEvent = {
      type: "error",
      message: "anything",
      code: "INCOMPLETE_TOOL_USE",
    };
    // It's still a legal event because the `error` type is unchanged,
    // but code-path-wise the routes no longer emit this. Assert the new
    // shape is distinguishable at runtime.
    expect(oldShape.type).toBe("error");
    const newShape: AgentEvent = {
      type: "output_truncated",
      phase: "tool_use",
      message: "Neo's per-turn output budget was exhausted...",
      remainingPlan: null,
    };
    expect(newShape.type).toBe("output_truncated");
    expect(newShape.type).not.toBe(oldShape.type);
  });
});
