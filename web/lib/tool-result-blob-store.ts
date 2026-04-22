import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { createHash } from "crypto";
import { env, NEO_BLOB_OFFLOAD_THRESHOLD_BYTES, NEO_TOOL_RESULT_BLOB_CONTAINER } from "./config";
import { logger } from "./logger";
import type { BlobRefDescriptor } from "./types";

// ─────────────────────────────────────────────────────────────
//  Tool-result blob offload
//
//  When a tool produces a result larger than NEO_BLOB_OFFLOAD_THRESHOLD_BYTES,
//  maybeOffloadToolResult writes the raw bytes to Azure Blob Storage
//  and returns a BlobRefDescriptor in place of the inline payload.
//
//  Layout inside the NEO_TOOL_RESULT_BLOB_CONTAINER container:
//    staging/<sha256>  — written first, before the Cosmos turn-doc commit
//    blobs/<sha256>    — the immutable final location; renamed from
//                        staging/ by promoteStagingBlob AFTER Cosmos commits
//
//  The staging → blobs split is the partial-failure strategy (spec
//  recommendation): if the Cosmos write fails, the staging blob is
//  garbage-collected by a lifecycle policy on the staging/ prefix.
//  Content-addressed (SHA-256) keying makes re-offload idempotent —
//  the same result twice produces the same path.
//
//  SSRF GUARD: resolveBlobRef validates the descriptor's `uri` belongs
//  to the configured container before fetching. A maliciously crafted
//  Cosmos document could otherwise trick the server into GETting an
//  arbitrary URL under its managed-identity credentials.
// ─────────────────────────────────────────────────────────────

// Lazy singleton — mirrors getCsvContainerClient in upload-storage.ts.
let _toolResultContainer: ContainerClient | null = null;
let _toolResultInitAttempted = false;

function getToolResultContainer(): ContainerClient | null {
  if (_toolResultInitAttempted) return _toolResultContainer;
  _toolResultInitAttempted = true;

  const account = env.CLI_STORAGE_ACCOUNT;
  if (!account) {
    logger.warn(
      "Tool-result blob storage not configured — CLI_STORAGE_ACCOUNT not set.",
      "tool-result-blob-store",
    );
    return null;
  }

  const blobService = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new ManagedIdentityCredential(),
  );

  _toolResultContainer = blobService.getContainerClient(NEO_TOOL_RESULT_BLOB_CONTAINER);
  return _toolResultContainer;
}

/**
 * True when the tool-result blob container is available. Callers that
 * want to degrade gracefully (skip offload, persist inline) check this
 * first — otherwise maybeOffloadToolResult silently falls through to
 * inline when unconfigured.
 */
export function isToolResultBlobStorageConfigured(): boolean {
  return !!env.CLI_STORAGE_ACCOUNT;
}

// ── Helpers ──────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

