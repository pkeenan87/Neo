import crypto from "crypto";
import { CosmosClient, type Container, type PatchOperation } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { RATE_LIMITS, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import {
  env,
  NEO_CONVERSATIONS_V2_CONTAINER,
  NEO_RETENTION_CLASS_DEFAULT,
} from "./config";
import { resolveRetentionTtlSeconds, COSMOS_TTL_NEVER } from "./retention";
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
import { promoteStagingBlob, isBlobRefDescriptor } from "./tool-result-blob-store";

/**
 * Thrown by v2 write paths when the v2 root doc doesn't exist for the
 * given conversation id. Distinct typed error so the dispatch layer
 * can detect v1-only conversations during `dual-read` and fall back
 * to v1 instead of surfacing a generic 500. See merged_bug_001 in the
 * ultrareview.
 */
export class ConversationNotFoundV2Error extends Error {
  readonly conversationId: string;
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} not found (v2)`);
    this.name = "ConversationNotFoundV2Error";
    this.conversationId = conversationId;
  }
}

// ─────────────────────────────────────────────────────────────
//  Conversation store v2 — split-document + blob-offload schema
//
//  See _plans/conversation-storage-split-blob-offload.md.
//
//  Four document types co-located under partition key /conversationId:
//    1. ConversationV2Root  (docType: "root")
//    2. TurnDoc             (docType: "turn")       append-only
//    3. BlobRefDoc          (docType: "blobref")    metadata for offloaded tool results
//    4. CheckpointDoc       (docType: "checkpoint") immutable, produced by compaction
//
//  Writes:
//    - createConversationV2: inserts a root doc.
//    - appendMessagesV2: appends turn docs + patches root turnCount/updatedAt
//      via a single TransactionalBatch keyed on /conversationId.
//    - updateTitleV2 / setPendingConfirmationV2 / clearPendingConfirmationV2:
//      narrow root patches. Cheaper RU than v1's full-replace.
//    - appendCsvAttachmentV2: single patch on root.csvAttachments.
//    - deleteConversationV2: partition-scoped delete iterator.
//
//  Reads:
//    - getConversationV2: point-read root + partition-scoped query for turns,
//      re-assembles a Conversation matching v1's external shape.
//    - listConversationsV2: cross-partition query for root docs filtered by
//      ownerId + channel. Admin-only cross-partition query via listV2All.
//
//  Blob promotion: after any turn that carried a BlobRefDescriptor on a
//  tool_result.content, we call promoteStagingBlob(sha) so the immutable
//  blobs/<sha> path becomes reachable only AFTER the Cosmos write commits.
//  A partial-failure mid-write leaves the bytes in staging/<sha>, which
//  the lifecycle policy on staging/ reaps automatically.
// ─────────────────────────────────────────────────────────────

const DEFAULT_TTL_BUCKET = "conversation-root";
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TURN_ID_PREFIX = "turn_";
const BLOBREF_ID_PREFIX = "blobref_";
const CHECKPOINT_ID_PREFIX = "ckpt_";

// ── Cosmos container (lazy init) ─────────────────────────────

let _containerV2: Container | null = null;

function getContainerV2(): Container {
  if (_containerV2) return _containerV2;
  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint) {
    throw new Error("COSMOS_ENDPOINT is not configured (v2)");
  }
  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _containerV2 = client
    .database("neo-db")
    .container(NEO_CONVERSATIONS_V2_CONTAINER);
  return _containerV2;
}

/** Test-only escape hatch so unit tests can swap in a fake container. */
export function __resetV2ContainerForTest(fake?: Container | null): void {
  _containerV2 = fake ?? null;
}

// ── ID helpers ───────────────────────────────────────────────

function turnDocId(conversationId: string, turnNumber: number): string {
  return `${TURN_ID_PREFIX}${conversationId}_${turnNumber}`;
}

function blobRefDocId(sha256: string): string {
  return `${BLOBREF_ID_PREFIX}${sha256}`;
}

function checkpointDocId(conversationId: string, rangeEndTurn: number): string {
  return `${CHECKPOINT_ID_PREFIX}${conversationId}_${rangeEndTurn}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Schema transforms ────────────────────────────────────────

/**
 * Pure transform: split an in-memory Conversation into the v2 document
 * set. Used by the migration script (phase 9) and by the write path
 * after appendMessages (for newly-appended turns only, not the whole
 * conversation).
 *
 * For normal runtime writes, prefer appendMessagesV2 which operates on
 * just the incremental turn deltas and patches the root atomically in
 * a single TransactionalBatch. splitConversationToDocs is the
 * migration-time equivalent that produces the full doc set from
 * scratch.
 *
 * Tool-result blob offload is NOT done here — the agent-loop callers
 * in phase 6 run maybeOffloadToolResult on the raw tool result BEFORE
 * the message reaches this helper, so any offloaded payload already
 * arrives as a BlobRefDescriptor JSON string inside the tool_result
 * content. Migration-time offload is handled separately in phase 9.
 */
export function splitConversationToDocs(conv: Conversation): {
  root: ConversationV2Root;
  turns: TurnDoc[];
  blobRefs: BlobRefDoc[];
  checkpoints: CheckpointDoc[];
} {
  const retentionClass = NEO_RETENTION_CLASS_DEFAULT;
  const ttl = resolveRetentionTtlSeconds(retentionClass);

  const root: ConversationV2Root = {
    id: conv.id,
    docType: "root",
    conversationId: conv.id,
    ownerId: conv.ownerId,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    role: conv.role,
    channel: conv.channel,
    schemaVersion: 2,
    retentionClass,
    turnCount: conv.messages.length,
    latestCheckpointId: null,
    rollingSummary: null,
    pendingConfirmation: conv.pendingConfirmation,
    model: conv.model,
    ttl,
    csvAttachments: conv.csvAttachments,
  };

  const turns: TurnDoc[] = conv.messages.map((msg, idx) => {
    const turnNumber = idx + 1; // 1-based
    return {
      id: turnDocId(conv.id, turnNumber),
      docType: "turn",
      conversationId: conv.id,
      turnNumber,
      role: msg.role as "user" | "assistant",
      content: msg.content,
      parentTurnId: turnNumber > 1 ? turnDocId(conv.id, turnNumber - 1) : null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: conv.createdAt,
      ttl,
    };
  });

  // BlobRef metadata docs are created at offload time by the agent loop;
  // the split transform doesn't synthesize them. Migration in phase 9
  // walks the tool_result blocks and produces matching BlobRefDocs.
  const blobRefs: BlobRefDoc[] = [];

  // Checkpoints are created by compaction (deferred to a follow-on
  // plan). No checkpoints in a freshly-split conversation.
  const checkpoints: CheckpointDoc[] = [];

  return { root, turns, blobRefs, checkpoints };
}

/**
 * Pure transform: reassemble an external-shape Conversation from the
 * v2 document set. Turns are sorted by turnNumber. Blob-ref descriptors
 * inside tool_result.content stay as descriptors — the agent loop's
 * get_full_tool_result (phase 6) resolves them lazily when the model
 * re-reads the referenced result.
 */
export function rebuildConversationFromDocs(input: {
  root: ConversationV2Root;
  turns: TurnDoc[];
}): Conversation {
  const sorted = [...input.turns].sort((a, b) => a.turnNumber - b.turnNumber);
  const messages: Message[] = sorted.map((t) => ({
    role: t.role,
    // Cosmos stores content as-persisted (Anthropic content-block array
    // or string). Cast back to the Anthropic Message shape for the
    // external API. No content mutation.
    content: t.content as Message["content"],
  }));

  return {
    id: input.root.id,
    ownerId: input.root.ownerId,
    title: input.root.title,
    createdAt: input.root.createdAt,
    updatedAt: input.root.updatedAt,
    messageCount: input.root.turnCount,
    role: input.root.role,
    channel: input.root.channel,
    messages,
    pendingConfirmation: input.root.pendingConfirmation,
    model: input.root.model,
    ttl: input.root.ttl,
    csvAttachments: input.root.csvAttachments,
  };
}

// ── Blob-promote helper ──────────────────────────────────────

/**
 * Walk a message array looking for tool_result blocks whose content
 * parses as a BlobRefDescriptor, and promote each staging blob to its
 * immutable blobs/<sha> path. Called after the Cosmos write commits so
 * the immutable blob only becomes reachable in lock-step with the
 * referencing row.
 *
 * Failures are best-effort — promotion never throws out, because the
 * staging lifecycle policy backstops any orphan. We log warns.
 */
async function promoteOffloadedBlobsIn(messages: Message[]): Promise<void> {
  // Outer guard upholds the "never throws" contract at this function's
  // own boundary. Without it, the guarantee would depend on every
  // awaited call inside the loop being safe.
  try {
    // Cap the JSON parse size per tool_result block. A real
    // BlobRefDescriptor serializes to well under 1 KB; anything over
    // 4 KB is either a huge genuine descriptor (not our shape) or a
    // DoS probe — either way, skipping is fine.
    const MAX_DESCRIPTOR_PARSE_BYTES = 4 * 1024;

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const maybeToolResult = block as { type?: string; content?: unknown };
        if (maybeToolResult.type !== "tool_result") continue;
        const inner = maybeToolResult.content;

        let parsed: unknown = inner;
        if (typeof inner === "string") {
          if (inner.length > MAX_DESCRIPTOR_PARSE_BYTES) continue;
          try {
            parsed = JSON.parse(inner);
          } catch {
            continue;
          }
        }

        // The descriptor may be wrapped in injection-guard's
        // { _neo_trust_boundary: ..., data: <descriptor> } envelope.
        // CRITICAL: only accept the unwrap when the envelope carries
        // the `_neo_trust_boundary` marker. Without this check, a
        // doctored Cosmos doc with content: { data: { _neo_blob_ref: ... } }
        // would bypass the intended origin verification and trigger
        // a promote on attacker-chosen sha values.
        const outer = parsed as Record<string, unknown> | null;
        let unwrapped: unknown = parsed;
        if (outer && typeof outer === "object" && "data" in outer) {
          if (outer._neo_trust_boundary !== undefined) {
            unwrapped = outer.data;
          } else {
            // Envelope-shaped but not trust-marked — reject.
            continue;
          }
        }

        if (isBlobRefDescriptor(unwrapped)) {
          await promoteStagingBlob(unwrapped.sha256);
        }
      }
    }
  } catch (err) {
    logger.warn(
      "promoteOffloadedBlobsIn failed (best-effort)",
      "conversation-store-v2",
      { errorMessage: (err as Error).message },
    );
  }
}

