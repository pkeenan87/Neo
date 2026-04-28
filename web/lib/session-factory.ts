import type { Role } from "./permissions";
import { env } from "./config";
import { logger, hashPii } from "./logger";
import { InMemorySessionStore, type SessionStore } from "./session-store";
import { CosmosSessionStore } from "./conversation-store";
import {
  CosmosV2SessionStore,
  ConversationNotFoundV2Error,
} from "./conversation-store-v2";
import { mockStore } from "./mock-conversation-store";
import { getActiveStoreMode } from "./conversation-store-mode";
import { CsvAttachmentCapError } from "./types";
import type {
  Channel,
  DualWriteDivergencePayload,
  InProgressPlan,
  Message,
  PendingTool,
  Session,
  SessionMeta,
} from "./types";

// ─────────────────────────────────────────────────────────────
//  Dispatching SessionStore
//
//  Picks v1 CosmosSessionStore vs. v2 CosmosV2SessionStore per-call
//  based on NEO_CONVERSATION_STORE_MODE (possibly overridden per-
//  request via the admin X-Neo-Store-Mode header). Mirrors the
//  module-level CRUD dispatch in conversation-store.ts but at the
//  SessionStore interface level so callers (stream.ts,
//  app/api/**/*.ts) don't need to know which schema is active.
//
//  Semantics (matching conversation-store.ts):
//    v1         — v1 store exclusively.
//    v2         — v2 store exclusively.
//    dual-read  — writes to v2; reads try v2, fall back to v1 on null.
//    dual-write — writes to BOTH (v1 authoritative); reads from v1.
//                 v2 write failures log conversation_dual_write_
//                 divergence but do NOT throw.
// ─────────────────────────────────────────────────────────────

/**
 * Dual-read fallback: run the v2 write, fall back to v1 if v2 reports
 * the root is missing (v1-only conversations during rolling migration).
 * Mirrors the module-level `dualReadWriteWithV1Fallback` in
 * conversation-store.ts — necessary here because some SessionStore
 * methods bypass module-level dispatch and talk directly to v2.
 */
async function v2WriteWithV1Fallback<T>(
  conversationId: string,
  operation: string,
  v2Write: () => Promise<T>,
  v1Write: () => Promise<T>,
): Promise<T> {
  try {
    return await v2Write();
  } catch (err) {
    if (err instanceof ConversationNotFoundV2Error) {
      logger.info(
        `dual-read ${operation} fell back to v1 (v2 root missing)`,
        "session-factory",
        { conversationId },
      );
      return v1Write();
    }
    throw err;
  }
}

async function dualWriteV2Best(
  opName: DualWriteDivergencePayload["operation"],
  conversationId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // See conversation-store.ts dualWriteV2BestEffort — cap errors are
    // contract-visible signals, not infra faults. Propagate so the
    // caller doesn't accidentally bypass the cap by virtue of v1
    // succeeding.
    if (err instanceof CsvAttachmentCapError) {
      throw err;
    }
    const payload: DualWriteDivergencePayload = {
      conversationId,
      operation: opName,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    logger.warn(
      "Dual-write v2 diverged from v1 (session-store, best-effort)",
      "session-factory",
      payload as unknown as Record<string, unknown>,
    );
    logger.emitEvent(
      "conversation_dual_write_divergence",
      "v2 session-store write failed under dual-write mode",
      "session-factory",
      payload as unknown as Record<string, unknown>,
    );
  }
}

export class DispatchingSessionStore implements SessionStore {
  private readonly v1 = new CosmosSessionStore();
  private readonly v2 = new CosmosV2SessionStore();

