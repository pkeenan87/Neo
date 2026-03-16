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

import { calculateCost } from "../lib/usage-tracker";
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
