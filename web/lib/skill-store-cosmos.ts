// ─────────────────────────────────────────────────────────────
//  Skill store — Cosmos backend
//
//  Production source of truth for skills. The wrapper in
//  `skill-store.ts` decides between this Cosmos backend and the
//  legacy file-system backend based on `MOCK_MODE` + `COSMOS_ENDPOINT`.
//  See _plans/multi-instance-deployment.md.
//
//  Schema: one document per skill, partition key /id (skill id is
//  unique by definition). Documents store the parsed Skill plus a
//  raw markdown copy for round-trip migrations and admin re-edit.
// ─────────────────────────────────────────────────────────────

import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { logger } from "./logger";
import type { Skill } from "./types";

const DATABASE_NAME = "neo-db";
const CONTAINER_NAME = "skills";

interface SkillDoc extends Skill {
  /** Raw markdown source — preserved so admin edit / migration can
   *  round-trip the document without re-parsing on every read. */
  rawMarkdown: string;
  updatedAt: string;
}

/** Catch-block helper: narrows `unknown` to a string. Cosmos SDK
 *  normally throws Error objects, but historic versions and forwarded
 *  fetch errors aren't guaranteed to — fall back to String(err) so
 *  log entries never end up `errorMessage: undefined`. */
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
 * List every skill in Cosmos. Used by the cache-refresh path —
 * skills are typically <100 entries so a single full-container query
 * per cache window is cheap (and cheaper than per-skill point reads).
 *
 * Project to the parsed-Skill fields only — `rawMarkdown` is up to
 * 32KB per skill and isn't needed for cache lookups (it's only fetched
 * on admin edit via `getRawMarkdownFromCosmos`). Keeps the per-refresh
 * RU spike bounded as the skill set grows.
 */
export async function listSkillsFromCosmos(): Promise<Skill[]> {
  const container = getContainer();
  if (!container) return [];
  try {
    const { resources } = await container.items
      .query<Skill>({
        query:
          "SELECT c.id, c.name, c.description, c.instructions, c.requiredTools, c.requiredRole, c.parameters FROM c",
      })
      .fetchAll();
    return resources;
  } catch (err) {
    logger.warn("listSkillsFromCosmos failed", "skill-store-cosmos", {
      errorMessage: toMessage(err),
    });
    return [];
  }
}

export async function getSkillFromCosmos(id: string): Promise<Skill | undefined> {
  const container = getContainer();
  if (!container) return undefined;
  try {
    const { resource } = await container.item(id, id).read<SkillDoc>();
    if (!resource) return undefined;
    const { rawMarkdown: _r, updatedAt: _u, ...skill } = resource;
    return skill;
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 404) return undefined;
    logger.warn("getSkillFromCosmos failed", "skill-store-cosmos", {
      id,
      errorMessage: toMessage(err),
    });
    return undefined;
  }
}

/**
 * Upsert a skill (create-or-replace). The full markdown source is
 * persisted alongside the parsed shape so admin edit can re-show
 * it later. Used for the update path and the migration script —
 * NOT for create (which must be atomic; see createSkillInCosmos).
 */
export async function upsertSkillInCosmos(skill: Skill, rawMarkdown: string): Promise<void> {
  const container = getContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured. Cannot persist skill.");
  }
  const doc: SkillDoc = {
    ...skill,
    rawMarkdown,
    updatedAt: new Date().toISOString(),
  };
  await container.items.upsert(doc);
}

/**
 * Create a skill atomically. Maps Cosmos 409 (conflict) to a stable
 * "already exists" Error so the admin route returns the right status.
 *
 * Why a separate operation instead of `upsert` + a pre-read guard:
 * the read-then-upsert pattern races under concurrent admin POSTs
 * for the same id — both pass the existence check, the second
 * silently overwrites the first. `items.create` is server-side
 * atomic and returns 409 on collision, eliminating the TOCTOU.
 * Defends against the multi-instance race this whole change set
 * exists to fix.
 */
export async function createSkillInCosmos(skill: Skill, rawMarkdown: string): Promise<void> {
  const container = getContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured. Cannot persist skill.");
  }
  const doc: SkillDoc = {
    ...skill,
    rawMarkdown,
    updatedAt: new Date().toISOString(),
  };
  try {
    await container.items.create(doc);
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 409) {
      throw new Error(`Skill with id "${skill.id}" already exists`);
    }
    throw err;
  }
}

export async function deleteSkillFromCosmos(id: string): Promise<void> {
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

/** Internal — used by the migration script to read the raw markdown. */
export async function getRawMarkdownFromCosmos(id: string): Promise<string | undefined> {
  const container = getContainer();
  if (!container) return undefined;
  try {
    const { resource } = await container.item(id, id).read<SkillDoc>();
    return resource?.rawMarkdown;
  } catch {
    return undefined;
  }
}
