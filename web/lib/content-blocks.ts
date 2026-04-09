import type Anthropic from "@anthropic-ai/sdk";
import type { FileAttachment, FileRef } from "./types";
import { isImageType, isDocumentType } from "./file-validation";

/**
 * Build Claude API content blocks from a text message + file attachments.
 * Files are base64-encoded inline for the API call (not persisted this way).
 * Returns string for text-only, or array of content blocks when files present.
 * The array is typed loosely because the SDK may not have document block types
 * in older versions — the Claude API accepts them regardless.
 */
export function buildContentBlocks(
  text: string,
  files: FileAttachment[],
): Anthropic.Messages.MessageParam["content"] {
  if (files.length === 0) return text;

  // Single pass: text block first, then images and documents in order
  const result: unknown[] = [{ type: "text", text }];

  for (const file of files) {
    if (isImageType(file.mimetype)) {
      result.push({
        type: "image",
        source: {
          type: "base64",
          media_type: file.mimetype as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: file.buffer.toString("base64"),
        },
      });
    } else if (isDocumentType(file.mimetype)) {
      // Document blocks — the Claude API accepts these even if older SDK
      // versions don't have typed support for them
      result.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.buffer.toString("base64"),
        },
      });
    }
  }

  return result as Anthropic.Messages.MessageParam["content"];
}

/**
 * Build a persistable content representation for Cosmos DB.
 * Uses blob URLs instead of raw base64 — much smaller documents.
 * On reload, these render as file reference placeholders.
 */
export function buildPersistedContent(
  text: string,
  fileRefs: FileRef[],
): string {
  if (fileRefs.length === 0) return text;

  const attachmentLines = fileRefs
    .map((f) => {
      // Sanitize filename for safe embedding in conversation text
      const safe = f.filename.replace(/[\[\]\n\r]/g, "_").slice(0, 100);
      return `[Attached: ${safe}]`;
    })
    .join("\n");

  return `${text}\n\n${attachmentLines}`;
}
