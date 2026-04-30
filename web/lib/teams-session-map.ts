// Read-through cache from Teams conversationId to Neo sessionId.
//
// The in-memory `map` is per-instance best-effort — a write on
// instance A populates A's map but NOT B's, so B will cache-miss on
// its first lookup and fall through to Cosmos. The Cosmos document
// (`teams-mappings` container, partition key /id) is the source of
// truth across the fleet; the cache is purely a hot-path latency
// optimization. See _plans/multi-instance-deployment.md.
//
// TTL is intentionally short so a stale per-instance cache entry
// doesn't outlive a relevant Cosmos write from a sibling instance.
// If two instances handle alternating messages on the same Teams
// thread, the worst case is that B's first lookup is a Cosmos point-
// read — fast (<10ms, ~1 RU on /id partition) and idempotent.

import { env } from "./config";
import { logger } from "./logger";
import {
  getTeamsMapping,
  createTeamsMapping,
  updateTeamsMappingActivity,
  updateTeamsMappingSessionId,
} from "./teams-mapping-store";
import type { TeamsChannelType } from "./types";

interface MapEntry {
  sessionId: string;
  cachedAt: number;
}

// Short TTL so a per-instance cache entry doesn't outlive a relevant
// write from a sibling instance. Cosmos is the source of truth; a
// cache miss costs ~1 RU and <10ms, which is acceptable to keep the
// multi-instance contract simple.
const TTL_MS = 60 * 1000; // 60s — was 35min when single-instance was assumed
const map = new Map<string, MapEntry>();

// Periodic sweep for stale cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.cachedAt > TTL_MS) {
      map.delete(key);
    }
  }
}, 60_000);

function useCosmosDb(): boolean {
  return Boolean(env.COSMOS_ENDPOINT) && !env.MOCK_MODE;
}

/**
 * Resolve a Teams conversationId to a Neo sessionId.
 * Checks in-memory cache first, then Cosmos DB on cache miss.
 */
export async function getSessionId(
  conversationId: string,
): Promise<string | undefined> {
  // Fast path: in-memory cache. Enforce TTL on the hit path —
  // without this, the periodic sweep is the only enforcement, which
  // means an entry could be served for up to ~2× TTL (sweep period +
  // sweep evaluation lag). Falling through to Cosmos on TTL expiry
  // is exactly what we want: the Cosmos round-trip refreshes the
  // entry with the up-to-date sessionId from sibling instances.
  const cached = map.get(conversationId);
  if (cached && Date.now() - cached.cachedAt < TTL_MS) {
    return cached.sessionId;
  }
  if (cached) map.delete(conversationId); // expired — drop and re-fetch

  // Slow path: Cosmos DB lookup
  if (useCosmosDb()) {
    try {
      const mapping = await getTeamsMapping(conversationId);
      if (mapping) {
        map.set(conversationId, {
          sessionId: mapping.sessionId,
          cachedAt: Date.now(),
        });
        return mapping.sessionId;
      }
    } catch (err) {
      logger.warn("Cosmos DB mapping lookup failed, cache miss", "teams-session-map", {
        conversationId,
        errorMessage: (err as Error).message,
      });
    }
  }

  return undefined;
}

/**
 * Store a new Teams conversationId → sessionId mapping.
 * Writes to Cosmos DB (if configured) and populates the in-memory cache.
 */
export async function setSessionId(
  conversationId: string,
  sessionId: string,
  channelType: TeamsChannelType,
  teamId: string | null,
): Promise<void> {
  // Always update in-memory cache
  map.set(conversationId, { sessionId, cachedAt: Date.now() });

  // Persist to Cosmos DB
  if (useCosmosDb()) {
    try {
      await createTeamsMapping({
        id: conversationId,
        sessionId,
        channelType,
        teamId,
      });
    } catch (err) {
      logger.error("Failed to persist teams mapping", "teams-session-map", {
        conversationId,
        errorMessage: (err as Error).message,
      });
    }
  }
}

/**
 * Update the sessionId for an existing mapping (used when resuming expired sessions).
 */
export async function updateSessionId(
  conversationId: string,
  newSessionId: string,
): Promise<void> {
  map.set(conversationId, { sessionId: newSessionId, cachedAt: Date.now() });

  if (useCosmosDb()) {
    try {
      await updateTeamsMappingSessionId(conversationId, newSessionId);
    } catch (err) {
      logger.error("Failed to update teams mapping session", "teams-session-map", {
        conversationId,
        errorMessage: (err as Error).message,
      });
    }
  }
}

/**
 * Refresh the activity timestamp on a mapping (keeps TTL alive in Cosmos DB).
 */
export async function refreshMapping(conversationId: string): Promise<void> {
  // Refresh in-memory cache timestamp
  const cached = map.get(conversationId);
  if (cached) {
    cached.cachedAt = Date.now();
  }

  if (useCosmosDb()) {
    try {
      await updateTeamsMappingActivity(conversationId);
    } catch (err) {
      logger.warn("Failed to refresh teams mapping activity", "teams-session-map", {
        conversationId,
        errorMessage: (err as Error).message,
      });
    }
  }
}

export function deleteSessionId(conversationId: string): void {
  map.delete(conversationId);
}