// ── Public CRUD ──────────────────────────────────────────────

export async function createConversationV2(
  ownerId: string,
  role: Role,
  channel: Channel,
  model?: string,
): Promise<string> {
  const id = `conv_${crypto.randomUUID()}`;
  return createConversationV2WithId(id, ownerId, role, channel, model);
}

/**
 * Create a v2 conversation root with an externally-minted id. Used by
 * the dual-write dispatch in conversation-store.ts so the v1 and v2
 * documents share the same conversationId (v1 mints it first, v2
 * mirrors it). Separate from createConversationV2 so normal production
 * callers don't accidentally supply an unchecked id from request input.
 *
 * SECURITY: the id parameter must match the exact server-minted UUID
 * format — `conv_<uuid-v4>`. Strict regex guard here enforces the
 * contract at runtime even if a future caller accidentally threads a
 * user-controlled string into this function.
 */
// conv_ + 8-4-4-4-12 lowercase hex groups joined with `-` (RFC 4122).
const CONV_V2_ID_RE =
  /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function createConversationV2WithId(
  id: string,
  ownerId: string,
  role: Role,
  channel: Channel,
  model?: string,
): Promise<string> {
  if (!CONV_V2_ID_RE.test(id)) {
    throw new Error(
      `createConversationV2WithId: id must match conv_<uuid-v4>, got "${id}"`,
    );
  }
  const container = getContainerV2();
  const now = nowIso();
  const retentionClass = NEO_RETENTION_CLASS_DEFAULT;
  const ttl = resolveRetentionTtlSeconds(retentionClass);

  const root: ConversationV2Root = {
    id,
    docType: "root",
    conversationId: id,
    ownerId,
    title: null,
    createdAt: now,
    updatedAt: now,
    role,
    channel,
    schemaVersion: 2,
    retentionClass,
    turnCount: 0,
    latestCheckpointId: null,
    rollingSummary: null,
    pendingConfirmation: null,
    model,
    ttl,
  };

  await container.items.create(root);
  logger.info("Conversation created (v2)", "conversation-store-v2", {
    conversationId: id,
    role,
    ownerIdHash: hashPii(ownerId),
  });
  return id;
}

