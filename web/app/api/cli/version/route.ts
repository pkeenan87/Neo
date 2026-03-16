import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "@/lib/config";
import { PLATFORMS } from "@/lib/download-config";
import { detectOS } from "@/lib/detect-os";

let _blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (!_blobServiceClient) {
    _blobServiceClient = new BlobServiceClient(
      `https://${env.CLI_STORAGE_ACCOUNT}.blob.core.windows.net`,
      new ManagedIdentityCredential()
    );
  }
  return _blobServiceClient;
}

// In-memory cache: keyed by blobFilename, stores { etag, sha256 }
const hashCache = new Map<string, { etag: string; sha256: string }>();

async function getBlobSha256(blobFilename: string): Promise<string | null> {
  if (!env.CLI_STORAGE_ACCOUNT) return null;

  try {
    const client = getBlobServiceClient();
    const containerClient = client.getContainerClient(env.CLI_STORAGE_CONTAINER);
    const blobClient = containerClient.getBlobClient(blobFilename);

    const properties = await blobClient.getProperties();
    const etag = properties.etag ?? "";

    const cached = hashCache.get(blobFilename);
    if (cached && cached.etag === etag) {
      return cached.sha256;
    }

    const downloadResponse = await blobClient.download(0);
    if (!downloadResponse.readableStreamBody) return null;

    const hash = createHash("sha256");
    for await (const chunk of downloadResponse.readableStreamBody) {
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex");

    hashCache.set(blobFilename, { etag, sha256 });
    return sha256;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const userAgent = request.headers.get("user-agent") ?? "";
  const detectedPlatform = detectOS(userAgent);

  const platform =
    PLATFORMS.find((p) => p.id === detectedPlatform && p.status === "available") ??
    PLATFORMS.find((p) => p.id === "windows" && p.status === "available");

  if (!platform || !platform.downloadPath || !platform.blobFilename) {
    return NextResponse.json(
      { error: "No release available" },
      { status: 404 }
    );
  }

  const sha256 = await getBlobSha256(platform.blobFilename);

  return NextResponse.json({
    version: platform.version,
    downloadUrl: platform.downloadPath,
    platform: platform.id,
    ...(sha256 ? { sha256 } : {}),
  });
}
