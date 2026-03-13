import crypto from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { RATE_LIMITS, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import { env } from "./config";
import type {
  Conversation,
  ConversationMeta,
  Message,
  PendingTool,
  Session,
  SessionMeta,
  Channel,
} from "./types";
import type { SessionStore } from "./session-store";

// ─────────────────────────────────────────────────────────────
//  Cosmos DB client (lazy init)
// ─────────────────────────────────────────────────────────────

let _container: Container | null = null;

function getContainer(): Container {
  if (_container) return _container;

  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint) {
    throw new Error("COSMOS_ENDPOINT is not configured");
  }

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database("neo-db").container("conversations");
  return _container;
}

// ─────────────────────────────────────────────────────────────
//  Cosmos CRUD functions
// ─────────────────────────────────────────────────────────────

const DEFAULT_TTL = 7_776_000; // 90 days in seconds

export async function createConversation(
  ownerId: string,
  role: Role,
  channel: Channel,
): Promise<string> {
  const container = getContainer();
  const id = `conv_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const doc: Conversation = {
    id,
    ownerId,
    title: null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    role,
    channel,
    messages: [],
    pendingConfirmation: null,
    ttl: DEFAULT_TTL,
  };

  await container.items.create(doc);
  logger.info("Conversation created", "conversation-store", {
    conversationId: id,
    role,
    ownerIdHash: hashPii(ownerId),
  });
  return id;
}

export async function getConversation(
  id: string,
  ownerId: string,
): Promise<Conversation | null> {
  const container = getContainer();
  try {
    const { resource } = await container.item(id, ownerId).read<Conversation>();
    return resource ?? null;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: number }).code === 404) {
      return null;
    }
    throw e;
  }
}

export async function listConversations(
  ownerId: string,
  channel?: Channel,
): Promise<ConversationMeta[]> {
  const container = getContainer();

  const query = channel
    ? `SELECT c.id, c.ownerId, c.title, c.createdAt, c.updatedAt,
              c.messageCount, c.role, c.channel
       FROM c
       WHERE c.ownerId = @ownerId AND c.channel = @channel
       ORDER BY c.updatedAt DESC
       OFFSET 0 LIMIT 50`
    : `SELECT c.id, c.ownerId, c.title, c.createdAt, c.updatedAt,
              c.messageCount, c.role, c.channel
       FROM c
       WHERE c.ownerId = @ownerId
       ORDER BY c.updatedAt DESC
       OFFSET 0 LIMIT 50`;

  const parameters: { name: string; value: string }[] = [
    { name: "@ownerId", value: ownerId },
  ];
  if (channel) {
    parameters.push({ name: "@channel", value: channel });
  }

  const { resources } = await container.items
    .query<ConversationMeta>({ query, parameters })
    .fetchAll();
  return resources;
}

export async function appendMessages(
  id: string,
  ownerId: string,
  newMessages: Message[],
  title?: string,
): Promise<void> {
  const container = getContainer();
  const { resource, etag } = await container.item(id, ownerId).read<Conversation>();
  if (!resource) throw new Error(`Conversation ${id} not found`);
  if (!etag) throw new Error(`Missing ETag for conversation ${id}`);

  resource.messages.push(...newMessages);
  resource.messageCount = resource.messages.length;
  resource.updatedAt = new Date().toISOString();
  if (title && !resource.title) resource.title = title;

  await container.item(id, ownerId).replace(resource, {
    accessCondition: { type: "IfMatch", condition: etag },
  });
}

export async function updateTitle(
  id: string,
  ownerId: string,
  title: string,
): Promise<void> {
  const container = getContainer();
  const { resource, etag } = await container.item(id, ownerId).read<Conversation>();
  if (!resource) throw new Error(`Conversation ${id} not found`);
  if (!etag) throw new Error(`Missing ETag for conversation ${id}`);

  resource.title = title;
  resource.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(resource, {
    accessCondition: { type: "IfMatch", condition: etag },
  });
}

export async function deleteConversation(
  id: string,
  ownerId: string,
): Promise<void> {
  const container = getContainer();
  await container.item(id, ownerId).delete();
  logger.info("Conversation deleted", "conversation-store", {
    conversationId: id,
    ownerIdHash: hashPii(ownerId),
  });
}

export async function setConversationPendingConfirmation(
  id: string,
  ownerId: string,
  tool: PendingTool,
): Promise<void> {
  const container = getContainer();
  const conv = await getConversation(id, ownerId);
  if (!conv) return;

  conv.pendingConfirmation = tool;
  conv.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(conv);
}

export async function clearConversationPendingConfirmation(
  id: string,
  ownerId: string,
): Promise<PendingTool | null> {
  const container = getContainer();
  const conv = await getConversation(id, ownerId);
  if (!conv) return null;

  const pending = conv.pendingConfirmation;
  conv.pendingConfirmation = null;
  conv.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(conv);
  return pending;
}

export async function isConversationRateLimited(
  id: string,
  ownerId: string,
): Promise<boolean> {
  const conv = await getConversation(id, ownerId);
  if (!conv) return false;
  return conv.messageCount >= RATE_LIMITS[conv.role].messagesPerSession;
}

// ─────────────────────────────────────────────────────────────
//  CosmosSessionStore — adapts Cosmos CRUD to the SessionStore
//  interface so existing route code works unchanged.
// ─────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function conversationToSession(conv: Conversation): Session {
  return {
    id: conv.id,
    role: conv.role as Role,
    ownerId: conv.ownerId,
    messages: conv.messages,
    createdAt: new Date(conv.createdAt),
    lastActivityAt: new Date(conv.updatedAt),
    messageCount: conv.messageCount,
    pendingConfirmation: conv.pendingConfirmation,
  };
}

export class CosmosSessionStore implements SessionStore {
  /**
   * Since the SessionStore interface's get/delete/etc methods don't take
   * ownerId, we maintain a lightweight id→ownerId cache populated on
   * create and get. For cache misses, we fall back to a cross-partition
   * query which is slightly more expensive but correct.
   */
  private static readonly MAX_CACHE_SIZE = 1000;
  private ownerCache = new Map<string, string>();

  async create(role: Role, ownerId: string, channel: Channel = "web"): Promise<string> {
    const id = await createConversation(ownerId, role, channel);
    this.cacheOwner(id, ownerId);
    return id;
  }

  async get(id: string): Promise<Session | undefined> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return undefined;

    const conv = await getConversation(id, ownerId);
    if (!conv) return undefined;

    // Check idle timeout
    const elapsed = Date.now() - new Date(conv.updatedAt).getTime();
    if (elapsed > IDLE_TIMEOUT_MS) {
      logger.info("Conversation idle-expired", "cosmos-session-store", { conversationId: id });
      return undefined;
    }

    return conversationToSession(conv);
  }

  async getExpired(id: string): Promise<Session | undefined> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return undefined;

    const conv = await getConversation(id, ownerId);
    if (!conv) return undefined;

    // Return session regardless of idle timeout
    return conversationToSession(conv);
  }

  async delete(id: string): Promise<boolean> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return false;

    try {
      await deleteConversation(id, ownerId);
      this.ownerCache.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<SessionMeta[]> {
    // Cross-partition query — only used by admin list endpoint
    const container = getContainer();
    const { resources } = await container.items
      .query<ConversationMeta>({
        query: `
          SELECT c.id, c.ownerId, c.role, c.createdAt, c.messageCount
          FROM c
          ORDER BY c.updatedAt DESC
          OFFSET 0 LIMIT 50
        `,
      })
      .fetchAll();

    return resources.map((c) => ({
      id: c.id,
      role: c.role as Role,
      ownerId: c.ownerId,
      createdAt: new Date(c.createdAt),
      messageCount: c.messageCount,
    }));
  }

  async listForOwner(ownerId: string): Promise<SessionMeta[]> {
    const convos = await listConversations(ownerId);
    return convos.map((c) => ({
      id: c.id,
      role: c.role as Role,
      ownerId: c.ownerId,
      createdAt: new Date(c.createdAt),
      messageCount: c.messageCount,
    }));
  }

  async setPendingConfirmation(id: string, tool: PendingTool): Promise<void> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return;
    await setConversationPendingConfirmation(id, ownerId, tool);
  }

  async clearPendingConfirmation(id: string): Promise<PendingTool | null> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return null;
    return clearConversationPendingConfirmation(id, ownerId);
  }

  async isRateLimited(id: string): Promise<boolean> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return false;
    return isConversationRateLimited(id, ownerId);
  }

  async saveMessages(id: string, messages: Message[], title?: string): Promise<void> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return;

    const attempt = async () => {
      const container = getContainer();
      const { resource, etag } = await container.item(id, ownerId).read<Conversation>();
      if (!resource) return;
      if (!etag) throw new Error(`Missing ETag for conversation ${id}`);

      resource.messages = messages;
      resource.messageCount = messages.length;
      resource.updatedAt = new Date().toISOString();
      if (title && !resource.title) resource.title = title;

      await container.item(id, ownerId).replace(resource, {
        accessCondition: { type: "IfMatch", condition: etag },
      });
    };

    try {
      await attempt();
    } catch (err: unknown) {
      // Retry once on 412 Precondition Failed (etag conflict)
      const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
      if (code === 412) {
        await attempt();
      } else {
        throw err;
      }
    }
  }

  /**
   * Resolve ownerId for a conversation id.
   * Checks the in-memory cache first, then falls back to a cross-partition query.
   */
  private async resolveOwner(id: string): Promise<string | null> {
    const cached = this.ownerCache.get(id);
    if (cached) return cached;

    // Cross-partition lookup
    const container = getContainer();
    const { resources } = await container.items
      .query<{ ownerId: string }>({
        query: "SELECT c.ownerId FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: id }],
      })
      .fetchAll();

    if (resources.length === 0) return null;
    const ownerId = resources[0].ownerId;
    this.cacheOwner(id, ownerId);
    return ownerId;
  }

  private cacheOwner(id: string, ownerId: string): void {
    if (this.ownerCache.size >= CosmosSessionStore.MAX_CACHE_SIZE) {
      // Evict oldest entry (first inserted)
      const first = this.ownerCache.keys().next().value;
      if (first) this.ownerCache.delete(first);
    }
    this.ownerCache.set(id, ownerId);
  }
}