  async create(role: Role, ownerId: string, channel: Channel = "web"): Promise<string> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.create(role, ownerId, channel);
    if (mode === "dual-read") return this.v2.create(role, ownerId, channel);
    // v1 and dual-write both go through CosmosSessionStore.create →
    // module-level createConversation, which itself dispatches to v1
    // and (under dual-write) mirrors to v2 via createConversationV2WithId.
    // A second v2 call here would 409 on every conversation and
    // poison the conversation_dual_write_divergence log signal that
    // operators rely on for the rollout gate. See ultrareview bug_007.
    return this.v1.create(role, ownerId, channel);
  }

  async get(id: string): Promise<Session | undefined> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.get(id);
    if (mode === "dual-read") {
      const v2Result = await this.v2.get(id);
      if (v2Result) return v2Result;
      return this.v1.get(id);
    }
    return this.v1.get(id);
  }

  async getExpired(id: string): Promise<Session | undefined> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.getExpired(id);
    if (mode === "dual-read") {
      const v2Result = await this.v2.getExpired(id);
      if (v2Result) return v2Result;
      return this.v1.getExpired(id);
    }
    return this.v1.getExpired(id);
  }

  async delete(id: string): Promise<boolean> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.delete(id);
    if (mode === "dual-read") {
      // CosmosV2SessionStore.delete swallows errors and returns false
      // on any failure, so we can't rely on the typed error class
      // here. Try v2 first, and if it returns false (not found), also
      // delete from v1 so the delete is effective for v1-only
      // conversations. Double-deleting a conversation that exists in
      // both stores is fine because both `delete` methods are
      // idempotent on missing ids.
      const v2Deleted = await this.v2.delete(id);
      if (!v2Deleted) return this.v1.delete(id);
      return true;
    }
    // v1 and dual-write both go through CosmosSessionStore.delete →
    // module-level deleteConversation, which itself dispatches dual-write.
    // Avoid re-dispatching from here. See ultrareview bug_007.
    return this.v1.delete(id);
  }

  async list(): Promise<SessionMeta[]> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.list();
    if (mode === "dual-read") {
      // Admin-only cross-partition list — merge both stores, dedupe by id.
      const [a, b] = await Promise.all([this.v2.list(), this.v1.list()]);
      const seen = new Set(a.map((s) => s.id));
      const v1Duplicates = b.filter((s) => seen.has(s.id));
      if (v1Duplicates.length > 0) {
        logger.warn(
          "dual-read admin list: v1 ids also present in v2 (v2 wins)",
          "session-factory",
          { duplicateIds: v1Duplicates.map((s) => s.id) },
        );
      }
      return [...a, ...b.filter((s) => !seen.has(s.id))];
    }
    return this.v1.list();
  }

  async listForOwner(ownerId: string): Promise<SessionMeta[]> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.listForOwner(ownerId);
    if (mode === "dual-read") {
      const [a, b] = await Promise.all([
        this.v2.listForOwner(ownerId),
        this.v1.listForOwner(ownerId),
      ]);
      const seen = new Set(a.map((s) => s.id));
      const v1Duplicates = b.filter((s) => seen.has(s.id));
      if (v1Duplicates.length > 0) {
        logger.warn(
          "dual-read listForOwner: v1 ids also present in v2 (v2 wins)",
          "session-factory",
          {
            duplicateIds: v1Duplicates.map((s) => s.id),
            ownerIdHash: hashPii(ownerId),
          },
        );
      }
      return [...a, ...b.filter((s) => !seen.has(s.id))];
    }
    return this.v1.listForOwner(ownerId);
  }

  async setPendingConfirmation(id: string, tool: PendingTool): Promise<void> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.setPendingConfirmation(id, tool);
    if (mode === "dual-read") {
      return v2WriteWithV1Fallback(
        id,
        "setPendingConfirmation",
        () => this.v2.setPendingConfirmation(id, tool),
        () => this.v1.setPendingConfirmation(id, tool),
      );
    }
    // v1 and dual-write: CosmosSessionStore.setPendingConfirmation
    // dispatches through the module-level function, which handles the
    // dual-write mirror. See ultrareview bug_007.
    return this.v1.setPendingConfirmation(id, tool);
  }

  async clearPendingConfirmation(id: string): Promise<PendingTool | null> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.clearPendingConfirmation(id);
    if (mode === "dual-read") {
      return v2WriteWithV1Fallback(
        id,
        "clearPendingConfirmation",
        () => this.v2.clearPendingConfirmation(id),
        () => this.v1.clearPendingConfirmation(id),
      );
    }
    // v1 and dual-write: module-level dispatch in the v1 adapter
    // handles the dual-write mirror.
    return this.v1.clearPendingConfirmation(id);
  }

  async isRateLimited(id: string): Promise<boolean> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.isRateLimited(id);
    if (mode === "dual-read" || mode === "dual-write") {
      // Rate limiting is a security control — a session born under
      // dual-read lives only in v2, but under dual-write we'd normally
      // read v1 only and return false for that session. Union both
      // stores in either dual-* mode to prevent false-negative cap
      // bypasses during the migration window. The extra RU is cheap
      // and rate-limiting shouldn't fail open.
      const [a, b] = await Promise.all([
        this.v2.isRateLimited(id),
        this.v1.isRateLimited(id),
      ]);
      return a || b;
    }
    return this.v1.isRateLimited(id);
  }

  async saveMessages(id: string, messages: Message[], title?: string): Promise<void> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.saveMessages(id, messages, title);
    if (mode === "dual-read") {
      // v2.saveMessages throws ConversationNotFoundV2Error for v1-only
      // conversations (divergence during dual-write, pre-migration
      // sessions). Fall back to v1 so the rolling migration doesn't
      // drop turns from the users whose conversations haven't migrated
      // yet. See ultrareview merged_bug_001.
      try {
        await this.v2.saveMessages(id, messages, title);
      } catch (err) {
        if (err instanceof ConversationNotFoundV2Error) {
          logger.info(
            "dual-read saveMessages fell back to v1 (v2 root missing)",
            "session-factory",
            { conversationId: id },
          );
          await this.v1.saveMessages(id, messages, title);
          return;
        }
        throw err;
      }
      return;
    }
    if (mode === "dual-write") {
      await this.v1.saveMessages(id, messages, title);
      await dualWriteV2Best("saveMessages", id, () =>
        this.v2.saveMessages(id, messages, title),
      );
      return;
    }
    return this.v1.saveMessages(id, messages, title);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.updateTitle(id, title);
    if (mode === "dual-read") {
      return v2WriteWithV1Fallback(
        id,
        "updateTitle",
        () => this.v2.updateTitle(id, title),
        () => this.v1.updateTitle(id, title),
      );
    }
    // v1 and dual-write: module-level dispatch in the v1 adapter
    // handles the dual-write mirror.
    return this.v1.updateTitle(id, title);
  }

  async setInProgressPlan(id: string, plan: InProgressPlan | null): Promise<void> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.setInProgressPlan(id, plan);
    if (mode === "dual-read") {
      return v2WriteWithV1Fallback(
        id,
        "setInProgressPlan",
        () => this.v2.setInProgressPlan(id, plan),
        () => this.v1.setInProgressPlan(id, plan),
      );
    }
    // v1 and dual-write: module-level dispatch handles the mirror.
    return this.v1.setInProgressPlan(id, plan);
  }

  async getInProgressPlan(id: string): Promise<InProgressPlan | null> {
    const mode = getActiveStoreMode();
    if (mode === "v2") return this.v2.getInProgressPlan(id);
    if (mode === "dual-read") {
      // v2 first; fall back to v1 on root-missing (v1-only
      // conversations during the rolling migration).
      try {
        return await this.v2.getInProgressPlan(id);
      } catch (err) {
        if (err instanceof ConversationNotFoundV2Error) {
          return this.v1.getInProgressPlan(id);
        }
        throw err;
      }
    }
    return this.v1.getInProgressPlan(id);
  }
}

function createStore(): SessionStore {
  if (env.COSMOS_ENDPOINT && !env.MOCK_MODE) {
    return new DispatchingSessionStore();
  }

  // MOCK_MODE or no Cosmos configured → file-backed mock store. Persists
  // conversations across dev-server restarts so the sidebar, reload
  // hydration, and tool-trace reconstruction all work without a Cosmos
  // DB. See lib/mock-conversation-store.ts. InMemorySessionStore stays
  // importable for any future test that needs an ephemeral store.
  void InMemorySessionStore;
  console.warn(
    "Cosmos DB disabled (MOCK_MODE or unconfigured) — using file-backed mock conversation store at .neo-mock-store/",
  );
  return mockStore;
}

export const sessionStore: SessionStore = createStore();
