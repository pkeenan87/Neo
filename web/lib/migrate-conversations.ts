import type { Container } from "@azure/cosmos";
import { logger, hashPii } from "./logger";
import {
  splitConversationToDocs,
  rebuildConversationFromDocs,
} from "./conversation-store-v2";
import {
  maybeOffloadToolResult,
  promoteStagingBlob,
  resolveBlobRef,
  isBlobRefDescriptor,
} from "./tool-result-blob-store";
import {
  NEO_BLOB_OFFLOAD_THRESHOLD_BYTES,
  NEO_RETENTION_CLASS_DEFAULT,
} from "./config";
import { resolveRetentionTtlSeconds } from "./retention";
import type {
  Conversation,
  ConversationV2Root,
  TurnDoc,
  BlobRefDoc,
  BlobRefDescriptor,
  Message,
} from "./types";

// ─────────────────────────────────────────────────────────────
//  Migration module: v1 ↔ v2 conversation store.
//
//  The CLI wrapper in scripts/migrate-cosmos-v1-to-v2.ts wires this
//  up to real Cosmos + blob clients; tests inject fakes. All dispatch
//  and iteration logic lives here so it can be unit-tested end-to-end
//  without requiring a live Cosmos endpoint.
// ─────────────────────────────────────────────────────────────

/** Reasonable headroom under Cosmos's hard 2 MB per-item ceiling. */
export const V1_MAX_DOC_BYTES = 2 * 1024 * 1024 - 32 * 1024;

export interface MigrateOptions {
  dryRun: boolean;
  direction: "v1-to-v2" | "v2-to-v1";
  /** ISO date — only migrate conversations whose `updatedAt >= since`. */
  since?: string;
  /** Filter to a single conversation id. */
  conversationId?: string;
  /** Filter to a single owner. */
  ownerId?: string;
  /** Sleep ms between batches once `--ru-budget` RU is spent in the
   *  current second. 0 disables throttling. */
  ruBudget?: number;
  /** Skip conversations already marked migrated. Ignored with
   *  --force-rerun. */
  forceRerun?: boolean;
}

export interface MigrationCheckpoint {
  lastProcessedConversationId: string | null;
  direction: "v1-to-v2" | "v2-to-v1";
  updatedAt: string;
}

export interface MigrationSummary {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  rejectedOversized: string[]; // v2-to-v1 only
  failures: Array<{ conversationId: string; errorMessage: string }>;
}

export interface MigrationIO {
  v1Container: Container;
  v2Container: Container;
  /** Optional — tests can override to inject deterministic behavior. */
  offloadToolResult?: typeof maybeOffloadToolResult;
  promoteBlob?: typeof promoteStagingBlob;
  resolveBlob?: typeof resolveBlobRef;
  now?: () => string;
}

// ── v1 → v2 ──────────────────────────────────────────────────

/**
 * Transform a single v1 Conversation into the v2 document set,
 * offloading oversized tool_result blocks to blob storage.
 *
 * Pure-ish: the transform itself is synchronous, but blob offload
 * requires async I/O. Returns the v2 docs + the list of sha256 values
 * whose staging blobs need promotion after the Cosmos write commits.
 */
