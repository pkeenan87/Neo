import { parse } from "csv-parse/sync";
import {
  CSV_INLINE_BYTE_LIMIT,
  CSV_INLINE_ROW_LIMIT,
  CSV_MAX_COLUMNS,
  CSV_PREVIEW_CELL_MAX_CHARS,
  CSV_PREVIEW_ROW_COUNT,
} from "./types";

/**
 * Strip a UTF-8 BOM if present. Browsers on Windows commonly prefix CSV
 * exports with a BOM that would otherwise end up inside the first column
 * name.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface ClassifiedCsv {
  mode: "inline" | "reference";
  /** Column names, with duplicates disambiguated as col, col_2, col_3, … */
  columns: string[];
  /** Total number of data rows (header excluded). */
  rowCount: number;
  /** First N rows for preview (reference mode) or full body (inline mode). */
  previewRows: string[][];
  /** Normalized UTF-8 text (BOM stripped). Only populated for inline mode. */
  inlineText: string | null;
  /** Raw normalized body used for reference-mode blob upload. */
  normalizedBuffer: Buffer;
  /** Byte size of the normalized body (post-BOM-strip). */
  byteSize: number;
}

export interface CsvValidationError {
  message: string;
}

/**
 * Disambiguate duplicate column names by suffixing _2, _3, … to each
 * additional occurrence. Matches the convention used by the SQLite
 * loader so the names stay consistent end-to-end.
 */
export function disambiguateColumns(raw: string[]): string[] {
  const seen = new Map<string, number>();
  const result: string[] = [];
  for (const name of raw) {
    const trimmed = name.trim();
    const base = trimmed.length > 0 ? trimmed : "column";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.push(count === 0 ? base : `${base}_${count + 1}`);
  }
  return result;
}

/**
 * Truncate a preview cell value to CSV_PREVIEW_CELL_MAX_CHARS, appending an
 * ellipsis marker so downstream consumers can see the truncation happened.
 * Exported for tests.
 */
export function truncatePreviewCell(value: string): string {
  if (value.length <= CSV_PREVIEW_CELL_MAX_CHARS) return value;
  return value.slice(0, CSV_PREVIEW_CELL_MAX_CHARS) + "…";
}

/**
 * Parse + classify a CSV upload buffer. Returns ClassifiedCsv on success
 * or throws a plain Error with a user-safe message on validation failure.
 *
 * Classification is strict-inclusive: a CSV exactly at both thresholds
 * takes the inline path.
 */
export function classifyCsv(buffer: Buffer): ClassifiedCsv {
  // Null-byte guard: CSVs are text. Any 0x00 in the buffer means the
  // upload is binary content masquerading as CSV (mislabeled MIME type,
  // .csv extension slapped on an image / executable, etc.). Reject
  // before csv-parse even sees the bytes so we don't expose the parser
  // to binary-shaped adversarial input.
  if (buffer.includes(0x00)) {
    throw new Error("CSV contains binary (null-byte) content and was rejected.");
  }

  // Decode UTF-8 and strip BOM.
  const rawText = buffer.toString("utf-8");
  const text = stripBom(rawText);
  const normalizedBuffer = Buffer.from(text, "utf-8");
  const byteSize = normalizedBuffer.byteLength;

  let records: string[][];
  try {
    records = parse(text, {
      bom: false, // already stripped above
      relax_quotes: false,
      skip_empty_lines: true,
      trim: false,
    }) as string[][];
  } catch (err) {
    throw new Error(
      `CSV could not be parsed: ${(err as Error).message || "malformed content"}`,
    );
  }

  if (records.length === 0) {
    throw new Error("CSV is empty — no header row found.");
  }

  const headerRow = records[0];
  if (headerRow.length === 0) {
    throw new Error("CSV header row is empty.");
  }
  if (headerRow.length > CSV_MAX_COLUMNS) {
    throw new Error(
      `CSV has too many columns (${headerRow.length}; maximum ${CSV_MAX_COLUMNS}).`,
    );
  }
  const columns = disambiguateColumns(headerRow);
  const dataRows = records.slice(1);
  const rowCount = dataRows.length;

  const isInline =
    rowCount <= CSV_INLINE_ROW_LIMIT && byteSize <= CSV_INLINE_BYTE_LIMIT;

  const previewRows = dataRows
    .slice(0, CSV_PREVIEW_ROW_COUNT)
    .map((row) => row.map(truncatePreviewCell));

  return {
    mode: isInline ? "inline" : "reference",
    columns,
    rowCount,
    previewRows,
    inlineText: isInline ? text : null,
    normalizedBuffer,
    byteSize,
  };
}

/**
 * Test helper — quickly determine inline vs reference without parsing.
 * Exposed for unit-testing the threshold arithmetic without rebuilding
 * a whole CSV buffer each time.
 */
export function shouldInlineCsv(rowCount: number, byteSize: number): boolean {
  return rowCount <= CSV_INLINE_ROW_LIMIT && byteSize <= CSV_INLINE_BYTE_LIMIT;
}
