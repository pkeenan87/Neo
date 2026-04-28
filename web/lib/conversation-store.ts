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
  InProgressPlan,
} from "./types";
import { CSV_MAX_REFERENCE_ATTACHMENTS, CsvAttachmentCapError, isInProgressPlan } from "./types";
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
 *
 * EXCEPTION: certain error types are caller-visible contract signals,
 * not infra faults, and MUST propagate so the caller can react:
 *   - CsvAttachmentCapError: user hit the per-conversation cap. If v2
 *     throws it under dual-write (e.g. v2 has more attachments than
 *     v1 due to drift), we should NOT silently let v1 exceed the cap.
 *   - (future) ownership-rejection errors, once typed.
 * Anything not in this allowlist is treated as an infra fault and
 * swallowed with a divergence log.
 */
/**
 * Dual-read write helper: runs the v2 write; if v2 reports the root
 * is missing (v1-only conversation during a rolling migration),
 * logs a fallback event and delegates to the v1 writer. Matches the
 * read-side fallback in getConversation so dual-read is safe for
 * v1-only conversations that pre-date the migration or were created
 * during a dual-write v2 outage. See ultrareview merged_bug_001.
 */
async function dualReadWriteWithV1Fallback<T>(
  conversationId: string,
  operation: DualWriteDivergencePayload["operation"],
  ownerId: string | undefined,
  v2Write: () => Promise<T>,
  v1Write: () => Promise<T>,
): Promise<T> {
  try {
    return await v2Write();
  } catch (err) {
    if (err instanceof v2.ConversationNotFoundV2Error) {
      logger.info(
        "dual-read write fell back to v1 (v2 root missing)",
        "conversation-store",
        {
          conversationId,
          operation,
          ownerIdHash: ownerId !== undefined ? hashPii(ownerId) : undefined,
        },
      );
      return v1Write();
    }
    throw err;
  }
}