export async function splitV1ToV2WithOffload(
  conv: Conversation,
  io: Pick<MigrationIO, "offloadToolResult">,
): Promise<{
  root: ConversationV2Root;
  turns: TurnDoc[];
  blobRefs: BlobRefDoc[];
  shasToPromote: string[];
}> {
  const offload = io.offloadToolResult ?? maybeOffloadToolResult;
  const split = splitConversationToDocs(conv);
  const shasToPromote: string[] = [];
  const synthesizedBlobRefs: BlobRefDoc[] = [];
  const ttl = resolveRetentionTtlSeconds(NEO_RETENTION_CLASS_DEFAULT);

  // Walk each turn's content looking for tool_result blocks whose
  // serialized form exceeds the offload threshold.
  for (const turn of split.turns) {
    if (!Array.isArray(turn.content)) continue;
    const blocks = turn.content as Array<Record<string, unknown>>;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block || block.type !== "tool_result") continue;

      const inner = block.content;
      // Inner may already be a BlobRefDescriptor (migrating a
      // previously-offloaded v1 doc). Skip those — the descriptor
      // already points at a stable blob and the v1 doc's inline
      // payload is the full JSON anyway.
      if (typeof inner === "object" && isBlobRefDescriptor(inner)) {
        continue;
      }

      // Serialize to measure size. We offload the inner content only,
      // leaving the wrapping tool_result block structure intact.
      const innerJson = typeof inner === "string" ? inner : JSON.stringify(inner);
      const sizeBytes = Buffer.byteLength(innerJson, "utf8");
      if (sizeBytes < NEO_BLOB_OFFLOAD_THRESHOLD_BYTES) continue;

      const sourceTool =
        typeof block.tool_use_id === "string"
          ? `tool_use_${block.tool_use_id.slice(0, 16)}`
          : "unknown";

      const offloaded = await offload(innerJson, {
        conversationId: conv.id,
        sourceTool,
      });
      if (typeof offloaded === "string") {
        // Below threshold or storage unavailable — keep inline.
        continue;
      }

      // Replace the tool_result's inner content with the descriptor.
      blocks[i] = { ...block, content: offloaded };
      shasToPromote.push(offloaded.sha256);
      synthesizedBlobRefs.push({
        id: `blobref_${offloaded.sha256}`,
        docType: "blobref",
        conversationId: conv.id,
        turnNumber: turn.turnNumber,
        uri: offloaded.uri,
        sha256: offloaded.sha256,
        sizeBytes: offloaded.sizeBytes,
        mediaType: offloaded.mediaType,
        sourceTool: offloaded.sourceTool,
        rawPrefix: offloaded.rawPrefix,
        expiresAt: null,
        ttl,
      });
    }
  }

  return {
    root: split.root,
    turns: split.turns,
    blobRefs: synthesizedBlobRefs,
    shasToPromote,
  };
}

/**
 * Migrate one conversation from v1 → v2. Idempotent — a v1 doc marked
 * `migrated=true` is skipped (unless forceRerun), and v2 container
 * pre-existence of the root id short-circuits to a no-op.
 */
export async function migrateOneConversationV1ToV2(
  conv: Conversation & { migrated?: boolean },
  io: MigrationIO,
  opts: Pick<MigrateOptions, "dryRun" | "forceRerun">,
): Promise<"migrated" | "skipped" | "dry-run"> {
  if (conv.migrated && !opts.forceRerun) return "skipped";

  // v2 pre-existence check — makes re-runs after partial success safe.
  try {
    const { resource } = await io.v2Container
      .item(conv.id, conv.id)
      .read<ConversationV2Root>();
    if (resource && resource.docType === "root" && !opts.forceRerun) {
      return "skipped";
    }
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code !== 404) throw err;
  }

  const split = await splitV1ToV2WithOffload(conv, io);

  if (opts.dryRun) return "dry-run";

  // Write all docs via TransactionalBatch on /conversationId.
  // Cosmos caps at 100 ops — we chunk if the conversation is huge.
  const allDocs: Array<ConversationV2Root | TurnDoc | BlobRefDoc> = [
    split.root,
    ...split.turns,
    ...split.blobRefs,
  ];

  const BATCH_CAP = 100;
  for (let i = 0; i < allDocs.length; i += BATCH_CAP) {
    const chunk = allDocs.slice(i, i + BATCH_CAP);
    const operations = chunk.map((d) => ({
      operationType: "Create" as const,
      resourceBody: d as unknown as Record<string, unknown>,
    }));
    const resp = await io.v2Container.items.batch(
      operations as Parameters<Container["items"]["batch"]>[0],
      conv.id,
    );
    const status =
      resp && typeof resp === "object" && "code" in resp
        ? (resp as { code?: number }).code ?? 0
        : 0;
    if (status >= 300) {
      throw new Error(
        `migrateOneConversationV1ToV2: batch failed status=${status} conversationId=${conv.id}`,
      );
    }
  }

  // Promote staging blobs only after Cosmos commit.
  const promote = io.promoteBlob ?? promoteStagingBlob;
  for (const sha of split.shasToPromote) {
    try {
      await promote(sha);
    } catch (err) {
      logger.warn("migrate: blob promote failed (best-effort)", "migrate", {
        conversationId: conv.id,
        sha256: sha,
        errorMessage: (err as Error).message,
      });
    }
  }

  // Mark the v1 doc migrated so a re-run skips it.
  await io.v1Container
    .item(conv.id, conv.ownerId)
    .patch({
      operations: [
        { op: "set", path: "/migrated", value: true },
        { op: "set", path: "/migratedAt", value: (io.now ?? nowIso)() },
      ],
    });

  logger.info("Conversation migrated v1 → v2", "migrate", {
    conversationId: conv.id,
    ownerIdHash: hashPii(conv.ownerId),
    turnCount: split.turns.length,
    blobRefCount: split.blobRefs.length,
  });

  return "migrated";
}