export async function getConversationV2(
  id: string,
  ownerId: string,
): Promise<Conversation | null> {
  const container = getContainerV2();

  // Point-read the root — partition-keyed so RU cost is ~1.
  let root: ConversationV2Root;
  try {
    const { resource } = await container.item(id, id).read<ConversationV2Root>();
    if (!resource || resource.docType !== "root") return null;
    root = resource;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: number }).code === 404) {
      return null;
    }
    throw e;
  }

  // Owner check — mirrors v1 behavior. Admin cross-owner reads are
  // handled at the route level, not here.
  if (root.ownerId !== ownerId) return null;

  // Partition-scoped query for all turn docs, ordered.
  const { resources: turns } = await container.items
    .query<TurnDoc>({
      query: `SELECT * FROM c
              WHERE c.conversationId = @id AND c.docType = "turn"
              ORDER BY c.turnNumber ASC`,
      parameters: [{ name: "@id", value: id }],
    }, { partitionKey: id })
    .fetchAll();

  return rebuildConversationFromDocs({ root, turns });
}

export async function listConversationsV2(
  ownerId: string,
  channel?: Channel,
): Promise<ConversationMeta[]> {
  const container = getContainerV2();

  // Cross-partition query for root docs owned by this user. Partition
  // scoping doesn't help here since /conversationId means each
  // conversation is its own partition.
  const query = channel
    ? `SELECT c.id, c.ownerId, c.title, c.createdAt, c.updatedAt,
              c.turnCount, c.role, c.channel
       FROM c
       WHERE c.docType = "root"
         AND c.ownerId = @ownerId
         AND (c.channel = @channel OR NOT IS_DEFINED(c.channel))
       ORDER BY c.updatedAt DESC
       OFFSET 0 LIMIT 50`
    : `SELECT c.id, c.ownerId, c.title, c.createdAt, c.updatedAt,
              c.turnCount, c.role, c.channel
       FROM c
       WHERE c.docType = "root" AND c.ownerId = @ownerId
       ORDER BY c.updatedAt DESC
       OFFSET 0 LIMIT 50`;

  const parameters: { name: string; value: string }[] = [
    { name: "@ownerId", value: ownerId },
  ];
  if (channel) parameters.push({ name: "@channel", value: channel });

  const { resources } = await container.items
    .query<{
      id: string;
      ownerId: string;
      title: string | null;
      createdAt: string;
      updatedAt: string;
      turnCount: number;
      role: Role;
      channel: Channel;
    }>({ query, parameters })
    .fetchAll();

  return resources.map((r) => ({
    id: r.id,
    ownerId: r.ownerId,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messageCount: r.turnCount,
    role: r.role,
    channel: r.channel,
  }));
}

