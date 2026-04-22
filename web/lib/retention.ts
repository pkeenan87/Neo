import type { RetentionClass } from "./types";

// ─────────────────────────────────────────────────────────────
//  Retention policy helper
//
//  A conversation's `retentionClass` on the root document drives both
//  the Cosmos `ttl` (seconds) stamped on every doc in that partition
//  AND the Azure Blob Storage lifecycle tagging for any offloaded
//  tool-result blobs referenced by that conversation. Aligns Neo's
//  storage lifetime with Goodwin's records-policy categories.
//
//  NOTE: Cosmos TTL of `null` = never expire (used for legal-hold).
//  Cosmos TTL of `undefined` = inherit container default (NOT what we
//  want here — we set an explicit per-doc TTL so legal-hold is honoured
//  regardless of container default).
// ─────────────────────────────────────────────────────────────

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

/**
 * Seconds-of-TTL for a given retention class. `null` means "never expire"
 * — required for legal-hold where lifecycle tiering and TTL deletion are
 * both suppressed. Cosmos treats a `ttl` of `-1` on the document as "no
 * expiry even when the container has a default TTL set", so callers
 * should pass `-1` to Cosmos when they see `null` from this helper.
 */
export function resolveRetentionTtlSeconds(retentionClass: RetentionClass): number | null {
  switch (retentionClass) {
    case "standard-7y":
      return 7 * SECONDS_PER_YEAR;
    case "client-matter":
      // Client-matter retention is governed per-matter by the records
      // team; the Cosmos TTL is a conservative 7-year outer bound. The
      // real retention decision is driven by blob-storage lifecycle
      // tagging (see isLegalHold / tagForLifecycle in the blob store).
      return 7 * SECONDS_PER_YEAR;
    case "transient":
      return 30 * SECONDS_PER_DAY;
    case "legal-hold":
      return null;
  }
}

/**
 * Convenience: the Cosmos `ttl` field's "never expire" sentinel. Use
 * when the retention class resolves to null and the caller needs a
 * concrete number to pass to the SDK.
 */
export const COSMOS_TTL_NEVER = -1;

/**
 * True when the retention class suppresses lifecycle tiering and TTL.
 * The blob-store uses this to decide whether to apply the cool/archive
 * lifecycle tag or the legal-hold tag that blocks tiering.
 */
export function isLegalHold(retentionClass: RetentionClass): boolean {
  return retentionClass === "legal-hold";
}
