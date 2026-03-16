import crypto from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env, TOKEN_PRICING, USAGE_LIMITS, DEFAULT_MODEL } from "./config";
import { logger, hashPii } from "./logger";
import type { TokenUsage, UsageRecord, UsageSummary } from "./types";

// ─────────────────────────────────────────────────────────────
//  Cosmos DB container (lazy init)
// ─────────────────────────────────────────────────────────────

let _container: Container | null = null;

function getContainer(): Container | null {
  if (_container) return _container;

  const endpoint = env.COSMOS_ENDPOINT;
  // In mock mode or when Cosmos is not configured, usage tracking and
  // budget enforcement are disabled — all requests are allowed through.
  if (!endpoint || env.MOCK_MODE) return null;

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database("neo-db").container("usage-logs");
  return _container;
}

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────

// 90-day retention: covers budget windows (2h, 1w) plus historical cost reporting
const DEFAULT_TTL = 7_776_000;

const TWO_HOUR_MS = USAGE_LIMITS.twoHourWindow.windowMs;
const WEEKLY_MS = USAGE_LIMITS.weeklyWindow.windowMs;

// Estimated input tokens for a single agent turn, used as a pessimistic
// reservation before the agent loop runs. Settled with actual usage after.
const RESERVATION_ESTIMATE_TOKENS = 8_000;

// ─────────────────────────────────────────────────────────────
//  Record usage
// ─────────────────────────────────────────────────────────────

