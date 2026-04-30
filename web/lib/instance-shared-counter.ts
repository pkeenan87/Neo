// ─────────────────────────────────────────────────────────────
//  Instance-shared counter primitive
//
//  Cosmos-backed counter and outcome-window storage for state that
//  must be consistent across all App Service instances. Replaces
//  per-instance Map / array singletons that broke correctness when
//  traffic round-robins. See _plans/multi-instance-deployment.md.
//
//  Two shapes coexist on the same `instance-shared` container:
//
//    1. Counter doc (rate limiter):
//       { id, key, count, windowStart, ttl }
//       Atomic increments via Cosmos Patch. Window rolls over when
//       windowStart age exceeds windowMs — caller asks for the
//       current window's limit on every increment.
//
//    2. Outcome doc (circuit breaker):
//       { id, key, outcomes: { ts, success }[], trippedAt, ttl }
//       Bounded outcome array; recordOutcome appends, readState
//       prunes by windowMs.
//
//  Both shapes live on the same partition (/key) so a single
//  point-read or Patch is one round trip.
//
//  Failure mode: Cosmos hiccups fail closed for the breaker (return
//  open=false → does NOT trip on storage error), and fail open for
//  the rate limiter (return allowed=true → does NOT block legitimate
//  callers when storage is briefly down). Both behaviours are
//  documented per-helper.
// ─────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { CosmosClient, type Container, type PatchOperation } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { logger } from "./logger";

/** Catch-block helper: narrows `unknown` to a string. Cosmos SDK
 *  normally throws Error objects, but historic versions and forwarded
 *  fetch errors aren't guaranteed to — fall back to String(err) so
 *  log entries never end up `errorMessage: undefined`. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DATABASE_NAME = "neo-db";
const CONTAINER_NAME = "instance-shared";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h GC for idle keys
const PATCH_RETRY_LIMIT = 3;

// Cosmos document IDs reject `/`, `\`, `?`, `#` and have a 255-byte
// cap. Callers compose keys from auth-derived identifiers (e.g.
// `rate:triage:${ownerId}`); if `ownerId` ever contained one of those
// chars or a long-byte sequence, the create call would throw a
// non-409/412 and fall through to the outer catch — which silently
// flips the limiter to "always allow" for that caller (a trivial
// rate-limit bypass). Normalize at the primitive boundary so callers
// don't have to remember.
const FORBIDDEN_KEY_CHARS = /[/\\?#]/g;
const MAX_KEY_BYTES = 200; // leaves headroom under Cosmos's 255-byte limit
function normalizeKey(key: string): string {
  // Replace forbidden chars with `_` (deterministic; preserves
  // human-readability for log debugging vs. a hash of the entire key).
  let safe = key.replace(FORBIDDEN_KEY_CHARS, "_");
  if (Buffer.byteLength(safe, "utf8") > MAX_KEY_BYTES) {
    // Long input — collapse to a SHA-256 hash with a short prefix so
    // operators can still grep by namespace.
    const prefix = safe.slice(0, 24);
    const hash = createHash("sha256").update(safe).digest("hex").slice(0, 32);
    safe = `${prefix}#${hash}`.replace(FORBIDDEN_KEY_CHARS, "_");
  }
  return safe;
}

let _container: Container | null = null;

function getContainer(): Container | null {
  if (_container) return _container;
  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint || env.MOCK_MODE) return null;
  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database(DATABASE_NAME).container(CONTAINER_NAME);
  return _container;
}

/** Test-only escape hatch — inject a fake container so unit tests can
 *  exercise the patch / read paths against an in-memory store. */
export function __setContainerForTest(c: Container | null): void {
  _container = c;
}

// ── Counter (rate limiter) ───────────────────────────────────

interface CounterDoc {
  id: string;
  key: string;
  count: number;
  windowStart: number; // ms epoch
  ttl?: number;
}

export interface IncrementResult {
  count: number;
  allowed: boolean;
}