/**
 * Append new turn documents and patch the root's turnCount +
 * updatedAt + optional title in a single TransactionalBatch keyed on
 * /conversationId. Atomic within the partition; the batch fails (and
 * re-attempts on etag mismatch) if the root has been modified
 * concurrently.
 *
 * Blob promotion runs AFTER the batch commits so staging blobs are
 * only moved to their immutable path once their referencing turn doc
 * is durable.
 */
export async function appendMessagesV2(
  id: string,
  ownerId: string,
  newMessages: Message[],
  title?: string,
): Promise<void> {
  if (newMessages.length === 0) return;
  const container = getContainerV2();

  const attempt = async () => {
    // Read the root to discover the current turn count (we append
    // 1-based from turnCount+1). Also carry the etag so the patch is
    // guarded by it in the batch.
    const { resource: root, etag } = await container
      .item(id, id)
      .read<ConversationV2Root>();
    if (!root || root.docType !== "root") {
      throw new ConversationNotFoundV2Error(id);
    }
    if (root.ownerId !== ownerId) {
      throw new Error(`Conversation ${id} owner mismatch (v2)`);
    }
    if (!etag) throw new Error(`Missing ETag for conversation ${id} (v2)`);

    const nowIsoStr = nowIso();
    const startingTurn = root.turnCount + 1;
    const ttl = resolveRetentionTtlSeconds(root.retentionClass);

    const newTurnDocs: TurnDoc[] = newMessages.map((msg, idx) => {
      const turnNumber = startingTurn + idx;
      return {
        id: turnDocId(id, turnNumber),
        docType: "turn",
        conversationId: id,
        turnNumber,
        role: msg.role as "user" | "assistant",
        content: msg.content,
        parentTurnId: turnNumber > 1 ? turnDocId(id, turnNumber - 1) : null,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: nowIsoStr,
        ttl,
      };
    });

    // Build a TransactionalBatch:
    //   - Create each turn doc.
    //   - Patch the root: turnCount, updatedAt, maybe title.
    // Cosmos caps batches at 100 ops per request, so for very large
    // appends we loop in chunks. In practice an agent turn appends 1-3
    // messages (user + assistant + tool-result user), so we almost
    // always fit in one batch.
    const rootPatchOps: PatchOperation[] = [
      { op: "set", path: "/turnCount", value: root.turnCount + newMessages.length },
      { op: "set", path: "/updatedAt", value: nowIsoStr },
    ];
    if (title && !root.title) {
      rootPatchOps.push({ op: "set", path: "/title", value: title });
    }

    const BATCH_CAP = 99; // leave one slot for the root patch
    for (let i = 0; i < newTurnDocs.length; i += BATCH_CAP) {
      const chunk = newTurnDocs.slice(i, i + BATCH_CAP);
      const isLastChunk = i + BATCH_CAP >= newTurnDocs.length;

      const operations: Array<{
        operationType: "Create" | "Patch";
        id?: string;
        resourceBody?: unknown;
        ifMatch?: string;
        partitionKey?: string;
        options?: unknown;
      }> = chunk.map((t) => ({
        operationType: "Create",
        resourceBody: t as unknown as Record<string, unknown>,
      }));

      if (isLastChunk) {
        operations.push({
          operationType: "Patch",
          id,
          resourceBody: { operations: rootPatchOps },
          ifMatch: etag,
        });
      }

      const batchResp = await container.items.batch(
        operations as Parameters<Container["items"]["batch"]>[0],
        id,
      );
      const status =
        batchResp && typeof batchResp === "object" && "code" in batchResp
          ? (batchResp as { code?: number }).code ?? 0
          : 0;
      if (status >= 300) {
        const err = new Error(
          `appendMessagesV2 batch failed: status=${status}`,
        ) as Error & { code: number };
        err.code = status;
        throw err;
      }
    }
  };

  try {
    await attempt();
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code: number }).code : 0;
    if (code === 412 || code === 409) {
      // Two races produce the same retry remedy:
      //   - 412: our root patch's IfMatch lost to a concurrent root
      //     update (another appender or metadata patch).
      //   - 409: a concurrent appender beat us to the deterministic
      //     turn id `turn_<conv>_<N+1>`. The batch is Create-first /
      //     Patch-last, so the Create collides before our etag guard
      //     fires.
      // Either way: re-read the root → recompute starting turn →
      // re-attempt. Safe only for single-batch appends; multi-chunk
      // appends (>99 messages) can partial-commit, and a retry would
      // double-create the earlier chunks. Rare in agent turns but
      // reachable from migration / bulk imports.
      if (newMessages.length > 99) {
        throw new Error(
          `appendMessagesV2: ${code} conflict on a multi-chunk append ` +
            `(${newMessages.length} messages). Retry logic is safe only for ` +
            `single-batch appends. See phase-9 migration for the proper fix.`,
        );
      }
      await attempt();
    } else {
      throw err;
    }
  }

  // Best-effort staging→blobs promotion for any offloaded tool results
  // referenced by the newly-persisted turns. Failure here doesn't
  // invalidate the write — staging lifecycle reaps orphans.
  await promoteOffloadedBlobsIn(newMessages);
}

