import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      TRIAGE_CIRCUIT_BREAKER_THRESHOLD: 0.30,
      TRIAGE_CIRCUIT_BREAKER_WINDOW_MS: 15 * 60 * 1000,
      TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS: 30 * 60 * 1000,
    },
  };
});

import {
  checkCircuitBreaker,
  recordTriageOutcome,
  resetCircuitBreaker,
} from "../lib/triage-circuit-breaker";

describe("triage circuit breaker", () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  it("is closed when no outcomes are recorded", () => {
    expect(checkCircuitBreaker().open).toBe(false);
  });

  it("is closed when failure rate is below the threshold", () => {
    // 7 successes, 2 failures = 22% failure rate (below 30%)
    for (let i = 0; i < 7; i++) recordTriageOutcome(true);
    for (let i = 0; i < 2; i++) recordTriageOutcome(false);
    expect(checkCircuitBreaker().open).toBe(false);
  });

  it("trips when the failure rate reaches the threshold", () => {
    // 7 successes, 3 failures = 30% failure rate (at threshold)
    for (let i = 0; i < 7; i++) recordTriageOutcome(true);
    for (let i = 0; i < 3; i++) recordTriageOutcome(false);
    const result = checkCircuitBreaker();
    expect(result.open).toBe(true);
    expect(result.reason).toBe("circuit_breaker_open");
  });

  it("stays open after tripping until cooldown elapses", () => {
    for (let i = 0; i < 3; i++) recordTriageOutcome(true);
    for (let i = 0; i < 7; i++) recordTriageOutcome(false);
    expect(checkCircuitBreaker().open).toBe(true);
    // Still open on subsequent checks
    expect(checkCircuitBreaker().open).toBe(true);
  });

  it("resets on manual reset", () => {
    for (let i = 0; i < 10; i++) recordTriageOutcome(false);
    expect(checkCircuitBreaker().open).toBe(true);
    resetCircuitBreaker();
    expect(checkCircuitBreaker().open).toBe(false);
  });

  it("is closed after all successes", () => {
    for (let i = 0; i < 100; i++) recordTriageOutcome(true);
    expect(checkCircuitBreaker().open).toBe(false);
  });
});
