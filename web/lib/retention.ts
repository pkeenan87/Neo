import type { RetentionClass } from "./types";

// ─────────────────────────────────────────────────────────────
//  Retention policy helper
//
//  A conversation's `retentionClass` on the root document drives both
//  the Cosmos `ttl` (seconds) stamped on every doc in that partition
//  AND the Azure Blob Storage lifecycle tagging for any offloaded
//  tool-result blobs referenced by that conversation. Aligns Neo's
//  storage lifetime with Goodwin's records-policy categories.
// ─────────────────────────────────────────────────────────────

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

/**
 * Sentinel value Cosmos uses on a document's `ttl` field to mean "never
 * expire, even if the container has a default TTL set". Exported as a
 * named constant for readability at call sites, but `resolveRetentionTtlSeconds`
 * already returns this value directly for legal-hold — callers don't
 * need to translate.
 */
export const COSMOS_TTL_NEVER = -1;

/**
 * Cosmos TTL in seconds for a given retention class. Callers can pass
 * the return value straight through to the Cosmos SDK's `ttl` field:
 *   - standard-7y / client-matter → 7 years
 *   - transient → 30 days
 *   - legal-hold → -1 (Cosmos "never expire" sentinel)
 */
export function resolveRetentionTtlSeconds(retentionClass: RetentionClass): number {
  switch (retentionClass) {
    case "standard-7y":
      return 7 * SECONDS_PER_YEAR;
    case "client-matter":
      // Per-matter retention is governed by the records team via
      // blob-storage lifecycle tags on the matter's blob container
      // (see the blob-store module in phase 3). The Cosmos TTL here
      // is a conservative 7-year outer bound that will be truncated
      // by the per-matter tag when the lifecycle fires.
      return 7 * SECONDS_PER_YEAR;
    case "transient":
      return 30 * SECONDS_PER_DAY;
    case "legal-hold":
      return COSMOS_TTL_NEVER;
  }
}

/**
 * True when the retention class suppresses lifecycle tiering and TTL.
 * The blob-store uses this to decide whether to apply the cool/archive
 * lifecycle tag or the legal-hold tag that blocks tiering.
 */
export function isLegalHold(retentionClass: RetentionClass): boolean {
  return retentionClass === "legal-hold";
}