export async function updateTitleV2(
  id: string,
  ownerId: string,
  title: string,
): Promise<void> {
  const container = getContainerV2();

  // Owner check via point-read (cheap — partition-keyed point-read is
  // ~1 RU).
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") {
    throw new ConversationNotFoundV2Error(id);
  }
  if (resource.ownerId !== ownerId) {
    throw new Error(`Conversation ${id} owner mismatch (v2)`);
  }

  await container.item(id, id).patch({
    operations: [
      { op: "set", path: "/title", value: title },
      { op: "set", path: "/updatedAt", value: nowIso() },
    ],
  });
}

export async function deleteConversationV2(
  id: string,
  ownerId: string,
): Promise<void> {
  const container = getContainerV2();

  // Owner check first.
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") {
    throw new ConversationNotFoundV2Error(id);
  }
  if (resource.ownerId !== ownerId) {
    throw new Error(`Conversation ${id} owner mismatch (v2)`);
  }

  // Partition-scoped query to enumerate all doc IDs in this partition.
  const { resources: allDocs } = await container.items
    .query<{ id: string }>({
      query: `SELECT c.id FROM c WHERE c.conversationId = @id`,
      parameters: [{ name: "@id", value: id }],
    }, { partitionKey: id })
    .fetchAll();

  // Batch delete — Cosmos caps batches at 100 ops. For conversations
  // with thousands of docs (rare — most are 1 root + N turns), loop.
  const BATCH_CAP = 100;
  for (let i = 0; i < allDocs.length; i += BATCH_CAP) {
    const chunk = allDocs.slice(i, i + BATCH_CAP);
    const operations = chunk.map((d) => ({
      operationType: "Delete" as const,
      id: d.id,
    }));
    await container.items.batch(
      operations as Parameters<Container["items"]["batch"]>[0],
      id,
    );
  }

  logger.info("Conversation deleted (v2)", "conversation-store-v2", {
    conversationId: id,
    ownerIdHash: hashPii(ownerId),
    docCount: allDocs.length,
  });
}

