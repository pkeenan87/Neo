import type { Message } from "./types";

const MAX_TITLE_LENGTH = 200;

// Strip control characters (C0/C1) except common whitespace
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Strip HTML-significant characters to prevent stored XSS
const HTML_CHARS_RE = /[<>"'&]/g;

/**
 * Extract the plain text from a message's content field.
 * Handles both string and content-block-array formats.
 */
export function messageToPlainText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * Sanitize and truncate a string for use as a conversation title.
 * Strips control characters, HTML-significant characters, and caps length.
 */
export function sanitizeTitle(text: string): string | undefined {
  const cleaned = text.replace(CONTROL_CHAR_RE, "").replace(HTML_CHARS_RE, "").trim();
  if (!cleaned) return undefined;
  const codePoints = [...cleaned];
  if (codePoints.length <= MAX_TITLE_LENGTH) return cleaned;
  return codePoints.slice(0, MAX_TITLE_LENGTH).join("") + "...";
}

/**
 * Extract a fallback title from the first user message in a conversation.
 * Returns undefined if no suitable user message is found.
 */
export function extractAutoTitle(messages: Message[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;

  const text = messageToPlainText(firstUser.content);
  return sanitizeTitle(text);
}
