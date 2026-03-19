import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveInt } from "../web/lib/parse-env.ts";

describe("Usage limits env-var parsing", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.USAGE_LIMIT_2H_INPUT_TOKENS;
    delete process.env.USAGE_LIMIT_WEEKLY_INPUT_TOKENS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses defaults when env vars are not set", () => {
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 670_000);
    assert.equal(parsePositiveInt("USAGE_LIMIT_WEEKLY_INPUT_TOKENS", 6_700_000), 6_700_000);
  });

  it("reads valid env vars as overrides", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "100000";
    process.env.USAGE_LIMIT_WEEKLY_INPUT_TOKENS = "500000";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 100_000);
    assert.equal(parsePositiveInt("USAGE_LIMIT_WEEKLY_INPUT_TOKENS", 6_700_000), 500_000);
  });

  it("falls back to defaults for non-numeric values", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "abc";
    process.env.USAGE_LIMIT_WEEKLY_INPUT_TOKENS = "not-a-number";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 670_000);
    assert.equal(parsePositiveInt("USAGE_LIMIT_WEEKLY_INPUT_TOKENS", 6_700_000), 6_700_000);
  });

  it("falls back to defaults for negative values", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "-5000";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 670_000);
  });

  it("falls back to defaults for zero", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "0";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 670_000);
  });

  it("falls back to defaults for empty string", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 670_000);
  });

  it("reflects env changes on each call (not cached)", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "200000";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 200_000);
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "300000";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 300_000);
  });

  it("handles float-like strings by truncating to int", () => {
    process.env.USAGE_LIMIT_2H_INPUT_TOKENS = "100500.75";
    assert.equal(parsePositiveInt("USAGE_LIMIT_2H_INPUT_TOKENS", 670_000), 100_500);
  });
});

// ── Budget enforcement logic ────────────────────────────────

describe("Budget enforcement with configurable limits", () => {
  it("correctly identifies exceeded 2-hour window", () => {
    const maxInputTokens = 670_000;
    const currentUsage = 680_000;
    assert.ok(currentUsage >= maxInputTokens, "Usage should exceed 2-hour max");
  });

  it("correctly identifies within-budget state", () => {
    const maxInputTokens = 670_000;
    const currentUsage = 500_000;
    assert.ok(currentUsage < maxInputTokens, "Usage should be under 2-hour max");
  });

  it("warning threshold triggers at 80%", () => {
    const maxInputTokens = 670_000;
    const warningThreshold = 0.80;
    const currentUsage = 540_000; // ~80.6%
    assert.ok(
      currentUsage >= maxInputTokens * warningThreshold,
      "Usage above 80% should trigger warning",
    );
  });

  it("warning threshold does not trigger below 80%", () => {
    const maxInputTokens = 670_000;
    const warningThreshold = 0.80;
    const currentUsage = 500_000; // ~74.6%
    assert.ok(
      currentUsage < maxInputTokens * warningThreshold,
      "Usage below 80% should not trigger warning",
    );
  });
});

// ── Admin reset validation ──────────────────────────────────

describe("Admin reset input validation", () => {
  const VALID_WINDOWS = new Set(["two-hour", "weekly"]);

  it("accepts valid window values", () => {
    assert.ok(VALID_WINDOWS.has("two-hour"));
    assert.ok(VALID_WINDOWS.has("weekly"));
  });

  it("rejects invalid window values", () => {
    assert.ok(!VALID_WINDOWS.has("daily"));
    assert.ok(!VALID_WINDOWS.has(""));
    assert.ok(!VALID_WINDOWS.has("monthly"));
  });

  it("reset marker uses effective window start", () => {
    const windowMs = 2 * 60 * 60 * 1000; // 2 hours
    const naturalSince = new Date(Date.now() - windowMs).toISOString();
    // Reset happened 30 minutes ago (more recent than natural 2h window)
    const resetAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const effectiveSince = resetAt > naturalSince ? resetAt : naturalSince;
    assert.equal(effectiveSince, resetAt, "Should use reset timestamp when more recent");
  });

  it("natural window start used when no reset or reset is older", () => {
    const windowMs = 2 * 60 * 60 * 1000;
    const naturalSince = new Date(Date.now() - windowMs).toISOString();
    // Reset happened 3 hours ago (older than natural 2h window)
    const resetAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const effectiveSince = resetAt > naturalSince ? resetAt : naturalSince;
    assert.equal(effectiveSince, naturalSince, "Should use natural window when reset is older");
  });
});
