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
  CSVReference,
} from "./types";
import { CSV_MAX_REFERENCE_ATTACHMENTS, CsvAttachmentCapError } from "./types";
import type { DualWriteDivergencePayload } from "./types";
import type { SessionStore } from "./session-store";
import { truncateToolResults } from "./context-manager";
import { PERSISTENCE_TOOL_RESULT_TOKEN_CAP } from "./config";
import { mockStore } from "./mock-conversation-store";
import { getActiveStoreMode } from "./conversation-store-mode";
import * as v2 from "./conversation-store-v2";

// Dev-mode dispatch guard. When true, all module-level CRUD functions
// short-circuit to the file-backed MockConversationStore instead of
// touching Cosmos. See lib/mock-conversation-store.ts.
function useMock(): boolean {
  return env.MOCK_MODE || !env.COSMOS_ENDPOINT;
}

// ─────────────────────────────────────────────────────────────
//  Mode dispatch helpers
//
//  NEO_CONVERSATION_STORE_MODE (env, possibly overridden per-request
//  via the admin X-Neo-Store-Mode header — see lib/conversation-store-
//  mode.ts) controls which schema handles each call:
//
//    v1         — current inline code (legacy single-doc)
//    v2         — delegates to the v2 adapter in conversation-store-v2.ts
//    dual-read  — writes to v2; reads try v2, fall back to v1 on null
//    dual-write — writes to BOTH; reads come from v1 (authoritative);
//                 v2 write failures are logged as conversation_dual_
//                 write_divergence and do NOT fail the request.
//
//  Mock mode always short-circuits to the file-backed mock regardless
//  of store mode — dev doesn't touch the split schema until phase 7
//  wires up mock-store parity.
// ─────────────────────────────────────────────────────────────

/**
 * Best-effort fire-and-forget call to a v2 operation in dual-write
 * mode. Logs `conversation_dual_write_divergence` on failure but does
 * NOT throw — the v1 write is the authoritative path and succeeding
 * v1 writes must not be reversed by v2 hiccups.
 */
async function dualWriteV2BestEffort(
  opName: DualWriteDivergencePayload["operation"],
  conversationId: string,
  ownerId: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const payload: DualWriteDivergencePayload = {
      conversationId,
      operation: opName,
      errorMessage: (err as Error).message,
      ownerId,
    };
    logger.warn(
      "Dual-write v2 diverged from v1 (best-effort, continuing)",
      "conversation-store",
      payload as unknown as Record<string, unknown>,
    );
    logger.emitEvent(
      "conversation_dual_write_divergence",
      "v2 write failed under dual-write mode",
      "conversation-store",
      payload as unknown as Record<string, unknown>,
    );
  }
}

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
  model?: string,
): Promise<string> {
  if (useMock()) return mockStore.createConversation(ownerId, role, channel, model);

  const mode = getActiveStoreMode();
  if (mode === "v2") {
    return v2.createConversationV2(ownerId, role, channel, model);
  }
  // dual-* modes: v1 generates the id that downstream reads/writes will
  // use. In dual-write, v2 must create a root doc with the SAME id so
  // subsequent v2 reads find it. Since v2.createConversationV2 mints
  // its own id, we instead create both docs here with a shared id.
  if (mode === "dual-write") {
    // Perform the v1 write first — it's authoritative for reads.
    const id = await createConversationV1Internal(ownerId, role, channel, model);
    await dualWriteV2BestEffort("createConversation", id, ownerId, async () => {
      await v2.createConversationV2WithId(id, ownerId, role, channel, model);
    });
    return id;
  }
  if (mode === "dual-read") {
    // Writes go to v2 only; the shared id is minted by v2.
    return v2.createConversationV2(ownerId, role, channel, model);
  }
  // mode === "v1"
  return createConversationV1Internal(ownerId, role, channel, model);
}

// Internal helper extracted so the dispatch branches can delegate
// without re-entering the top of createConversation. Contains the
// original v1 code path, unchanged.
async function createConversationV1Internal(
  ownerId: string,
  role: Role,
  channel: Channel,
  model?: string,
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
    model,
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
  if (useMock()) return mockStore.getConversation(id, ownerId);

  const mode = getActiveStoreMode();
  if (mode === "v2") {
    return v2.getConversationV2(id, ownerId);
  }
  if (mode === "dual-read") {
    // v2 first; on null fall back to v1 so conversations that haven't
    // been migrated yet still read cleanly.
    const v2Result = await v2.getConversationV2(id, ownerId);
    if (v2Result) return v2Result;
    return getConversationV1Internal(id, ownerId);
  }
  // v1 and dual-write both read from v1.
  return getConversationV1Internal(id, ownerId);
}