export async function setConversationPendingConfirmationV2(
  id: string,
  ownerId: string,
  tool: PendingTool,
): Promise<void> {
  const container = getContainerV2();
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") {
    throw new ConversationNotFoundV2Error(id);
  }
  if (resource.ownerId !== ownerId) return;

  await container.item(id, id).patch({
    operations: [
      { op: "set", path: "/pendingConfirmation", value: tool },
      { op: "set", path: "/updatedAt", value: nowIso() },
    ],
  });
}

export async function clearConversationPendingConfirmationV2(
  id: string,
  ownerId: string,
): Promise<PendingTool | null> {
  const container = getContainerV2();
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") {
    throw new ConversationNotFoundV2Error(id);
  }
  if (resource.ownerId !== ownerId) return null;

  const pending = resource.pendingConfirmation;
  await container.item(id, id).patch({
    operations: [
      { op: "set", path: "/pendingConfirmation", value: null },
      { op: "set", path: "/updatedAt", value: nowIso() },
    ],
  });
  return pending;
}

const APPEND_CSV_MAX_ATTEMPTS = 3;

export async function appendCsvAttachmentV2(
  id: string,
  ownerId: string,
  attachment: CSVReference,
): Promise<void> {
  const container = getContainerV2();

  const attempt = async () => {
    const { resource, etag } = await container
      .item(id, id)
      .read<ConversationV2Root>();
    if (!resource || resource.docType !== "root") {
      throw new ConversationNotFoundV2Error(id);
    }
    if (resource.ownerId !== ownerId) {
      throw new Error(`Conversation ${id} owner mismatch (v2)`);
    }
    if (!etag) throw new Error(`Missing ETag for conversation ${id} (v2)`);

    const existing = resource.csvAttachments ?? [];
    if (existing.length >= CSV_MAX_REFERENCE_ATTACHMENTS) {
      throw new CsvAttachmentCapError(CSV_MAX_REFERENCE_ATTACHMENTS);
    }

    const next = [...existing, attachment];
    await container.item(id, id).patch(
      {
        operations: [
          { op: "set", path: "/csvAttachments", value: next },
          { op: "set", path: "/updatedAt", value: nowIso() },
        ],
      },
      { accessCondition: { type: "IfMatch", condition: etag } },
    );
  };

  let lastErr: unknown;
  for (let i = 0; i < APPEND_CSV_MAX_ATTEMPTS; i++) {
    try {
      await attempt();
      return;
    } catch (err: unknown) {
      if (err instanceof CsvAttachmentCapError) throw err;
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: number }).code
          : 0;
      if (code !== 412) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("appendCsvAttachmentV2: exhausted retries");
}

export async function getCsvAttachmentsV2(
  id: string,
  ownerId: string,
): Promise<CSVReference[]> {
  const container = getContainerV2();
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") return [];
  if (resource.ownerId !== ownerId) return [];
  return resource.csvAttachments ?? [];
}

export async function isConversationRateLimitedV2(
  id: string,
  ownerId: string,
): Promise<boolean> {
  const container = getContainerV2();
  const { resource } = await container.item(id, id).read<ConversationV2Root>();
  if (!resource || resource.docType !== "root") return false;
  if (resource.ownerId !== ownerId) return false;
  return resource.turnCount >= RATE_LIMITS[resource.role].messagesPerSession;
}

// ── CosmosV2SessionStore ────────────────────────────────────

