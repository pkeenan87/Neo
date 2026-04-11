import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { randomUUID } from "crypto";
import { env } from "./config";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────
//  Lazy singleton — same pattern as CLI downloads route
// ─────────────────────────────────────────────────────────────

let _containerClient: ContainerClient | null = null;
let _initAttempted = false;

function getUploadContainerClient(): ContainerClient | null {
  if (_initAttempted) return _containerClient;
  _initAttempted = true;

  const account = env.CLI_STORAGE_ACCOUNT;
  const container = env.UPLOAD_STORAGE_CONTAINER;

  if (!account || !container) {
    logger.warn(
      "File upload storage not configured — UPLOAD_STORAGE_CONTAINER or CLI_STORAGE_ACCOUNT not set.",
      "upload-storage",
    );
    return null;
  }

  const blobService = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new ManagedIdentityCredential(),
  );

  _containerClient = blobService.getContainerClient(container);
  return _containerClient;
}

/**
 * Upload a file to Azure Blob Storage. Returns the blob URL.
 * Throws if storage is not configured.
 */
export async function uploadFile(
  originalFilename: string,
  buffer: Buffer,
  mimetype: string,
): Promise<string> {
  const container = getUploadContainerClient();
  if (!container) {
    throw new Error("File upload storage is not configured.");
  }

  const blobName = generateBlobName(originalFilename);
  const blockBlob = container.getBlockBlobClient(blobName);

  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimetype },
  });

  logger.info("File uploaded to blob storage", "upload-storage", {
    filename: originalFilename,
    blobName,
  });

  return blockBlob.url;
}

/**
 * Generate a unique blob name to prevent collisions.
 * Format: YYYY/MM/DD/<uuid>/<original-filename>
 */
function generateBlobName(originalFilename: string): string {
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}`;
  const id = randomUUID();
  // Sanitize filename: keep only safe characters
  const safe = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return `${datePath}/${id}/${safe}`;
}

/**
 * Check whether file upload storage is configured.
 */
export function isUploadStorageConfigured(): boolean {
  return !!(env.CLI_STORAGE_ACCOUNT && env.UPLOAD_STORAGE_CONTAINER);
}

// ─────────────────────────────────────────────────────────────
//  CSV-specific storage (neo-csv-uploads container)
// ─────────────────────────────────────────────────────────────

let _csvContainerClient: ContainerClient | null = null;
let _csvInitAttempted = false;

function getCsvContainerClient(): ContainerClient | null {
  if (_csvInitAttempted) return _csvContainerClient;
  _csvInitAttempted = true;

  const account = env.CLI_STORAGE_ACCOUNT;
  const container = env.CSV_UPLOAD_STORAGE_CONTAINER;

  if (!account || !container) {
    logger.warn(
      "CSV upload storage not configured — CLI_STORAGE_ACCOUNT or CSV_UPLOAD_STORAGE_CONTAINER not set.",
      "upload-storage",
    );
    return null;
  }

  const blobService = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new ManagedIdentityCredential(),
  );

  _csvContainerClient = blobService.getContainerClient(container);
  return _csvContainerClient;
}

function sanitizeFilename(original: string): string {
  return original.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Upload a CSV buffer to the CSV blob container under
 * {conversationId}/{csvId}/{filename}. Returns the blob URL. Throws if
 * storage is not configured.
 */
export async function uploadCsv(
  conversationId: string,
  csvId: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const container = getCsvContainerClient();
  if (!container) {
    throw new Error("CSV upload storage is not configured.");
  }

  const blobName = `${conversationId}/${csvId}/${sanitizeFilename(filename)}`;
  const blockBlob = container.getBlockBlobClient(blobName);

  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: "text/csv" },
  });

  logger.info("CSV uploaded to blob storage", "upload-storage", {
    conversationId,
    csvId,
    filename,
    blobName,
  });

  return blockBlob.url;
}

/**
 * Download a CSV blob by URL into a Buffer. Uses the same Managed
 * Identity-backed container client as uploadCsv.
 */
export async function downloadCsvByUrl(blobUrl: string): Promise<Buffer> {
  const container = getCsvContainerClient();
  if (!container) {
    throw new Error("CSV upload storage is not configured.");
  }
  // Parse the blob name out of the URL. The container client exposes
  // getBlobClient from a name — we derive the name by stripping the
  // container URL prefix.
  const containerUrl = container.url;
  if (!blobUrl.startsWith(containerUrl)) {
    throw new Error("CSV blob URL does not belong to the configured container.");
  }
  const blobName = decodeURIComponent(blobUrl.slice(containerUrl.length + 1));
  const blob = container.getBlobClient(blobName);

  return await blob.downloadToBuffer();
}

export function isCsvUploadStorageConfigured(): boolean {
  return !!(env.CLI_STORAGE_ACCOUNT && env.CSV_UPLOAD_STORAGE_CONTAINER);
}

/**
 * Best-effort delete of a CSV blob by URL. Used when an upload succeeds
 * but the subsequent Cosmos write fails (e.g. the per-conversation cap is
 * reached during a race), to prevent orphaned blobs from accumulating.
 *
 * Errors are logged and swallowed — the caller already has a more
 * important failure to report and cleanup should never mask it.
 */
export async function deleteCsvBlob(blobUrl: string): Promise<void> {
  const container = getCsvContainerClient();
  if (!container) return;
  try {
    const containerUrl = container.url;
    if (!blobUrl.startsWith(containerUrl)) {
      logger.warn("Refusing to delete blob outside configured container", "upload-storage", {
        blobUrl,
      });
      return;
    }
    const blobName = decodeURIComponent(blobUrl.slice(containerUrl.length + 1));
    await container.getBlobClient(blobName).deleteIfExists();
  } catch (err) {
    logger.warn("Failed to delete orphaned CSV blob", "upload-storage", {
      blobUrl,
      errorMessage: (err as Error).message,
    });
  }
}
