// ─────────────────────────────────────────────────────────────
//  Triage-mapping store — public API + dual-source dispatch.
//
//  Cosmos-mode (production): the `triage-mappings` Cosmos container
//  is the source of truth, fronted by a 15s read-through cache so an
//  admin write via the API propagates to every App Service instance
//  within one cache window. Same TTL contract as skill-store.ts so
//  operators have one mental model for "how long until my change
//  shows up everywhere".
//
//  Mock-mode (dev / MOCK_MODE / no Cosmos): an in-memory Map seeded
//  with the legacy hardcoded entry that lived in
//  triage-dispatch.ts before this change set. Keeps the dev workflow
//  zero-config — you don't need a Cosmos account to run the agent.
//
//  The choice is driven by `useCosmos()`: production with Cosmos
//  configured AND not in MOCK_MODE.
// ─────────────────────────────────────────────────────────────

import {
  listMappingsFromCosmos,
  listMappingsFromCosmosStrict,
  getMappingFromCosmos,
  createMappingInCosmos,
  upsertMappingInCosmos,
  deleteMappingFromCosmos,
} from "./triage-mapping-store-cosmos";
import type { TriageMapping } from "./types";

// 15s read-through cache for the Cosmos backend, matching skill-store.
const COSMOS_CACHE_TTL_MS = 15 * 1000;

/** The single legacy mapping that previously lived as a hardcoded
 *  constant in triage-dispatch.ts. Used as the mock-mode seed AND
 *  as the seed-script default so behaviour is identical pre/post
 *  rollout. */
const LEGACY_DEFAULT_MAPPING: TriageMapping = {
  id: "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
  skillId: "defender-endpoint-triage",
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "system:legacy-default",
};

function useCosmos(): boolean {
  // Match skill-store: Cosmos kicks in only when BOTH the endpoint is
  // configured AND MOCK_MODE is the literal string "false". Read
  // process.env directly to avoid any config↔store import cycle.
  return (
    Boolean(process.env.COSMOS_ENDPOINT) &&
    process.env.MOCK_MODE === "false"
  );
}

// ── Mock-mode in-memory store ────────────────────────────────

let mockStore: Map<string, TriageMapping> | null = null;

function getMockStore(): Map<string, TriageMapping> {
  if (!mockStore) {
    mockStore = new Map<string, TriageMapping>();
    mockStore.set(LEGACY_DEFAULT_MAPPING.id, LEGACY_DEFAULT_MAPPING);
  }
  return mockStore;
}

// ── Cosmos-mode cache (15s read-through) ────────────────────

interface CosmosCache {
  byId: Map<string, TriageMapping>;
  loadedAt: number;
}
let cosmosCache: CosmosCache | null = null;

async function refreshCosmosCache(): Promise<CosmosCache> {
  const mappings = await listMappingsFromCosmos();
  const byId = new Map<string, TriageMapping>();
  for (const m of mappings) byId.set(m.id, m);
  cosmosCache = { byId, loadedAt: Date.now() };
  return cosmosCache;
}

function invalidateCosmosCache(): void {
  cosmosCache = null;
}

async function getCosmosCache(): Promise<CosmosCache> {
  if (cosmosCache && Date.now() - cosmosCache.loadedAt < COSMOS_CACHE_TTL_MS) {
    return cosmosCache;
  }
  return refreshCosmosCache();
}

// ── Validation ────────────────────────────────────────────────

const MAX_MAPPING_KEY_LENGTH = 256;

/**
 * Validate the source-key format. Returns null on success, an
 * error message on failure. Re-applied server-side by the route
 * handlers so client-side validation can never be bypassed.
 *
 * Rules:
 *   - Non-empty
 *   - Single colon separator
 *   - Each side: alphanumeric, dot, underscore, hyphen — no whitespace
 *   - Length <= MAX_MAPPING_KEY_LENGTH
 *   - Case-sensitive (matches the wire format products like "DefenderXDR")
 */
export function validateMappingKey(key: string): string | null {
  if (!key) return "Source key is required";
  if (key.length > MAX_MAPPING_KEY_LENGTH) {
    return `Source key must be ${MAX_MAPPING_KEY_LENGTH} characters or fewer`;
  }
  if (/\s/.test(key)) {
    return "Source key must not contain whitespace";
  }
  const parts = key.split(":");
  if (parts.length !== 2) {
    return "Source key must contain exactly one ':' separator (e.g. 'DefenderXDR:DefenderEndpoint.SuspiciousProcess')";
  }
  const [product, alertType] = parts;
  const segment = /^[A-Za-z0-9._-]+$/;
  if (!segment.test(product) || !segment.test(alertType)) {
    return "Each side of the ':' must be alphanumeric, dot, underscore or hyphen";
  }
  return null;
}