/**
 * Increment a counter atomically. Caller supplies windowMs (rolling
 * window) and limit (cap). Returns the post-increment count and
 * whether the count is still ≤ limit.
 *
 * Failure mode: storage error → fail open (allowed=true, count=0).
 * Rate-limiting must not block legitimate callers when Cosmos is
 * down; the circuit breaker covers persistent error states.
 */
export async function incrementCounter(
  rawKey: string,
  windowMs: number,
  limit: number,
): Promise<IncrementResult> {
  const container = getContainer();
  if (!container) {
    // No Cosmos configured (dev / mock) — no-op rate limit, allow all.
    return { count: 0, allowed: true };
  }
  const key = normalizeKey(rawKey);

  const now = Date.now();
  for (let attempt = 0; attempt < PATCH_RETRY_LIMIT; attempt++) {
    try {
      const { resource, etag } = await container
        .item(key, key)
        .read<CounterDoc>();

      // Cold doc OR window expired → write fresh.
      if (!resource || now - resource.windowStart >= windowMs) {
        const fresh: CounterDoc = {
          id: key,
          key,
          count: 1,
          windowStart: now,
          ttl: DEFAULT_TTL_SECONDS,
        };
        try {
          if (resource) {
            await container.item(key, key).replace(fresh, {
              accessCondition: { type: "IfMatch", condition: etag ?? "" },
            });
          } else {
            await container.items.create(fresh);
          }
          return { count: 1, allowed: 1 <= limit };
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "code" in err
              ? (err as { code: number }).code
              : 0;
          if (code === 412 || code === 409) continue; // someone else got there first; retry
          throw err;
        }
      }

      // Hot path — atomic server-side increment. Cosmos `incr` is
      // race-safe on its own; deliberately NOT passing IfMatch here:
      // gating the increment on a stale etag would force a retry on
      // every concurrent caller, but the increment itself can't lose
      // updates — it's a server-side mutation. IfMatch stays on the
      // cold-write window-rollover branch above, where we ARE racing
      // to be the one writer that resets count + windowStart.
      const ops: PatchOperation[] = [
        { op: "incr", path: "/count", value: 1 },
      ];
      const { resource: patched } = await container
        .item(key, key)
        .patch<CounterDoc>({ operations: ops });
      const count = patched?.count ?? resource.count + 1;
      return { count, allowed: count <= limit };
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: number }).code
          : 0;
      if (code === 412 || code === 409) continue;
      logger.warn("incrementCounter failed — failing open", "instance-shared-counter", {
        key,
        errorMessage: toMessage(err),
      });
      return { count: 0, allowed: true };
    }
  }

  // Retries exhausted — fail open.
  logger.warn("incrementCounter retry exhausted — failing open", "instance-shared-counter", { key });
  return { count: 0, allowed: true };
}

/** Read the current counter value (for inspection / tests). */
export async function readCounter(rawKey: string): Promise<number> {
  const container = getContainer();
  if (!container) return 0;
  const key = normalizeKey(rawKey);
  try {
    const { resource } = await container.item(key, key).read<CounterDoc>();
    return resource?.count ?? 0;
  } catch {
    return 0;
  }
}

/** Delete the counter doc (manual reset, mostly for tests). */
export async function resetCounter(rawKey: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  const key = normalizeKey(rawKey);
  try {
    await container.item(key, key).delete();
  } catch {
    // best-effort
  }
}

// ── Outcomes window (circuit breaker) ────────────────────────

export interface OutcomeRecord {
  ts: number;
  success: boolean;
}

interface OutcomeDoc {
  id: string;
  key: string;
  outcomes: OutcomeRecord[];
  trippedAt: number | null;
  ttl?: number;
}

/**
 * Append an outcome to the rolling window for `key`. Best-effort —
 * storage error is logged and silently absorbed; the outcome is
 * dropped rather than throwing into the calling agent loop.
 */