function rootToSession(root: ConversationV2Root, turns: TurnDoc[]): Session {
  const sorted = [...turns].sort((a, b) => a.turnNumber - b.turnNumber);
  return {
    id: root.id,
    role: root.role as Role,
    ownerId: root.ownerId,
    messages: sorted.map((t) => ({
      role: t.role,
      content: t.content as Message["content"],
    })),
    createdAt: new Date(root.createdAt),
    lastActivityAt: new Date(root.updatedAt),
    messageCount: root.turnCount,
    pendingConfirmation: root.pendingConfirmation,
  };
}

/**
 * v2 SessionStore adapter. External shape is identical to v1
 * CosmosSessionStore; internally it uses the split-doc schema.
 *
 * Differences from v1:
 *   - No id→ownerId cache needed. The partition key is /conversationId
 *     so point-reads don't require the ownerId up front; the ownerId
 *     check happens after the read.
 *   - `list()` (admin-only cross-partition) filters by docType = "root".
 *
 * AUTHORIZATION CONTRACT — IMPORTANT:
 *   SessionStore methods that take only `id` (delete, setPendingConfirmation,
 *   clearPendingConfirmation, isRateLimited, updateTitle) perform a point-read
 *   to resolve the persisted `ownerId` and then pass it to the owner-aware
 *   module function. That owner check is tautological here (persisted === what
 *   we just read). The REAL authorization happens at the route layer: callers
 *   are responsible for authenticating the user AND verifying they own the
 *   session BEFORE invoking these methods. This mirrors the v1 CosmosSessionStore
 *   contract, which has shipped for months with the same semantics — not a
 *   regression. Routes that need explicit ownerId enforcement should call the
 *   module-level *V2 functions directly (they take ownerId) rather than going
 *   through the SessionStore wrapper.
 */
export class CosmosV2SessionStore implements SessionStore {
  async create(role: Role, ownerId: string, channel: Channel = "web"): Promise<string> {
    return createConversationV2(ownerId, role, channel);
  }

  async get(id: string): Promise<Session | undefined> {
    const container = getContainerV2();
    const { resource: root } = await container
      .item(id, id)
      .read<ConversationV2Root>();
    if (!root || root.docType !== "root") return undefined;

    const elapsed = Date.now() - new Date(root.updatedAt).getTime();
    if (elapsed > IDLE_TIMEOUT_MS) {
      logger.info("Conversation idle-expired (v2)", "conversation-store-v2", {
        conversationId: id,
      });
      return undefined;
    }

    const { resources: turns } = await container.items
      .query<TurnDoc>({
        query: `SELECT * FROM c
                WHERE c.conversationId = @id AND c.docType = "turn"
                ORDER BY c.turnNumber ASC`,
        parameters: [{ name: "@id", value: id }],
      }, { partitionKey: id })
      .fetchAll();

    return rootToSession(root, turns);
  }

  async getExpired(id: string): Promise<Session | undefined> {
    const container = getContainerV2();
    const { resource: root } = await container
      .item(id, id)
      .read<ConversationV2Root>();
    if (!root || root.docType !== "root") return undefined;

    const { resources: turns } = await container.items
      .query<TurnDoc>({
        query: `SELECT * FROM c
                WHERE c.conversationId = @id AND c.docType = "turn"
                ORDER BY c.turnNumber ASC`,
        parameters: [{ name: "@id", value: id }],
      }, { partitionKey: id })
      .fetchAll();

    return rootToSession(root, turns);
  }

