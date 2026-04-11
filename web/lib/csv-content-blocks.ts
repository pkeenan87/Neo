import type Anthropic from "@anthropic-ai/sdk";
import type { CSVReference } from "./types";
import type { ClassifiedCsv } from "./csv-classifier";

/**
 * Escape double quotes and angle brackets so CSV metadata cannot close the
 * enclosing XML attribute or tag.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * End-of-data sentinel injected into every csv_attachment block so Claude
 * has an unambiguous structural marker for where the CSV data ends. Defense
 * in depth against prompt-injection attempts buried in CSV cell values.
 */
const CSV_END_SENTINEL = "<!-- end_of_csv_data -->";

function escapeText(value: string): string {
  // Neutralize two structural markers that a hostile CSV cell could forge:
  //   1. `</csv_attachment` — the closing tag, which would end the block early.
  //   2. `<!-- end_of_csv_data -->` — the in-band sentinel, which would give
  //      Claude a false boundary before the real end of data.
  // Both replacements are case-insensitive to cover common obfuscations.
  return value
    .replace(/<\/csv_attachment/gi, "< /csv_attachment")
    .replace(/<!--\s*end_of_csv_data\s*-->/gi, "<!- - end_of_csv_data - ->");
}

/**
 * Build an inline `<csv_attachment mode="inline">` text content block
 * containing the full CSV body plus metadata attributes. This goes on the
 * user turn's content array alongside the user's message.
 */
export function buildInlineCsvBlock(
  filename: string,
  classified: ClassifiedCsv,
): Anthropic.Messages.TextBlockParam {
  if (classified.mode !== "inline" || classified.inlineText === null) {
    throw new Error("buildInlineCsvBlock called with a non-inline ClassifiedCsv");
  }

  const attrs = [
    `filename="${escapeAttr(filename)}"`,
    `columns="${escapeAttr(classified.columns.join(","))}"`,
    `total_rows="${classified.rowCount}"`,
  ].join(" ");

  const body = escapeText(classified.inlineText);
  const text =
    `<csv_attachment mode="inline" ${attrs}>\n${body}\n${CSV_END_SENTINEL}\n</csv_attachment>`;

  return { type: "text", text };
}

/**
 * Build a reference `<csv_attachment mode="reference">` text content block
 * describing a large CSV that lives in blob storage. Includes the csv_id,
 * column schema, row count, and a 5-row preview so Claude has enough
 * context to decide what to query.
 */
export function buildReferenceCsvBlock(
  reference: CSVReference,
): Anthropic.Messages.TextBlockParam {
  const attrs = [
    `csv_id="${escapeAttr(reference.csvId)}"`,
    `filename="${escapeAttr(reference.filename)}"`,
    `total_rows="${reference.rowCount}"`,
  ].join(" ");

  // Preview rows are CSV-derived and user-controlled, so they must pass
  // through escapeText to prevent a crafted cell value from closing the
  // attachment block early.
  const columnsLine = reference.columns.map(escapeText).join(",");
  const previewLines = [
    columnsLine,
    ...reference.sampleRows.map((row) => row.map(escapeText).join(",")),
  ].join("\n");

  const text =
    `<csv_attachment mode="reference" ${attrs}>\n` +
    `Use the query_csv tool with csv_id="${escapeAttr(reference.csvId)}" to query the full dataset. ` +
    `The table name is "csv". Preview (first ${reference.sampleRows.length} rows):\n` +
    previewLines +
    `\n${CSV_END_SENTINEL}\n</csv_attachment>`;

  return { type: "text", text };
}

/**
 * Compose a Claude API user-turn content array from the user's text plus
 * optional file attachments and CSV blocks. Ordering:
 *
 *   media (images / PDFs) → CSV blocks (inline + reference) → user text
 *
 * This matches the spec's ordering rule and keeps the user's question at
 * the tail so Claude sees attachments as context before the request.
 *
 * When `existingMediaBlocks` is empty and `csvBlocks` is empty, returns a
 * plain string for Claude API efficiency.
 */
export function composeUserContent(
  userText: string,
  existingMediaBlocks: readonly unknown[],
  csvBlocks: readonly Anthropic.Messages.TextBlockParam[],
): Anthropic.Messages.MessageParam["content"] {
  if (existingMediaBlocks.length === 0 && csvBlocks.length === 0) {
    return userText;
  }
  const result: unknown[] = [
    ...existingMediaBlocks,
    ...csvBlocks,
    { type: "text", text: userText },
  ];
  return result as Anthropic.Messages.MessageParam["content"];
}