export async function recordOutcome(rawKey: string, success: boolean): Promise<void> {
  const container = getContainer();
  if (!container) return;
  const key = normalizeKey(rawKey);
  const now = Date.now();
  for (let attempt = 0; attempt < PATCH_RETRY_LIMIT; attempt++) {
    try {
      const { resource, etag } = await container.item(key, key).read<OutcomeDoc>();
      if (!resource) {
        const fresh: OutcomeDoc = {
          id: key,
          key,
          outcomes: [{ ts: now, success }],
          trippedAt: null,
          ttl: DEFAULT_TTL_SECONDS,
        };
        try {
          await container.items.create(fresh);
          return;
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "code" in err
              ? (err as { code: number }).code
              : 0;
          if (code === 409) continue; // collision; retry as patch
          throw err;
        }
      }

      // Bound the array so it doesn't grow unbounded under high traffic.
      // Keep last 200 entries — enough for any sensible window/threshold
      // calculation while capping the doc size.
      const next = [...resource.outcomes, { ts: now, success }].slice(-200);
      await container.item(key, key).replace(
        { ...resource, outcomes: next },
        { accessCondition: { type: "IfMatch", condition: etag ?? "" } },
      );
      return;
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: number }).code
          : 0;
      if (code === 412 || code === 409) continue;
      logger.warn("recordOutcome failed", "instance-shared-counter", {
        key,
        errorMessage: toMessage(err),
      });
      return;
    }
  }
}

export interface OutcomeState {
  /** Outcomes within the rolling window. */
  outcomes: OutcomeRecord[];
  /** Timestamp the breaker tripped (null if not tripped). */
  trippedAt: number | null;
}

/** Read + window-prune the outcome list. Does NOT mutate Cosmos. */
export async function readOutcomeState(
  rawKey: string,
  windowMs: number,
): Promise<OutcomeState> {
  const container = getContainer();
  if (!container) return { outcomes: [], trippedAt: null };
  const key = normalizeKey(rawKey);
  try {
    const { resource } = await container.item(key, key).read<OutcomeDoc>();
    if (!resource) return { outcomes: [], trippedAt: null };
    const cutoff = Date.now() - windowMs;
    const pruned = resource.outcomes.filter((o) => o.ts >= cutoff);
    return { outcomes: pruned, trippedAt: resource.trippedAt };
  } catch (err) {
    logger.warn("readOutcomeState failed — defaulting to empty", "instance-shared-counter", {
      key,
      errorMessage: toMessage(err),
    });
    return { outcomes: [], trippedAt: null };
  }
}

/** Mark the breaker as tripped (sets trippedAt = now). Idempotent. */
export async function tripBreaker(rawKey: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  const key = normalizeKey(rawKey);
  const now = Date.now();
  try {
    await container
      .item(key, key)
      .patch({ operations: [{ op: "set", path: "/trippedAt", value: now }] });
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 404) {
      // Doc didn't exist yet — create with trippedAt set + empty outcomes.
      try {
        await container.items.create({
          id: key,
          key,
          outcomes: [],
          trippedAt: now,
          ttl: DEFAULT_TTL_SECONDS,
        } as OutcomeDoc);
      } catch {
        // best-effort
      }
      return;
    }
    logger.warn("tripBreaker failed", "instance-shared-counter", {
      key,
      errorMessage: toMessage(err),
    });
  }
}

/**
 * Reset the breaker (clears trippedAt + outcomes).
 *
 * Throws on persistent Cosmos error so the caller can decide what to
 * do — the manual admin reset endpoint surfaces failure as 500
 * (otherwise the admin sees 200, walks away, and the fleet stays
 * tripped). The auto-reset path in `triage-circuit-breaker` ignores
 * the throw via `.catch(() => {})` because it'll re-attempt next
 * cooldown evaluation anyway.
 *
 * Note: this Patch is etag-free, so concurrent `recordOutcome` writes
 * in flight at reset time are silently dropped. Intentional — the
 * cooldown is a recovery window and we want a clean slate after it.
 */
export async function resetOutcomeWindow(rawKey: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  const key = normalizeKey(rawKey);
  await container.item(key, key).patch({
    operations: [
      { op: "set", path: "/outcomes", value: [] },
      { op: "set", path: "/trippedAt", value: null },
    ],
  });
}
