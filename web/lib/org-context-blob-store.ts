import { BlobServiceClient, ContainerClient, RestError } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────
//  Org-context blob store
//
//  Persists the admin-supplied organisational-context addendum to
//  Azure Blob Storage at `<container>/org-context/current.yaml`.
//  Replaces the 25 KB Key Vault ceiling so the full environment
//  fingerprint (~36 KB and growing) can be injected into the system
//  prompt every turn. Key Vault remains as a fallback tier in
//  `config.loadOrgContext` so small legacy deployments keep working.
//
//  Layout choices:
//    • Single mutable path — Azure Blob soft-delete + versioning is
//      the canonical history store. No bespoke version table.
//    • Content-type text/plain — the loader treats the value as
//      opaque text; YAML structure has no operational meaning here.
//    • Managed-identity auth — same pattern as the existing tool-
//      result + upload-storage modules.
// ─────────────────────────────────────────────────────────────

const ORG_CONTEXT_BLOB_NAME = "org-context/current.yaml";

let _container: ContainerClient | null = null;
let _initAttempted = false;

function getOrgContextContainer(): ContainerClient | null {
  if (_initAttempted) return _container;
  _initAttempted = true;

  const account = env.CLI_STORAGE_ACCOUNT;
  const container = env.NEO_ORG_CONTEXT_CONTAINER;
  if (!account || !container) {
    logger.warn(
      "Org-context blob storage not configured — CLI_STORAGE_ACCOUNT or NEO_ORG_CONTEXT_CONTAINER not set.",
      "org-context-blob-store",
    );
    return null;
  }

  const blobService = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new ManagedIdentityCredential(),
  );
  _container = blobService.getContainerClient(container);
  return _container;
}

/**
 * True when both the storage account and container env vars are set.
 * Callers branch on this to decide whether the blob tier is the
 * active write target (admin route) or just an optional read tier
 * (loader).
 */
export function isOrgContextBlobConfigured(): boolean {
  return !!env.CLI_STORAGE_ACCOUNT && !!env.NEO_ORG_CONTEXT_CONTAINER;
}

/**
 * Fetch the current org-context blob.
 *
 * Returns `null` when the blob does not exist (first deploy, never
 * saved). Throws on any other failure so the caller in
 * `loadOrgContext` can distinguish "no content yet" from "transient
 * Azure error" and avoid caching the latter.
 */
export async function loadOrgContextFromBlob(): Promise<string | null> {
  const container = getOrgContextContainer();
  if (!container) return null;

  const blob = container.getBlockBlobClient(ORG_CONTEXT_BLOB_NAME);
  try {
    const buf = await blob.downloadToBuffer();
    return buf.toString("utf8");
  } catch (err) {
    // BlobNotFound is the "never saved yet" signal — return null so
    // the loader falls through to Key Vault / env var without
    // emitting an error log on every cold deploy.
    if (err instanceof RestError && err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Persist the org-context to blob storage. Overwrites the current
 * blob; Azure soft-delete / versioning (configured at container
 * creation time) is the audit trail.
 *
 * Caller is responsible for clearing the in-memory cache via
 * `clearOrgContextCache()` after a successful save.
 */
export async function saveOrgContextToBlob(text: string): Promise<void> {
  const container = getOrgContextContainer();
  if (!container) {
    throw new Error("Org-context blob storage is not configured.");
  }
  const blob = container.getBlockBlobClient(ORG_CONTEXT_BLOB_NAME);
  await blob.upload(text, Buffer.byteLength(text, "utf8"), {
    blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
  });
  logger.info("Org-context saved to blob storage", "org-context-blob-store", {
    contentLength: text.length,
  });
}

// Test-only: reset the lazy singleton so per-test env mutations are
// picked up. Not part of the runtime API.
export function __resetOrgContextBlobClient(): void {
  _container = null;
  _initAttempted = false;
}
