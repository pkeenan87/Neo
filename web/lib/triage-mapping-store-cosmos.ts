// ─────────────────────────────────────────────────────────────
//  Triage-mapping store — Cosmos backend
//
//  Production source of truth for the alert source → skill lookup
//  table. The wrapper in `triage-mapping-store.ts` decides between
//  this Cosmos backend and the in-memory mock-mode default based on
//  `MOCK_MODE` + `COSMOS_ENDPOINT`. Mirrors the pattern in
//  `skill-store-cosmos.ts` line for line; see _specs/admin-ui-alert-
//  triage-mapping.md for the design intent.
//
//  Schema: one document per mapping. Partition key /id (the source
//  key is unique by definition). The id is `<product>:<alertType>`,
//  case-sensitive, validated by the public store before reaching
//  this module.
// ─────────────────────────────────────────────────────────────

import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { logger } from "./logger";
import type { TriageMapping } from "./types";

const DATABASE_NAME = "neo-db";
const CONTAINER_NAME = "triage-mappings";

/** Catch-block helper — narrows `unknown` to a string for log fields. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export function __setContainerForTest(c: Container | null): void {
  _container = c;
}

/**
 * List every mapping. Used by the cache-refresh path — the table is
 * very small (typically <50 entries) so a single full-container query
 * per cache window is the right shape.
 */
export async function listMappingsFromCosmos(): Promise<TriageMapping[]> {
  const container = getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<TriageMapping>({
        query: "SELECT c.id, c.skillId, c.updatedAt, c.updatedBy FROM c",
      })
      .fetchAll();
    return resources;
  } catch (err) {
    logger.warn("listMappingsFromCosmos failed", "triage-mapping-store-cosmos", {
      errorMessage: toMessage(err),
    });
    return [];
  }
}

export async function getMappingFromCosmos(
  id: string,
): Promise<TriageMapping | undefined> {
  const container = getContainer();
  if (!container) return undefined;
  try {
    const { resource } = await container.item(id, id).read<TriageMapping>();
    return resource ?? undefined;
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 404) return undefined;
    logger.warn("getMappingFromCosmos failed", "triage-mapping-store-cosmos", {
      id,
      errorMessage: toMessage(err),
    });
    return undefined;
  }
}

/**
 * Create a mapping atomically. Maps Cosmos 409 to a stable
 * "already exists" Error so the admin route can return 409 cleanly.
 *
 * Same TOCTOU rationale as createSkillInCosmos: read-then-upsert
 * races under concurrent admin POSTs for the same id; `items.create`
 * is server-side atomic.
 */
export async function createMappingInCosmos(mapping: TriageMapping): Promise<void> {
  const container = getContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured. Cannot persist triage mapping.");
  }
  try {
    await container.items.create(mapping);
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 409) {
      throw new Error(`Triage mapping for "${mapping.id}" already exists`);
    }
    throw err;
  }
}

/**
 * Replace an existing mapping's skillId + updatedAt + updatedBy.
 * Used by the update path; create uses createMappingInCosmos for
 * atomicity.
 */
export async function upsertMappingInCosmos(mapping: TriageMapping): Promise<void> {
  const container = getContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured. Cannot persist triage mapping.");
  }
  await container.items.upsert(mapping);
}

export async function deleteMappingFromCosmos(id: string): Promise<void> {
  const container = getContainer();
  if (!container) return;
  try {
    await container.item(id, id).delete();
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 404) return; // idempotent — already gone
    throw err;
  }
}