async function getConversationV1Internal(
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
  if (useMock()) return mockStore.listConversations(ownerId, channel);

  const mode = getActiveStoreMode();
  if (mode === "v2") {
    return v2.listConversationsV2(ownerId, channel);
  }
  if (mode === "dual-read") {
    // Merge v2 (preferred) + v1 (legacy), dedupe by id. Keeps the
    // sidebar functional during a rolling migration where some
    // conversations have been split and others haven't yet.
    const [v2List, v1List] = await Promise.all([
      v2.listConversationsV2(ownerId, channel),
      listConversationsV1Internal(ownerId, channel),
    ]);
    const seen = new Set(v2List.map((c) => c.id));
    const merged = [...v2List, ...v1List.filter((c) => !seen.has(c.id))];
    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return merged.slice(0, 50);
  }
  // v1 and dual-write read from v1.
  return listConversationsV1Internal(ownerId, channel);
}

async function listConversationsV1Internal(
  ownerId: string,
  channel?: Channel,
): Promise<ConversationMeta[]> {
  const container = getContainer();

  const query = channel
    ? `SELECT c.id, c.ownerId, c.title, c.createdAt, c.updatedAt,
              c.messageCount, c.role, c.channel
       FROM c
       WHERE c.ownerId = @ownerId AND (c.channel = @channel OR NOT IS_DEFINED(c.channel))
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
  if (useMock()) return mockStore.appendMessages(id, ownerId, newMessages, title);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    // dual-read writes to v2 only (v1 is read-only fallback in that mode).
    return v2.appendMessagesV2(id, ownerId, newMessages, title);
  }
  if (mode === "dual-write") {
    await appendMessagesV1Internal(id, ownerId, newMessages, title);
    await dualWriteV2BestEffort("appendMessages", id, ownerId, () =>
      v2.appendMessagesV2(id, ownerId, newMessages, title),
    );
    return;
  }
  return appendMessagesV1Internal(id, ownerId, newMessages, title);
}

async function appendMessagesV1Internal(
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
  if (useMock()) return mockStore.updateConversationTitle(id, ownerId, title);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    return v2.updateTitleV2(id, ownerId, title);
  }
  if (mode === "dual-write") {
    await updateTitleV1Internal(id, ownerId, title);
    await dualWriteV2BestEffort("updateTitle", id, ownerId, () =>
      v2.updateTitleV2(id, ownerId, title),
    );
    return;
  }
  return updateTitleV1Internal(id, ownerId, title);
}

async function updateTitleV1Internal(
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
  if (useMock()) return mockStore.deleteConversation(id, ownerId);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    return v2.deleteConversationV2(id, ownerId);
  }
  if (mode === "dual-write") {
    await deleteConversationV1Internal(id, ownerId);
    await dualWriteV2BestEffort("deleteConversation", id, ownerId, () =>
      v2.deleteConversationV2(id, ownerId),
    );
    return;
  }
  return deleteConversationV1Internal(id, ownerId);
}

async function deleteConversationV1Internal(
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
  if (useMock()) return mockStore.setConversationPendingConfirmation(id, ownerId, tool);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    return v2.setConversationPendingConfirmationV2(id, ownerId, tool);
  }
  if (mode === "dual-write") {
    await setConversationPendingConfirmationV1Internal(id, ownerId, tool);
    await dualWriteV2BestEffort("setPendingConfirmation", id, ownerId, () =>
      v2.setConversationPendingConfirmationV2(id, ownerId, tool),
    );
    return;
  }
  return setConversationPendingConfirmationV1Internal(id, ownerId, tool);
}

async function setConversationPendingConfirmationV1Internal(
  id: string,
  ownerId: string,
  tool: PendingTool,
): Promise<void> {
  const container = getContainer();
  const conv = await getConversationV1Internal(id, ownerId);
  if (!conv) return;

  conv.pendingConfirmation = tool;
  conv.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(conv);
}

export async function clearConversationPendingConfirmation(
  id: string,
  ownerId: string,
): Promise<PendingTool | null> {
  if (useMock()) return mockStore.clearConversationPendingConfirmation(id, ownerId);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    return v2.clearConversationPendingConfirmationV2(id, ownerId);
  }
  if (mode === "dual-write") {
    const result = await clearConversationPendingConfirmationV1Internal(id, ownerId);
    await dualWriteV2BestEffort("clearPendingConfirmation", id, ownerId, () =>
      v2.clearConversationPendingConfirmationV2(id, ownerId).then(() => undefined),
    );
    return result;
  }
  return clearConversationPendingConfirmationV1Internal(id, ownerId);
}

async function clearConversationPendingConfirmationV1Internal(
  id: string,
  ownerId: string,
): Promise<PendingTool | null> {
  const container = getContainer();
  const conv = await getConversationV1Internal(id, ownerId);
  if (!conv) return null;

  const pending = conv.pendingConfirmation;
  conv.pendingConfirmation = null;
  conv.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(conv);
  return pending;
}

/**
 * Append a CSV reference attachment to a conversation. Enforces the per-
 * conversation cap and retries etag conflicts up to APPEND_CSV_MAX_ATTEMPTS
 * times so that 3+ concurrent uploads at the cap boundary resolve without
 * surfacing a 500 to the caller. CsvAttachmentCapError is never retried.
 */
const APPEND_CSV_MAX_ATTEMPTS = 3;

export async function appendCsvAttachment(
  id: string,
  ownerId: string,
  attachment: CSVReference,
): Promise<void> {
  if (useMock()) return mockStore.appendCsvAttachment(id, ownerId, attachment);

  const mode = getActiveStoreMode();
  if (mode === "v2" || mode === "dual-read") {
    return v2.appendCsvAttachmentV2(id, ownerId, attachment);
  }
  if (mode === "dual-write") {
    await appendCsvAttachmentV1Internal(id, ownerId, attachment);
    await dualWriteV2BestEffort("appendCsvAttachment", id, ownerId, () =>
      v2.appendCsvAttachmentV2(id, ownerId, attachment),
    );
    return;
  }
  return appendCsvAttachmentV1Internal(id, ownerId, attachment);
}

async function appendCsvAttachmentV1Internal(
  id: string,
  ownerId: string,
  attachment: CSVReference,
): Promise<void> {
  const container = getContainer();

  const attempt = async () => {
    const { resource, etag } = await container.item(id, ownerId).read<Conversation>();
    if (!resource) throw new Error(`Conversation ${id} not found`);
    if (!etag) throw new Error(`Missing ETag for conversation ${id}`);

    const existing = resource.csvAttachments ?? [];
    if (existing.length >= CSV_MAX_REFERENCE_ATTACHMENTS) {
      throw new CsvAttachmentCapError(CSV_MAX_REFERENCE_ATTACHMENTS);
    }

    resource.csvAttachments = [...existing, attachment];
    resource.updatedAt = new Date().toISOString();

    await container.item(id, ownerId).replace(resource, {
      accessCondition: { type: "IfMatch", condition: etag },
    });
  };

  let lastErr: unknown;
  for (let i = 0; i < APPEND_CSV_MAX_ATTEMPTS; i++) {
    try {
      await attempt();
      return;
    } catch (err: unknown) {
      if (err instanceof CsvAttachmentCapError) throw err;
      const code = err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
      if (code !== 412) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("appendCsvAttachment: exhausted retries");
}

export async function getCsvAttachments(
  id: string,
  ownerId: string,
): Promise<CSVReference[]> {
  // getConversation already dispatches to the mock store when needed.
  const conv = await getConversation(id, ownerId);
  return conv?.csvAttachments ?? [];
}

export async function isConversationRateLimited(
  id: string,
  ownerId: string,
): Promise<boolean> {
  // getConversation already dispatches to the mock store when needed.
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

    // Truncate tool results before persistence to keep the Cosmos document
    // under the 2 MB item limit. In-memory and API-bound messages retain
    // full results for the current session; only the persisted copy is truncated.
    const { messages: truncatedForPersistence, anyTruncated } = truncateToolResults(
      messages,
      PERSISTENCE_TOOL_RESULT_TOKEN_CAP,
    );
    if (anyTruncated) {
      logger.info("Tool results truncated for Cosmos persistence", "conversation-store", {
        conversationId: id,
        cap: PERSISTENCE_TOOL_RESULT_TOKEN_CAP,
      });
    }

    const attempt = async () => {
      const container = getContainer();
      const { resource, etag } = await container.item(id, ownerId).read<Conversation>();
      if (!resource) return;
      if (!etag) throw new Error(`Missing ETag for conversation ${id}`);

      resource.messages = truncatedForPersistence;
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

  async updateTitle(id: string, title: string): Promise<void> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return;
    await updateTitle(id, ownerId, title);
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