export async function recordUsage(
  userId: string,
  sessionId: string,
  model: string,
  usage: TokenUsage,
): Promise<void> {
  const container = getContainer();
  if (!container) return;

  const doc: UsageRecord = {
    id: `usage_${crypto.randomUUID()}`,
    userId,
    sessionId,
    model,
    usage,
    timestamp: new Date().toISOString(),
    ttl: DEFAULT_TTL,
  };

  try {
    await container.items.create(doc);
  } catch (err) {
    logger.warn("Failed to record usage", "usage-tracker", {
      errorMessage: (err as Error).message,
      userIdHash: hashPii(userId),
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  Pessimistic reservation
//
//  Before the agent loop runs, we write a reservation document
//  with an estimated token count. This ensures concurrent
//  requests from the same user see each other's reservations
//  and cannot all pass the budget gate simultaneously.
//  After the loop completes, the reservation is deleted and
//  replaced with actual usage records.
// ─────────────────────────────────────────────────────────────

export async function createReservation(
  userId: string,
  sessionId: string,
  model: string,
): Promise<string | null> {
  const container = getContainer();
  if (!container) return null;

  const reservationId = `reservation_${crypto.randomUUID()}`;
  const doc: UsageRecord = {
    id: reservationId,
    userId,
    sessionId,
    model,
    usage: {
      input_tokens: RESERVATION_ESTIMATE_TOKENS,
      output_tokens: 0,
    },
    timestamp: new Date().toISOString(),
    ttl: DEFAULT_TTL,
  };

  try {
    await container.items.create(doc);
    return reservationId;
  } catch (err) {
    logger.warn("Failed to create usage reservation", "usage-tracker", {
      errorMessage: (err as Error).message,
      userIdHash: hashPii(userId),
    });
    return null;
  }
}

export async function deleteReservation(
  reservationId: string,
  userId: string,
): Promise<void> {
  const container = getContainer();
  if (!container) return;

  try {
    await container.item(reservationId, userId).delete();
  } catch (err) {
    // Best-effort deletion — the reservation will expire via TTL if this fails
    logger.warn("Failed to delete usage reservation", "usage-tracker", {
      errorMessage: (err as Error).message,
      userIdHash: hashPii(userId),
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  Query usage within a rolling window (server-side aggregate)
// ─────────────────────────────────────────────────────────────

interface UsageAggregateRow {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  callCount: number;
}

export async function getUserUsage(
  userId: string,
  windowMs: number,
): Promise<UsageSummary> {
  const container = getContainer();
  const empty: UsageSummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    callCount: 0,
    estimatedCostUsd: 0,
  };

  if (!container) return empty;

  const since = new Date(Date.now() - windowMs).toISOString();

  try {
    const { resources } = await container.items
      .query<UsageAggregateRow>({
        query: `
          SELECT
            SUM(c.usage.input_tokens) AS totalInput,
            SUM(c.usage.output_tokens) AS totalOutput,
            SUM(IS_DEFINED(c.usage.cache_read_input_tokens) ? c.usage.cache_read_input_tokens : 0) AS totalCacheRead,
            SUM(IS_DEFINED(c.usage.cache_creation_input_tokens) ? c.usage.cache_creation_input_tokens : 0) AS totalCacheCreation,
            COUNT(1) AS callCount
          FROM c
          WHERE c.userId = @userId AND c.timestamp >= @since
        `,
        parameters: [
          { name: "@userId", value: userId },
          { name: "@since", value: since },
        ],
      })
      .fetchAll();

    const row = resources[0];
    if (!row || row.callCount === 0) return empty;

    // Estimate cost from aggregated totals using the default model pricing
    // (we can't do per-model pricing in a single aggregate query, but this
    // is close enough for budget display purposes)
    const defaultPricing = TOKEN_PRICING[env.MOCK_MODE ? "" : DEFAULT_MODEL] ?? { input: 3, output: 15 };
    const estimatedCost =
      ((row.totalInput ?? 0) / 1_000_000) * defaultPricing.input +
      ((row.totalOutput ?? 0) / 1_000_000) * defaultPricing.output +
      ((row.totalCacheCreation ?? 0) / 1_000_000) * defaultPricing.input * 1.25 +
      ((row.totalCacheRead ?? 0) / 1_000_000) * defaultPricing.input * 0.10;

    return {
      totalInputTokens: row.totalInput ?? 0,
      totalOutputTokens: row.totalOutput ?? 0,
      totalCacheReadTokens: row.totalCacheRead ?? 0,
      callCount: row.callCount,
      estimatedCostUsd: estimatedCost,
    };
  } catch (err) {
    logger.warn("Failed to query usage", "usage-tracker", {
      errorMessage: (err as Error).message,
      userIdHash: hashPii(userId),
    });
    return empty;
  }
}

// ─────────────────────────────────────────────────────────────
//  Budget check (returns usage summaries to avoid re-querying)
// ─────────────────────────────────────────────────────────────

export interface BudgetResult {
  allowed: boolean;
  twoHourRemaining: number;
  weekRemaining: number;
  warning: boolean;
  exceededWindow?: "two-hour" | "weekly";
  twoHourUsage: UsageSummary;
  weeklyUsage: UsageSummary;
}

const EMPTY_SUMMARY: UsageSummary = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  callCount: 0,
  estimatedCostUsd: 0,
};

export async function checkBudget(userId: string): Promise<BudgetResult> {
  const container = getContainer();
  if (!container) {
    return {
      allowed: true,
      twoHourRemaining: Infinity,
      weekRemaining: Infinity,
      warning: false,
      twoHourUsage: EMPTY_SUMMARY,
      weeklyUsage: EMPTY_SUMMARY,
    };
  }

  const [twoHour, weekly] = await Promise.all([
    getUserUsage(userId, TWO_HOUR_MS),
    getUserUsage(userId, WEEKLY_MS),
  ]);

  const twoHourMax = USAGE_LIMITS.twoHourWindow.maxInputTokens;
  const weeklyMax = USAGE_LIMITS.weeklyWindow.maxInputTokens;

  const twoHourRemaining = Math.max(0, twoHourMax - twoHour.totalInputTokens);
  const weekRemaining = Math.max(0, weeklyMax - weekly.totalInputTokens);

  const twoHourExceeded = twoHour.totalInputTokens >= twoHourMax;
  const weeklyExceeded = weekly.totalInputTokens >= weeklyMax;

  const twoHourWarning = twoHour.totalInputTokens >= twoHourMax * USAGE_LIMITS.warningThreshold;
  const weeklyWarning = weekly.totalInputTokens >= weeklyMax * USAGE_LIMITS.warningThreshold;

  if (twoHourExceeded) {
    return { allowed: false, twoHourRemaining: 0, weekRemaining, warning: true, exceededWindow: "two-hour", twoHourUsage: twoHour, weeklyUsage: weekly };
  }
  if (weeklyExceeded) {
    return { allowed: false, twoHourRemaining, weekRemaining: 0, warning: true, exceededWindow: "weekly", twoHourUsage: twoHour, weeklyUsage: weekly };
  }

  return {
    allowed: true,
    twoHourRemaining,
    weekRemaining,
    warning: twoHourWarning || weeklyWarning,
    twoHourUsage: twoHour,
    weeklyUsage: weekly,
  };
}

// ─────────────────────────────────────────────────────────────
//  Cost calculation (includes cache creation and read pricing)
// ─────────────────────────────────────────────────────────────

export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = TOKEN_PRICING[model];
  if (!pricing) return 0;

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.input * 1.25;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.input * 0.10;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
