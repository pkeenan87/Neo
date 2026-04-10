import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Replicated env parsing logic from config.ts
function parseEnableUsageLimits(value) {
  return value !== "false";
}

// Replicated checkBudget early-return behavior
function simulatedCheckBudget(enforced, twoHourUsage, weeklyUsage, twoHourMax, weeklyMax) {
  if (!enforced) {
    return {
      allowed: true,
      twoHourRemaining: Infinity,
      weekRemaining: Infinity,
      warning: false,
      twoHourUsage,
      weeklyUsage,
    };
  }
  const twoHourRemaining = Math.max(0, twoHourMax - twoHourUsage.totalInputTokens);
  const weekRemaining = Math.max(0, weeklyMax - weeklyUsage.totalInputTokens);
  const twoHourExceeded = twoHourUsage.totalInputTokens >= twoHourMax;
  const weeklyExceeded = weeklyUsage.totalInputTokens >= weeklyMax;
  if (twoHourExceeded) {
    return { allowed: false, twoHourRemaining: 0, weekRemaining, warning: true, exceededWindow: "two-hour", twoHourUsage, weeklyUsage };
  }
  if (weeklyExceeded) {
    return { allowed: false, twoHourRemaining, weekRemaining: 0, warning: true, exceededWindow: "weekly", twoHourUsage, weeklyUsage };
  }
  return { allowed: true, twoHourRemaining, weekRemaining, warning: false, twoHourUsage, weeklyUsage };
}

describe("ENABLE_USAGE_LIMITS env parsing", () => {
  it("parses 'false' as disabled", () => {
    assert.equal(parseEnableUsageLimits("false"), false);
  });

  it("parses 'true' as enabled", () => {
    assert.equal(parseEnableUsageLimits("true"), true);
  });

  it("defaults to enabled when undefined", () => {
    assert.equal(parseEnableUsageLimits(undefined), true);
  });

  it("defaults to enabled when empty string", () => {
    assert.equal(parseEnableUsageLimits(""), true);
  });

  it("defaults to enabled for random string", () => {
    assert.equal(parseEnableUsageLimits("off"), true);
    assert.equal(parseEnableUsageLimits("no"), true);
    assert.equal(parseEnableUsageLimits("0"), true);
  });

  it("is case-sensitive — only exact 'false' disables", () => {
    assert.equal(parseEnableUsageLimits("False"), true);
    assert.equal(parseEnableUsageLimits("FALSE"), true);
  });
});

describe("checkBudget behavior when disabled", () => {
  const overLimitUsage = { totalInputTokens: 1_000_000 };
  const weeklyOverLimit = { totalInputTokens: 10_000_000 };
  const twoHourMax = 670_000;
  const weeklyMax = 6_700_000;

  it("returns allowed: true when usage exceeds 2-hour limit", () => {
    const result = simulatedCheckBudget(false, overLimitUsage, { totalInputTokens: 0 }, twoHourMax, weeklyMax);
    assert.equal(result.allowed, true);
  });

  it("returns allowed: true when usage exceeds weekly limit", () => {
    const result = simulatedCheckBudget(false, { totalInputTokens: 0 }, weeklyOverLimit, twoHourMax, weeklyMax);
    assert.equal(result.allowed, true);
  });

  it("returns Infinity for both remaining values", () => {
    const result = simulatedCheckBudget(false, overLimitUsage, weeklyOverLimit, twoHourMax, weeklyMax);
    assert.equal(result.twoHourRemaining, Infinity);
    assert.equal(result.weekRemaining, Infinity);
  });

  it("returns warning: false even at 100%", () => {
    const result = simulatedCheckBudget(false, overLimitUsage, weeklyOverLimit, twoHourMax, weeklyMax);
    assert.equal(result.warning, false);
  });

  it("still returns the actual usage summaries for reporting", () => {
    const result = simulatedCheckBudget(false, overLimitUsage, weeklyOverLimit, twoHourMax, weeklyMax);
    assert.equal(result.twoHourUsage.totalInputTokens, 1_000_000);
    assert.equal(result.weeklyUsage.totalInputTokens, 10_000_000);
  });
});

describe("checkBudget behavior when enabled", () => {
  const twoHourMax = 670_000;
  const weeklyMax = 6_700_000;

  it("blocks when 2-hour limit exceeded", () => {
    const result = simulatedCheckBudget(true, { totalInputTokens: 700_000 }, { totalInputTokens: 0 }, twoHourMax, weeklyMax);
    assert.equal(result.allowed, false);
    assert.equal(result.exceededWindow, "two-hour");
  });

  it("blocks when weekly limit exceeded", () => {
    const result = simulatedCheckBudget(true, { totalInputTokens: 0 }, { totalInputTokens: 7_000_000 }, twoHourMax, weeklyMax);
    assert.equal(result.allowed, false);
    assert.equal(result.exceededWindow, "weekly");
  });

  it("allows when under both limits", () => {
    const result = simulatedCheckBudget(true, { totalInputTokens: 100_000 }, { totalInputTokens: 500_000 }, twoHourMax, weeklyMax);
    assert.equal(result.allowed, true);
  });
});
