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

describe("Opus 4.7 1M context configuration (legacy resume path)", () => {
  // Post-Opus-4.8 migration, this whole file pins the LEGACY path
  // for conversations whose persisted `session.model` is the
  // `[1m]` sentinel. New conversations go through Opus 4.8 (see
  // opus-4-8-migration.test.ts). The legacy entries below MUST
  // keep working until the longest-running [1m] conversation has
  // aged past Cosmos TTL.
  it("SUPPORTED_MODELS still exposes the legacy Opus 4.7 1M option", () => {
    expect(SUPPORTED_MODELS["Opus (1M, legacy)"]).toBe("claude-opus-4-7[1m]");
  });

  it("TOKEN_PRICING still covers Opus 4.7 variants (legacy resumes need it)", () => {
    expect(TOKEN_PRICING["claude-opus-4-7"]).toEqual({ input: 15, output: 75 });
    expect(TOKEN_PRICING["claude-opus-4-7[1m]"]).toEqual({ input: 30, output: 150 });
  });

  it("MODEL_OUTPUT_CEILINGS still covers the legacy [1m] variant", () => {
    expect(MODEL_OUTPUT_CEILINGS["claude-opus-4-7[1m]"]).toBe(32_000);
  });

  it("isOneMillionContextModel matches [1m] suffix AND Opus 4.8 (the new 1M-by-default model)", () => {
    expect(isOneMillionContextModel("claude-opus-4-7[1m]")).toBe(true);
    expect(isOneMillionContextModel("claude-opus-4-8")).toBe(true);
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

describe("ContextTierSelector — legacy [1m] resume support", () => {
  // The selector lives in components/ but the model-id mapping is the
  // server-facing contract; tested at the data layer. Post-Opus-4.8
  // migration, modelIdForTier('1m') now resolves to Opus 4.8 (NEW
  // conversations), but tierForModelId STILL accepts legacy [1m]-
  // suffixed ids so resumed conversations land on the right selector
  // state. See opus-4-8-migration.test.ts for the forward mapping.
  it("tierForModelId collapses the legacy [1m] sentinel into '1m' on resume", async () => {
    const { tierForModelId } = await import(
      "../components/ContextTierSelector/ContextTierSelector"
    );
    expect(tierForModelId("claude-opus-4-7[1m]")).toBe("1m");
    // Bare Opus 4.7 (200K) is treated as a Sonnet-tier resume since
    // it never had a 1M context — no first-class option in the UI.
    expect(tierForModelId("claude-opus-4-7")).toBe("200k");
  });
});