function truncateSummary(raw: string, maxChars = 280): string {
  // Short, plain summary of the offloaded payload for dashboards / SR
  // output. Truncates at maxChars at a word boundary when possible.
  if (raw.length <= maxChars) return raw;
  const clipped = raw.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body}…`;
}

/**
 * Test-only escape hatch — reset the cached container client between
 * unit tests so each test can inject its own fake container.
 */
export function __resetToolResultBlobStoreForTest(): void {
  _toolResultContainer = null;
  _toolResultInitAttempted = false;
}

// ── Public API ───────────────────────────────────────────────

export interface OffloadContext {
  conversationId: string;
  sourceTool: string;
  /** Optional MIME type hint for the persisted blob. Defaults to
   *  application/json because current tool results are all JSON. */
  mediaType?: string;
}

/**
 * Write a tool-result string to blob storage when it exceeds the
 * offload threshold; return the original string otherwise.
 *
 * - If storage isn't configured, falls through to inline (logs warn).
 * - Below threshold, pass-through with no I/O.
 * - Above threshold, writes to `staging/<sha256>` with the wrapped
 *   JSON body and returns a BlobRefDescriptor. The caller must call
 *   `promoteStagingBlob(sha)` AFTER the Cosmos write commits.
 * - Idempotent on SHA — offloading the same content twice produces
 *   the same staging path; the second blob upload overwrites with
 *   identical bytes.
 */
export async function maybeOffloadToolResult(
  wrappedJson: string,
  ctx: OffloadContext,
): Promise<string | BlobRefDescriptor> {
  const sizeBytes = Buffer.byteLength(wrappedJson, "utf8");
  if (sizeBytes < NEO_BLOB_OFFLOAD_THRESHOLD_BYTES) {
    return wrappedJson;
  }

  const container = getToolResultContainer();
  if (!container) {
    // Storage unavailable — fall back to inline. The downstream
    // Cosmos write may still fail the 2 MB per-doc ceiling; that's
    // the existing v1 failure mode, no regression here.
    return wrappedJson;
  }

  const sha256 = sha256Hex(wrappedJson);
  const blobName = `staging/${sha256}`;
  const blockBlob = container.getBlockBlobClient(blobName);

  const startedAt = Date.now();
  await blockBlob.uploadData(Buffer.from(wrappedJson, "utf8"), {
    blobHTTPHeaders: {
      blobContentType: ctx.mediaType ?? "application/json",
    },
  });
  const durationMs = Date.now() - startedAt;

  logger.emitEvent(
    "conversation_blob_offload",
    `Tool result offloaded (${sizeBytes} bytes)`,
    "tool-result-blob-store",
    {
      conversationId: ctx.conversationId,
      sourceTool: ctx.sourceTool,
      sha256,
      sizeBytes,
      durationMs,
    },
  );

  const descriptor: BlobRefDescriptor = {
    _neo_blob_ref: true,
    sha256,
    sizeBytes,
    mediaType: ctx.mediaType ?? "application/json",
    shortSummary: truncateSummary(wrappedJson),
    uri: blockBlob.url,
    sourceTool: ctx.sourceTool,
  };
  return descriptor;
}

/**
 * Promote a staged blob to its immutable `blobs/<sha256>` path. Call
 * after the Cosmos turn / blob-ref write has committed so the final
 * location is only reachable via a consistent Cosmos row. Best-effort
 * failure: a staging blob that never gets promoted is reaped by the
 * lifecycle policy on the staging/ prefix.
 *
 * Implemented as copy-then-delete (Azure blobs don't support atomic
 * rename) — a short-lived race window where the content exists at both
 * paths is harmless because both paths point at the same immutable
 * content-addressed bytes.
 */
export async function promoteStagingBlob(sha256: string): Promise<void> {
  const container = getToolResultContainer();
  if (!container) return;

  const source = container.getBlobClient(`staging/${sha256}`);
  const target = container.getBlockBlobClient(`blobs/${sha256}`);

  try {
    // Azure SDK's syncCopyFromURL copies within the same storage account
    // without a server round-trip through our code. If the target
    // already exists (idempotent re-promote), we skip the copy.
    const exists = await target.exists();
    if (!exists) {
      await target.syncCopyFromURL(source.url);
    }
    // Best-effort staging cleanup. If this fails the lifecycle policy
    // on staging/ will catch it eventually.
    await source.deleteIfExists();
  } catch (err) {
    logger.warn("Failed to promote staging blob", "tool-result-blob-store", {
      sha256,
      errorMessage: (err as Error).message,
    });
  }
}

/**
 * Fetch the full payload for a blob-ref descriptor. Validates the URI
 * belongs to the configured tool-result container before issuing any
 * request (SSRF guard — see the BlobRefDescriptor JSDoc in types.ts).
 */
export async function resolveBlobRef(descriptor: BlobRefDescriptor): Promise<string> {
  const container = getToolResultContainer();
  if (!container) {
    throw new Error("Tool-result blob storage is not configured.");
  }

  // SSRF guard — never follow a URI that isn't inside our configured
  // container, even if a doctored Cosmos descriptor asks us to.
  const containerUrl = container.url;
  if (!descriptor.uri.startsWith(containerUrl)) {
    throw new Error(
      `Refusing to resolve blob-ref: URI does not belong to configured container.`,
    );
  }

  const startedAt = Date.now();
  // Content addressed — try the immutable blobs/ path first; during
  // the race window between offload and promote, fall back to staging/.
  const blobName = `blobs/${descriptor.sha256}`;
  const stagingName = `staging/${descriptor.sha256}`;

  let buffer: Buffer;
  try {
    buffer = await container.getBlobClient(blobName).downloadToBuffer();
  } catch (err) {
    // If the blob doesn't exist at blobs/, fall back to staging.
    // RestError from a missing blob has `statusCode: 404`.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) throw err;
    buffer = await container.getBlobClient(stagingName).downloadToBuffer();
  }
  const durationMs = Date.now() - startedAt;

  logger.emitEvent(
    "conversation_blob_resolve",
    `Tool result resolved (${descriptor.sizeBytes} bytes)`,
    "tool-result-blob-store",
    {
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
      sourceTool: descriptor.sourceTool,
      durationMs,
    },
  );

  return buffer.toString("utf8");
}

/**
 * Detect whether a persisted tool_result `content` value is a blob-ref
 * envelope. Used by get_full_tool_result (phase 6) and the UI hydration
 * path (phase 10) so they know to call resolveBlobRef.
 */
export function isBlobRefDescriptor(value: unknown): value is BlobRefDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _neo_blob_ref?: unknown })._neo_blob_ref === true &&
    typeof (value as { sha256?: unknown }).sha256 === "string" &&
    typeof (value as { uri?: unknown }).uri === "string"
  );
}
