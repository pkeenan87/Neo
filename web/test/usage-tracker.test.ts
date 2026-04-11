import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Cosmos DB before importing usage-tracker
const mockCreate = vi.fn().mockResolvedValue({});
const mockFetchAll = vi.fn().mockResolvedValue({ resources: [] });
const mockQuery = vi.fn().mockReturnValue({ fetchAll: mockFetchAll });

vi.mock("@azure/cosmos", () => {
  return {
    CosmosClient: class MockCosmosClient {
      constructor(_opts?: unknown) {}
      database(_name: string) {
        return {
          container(_name: string) {
            return {
              items: {
                create: mockCreate,
                query: mockQuery,
              },
            };
          },
        };
      }
    },
  };
});

vi.mock("@azure/identity", () => {
  return {
    ManagedIdentityCredential: class MockCredential {
      constructor() {}
    },
  };
});

// Override env to enable Cosmos
vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/",
      MOCK_MODE: false,
    },
  };
});

import { calculateCost, checkBudget } from "../lib/usage-tracker";
import type { TokenUsage } from "../lib/types";

// ── calculateCost ────────────────────────────────────────────

describe("calculateCost", () => {
  it("calculates correct cost for Sonnet", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    };
    // Sonnet: $3/M input + $15/M output
    const cost = calculateCost("claude-sonnet-4-6", usage);
    expect(cost).toBeCloseTo(3.0 + 1.5, 4);
  });

  it("calculates correct cost for Opus", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    };
    // Opus: $15/M input + $75/M output
    const cost = calculateCost("claude-opus-4-6", usage);
    expect(cost).toBeCloseTo(15.0 + 7.5, 4);
  });

  it("calculates correct cost for Haiku", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    };
    // Haiku: $0.80/M input + $4/M output
    const cost = calculateCost("claude-haiku-4-5-20251001", usage);
    expect(cost).toBeCloseTo(0.80 + 4.0, 4);
  });

  it("includes cache creation and read costs", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    // Sonnet: $3/M input + cache creation 1.25x ($3.75) + cache read 0.1x ($0.30)
    const cost = calculateCost("claude-sonnet-4-6", usage);
    expect(cost).toBeCloseTo(3.0 + 3.75 + 0.30, 4);
  });

  it("returns 0 for unknown model", () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
    expect(calculateCost("unknown-model", usage)).toBe(0);
  });
});

// ── checkBudget reset-marker handling ────────────────────────

describe("checkBudget with reset markers", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("treats usage before a reset marker as zero and uses marker time as window start", async () => {
    // checkBudget fans out two getUserUsageWithReset calls in parallel, each of
    // which first queries the latest reset marker and then the usage aggregate.
    // The two pairs interleave under Promise.all, so we dispatch by the query
    // body rather than by call order.
    const nowIso = new Date().toISOString();

    mockQuery.mockImplementation((spec: { query: string }) => ({
      fetchAll: async () => {
        // The reset-marker lookup is the only query that selects c.resetAt.
        if (spec.query.includes("c.resetAt")) {
          return { resources: [{ resetAt: nowIso }] };
        }
        // Aggregate query: no rows after the reset → empty summary.
        return { resources: [] };
      },
    }));

    const result = await checkBudget("00000000-0000-4000-8000-000000000001");

    expect(result.allowed).toBe(true);
    expect(result.twoHourUsage.totalInputTokens).toBe(0);
    expect(result.weeklyUsage.totalInputTokens).toBe(0);
    expect(result.twoHourUsage.callCount).toBe(0);
    expect(result.weeklyUsage.callCount).toBe(0);

    // Verify the aggregate queries used the marker timestamp as effective-since.
    const aggregateCalls = mockQuery.mock.calls.filter(
      ([callSpec]) => typeof callSpec?.query === "string" && callSpec.query.includes("SUM(c.usage.input_tokens)"),
    );
    expect(aggregateCalls).toHaveLength(2);
    for (const [callSpec] of aggregateCalls) {
      const sinceParam = (callSpec.parameters as { name: string; value: string }[]).find(
        (p) => p.name === "@since",
      );
      expect(sinceParam?.value).toBe(nowIso);
    }
  });

  it("falls back to the natural window when no reset marker exists", async () => {
    // Aggregate row used for both windows; checkBudget sums input_tokens.
    const aggregateRow = {
      totalInput: 5000,
      totalOutput: 1000,
      totalCacheRead: 0,
      totalCacheCreation: 0,
      callCount: 3,
    };

    mockQuery.mockImplementation((spec: { query: string }) => ({
      fetchAll: async () => {
        // No reset marker recorded for this user.
        if (spec.query.includes("c.resetAt")) {
          return { resources: [] };
        }
        return { resources: [aggregateRow] };
      },
    }));

    const beforeCallMs = Date.now();
    const result = await checkBudget("00000000-0000-4000-8000-000000000002");
    const afterCallMs = Date.now();

    expect(result.twoHourUsage.totalInputTokens).toBe(5000);
    expect(result.weeklyUsage.totalInputTokens).toBe(5000);
    expect(result.twoHourUsage.callCount).toBe(3);
    expect(result.weeklyUsage.callCount).toBe(3);

    // Verify @since was derived from the natural window (now - windowMs),
    // not from any reset marker. Allow a wide tolerance for clock drift.
    const aggregateCalls = mockQuery.mock.calls.filter(
      ([callSpec]) => typeof callSpec?.query === "string" && callSpec.query.includes("SUM(c.usage.input_tokens)"),
    );
    expect(aggregateCalls).toHaveLength(2);
    for (const [callSpec] of aggregateCalls) {
      const sinceParam = (callSpec.parameters as { name: string; value: string }[]).find(
        (p) => p.name === "@since",
      );
      expect(sinceParam?.value).toBeDefined();
      const sinceMs = new Date(sinceParam!.value).getTime();
      // @since must be strictly in the past (i.e., now - windowMs), not equal to "now".
      expect(sinceMs).toBeLessThan(beforeCallMs);
      // And no older than the weekly window + a small slack.
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      expect(sinceMs).toBeGreaterThanOrEqual(afterCallMs - weeklyMs - 1000);
    }
  });
});
