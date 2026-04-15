import type Anthropic from "@anthropic-ai/sdk";

const TXT_END_SENTINEL = "<!-- end_of_text_data -->";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// NOTE: if TXT_END_SENTINEL changes, update the sentinel regex below to match.
function escapeText(value: string): string {
  return value
    .replace(/<text_attachment/gi, "< text_attachment")
    .replace(/<\/text_attachment/gi, "< /text_attachment")
    .replace(/<!--\s*end_of_text_data\s*-->/gi, "<!- - end_of_text_data - ->");
}

/**
 * Validate and prepare a TXT buffer for inline embedding.
 * Rejects binary content and empty files; strips UTF-8 BOM.
 */
export function validateAndPrepareTxt(
  buffer: Buffer,
): { text: string } | { error: string } {
  // Reject binary content (null bytes indicate non-text)
  if (buffer.includes(0x00)) {
    return { error: "File contains binary content and cannot be processed as text." };
  }

  let text = buffer.toString("utf-8");

  // Reject invalid UTF-8 (replacement characters indicate unmappable byte sequences)
  if (text.includes("\uFFFD")) {
    return { error: "File contains invalid UTF-8 sequences and cannot be processed as text." };
  }

  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  text = text.trim();

  if (text.length === 0) {
    return { error: "File is empty." };
  }

  return { text };
}

/**
 * Build an inline `<text_attachment>` text content block from a TXT file.
 * Content is escaped to prevent prompt injection via the closing tag or
 * end sentinel.
 */
export function buildTxtBlock(
  filename: string,
  buffer: Buffer,
): Anthropic.Messages.TextBlockParam {
  const result = validateAndPrepareTxt(buffer);
  if ("error" in result) {
    throw new Error(result.error);
  }

  const attrs = [
    `filename="${escapeAttr(filename)}"`,
    `size_bytes="${buffer.length}"`,
  ].join(" ");

  const body = escapeText(result.text);
  const text =
    `<text_attachment ${attrs}>\n${body}\n${TXT_END_SENTINEL}\n</text_attachment>`;

  return { type: "text", text };
}
