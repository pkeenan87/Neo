/**
 * Parser for text-family file attachments embedded in persisted message
 * content. Text uploads (`.txt`, `.json`, `.log`, `.md`) are wrapped in
 * `<text_attachment filename="..." size_bytes="...">...</text_attachment>`
 * blocks by `txt-content-blocks.ts` before being sent to Claude. On
 * conversation reload we don't want to render the file body inline —
 * instead we extract attachment metadata and render a badge above the
 * markdown content.
 */

export type ChatAttachmentKind = "text";

export interface ChatAttachment {
  filename: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
}

// Match a complete <text_attachment ...>...</text_attachment> block.
// Non-greedy + multiline so multiple attachments in one message are caught
// individually. Case-insensitive so future renames don't silently bypass
// extraction.
const TEXT_ATTACHMENT_RE =
  /<text_attachment\s+([^>]*)>[\s\S]*?<\/text_attachment>/gi;

const FILENAME_RE = /filename="([^"]*)"/i;
const SIZE_BYTES_RE = /size_bytes="([^"]*)"/i;

/**
 * Decode HTML entities that `txt-content-blocks.ts` writes into attribute
 * values (it uses escapeAttr on filename to prevent attribute injection).
 */
function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export interface ExtractResult {
  /** Original content with all text_attachment blocks removed and trimmed. */
  text: string;
  /** Attachments parsed out, in document order. */
  attachments: ChatAttachment[];
}

/**
 * Hard cap on input size before we run the regex. Real conversations
 * stay well under 500K characters per message; anything larger is either
 * adversarial (a 10MB paste with a malformed `<text_attachment` and no
 * closing tag would force a linear-time scan that hangs the tab) or has
 * already been trimmed upstream. Skip extraction in that case.
 */
const MAX_EXTRACT_LENGTH = 500_000;

/**
 * Extract all text_attachment blocks from a message content string.
 * Returns the cleaned content + the parsed attachments. If no attachments
 * are present, returns the original content unchanged.
 *
 * Malformed blocks (missing closing tag, garbled attributes) are left in
 * the content as-is rather than half-stripped.
 */
export function extractTextAttachments(content: string): ExtractResult {
  if (content.length > MAX_EXTRACT_LENGTH) {
    return { text: content, attachments: [] };
  }
  if (!content.includes("<text_attachment")) {
    return { text: content, attachments: [] };
  }

  const attachments: ChatAttachment[] = [];
  const stripped = content.replace(TEXT_ATTACHMENT_RE, (_match, attrs: string) => {
    const filenameMatch = FILENAME_RE.exec(attrs);
    const sizeMatch = SIZE_BYTES_RE.exec(attrs);
    const filename = filenameMatch ? decodeAttr(filenameMatch[1]) : "attachment.txt";
    const sizeBytes = sizeMatch ? Number(sizeMatch[1]) : 0;
    attachments.push({
      filename,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      kind: "text",
    });
    return "";
  });

  if (attachments.length === 0) {
    // The opening tag matched but the regex didn't (no closing tag, etc.)
    // Leave the content intact rather than partially mangle it.
    return { text: content, attachments: [] };
  }

  return { text: stripped.trim(), attachments };
}

/**
 * Format bytes as a human-readable size hint for badges (e.g. "1.2 KB").
 * Returns an empty string for sizes <= 0.
 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