  async delete(id: string): Promise<boolean> {
    const container = getContainerV2();
    try {
      const { resource } = await container
        .item(id, id)
        .read<ConversationV2Root>();
      if (!resource) return false;
      await deleteConversationV2(id, resource.ownerId);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<SessionMeta[]> {
    // Admin-only cross-partition query for root docs.
    const container = getContainerV2();
    const { resources } = await container.items
      .query<{
        id: string;
        ownerId: string;
        role: Role;
        createdAt: string;
        turnCount: number;
      }>({
        query: `SELECT c.id, c.ownerId, c.role, c.createdAt, c.turnCount
                FROM c
                WHERE c.docType = "root"
                ORDER BY c.updatedAt DESC
                OFFSET 0 LIMIT 50`,
      })
      .fetchAll();

    return resources.map((r) => ({
      id: r.id,
      role: r.role,
      ownerId: r.ownerId,
      createdAt: new Date(r.createdAt),
      messageCount: r.turnCount,
    }));
  }

  async listForOwner(ownerId: string): Promise<SessionMeta[]> {
    const convos = await listConversationsV2(ownerId);
    return convos.map((c) => ({
      id: c.id,
      role: c.role as Role,
      ownerId: c.ownerId,
      createdAt: new Date(c.createdAt),
      messageCount: c.messageCount,
    }));
  }

  async setPendingConfirmation(id: string, tool: PendingTool): Promise<void> {
    const container = getContainerV2();
    const { resource } = await container.item(id, id).read<ConversationV2Root>();
    if (!resource) throw new ConversationNotFoundV2Error(id);
    await setConversationPendingConfirmationV2(id, resource.ownerId, tool);
  }

  async clearPendingConfirmation(id: string): Promise<PendingTool | null> {
    const container = getContainerV2();
    const { resource } = await container.item(id, id).read<ConversationV2Root>();
    if (!resource) throw new ConversationNotFoundV2Error(id);
    return clearConversationPendingConfirmationV2(id, resource.ownerId);
  }

  async isRateLimited(id: string): Promise<boolean> {
    const container = getContainerV2();
    const { resource } = await container.item(id, id).read<ConversationV2Root>();
    if (!resource) return false;
    return isConversationRateLimitedV2(id, resource.ownerId);
  }

  async saveMessages(id: string, messages: Message[], title?: string): Promise<void> {
    // The v1 adapter historically treated saveMessages as "replace the
    // full message list". In v2 that would mean deleting every existing
    // turn doc and writing N new ones, which is expensive and
    // uncharacteristic of how callers actually use this method —
    // stream.ts:writeAgentResult always passes the cumulative message
    // array, but every Message beyond turnCount is the new-delta we
    // care about.
    //
    // Strategy: read the current turnCount from the root, slice the
    // incoming messages at that point, and append only the delta. Zero
    // delta ⇒ no-op (update the root's updatedAt so the sidebar
    // timestamp refreshes).
    //
    // Concurrency: a second writer can land a turn between our root
    // read and our append. Without protection, `slice(currentTurnCount)`
    // would return [] and our new turn would be silently dropped.
    // Detect the condition (currentTurnCount >= messages.length implies
    // someone else wrote) and surface it as a conflict that the caller
    // can retry, matching the v1 adapter's IfMatch-412 behavior.
    const container = getContainerV2();
    const { resource: root } = await container
      .item(id, id)
      .read<ConversationV2Root>();
    if (!root || root.docType !== "root") {
      // Missing root means the session the caller wanted to update
      // doesn't exist on this store. Throw the typed error so the
      // dispatch layer can fall back to v1 under dual-read (the
      // v1-only migration-in-progress case). See merged_bug_001.
      throw new ConversationNotFoundV2Error(id);
    }

    const currentTurnCount = root.turnCount;
    if (currentTurnCount > messages.length) {
      // Someone else appended turns after the caller loaded this
      // conversation. Dropping our delta would be silent data loss.
      throw Object.assign(
        new Error(
          `saveMessages: concurrent write detected on conversation ${id} ` +
            `(persisted turnCount=${currentTurnCount} > caller messages.length=${messages.length}). ` +
            `Caller should re-load and re-apply.`,
        ),
        { code: 409 },
      );
    }

    const delta = messages.slice(currentTurnCount);
    if (delta.length === 0) {
      // True zero-delta (currentTurnCount === messages.length). Fold
      // the updatedAt touch and the optional title-set into a single
      // patch so we only pay one Cosmos round-trip in the common
      // zero-delta case (stream.ts' save-on-turn-complete).
      const ops: PatchOperation[] = [
        { op: "set", path: "/updatedAt", value: nowIso() },
      ];
      if (title && !root.title) {
        ops.push({ op: "set", path: "/title", value: title });
      }
      await container.item(id, id).patch({ operations: ops });
      return;
    }

    await appendMessagesV2(id, root.ownerId, delta, title);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const container = getContainerV2();
    const { resource } = await container.item(id, id).read<ConversationV2Root>();
    if (!resource) throw new ConversationNotFoundV2Error(id);
    await updateTitleV2(id, resource.ownerId, title);
  }
}

// Re-exports so phase 5's dispatch layer can import without a deep
// module path.
export const COSMOS_V2_TTL_NEVER = COSMOS_TTL_NEVER;
export const V2_DEFAULT_TTL_BUCKET = DEFAULT_TTL_BUCKET;
