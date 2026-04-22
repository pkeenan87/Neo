import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import crypto from "node:crypto";
import { RATE_LIMITS, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import { NEO_CONVERSATION_STORE_MODE } from "./config";
import type {
  Conversation,
  ConversationMeta,
  ConversationV2Root,
  TurnDoc,
  BlobRefDoc,
  CheckpointDoc,
  Message,
  PendingTool,
  Session,
  SessionMeta,
  Channel,
  CSVReference,
} from "./types";
import { CSV_MAX_REFERENCE_ATTACHMENTS, CsvAttachmentCapError } from "./types";
import type { SessionStore } from "./session-store";
import {
  splitConversationToDocs,
  rebuildConversationFromDocs,
} from "./conversation-store-v2";

// ─────────────────────────────────────────────────────────────
//  MockConversationStore
//
//  A file-backed substitute for the Cosmos conversation store + the
//  InMemorySessionStore. Active only when env.MOCK_MODE (or when
//  Cosmos is otherwise unavailable) — see session-factory.ts and the
//  conversation-store.ts dispatchers.
//
//  Lets dev users run the app end-to-end without a Cosmos DB: the
//  sidebar conversations list, reload-hydration of an in-flight chat,
//  and persistence of tool traces across restarts all Just Work.
//
//  Not safe for multi-process use (single dev server, single on-disk
//  file, no locking). Intentionally write-synchronous — conversation
//  volumes in dev are low and a sync flush on every mutation keeps
//  the file in sync even if the dev server crashes mid-turn.
// ─────────────────────────────────────────────────────────────

const DEFAULT_STORE_PATH = resolve(
  process.cwd(),
  ".neo-mock-store",
  "conversations.json",
);

// ─── On-disk file layouts ───
//
// v1: one Conversation per entry. Matches the legacy Cosmos v1
//     schema where everything is packed into a single doc.
interface StoreShapeV1 {
  version: 1;
  conversations: Conversation[];
}

// v2: matches the split Cosmos schema — root + turns + blob-refs +
//     checkpoints as separate arrays. Devs running with
//     NEO_CONVERSATION_STORE_MODE != "v1" see the same shape on disk
//     they'd see in production Cosmos, giving them realistic parity
//     for debugging hydration / reload behavior. Blob offload is
//     STILL a no-op in mock (results stay inline inside each turn's
//     content) — the real offload module falls through to inline
//     when CLI_STORAGE_ACCOUNT isn't configured, which is the mock-
//     mode default.
interface StoreShapeV2 {
  version: 2;
  roots: ConversationV2Root[];
  turns: TurnDoc[];
  blobRefs: BlobRefDoc[];
  checkpoints: CheckpointDoc[];
}

type StoreShape = StoreShapeV1 | StoreShapeV2;

/** True when the active store mode implies devs should see the
 *  split-document on-disk layout. Any non-"v1" mode qualifies. */
function shouldUseSplitShape(): boolean {
  return NEO_CONVERSATION_STORE_MODE !== "v1";
}

export class MockConversationStore implements SessionStore {
  private conversations = new Map<string, Conversation>();
  private loaded = false;
  private readonly storePath: string;

  constructor(storePath: string = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.storePath)) return;
    try {
      const raw = readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      if (!parsed || typeof parsed.version !== "number") {
        logger.warn(
          "Mock conversation store file has unexpected shape; starting empty",
          "mock-conversation-store",
          { path: this.storePath },
        );
        return;
      }

      if (parsed.version === 1 && Array.isArray((parsed as StoreShapeV1).conversations)) {
        // Legacy v1 file — load as Conversations directly. If the
        // dev is now in a split-shape mode, the next save() will
        // auto-upgrade the file to v2.
        const v1 = parsed as StoreShapeV1;
        for (const conv of v1.conversations) {
          if (conv && typeof conv.id === "string") {
            this.conversations.set(conv.id, conv);
          }
        }
      } else if (
        parsed.version === 2 &&
        Array.isArray((parsed as StoreShapeV2).roots) &&
        Array.isArray((parsed as StoreShapeV2).turns)
      ) {
        // v2 file — reassemble each Conversation from root + turns.
        // blob-refs and checkpoints are loaded but not exercised by
        // the mock's in-memory model (tool-result content stays
        // inline inside the turn's content exactly as it was
        // persisted — the mock never offloads).
        const v2 = parsed as StoreShapeV2;
        const turnsByConv = new Map<string, TurnDoc[]>();
        for (const t of v2.turns) {
          if (!turnsByConv.has(t.conversationId)) {
            turnsByConv.set(t.conversationId, []);
          }
          turnsByConv.get(t.conversationId)!.push(t);
        }
        for (const root of v2.roots) {
          const turns = turnsByConv.get(root.conversationId) ?? [];
          this.conversations.set(
            root.id,
            rebuildConversationFromDocs({ root, turns }),
          );
        }
      } else {
        logger.warn(
          "Mock conversation store file has unknown version; starting empty",
          "mock-conversation-store",
          { path: this.storePath, version: parsed.version },
        );
        return;
      }

      logger.info("Mock conversation store loaded", "mock-conversation-store", {
        path: this.storePath,
        count: this.conversations.size,
        storedVersion: parsed.version,
      });
    } catch (err) {
      logger.warn(
        "Failed to load mock conversation store; starting empty",
        "mock-conversation-store",
        { path: this.storePath, errorMessage: (err as Error).message },
      );
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const useSplit = shouldUseSplitShape();
      let shape: StoreShape;
      if (useSplit) {
        // Split each Conversation into root + turns. blob-refs and
        // checkpoints are always empty in the mock — offload and
        // compaction are Cosmos-only paths.
        const roots: ConversationV2Root[] = [];
        const turns: TurnDoc[] = [];
        for (const conv of this.conversations.values()) {
          const split = splitConversationToDocs(conv);
          roots.push(split.root);
          turns.push(...split.turns);
        }
        shape = {
          version: 2,
          roots,
          turns,
          blobRefs: [],
          checkpoints: [],
        };
      } else {
        shape = {
          version: 1,
          conversations: Array.from(this.conversations.values()),
        };
      }
      writeFileSync(this.storePath, JSON.stringify(shape, null, 2), "utf-8");
    } catch (err) {
      logger.warn(
        "Failed to persist mock conversation store",
        "mock-conversation-store",
        { path: this.storePath, errorMessage: (err as Error).message },
      );
    }
  }

  // ── Conversation-store CRUD ─────────────────────────────────

  async createConversation(
    ownerId: string,
    role: Role,
    channel: Channel,
    model?: string,
  ): Promise<string> {
    this.load();
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
    };
    this.conversations.set(id, doc);
    this.save();
    logger.info("Mock conversation created", "mock-conversation-store", {
      conversationId: id,
      role,
      ownerIdHash: hashPii(ownerId),
    });
    return id;
  }

  async getConversation(id: string, ownerId: string): Promise<Conversation | null> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return null;
    if (conv.ownerId !== ownerId) return null;
    // Return a deep-enough clone so callers can mutate freely.
    return JSON.parse(JSON.stringify(conv)) as Conversation;
  }

  async listConversations(
    ownerId: string,
    channel?: Channel,
  ): Promise<ConversationMeta[]> {
    this.load();
    const out: ConversationMeta[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.ownerId !== ownerId) continue;
      if (channel && conv.channel && conv.channel !== channel) continue;
      out.push({
        id: conv.id,
        ownerId: conv.ownerId,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messageCount,
        role: conv.role,
        channel: conv.channel,
      });
    }
    // Newest first — matches the Cosmos ORDER BY updatedAt DESC.
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out.slice(0, 50);
  }

  async appendMessages(
    id: string,
    ownerId: string,
    newMessages: Message[],
    title?: string,
  ): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    if (conv.ownerId !== ownerId) throw new Error(`Conversation ${id} owner mismatch`);
    conv.messages.push(...newMessages);
    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    if (title && !conv.title) conv.title = title;
    this.save();
  }

  /**
   * Owner-checked title update used by the /api/conversations/[id]
   * PATCH route. Renamed from `updateTitle` so it doesn't clash with
   * the SessionStore.updateTitle(id, title) signature below (which
   * trusts the session's own ownerId instead of requiring it as an arg).
   */
  async updateConversationTitle(id: string, ownerId: string, title: string): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation ${id} not found`);
    if (conv.ownerId !== ownerId) throw new Error(`Conversation ${id} owner mismatch`);
    conv.title = title;
    conv.updatedAt = new Date().toISOString();
    this.save();
  }

  async deleteConversation(id: string, ownerId: string): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return;
    if (conv.ownerId !== ownerId) return;
    this.conversations.delete(id);
    this.save();
    logger.info("Mock conversation deleted", "mock-conversation-store", {
      conversationId: id,
      ownerIdHash: hashPii(ownerId),
    });
  }

  async setConversationPendingConfirmation(
    id: string,
    ownerId: string,
    tool: PendingTool,
  ): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId !== ownerId) return;
    conv.pendingConfirmation = tool;
    conv.updatedAt = new Date().toISOString();
    this.save();
  }

  async clearConversationPendingConfirmation(
    id: string,
    ownerId: string,
  ): Promise<PendingTool | null> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId !== ownerId) return null;
    const pending = conv.pendingConfirmation;
    conv.pendingConfirmation = null;
    conv.updatedAt = new Date().toISOString();
    this.save();
    return pending;
  }

  async appendCsvAttachment(
    id: string,
    ownerId: string,
    attachment: CSVReference,
  ): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId !== ownerId) {
      throw new Error(`Conversation ${id} not found`);
    }
    const existing = conv.csvAttachments ?? [];
    if (existing.length >= CSV_MAX_REFERENCE_ATTACHMENTS) {
      throw new CsvAttachmentCapError(CSV_MAX_REFERENCE_ATTACHMENTS);
    }
    conv.csvAttachments = [...existing, attachment];
    conv.updatedAt = new Date().toISOString();
    this.save();
  }

  async getCsvAttachments(id: string, ownerId: string): Promise<CSVReference[]> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId !== ownerId) return [];
    return conv.csvAttachments ?? [];
  }

  async isConversationRateLimited(id: string, ownerId: string): Promise<boolean> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv || conv.ownerId !== ownerId) return false;
    return conv.messageCount >= RATE_LIMITS[conv.role].messagesPerSession;
  }

  // ── SessionStore implementation ─────────────────────────────
  //
  // Sessions are just conversations with an empty ownerId when we don't
  // have one yet. The SessionStore interface signatures don't all carry
  // ownerId, so we embed it in the stored Conversation and treat the
  // first create() call as binding the ownerId.

  async create(role: Role, ownerId: string, channel: Channel = "web"): Promise<string> {
    return this.createConversation(ownerId, role, channel);
  }

  async get(id: string): Promise<Session | undefined> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return undefined;
    return {
      id: conv.id,
      role: conv.role,
      ownerId: conv.ownerId,
      messages: conv.messages,
      createdAt: new Date(conv.createdAt),
      lastActivityAt: new Date(conv.updatedAt),
      messageCount: conv.messageCount,
      pendingConfirmation: conv.pendingConfirmation,
    };
  }

  async getExpired(id: string): Promise<Session | undefined> {
    // Mock store has no idle-expiry sweep; "expired" === "present".
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return false;
    this.conversations.delete(id);
    this.save();
    return true;
  }

  async list(): Promise<SessionMeta[]> {
    this.load();
    const out: SessionMeta[] = [];
    for (const conv of this.conversations.values()) {
      out.push({
        id: conv.id,
        role: conv.role,
        ownerId: conv.ownerId,
        createdAt: new Date(conv.createdAt),
        messageCount: conv.messageCount,
      });
    }
    return out;
  }

  async listForOwner(ownerId: string): Promise<SessionMeta[]> {
    const all = await this.list();
    return all.filter((s) => s.ownerId === ownerId);
  }

  async setPendingConfirmation(id: string, tool: PendingTool): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return;
    conv.pendingConfirmation = tool;
    conv.updatedAt = new Date().toISOString();
    this.save();
  }

  async clearPendingConfirmation(id: string): Promise<PendingTool | null> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return null;
    const pending = conv.pendingConfirmation;
    conv.pendingConfirmation = null;
    conv.updatedAt = new Date().toISOString();
    this.save();
    return pending;
  }

  async isRateLimited(id: string): Promise<boolean> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return false;
    return conv.messageCount >= RATE_LIMITS[conv.role].messagesPerSession;
  }

  async saveMessages(id: string, messages: Message[], title?: string): Promise<void> {
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return;
    conv.messages = messages;
    conv.messageCount = messages.length;
    conv.updatedAt = new Date().toISOString();
    if (title && !conv.title) conv.title = title;
    this.save();
  }

  async updateTitle(id: string, title: string): Promise<void> {
    // SessionStore.updateTitle: no ownerId (the session already owns itself).
    this.load();
    const conv = this.conversations.get(id);
    if (!conv) return;
    conv.title = title;
    conv.updatedAt = new Date().toISOString();
    this.save();
  }
}

// Singleton — module-level so the conversation-store dispatchers and
// the session-factory see the same data.
export const mockStore = new MockConversationStore();
