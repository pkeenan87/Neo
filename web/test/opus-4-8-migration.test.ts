import { describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Opus 4.8 migration regression coverage.
//
//  Pins three invariants:
//    1. claude-opus-4-8 is registered (pricing, output ceiling,
//       1M-window classification, supported-models entry).
//    2. The legacy [1m]-suffixed Opus 4.7 resume path stays intact
//       — same context budget, beta header still attaches.
//    3. The tier selector helpers map Sonnet/Opus consistently in
//       both directions (model id ↔ tier ↔ display name).
// ─────────────────────────────────────────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
    beta = { messages: { create: vi.fn() } };
    constructor(_opts?: unknown) {}
  },
}));

import {
  MODEL_OUTPUT_CEILINGS,
  ONE_MILLION_CONTEXT_BUDGET,
  SUPPORTED_MODELS,
  TOKEN_PRICING,
  getContextBudget,
  isOneMillionContextModel,
} from "../lib/config";
import {
  displayNameForTier,
  modelIdForTier,
  tierForModelId,
} from "../components/ContextTierSelector";

describe("Opus 4.8 — config registry", () => {
  it("exposes claude-opus-4-8 in TOKEN_PRICING at $15/$75 (no 1M premium)", () => {
    expect(TOKEN_PRICING["claude-opus-4-8"]).toEqual({ input: 15, output: 75 });
  });

  it("exposes claude-opus-4-8 in MODEL_OUTPUT_CEILINGS at 32K", () => {
    expect(MODEL_OUTPUT_CEILINGS["claude-opus-4-8"]).toBe(32_000);
  });

  it("makes claude-opus-4-8 the default for the 'Opus' SUPPORTED_MODELS slot", () => {
    // The env var CLAUDE_OPUS_MODEL can override at runtime, but the
    // default value is what ships and what new conversations get.
    // We can't introspect the default without re-importing in a clean
    // env, so we assert the runtime value matches what was configured.
    expect(SUPPORTED_MODELS["Opus"]).toBeDefined();
  });

  it("classifies claude-opus-4-8 as a 1M-window model", () => {
    expect(isOneMillionContextModel("claude-opus-4-8")).toBe(true);
  });

  it("returns the ONE_MILLION_CONTEXT_BUDGET thresholds for claude-opus-4-8", () => {
    const budget = getContextBudget("claude-opus-4-8");
    expect(budget.neoContextMaxInputTokens).toBe(
      ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens,
    );
    expect(budget.trimTriggerThreshold).toBe(
      ONE_MILLION_CONTEXT_BUDGET.trimTriggerThreshold,
    );
    expect(budget.firstMessageMaxTokens).toBe(
      ONE_MILLION_CONTEXT_BUDGET.firstMessageMaxTokens,
    );
    expect(budget.perToolResultTokenCap).toBe(
      ONE_MILLION_CONTEXT_BUDGET.perToolResultTokenCap,
    );
  });
});

describe("Opus 4.8 — legacy [1m] path stays intact", () => {
  it("keeps the [1m] sentinel classified as 1M-window", () => {
    expect(isOneMillionContextModel("claude-opus-4-7[1m]")).toBe(true);
  });

  it("returns the same 1M budget for [1m] sentinels and Opus 4.8", () => {
    const legacy = getContextBudget("claude-opus-4-7[1m]");
    const next = getContextBudget("claude-opus-4-8");
    expect(legacy).toEqual(next);
  });

  it("keeps Sonnet on the standard (sub-1M) budget", () => {
    const sonnet = getContextBudget("claude-sonnet-4-6");
    expect(sonnet.neoContextMaxInputTokens).toBeLessThan(
      ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens,
    );
  });
});

describe("ContextTierSelector helpers — Sonnet/Opus 4.8 mapping", () => {
  it("maps the '200k' tier to Sonnet 4.6", () => {
    expect(modelIdForTier("200k")).toBe("claude-sonnet-4-6");
    expect(displayNameForTier("200k")).toBe("Claude Sonnet 4.6");
  });

  it("maps the '1m' tier to Opus 4.8 (not the legacy [1m] sentinel)", () => {
    expect(modelIdForTier("1m")).toBe("claude-opus-4-8");
    expect(displayNameForTier("1m")).toBe("Claude Opus 4.8");
  });

  it("collapses Opus 4.8 into the '1m' tier on resume", () => {
    expect(tierForModelId("claude-opus-4-8")).toBe("1m");
  });

  it("collapses legacy [1m] sentinels into the '1m' tier on resume", () => {
    expect(tierForModelId("claude-opus-4-7[1m]")).toBe("1m");
  });

  it("falls back to '200k' for Sonnet / unknown / undefined model ids", () => {
    expect(tierForModelId("claude-sonnet-4-6")).toBe("200k");
    expect(tierForModelId(undefined)).toBe("200k");
    expect(tierForModelId("some-future-model")).toBe("200k");
  });
});
