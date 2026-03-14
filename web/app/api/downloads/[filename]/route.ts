import { NextRequest, NextResponse } from "next/server";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { env } from "@/lib/config";
import { logger } from "@/lib/logger";
import { PLATFORMS } from "@/lib/download-config";
import { detectOS } from "@/lib/detect-os";

const ALLOWED_FILENAMES = new Set(
  PLATFORMS
    .filter((p) => p.status === "available" && p.blobFilename)
    .map((p) => p.blobFilename)
);

let _blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (!_blobServiceClient) {
    _blobServiceClient = new BlobServiceClient(
      `https://${env.CLI_STORAGE_ACCOUNT}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
  }
  return _blobServiceClient;
}

function hasStatusCode(err: unknown): err is { statusCode: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as Record<string, unknown>).statusCode === "number"
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!ALLOWED_FILENAMES.has(filename)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!env.CLI_STORAGE_ACCOUNT) {
    return NextResponse.json(
      { error: "Downloads not configured" },
      { status: 503 }
    );
  }

  const userAgent = request.headers.get("user-agent") ?? "";
  const detectedPlatform = detectOS(userAgent);

  try {
    const client = getBlobServiceClient();
    const containerClient = client.getContainerClient(
      env.CLI_STORAGE_CONTAINER
    );
    const blobClient = containerClient.getBlobClient(filename);

    const downloadResponse = await blobClient.download(0);

    if (!downloadResponse.readableStreamBody) {
      return NextResponse.json(
        { error: "Failed to read file" },
        { status: 500 }
      );
    }

    logger.info("CLI installer downloaded", "downloads", {
      filename,
      platform: detectedPlatform,
    });

    const encodedFilename = encodeURIComponent(filename);
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    });

    if (downloadResponse.contentLength !== undefined) {
      headers.set("Content-Length", String(downloadResponse.contentLength));
    }

    const webStream = nodeReadableToWebStream(
      downloadResponse.readableStreamBody
    );

    return new Response(webStream, { status: 200, headers });
  } catch (err: unknown) {
    if (hasStatusCode(err) && err.statusCode === 404) {
      return NextResponse.json(
        { error: "File not found in storage" },
        { status: 404 }
      );
    }

    logger.error("Download proxy error", "downloads", {
      filename,
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });

    return NextResponse.json(
      { error: "Failed to retrieve file" },
      { status: 500 }
    );
  }
}

function nodeReadableToWebStream(
  nodeStream: NodeJS.ReadableStream
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err: Error) => {
        controller.error(err);
      });
    },
  });
}