// ── v2 → v1 (reverse) ────────────────────────────────────────

/**
 * Rebuild a v1-shape Conversation from a v2 partition, resolving any
 * blob-ref descriptors inline so the v1 doc is self-contained. Returns
 * null if the rebuilt doc would exceed the v1 2 MB ceiling (caller
 * treats this as a pre-flight rejection).
 */
export async function rebuildV2ToV1WithInlining(
  conversationId: string,
  root: ConversationV2Root,
  turns: TurnDoc[],
  io: Pick<MigrationIO, "resolveBlob">,
): Promise<Conversation | { rejected: "oversized"; estimatedBytes: number }> {
  const resolve = io.resolveBlob ?? resolveBlobRef;
  const rebuilt = rebuildConversationFromDocs({ root, turns });

  // Resolve each blob-ref descriptor back to inline content.
  for (const msg of rebuilt.messages) {
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as unknown as Array<Record<string, unknown>>;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block || block.type !== "tool_result") continue;
      const inner = block.content;
      if (isBlobRefDescriptor(inner)) {
        const fullJson = await resolve(inner);
        // The resolved JSON is the wrapped tool_result string; v1
        // stores it as a parsed value when possible.
        try {
          blocks[i] = { ...block, content: JSON.parse(fullJson) };
        } catch {
          blocks[i] = { ...block, content: fullJson };
        }
      }
    }
  }

  // Pre-flight: reject if rebuilt doc would exceed the v1 ceiling.
  const estimatedBytes = Buffer.byteLength(JSON.stringify(rebuilt), "utf8");
  if (estimatedBytes > V1_MAX_DOC_BYTES) {
    return { rejected: "oversized", estimatedBytes };
  }

  void conversationId; // reserved for future cross-check
  return rebuilt;
}

/**
 * Migrate one conversation v2 → v1. Pre-flight size check rejects
 * oversized rebuilds; the caller aggregates rejected ids and exits
 * non-zero.
 */
export async function migrateOneConversationV2ToV1(
  conversationId: string,
  io: MigrationIO,
  opts: Pick<MigrateOptions, "dryRun">,
): Promise<"migrated" | "skipped" | "dry-run" | "rejected-oversized"> {
  // Read the root + turns.
  let root: ConversationV2Root;
  try {
    const { resource } = await io.v2Container
      .item(conversationId, conversationId)
      .read<ConversationV2Root>();
    if (!resource || resource.docType !== "root") return "skipped";
    root = resource;
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code === 404) return "skipped";
    throw err;
  }

  const { resources: turns } = await io.v2Container.items
    .query<TurnDoc>({
      query: `SELECT * FROM c
              WHERE c.conversationId = @id AND c.docType = "turn"
              ORDER BY c.turnNumber ASC`,
      parameters: [{ name: "@id", value: conversationId }],
    }, { partitionKey: conversationId })
    .fetchAll();

  const rebuilt = await rebuildV2ToV1WithInlining(conversationId, root, turns, io);
  if ("rejected" in rebuilt) {
    return "rejected-oversized";
  }

  if (opts.dryRun) return "dry-run";

  // v1 pre-existence short-circuit — re-running is a no-op.
  try {
    const { resource } = await io.v1Container
      .item(conversationId, rebuilt.ownerId)
      .read<Conversation>();
    if (resource) return "skipped";
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code !== 404) throw err;
  }

  await io.v1Container.items.create(rebuilt);
  logger.info("Conversation migrated v2 → v1", "migrate", {
    conversationId,
    ownerIdHash: hashPii(rebuilt.ownerId),
  });
  return "migrated";
}