async function dualWriteV2BestEffort(
  opName: DualWriteDivergencePayload["operation"],
  conversationId: string,
  ownerId: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Contract-signal errors propagate rather than being swallowed as
    // a routine divergence. CsvAttachmentCapError is the one concrete
    // case today; add more as they're identified.
    if (err instanceof CsvAttachmentCapError) {
      throw err;
    }
    const payload: DualWriteDivergencePayload = {
      conversationId,
      operation: opName,
      errorMessage: err instanceof Error ? err.message : String(err),
      ownerId: ownerId !== undefined ? hashPii(ownerId) : undefined,
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
    //
    // NOTE: both inner queries cap at 50. Users with more than 50
    // conversations in either store can have trailing v1-only entries
    // invisible to this merge. Acceptable during migration; post-
    // cutover, v2-only eliminates the issue.
    const [v2List, v1List] = await Promise.all([
      v2.listConversationsV2(ownerId, channel),
      listConversationsV1Internal(ownerId, channel),
    ]);
    const seen = new Set(v2List.map((c) => c.id));
    const v1Duplicates = v1List.filter((c) => seen.has(c.id));
    if (v1Duplicates.length > 0) {
      // Conversation appearing in BOTH containers is a migration-state
      // signal. v2 wins silently, but we log so ops can detect drift.
      logger.warn(
        "dual-read list: v1 ids also present in v2 (v2 wins)",
        "conversation-store",
        {
          duplicateIds: v1Duplicates.map((c) => c.id),
          ownerIdHash: hashPii(ownerId),
        },
      );
    }
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
  if (mode === "v2") {
    return v2.appendMessagesV2(id, ownerId, newMessages, title);
  }
  if (mode === "dual-read") {
    // dual-read writes to v2, falling back to v1 on v2-root-missing
    // so v1-only conversations (divergence during dual-write, pre-
    // migration sessions) don't 500 during the rolling migration.
    return dualReadWriteWithV1Fallback(
      id,
      "appendMessages",
      ownerId,
      () => v2.appendMessagesV2(id, ownerId, newMessages, title),
      () => appendMessagesV1Internal(id, ownerId, newMessages, title),
    );
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
  if (mode === "v2") {
    return v2.updateTitleV2(id, ownerId, title);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "updateTitle",
      ownerId,
      () => v2.updateTitleV2(id, ownerId, title),
      () => updateTitleV1Internal(id, ownerId, title),
    );
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
  if (mode === "v2") {
    return v2.deleteConversationV2(id, ownerId);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "deleteConversation",
      ownerId,
      () => v2.deleteConversationV2(id, ownerId),
      () => deleteConversationV1Internal(id, ownerId),
    );
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
  if (mode === "v2") {
    return v2.setConversationPendingConfirmationV2(id, ownerId, tool);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "setPendingConfirmation",
      ownerId,
      () => v2.setConversationPendingConfirmationV2(id, ownerId, tool),
      () => setConversationPendingConfirmationV1Internal(id, ownerId, tool),
    );
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
  if (mode === "v2") {
    return v2.clearConversationPendingConfirmationV2(id, ownerId);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "clearPendingConfirmation",
      ownerId,
      () => v2.clearConversationPendingConfirmationV2(id, ownerId),
      () => clearConversationPendingConfirmationV1Internal(id, ownerId),
    );
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
 * Persist a multi-step plan on the conversation root so the next user
 * turn can resume when the current turn was truncated mid-tool-use.
 * Pass `null` to clear. See _plans/output-budget.md.
 */
export async function setConversationInProgressPlan(
  id: string,
  ownerId: string,
  plan: InProgressPlan | null,
): Promise<void> {
  if (useMock()) return mockStore.setConversationInProgressPlan(id, ownerId, plan);

  const mode = getActiveStoreMode();
  if (mode === "v2") {
    return v2.setConversationInProgressPlanV2(id, ownerId, plan);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "setInProgressPlan",
      ownerId,
      () => v2.setConversationInProgressPlanV2(id, ownerId, plan),
      () => setConversationInProgressPlanV1Internal(id, ownerId, plan),
    );
  }
  if (mode === "dual-write") {
    await setConversationInProgressPlanV1Internal(id, ownerId, plan);
    await dualWriteV2BestEffort("setInProgressPlan", id, ownerId, () =>
      v2.setConversationInProgressPlanV2(id, ownerId, plan),
    );
    return;
  }
  return setConversationInProgressPlanV1Internal(id, ownerId, plan);
}

async function setConversationInProgressPlanV1Internal(
  id: string,
  ownerId: string,
  plan: InProgressPlan | null,
): Promise<void> {
  const container = getContainer();
  const conv = await getConversationV1Internal(id, ownerId);
  if (!conv) return;

  conv.inProgressPlan = plan;
  conv.updatedAt = new Date().toISOString();
  await container.item(id, ownerId).replace(conv);
}

export async function getConversationInProgressPlan(
  id: string,
  ownerId: string,
): Promise<InProgressPlan | null> {
  if (useMock()) return mockStore.getConversationInProgressPlan(id, ownerId);

  const conv = await getConversation(id, ownerId);
  const raw = conv?.inProgressPlan ?? null;
  // Shape-validate the persisted field before handing it to the agent
  // loop. A corrupted Cosmos doc (or an older schema) returning an
  // unrecognised object shape must NOT reach the system-prompt
  // resumption hint. See security review S1.
  if (raw && !isInProgressPlan(raw)) {
    logger.warn("Persisted inProgressPlan failed shape validation — ignoring", "conversation-store", {
      conversationId: id,
    });
    return null;
  }
  return raw;
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
  if (mode === "v2") {
    return v2.appendCsvAttachmentV2(id, ownerId, attachment);
  }
  if (mode === "dual-read") {
    return dualReadWriteWithV1Fallback(
      id,
      "appendCsvAttachment",
      ownerId,
      () => v2.appendCsvAttachmentV2(id, ownerId, attachment),
      () => appendCsvAttachmentV1Internal(id, ownerId, attachment),
    );
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
    inProgressPlan: conv.inProgressPlan ?? null,
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

  async setInProgressPlan(id: string, plan: InProgressPlan | null): Promise<void> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return;
    await setConversationInProgressPlan(id, ownerId, plan);
  }

  async getInProgressPlan(id: string): Promise<InProgressPlan | null> {
    const ownerId = await this.resolveOwner(id);
    if (!ownerId) return null;
    return getConversationInProgressPlan(id, ownerId);
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
