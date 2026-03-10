import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { logger } from "./logger";
import { env } from "./config";
import type { TeamsMapping } from "./types";

// ─────────────────────────────────────────────────────────────
//  Cosmos DB client for teams-mappings container (lazy init)
// ─────────────────────────────────────────────────────────────

// Must match the database name in conversation-store.ts and the
// provisioning script (scripts/provision-cosmos-db.ps1).
const DATABASE_NAME = "neo-db";
const CONTAINER_NAME = "teams-mappings";

let _container: Container | null = null;

function getContainer(): Container {
  if (_container) return _container;

  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint) {
    throw new Error("COSMOS_ENDPOINT is not configured");
  }

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database(DATABASE_NAME).container(CONTAINER_NAME);
  return _container;
}

// ─────────────────────────────────────────────────────────────
//  CRUD functions
// ─────────────────────────────────────────────────────────────

const DEFAULT_TTL = 7_776_000; // 90 days in seconds

export async function getTeamsMapping(
  conversationId: string,
): Promise<TeamsMapping | null> {
  const container = getContainer();
  try {
    const { resource } = await container
      .item(conversationId, conversationId)
      .read<TeamsMapping>();
    return resource ?? null;
  } catch (e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: number }).code === 404
    ) {
      return null;
    }
    throw e;
  }
}

export async function createTeamsMapping(
  mapping: Omit<TeamsMapping, "createdAt" | "lastActivityAt" | "ttl">,
): Promise<void> {
  const container = getContainer();
  const now = new Date().toISOString();

  const doc: TeamsMapping = {
    ...mapping,
    createdAt: now,
    lastActivityAt: now,
    ttl: DEFAULT_TTL,
  };

  await container.items.create(doc);
  logger.info("Teams mapping created", "teams-mapping-store", {
    conversationId: mapping.id,
    channelType: mapping.channelType,
  });
}

export async function updateTeamsMappingActivity(
  conversationId: string,
): Promise<void> {
  const container = getContainer();
  try {
    const { resource, etag } = await container
      .item(conversationId, conversationId)
      .read<TeamsMapping>();
    if (!resource || !etag) return;

    resource.lastActivityAt = new Date().toISOString();
    resource.ttl = DEFAULT_TTL;

    await container.item(conversationId, conversationId).replace(resource, {
      accessCondition: { type: "IfMatch", condition: etag },
    });
  } catch (err) {
    logger.warn("Failed to update teams mapping activity", "teams-mapping-store", {
      conversationId,
      errorMessage: (err as Error).message,
    });
  }
}

export async function updateTeamsMappingSessionId(
  conversationId: string,
  newSessionId: string,
): Promise<void> {
  const container = getContainer();

  let resource: TeamsMapping | undefined;
  let etag: string | undefined;
  try {
    const result = await container
      .item(conversationId, conversationId)
      .read<TeamsMapping>();
    resource = result.resource;
    etag = result.etag;
  } catch (e: unknown) {
    // Mapping may have been TTL-deleted — nothing to update
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: number }).code === 404
    ) {
      return;
    }
    throw e;
  }
  if (!resource || !etag) return;

  resource.sessionId = newSessionId;
  resource.lastActivityAt = new Date().toISOString();
  resource.ttl = DEFAULT_TTL;

  await container.item(conversationId, conversationId).replace(resource, {
    accessCondition: { type: "IfMatch", condition: etag },
  });
  logger.info("Teams mapping session updated", "teams-mapping-store", {
    conversationId,
    newSessionId,
  });
}