export function validateSkillIdReference(skillId: string): string | null {
  if (!skillId) return "skillId is required";
  if (typeof skillId !== "string") return "skillId must be a string";
  return null;
}

// ── Public API ────────────────────────────────────────────────

export async function getAllMappings(): Promise<TriageMapping[]> {
  if (useCosmos()) {
    const cache = await getCosmosCache();
    return Array.from(cache.byId.values());
  }
  return Array.from(getMockStore().values());
}

export async function getMapping(key: string): Promise<TriageMapping | undefined> {
  if (useCosmos()) {
    const cache = await getCosmosCache();
    return cache.byId.get(key);
  }
  return getMockStore().get(key);
}

/**
 * Mappings that point at a given skill. Used by the skill-deletion
 * guard in `DELETE /api/skills/[id]` so we can return a 409 listing
 * the blocking mappings rather than orphaning them silently.
 *
 * Cosmos mode reads via the **strict** lister (no error swallow) so
 * a transient outage propagates as an exception. The guard route is
 * expected to wrap this call in try/catch and respond 503 on failure
 * — fail-closed is correct here because letting the destructive
 * delete proceed on a false-empty result would silently orphan
 * mappings. Mock mode reads from the in-memory map, which can't fail.
 */
export async function getMappingsForSkill(skillId: string): Promise<TriageMapping[]> {
  if (useCosmos()) {
    const all = await listMappingsFromCosmosStrict();
    return all.filter((m) => m.skillId === skillId);
  }
  return Array.from(getMockStore().values()).filter((m) => m.skillId === skillId);
}

interface WriteIdentity {
  /** Hashed ownerId of the admin performing the write. The route
   *  handler is expected to pass `hashPii(identity.ownerId)` so this
   *  module never sees the raw value. */
  ownerIdHash: string;
}

export async function createMapping(
  key: string,
  skillId: string,
  identity: WriteIdentity,
): Promise<TriageMapping> {
  const keyError = validateMappingKey(key);
  if (keyError) throw new Error(keyError);

  const skillError = validateSkillIdReference(skillId);
  if (skillError) throw new Error(skillError);

  const mapping: TriageMapping = {
    id: key,
    skillId,
    updatedAt: new Date().toISOString(),
    updatedBy: identity.ownerIdHash,
  };

  if (useCosmos()) {
    await createMappingInCosmos(mapping);
    invalidateCosmosCache();
    return mapping;
  }

  const store = getMockStore();
  if (store.has(key)) {
    throw new Error(`Triage mapping for "${key}" already exists`);
  }
  store.set(key, mapping);
  return mapping;
}

export async function updateMapping(
  key: string,
  skillId: string,
  identity: WriteIdentity,
): Promise<TriageMapping> {
  const keyError = validateMappingKey(key);
  if (keyError) throw new Error(keyError);

  const skillError = validateSkillIdReference(skillId);
  if (skillError) throw new Error(skillError);

  const mapping: TriageMapping = {
    id: key,
    skillId,
    updatedAt: new Date().toISOString(),
    updatedBy: identity.ownerIdHash,
  };

  if (useCosmos()) {
    const existing = await getMappingFromCosmos(key);
    if (!existing) throw new Error(`Triage mapping not found: ${key}`);
    await upsertMappingInCosmos(mapping);
    invalidateCosmosCache();
    return mapping;
  }

  const store = getMockStore();
  if (!store.has(key)) {
    throw new Error(`Triage mapping not found: ${key}`);
  }
  store.set(key, mapping);
  return mapping;
}

export async function deleteMapping(key: string): Promise<void> {
  const keyError = validateMappingKey(key);
  if (keyError) throw new Error(keyError);

  if (useCosmos()) {
    await deleteMappingFromCosmos(key);
    invalidateCosmosCache();
    return;
  }

  getMockStore().delete(key);
}

/** Test-only — force the Cosmos cache to refresh on next read AND
 *  reset the mock-mode in-memory store back to the seeded default. */
export function __invalidateCacheForTest(): void {
  invalidateCosmosCache();
  mockStore = null;
}

/** Exposed for the seed script — same constant the legacy
 *  triage-dispatch.ts had inline. Single source of truth so the seed
 *  script and mock-mode default never drift. */
export function legacyDefaultMapping(): TriageMapping {
  return { ...LEGACY_DEFAULT_MAPPING };
}

export const TRIAGE_MAPPING_CACHE_TTL_MS = COSMOS_CACHE_TTL_MS;
