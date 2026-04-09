import { Readable } from "stream";
import Busboy from "busboy";
import type { FileAttachment } from "./types";
import { MAX_FILES_PER_MESSAGE } from "./types";
import { validateFile, validateMagicBytes } from "./file-validation";

export interface MultipartResult {
  fields: Record<string, string>;
  files: FileAttachment[];
}

// Cumulative request size cap to prevent OOM under adversarial input
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Parse a multipart/form-data request into fields and file buffers.
 * Validates file types, sizes, and magic bytes during parsing.
 */
export async function parseMultipart(
  request: Request,
): Promise<MultipartResult> {
  const contentType = request.headers.get("content-type") ?? "";
  const fields: Record<string, string> = {};
  const files: FileAttachment[] = [];
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    let abortError: Error | null = null;

    const busboy = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: MAX_FILES_PER_MESSAGE,
        fileSize: 33 * 1024 * 1024, // 33 MB per file hard cap
        fieldSize: 8 * 1024,        // 8 KB per field value
        fields: 10,                  // max 10 form fields
      },
    });

    busboy.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    busboy.on("file", (_name: string, stream: NodeJS.ReadableStream & { truncated?: boolean }, info: { filename: string; encoding: string; mimeType: string }) => {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => {
        if (abortError) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          abortError = new Error("Total upload size exceeds 100 MB limit.");
          stream.resume(); // drain remaining data
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", () => {
        if (abortError) return;

        // Check if busboy truncated the stream due to fileSize limit
        if (stream.truncated) {
          abortError = new Error(`File "${info.filename}" exceeds the maximum upload size.`);
          return;
        }

        const buffer = Buffer.concat(chunks);
        const validation = validateFile(info.mimeType, buffer.length);
        if (!validation.valid) {
          abortError = new Error(validation.error);
          return;
        }

        // Verify magic bytes match declared MIME type
        if (!validateMagicBytes(info.mimeType, buffer)) {
          abortError = new Error(`File "${info.filename}" content does not match its declared type.`);
          return;
        }

        // Sanitize filename: strip control chars, brackets, leading dots
        const safeFilename = (info.filename || "unnamed")
          .replace(/[\x00-\x1f\x7f\/\\[\]]/g, "_")
          .replace(/^\.+/, "_")
          .slice(0, 255);

        files.push({
          filename: safeFilename,
          mimetype: info.mimeType,
          size: buffer.length,
          buffer,
        });
      });
    });

    busboy.on("filesLimit", () => {
      if (!abortError) {
        abortError = new Error(`Too many files (max ${MAX_FILES_PER_MESSAGE}).`);
      }
    });

    busboy.on("finish", () => {
      if (abortError) {
        reject(abortError);
      } else {
        resolve({ fields, files });
      }
    });

    busboy.on("error", (err: Error) => {
      if (!abortError) reject(err);
    });

    // Pipe the request body into busboy
    const body = request.body;
    if (!body) {
      resolve({ fields, files });
      return;
    }

    const reader = body.getReader();
    const nodeStream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
          } else {
            this.push(Buffer.from(value));
          }
        } catch (err) {
          this.destroy(err as Error);
        }
      },
    });

    nodeStream.pipe(busboy);
  });
}

/**
 * Check if a request is multipart/form-data.
 */
export function isMultipartRequest(request: Request): boolean {
  const ct = request.headers.get("content-type") ?? "";
  return ct.includes("multipart/form-data");
}
