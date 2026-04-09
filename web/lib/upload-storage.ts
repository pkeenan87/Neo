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
