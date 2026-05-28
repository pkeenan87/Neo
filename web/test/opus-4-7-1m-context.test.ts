import { describe, it, expect } from "vitest";
import {
  SUPPORTED_MODELS,
  TOKEN_PRICING,
  MODEL_OUTPUT_CEILINGS,
  ONE_MILLION_CONTEXT_BUDGET,
  NEO_CONTEXT_MAX_INPUT_TOKENS,
  TRIM_TRIGGER_THRESHOLD,
  FIRST_MESSAGE_MAX_TOKENS,
  PER_TOOL_RESULT_TOKEN_CAP,
  getContextBudget,
  isOneMillionContextModel,
} from "../lib/config";

describe("Opus 4.7 1M context configuration", () => {
  it("SUPPORTED_MODELS exposes the 1M-context Opus 4.7 option", () => {
    expect(SUPPORTED_MODELS["Opus 4.7 (1M context)"]).toBe("claude-opus-4-7[1m]");
  });

  it("TOKEN_PRICING covers both Opus 4.7 variants and prices the 1M tier at 2x", () => {
    expect(TOKEN_PRICING["claude-opus-4-7"]).toEqual({ input: 15, output: 75 });
    expect(TOKEN_PRICING["claude-opus-4-7[1m]"]).toEqual({ input: 30, output: 150 });
  });

  it("MODEL_OUTPUT_CEILINGS covers the 1M-context variant", () => {
    expect(MODEL_OUTPUT_CEILINGS["claude-opus-4-7[1m]"]).toBe(32_000);
  });

  it("isOneMillionContextModel only matches the [1m] suffix", () => {
    expect(isOneMillionContextModel("claude-opus-4-7[1m]")).toBe(true);
    expect(isOneMillionContextModel("claude-opus-4-7")).toBe(false);
    expect(isOneMillionContextModel("claude-sonnet-4-6")).toBe(false);
    expect(isOneMillionContextModel("claude-opus-4-6")).toBe(false);
  });
});

describe("getContextBudget — model-aware thresholds", () => {
  it("returns the standard-tier budget for Sonnet", () => {
    const budget = getContextBudget("claude-sonnet-4-6");
    expect(budget.neoContextMaxInputTokens).toBe(NEO_CONTEXT_MAX_INPUT_TOKENS);
    expect(budget.trimTriggerThreshold).toBe(TRIM_TRIGGER_THRESHOLD);
    expect(budget.firstMessageMaxTokens).toBe(FIRST_MESSAGE_MAX_TOKENS);
    expect(budget.perToolResultTokenCap).toBe(PER_TOOL_RESULT_TOKEN_CAP);
  });

  it("returns the standard-tier budget for Opus 4.6 (no 1M variant)", () => {
    const budget = getContextBudget("claude-opus-4-6");
    expect(budget.neoContextMaxInputTokens).toBe(NEO_CONTEXT_MAX_INPUT_TOKENS);
  });

  it("returns the standard-tier budget for Opus 4.7 without the [1m] suffix", () => {
    const budget = getContextBudget("claude-opus-4-7");
    expect(budget.neoContextMaxInputTokens).toBe(NEO_CONTEXT_MAX_INPUT_TOKENS);
  });

  it("returns the 1M-tier budget only when the model id has the [1m] suffix", () => {
    const budget = getContextBudget("claude-opus-4-7[1m]");
    expect(budget.neoContextMaxInputTokens).toBe(ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens);
    expect(budget.trimTriggerThreshold).toBe(ONE_MILLION_CONTEXT_BUDGET.trimTriggerThreshold);
    expect(budget.firstMessageMaxTokens).toBe(ONE_MILLION_CONTEXT_BUDGET.firstMessageMaxTokens);
    expect(budget.perToolResultTokenCap).toBe(ONE_MILLION_CONTEXT_BUDGET.perToolResultTokenCap);
  });

  it("1M-tier budget sits between standard tier (180K) and the 1M model ceiling", () => {
    // Sanity envelope: trim must trigger before the ceiling, and the
    // ceiling must leave headroom below the actual 1M model limit.
    expect(ONE_MILLION_CONTEXT_BUDGET.trimTriggerThreshold).toBeLessThan(
      ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens,
    );
    expect(ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens).toBeLessThan(1_000_000);
    // Standard tier values are below their 1M-tier counterparts.
    expect(NEO_CONTEXT_MAX_INPUT_TOKENS).toBeLessThan(ONE_MILLION_CONTEXT_BUDGET.neoContextMaxInputTokens);
    expect(TRIM_TRIGGER_THRESHOLD).toBeLessThan(ONE_MILLION_CONTEXT_BUDGET.trimTriggerThreshold);
  });
});

describe("ContextTierSelector model mapping", () => {
  // The selector lives in components/ but the model-id mapping is the
  // server-facing contract; tested at the data layer.
  it("modelIdForTier maps '200k' to Sonnet and '1m' to Opus 4.7 [1m]", async () => {
    const { modelIdForTier, tierForModelId } = await import(
      "../components/ContextTierSelector/ContextTierSelector"
    );
    expect(modelIdForTier("200k")).toBe("claude-sonnet-4-6");
    expect(modelIdForTier("1m")).toBe("claude-opus-4-7[1m]");

    // Inverse mapping for conversation resume.
    expect(tierForModelId("claude-opus-4-7[1m]")).toBe("1m");
    expect(tierForModelId("claude-sonnet-4-6")).toBe("200k");
    expect(tierForModelId(undefined)).toBe("200k");
    expect(tierForModelId("claude-opus-4-7")).toBe("200k");
  });
});