// ── Top-level runner ─────────────────────────────────────────

export interface SourceQueryIO {
  /** Page of source conversations to migrate. The runner iterates
   *  until the generator is exhausted. */
  listConversations: (filter: {
    since?: string;
    ownerId?: string;
    conversationId?: string;
    afterId?: string | null;
  }) => AsyncIterable<Conversation & { migrated?: boolean }>;
}

/**
 * Top-level runner: walks the source container filtered by opts,
 * migrates each conversation, aggregates a summary.
 *
 * Checkpoint read/write is injected via `checkpointIO` so the CLI
 * can use a file and tests can use an in-memory stub.
 */
export async function runMigration(
  opts: MigrateOptions,
  io: MigrationIO & SourceQueryIO,
  checkpointIO?: {
    read: () => Promise<MigrationCheckpoint | null>;
    write: (cp: MigrationCheckpoint) => Promise<void>;
  },
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    dryRun: opts.dryRun,
    rejectedOversized: [],
    failures: [],
  };

  let afterId: string | null = null;
  if (checkpointIO) {
    const cp = await checkpointIO.read();
    if (cp && cp.direction === opts.direction) {
      afterId = cp.lastProcessedConversationId;
    }
  }

  const src = io.listConversations({
    since: opts.since,
    ownerId: opts.ownerId,
    conversationId: opts.conversationId,
    afterId,
  });

  for await (const conv of src) {
    summary.total += 1;
    try {
      const outcome =
        opts.direction === "v1-to-v2"
          ? await migrateOneConversationV1ToV2(conv, io, {
              dryRun: opts.dryRun,
              forceRerun: opts.forceRerun,
            })
          : await migrateOneConversationV2ToV1(conv.id, io, {
              dryRun: opts.dryRun,
            });

      if (outcome === "migrated" || outcome === "dry-run") {
        summary.migrated += 1;
      } else if (outcome === "rejected-oversized") {
        summary.rejectedOversized.push(conv.id);
        summary.failed += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({
        conversationId: conv.id,
        errorMessage: (err as Error).message,
      });
      logger.warn("migrate: conversation failed", "migrate", {
        conversationId: conv.id,
        errorMessage: (err as Error).message,
      });
    }

    if (checkpointIO) {
      await checkpointIO.write({
        lastProcessedConversationId: conv.id,
        direction: opts.direction,
        updatedAt: (io.now ?? nowIso)(),
      });
    }

    if (opts.ruBudget && opts.ruBudget > 0) {
      // Coarse throttle: sleep 250ms every 100 processed items. A
      // finer per-batch RU accounting would require threading the
      // response charge back through the IO interface.
      if (summary.total % 100 === 0) {
        await sleep(250);
      }
    }
  }

  return summary;
}

// ── CLI arg parser (pure — testable) ─────────────────────────

export function parseMigrateArgs(argv: readonly string[]): MigrateOptions {
  const opts: MigrateOptions = {
    dryRun: false,
    direction: "v1-to-v2",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force-rerun":
        opts.forceRerun = true;
        break;
      case "--since":
        opts.since = argv[++i];
        break;
      case "--conversation-id":
        opts.conversationId = argv[++i];
        break;
      case "--owner-id":
        opts.ownerId = argv[++i];
        break;
      case "--ru-budget":
        opts.ruBudget = Number(argv[++i]);
        break;
      case "--direction": {
        const next = argv[++i];
        if (next !== "v1-to-v2" && next !== "v2-to-v1") {
          throw new Error(
            `--direction must be v1-to-v2 or v2-to-v1, got "${next}"`,
          );
        }
        opts.direction = next;
        break;
      }
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown flag: ${a}`);
        }
    }
  }
  return opts;
}

// ── helpers ──────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export for scripts + tests.
export { splitConversationToDocs, rebuildConversationFromDocs };
export const __internals = { nowIso, sleep };
