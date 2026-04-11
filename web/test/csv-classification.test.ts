import { describe, it, expect } from "vitest";
import {
  classifyCsv,
  shouldInlineCsv,
  disambiguateColumns,
  truncatePreviewCell,
} from "../lib/csv-classifier";
import {
  CSV_INLINE_BYTE_LIMIT,
  CSV_INLINE_ROW_LIMIT,
  CSV_MAX_COLUMNS,
  CSV_PREVIEW_CELL_MAX_CHARS,
} from "../lib/types";

function makeCsv(headers: string[], rows: string[][]): Buffer {
  const lines = [headers.join(","), ...rows.map((r) => r.join(","))];
  return Buffer.from(lines.join("\n"), "utf-8");
}

describe("shouldInlineCsv thresholds", () => {
  it("inlines when both rows and bytes are below the cap", () => {
    expect(shouldInlineCsv(10, 1024)).toBe(true);
  });

  it("inlines at the exact boundary (inclusive)", () => {
    expect(shouldInlineCsv(CSV_INLINE_ROW_LIMIT, CSV_INLINE_BYTE_LIMIT)).toBe(true);
  });

  it("takes reference path when row count exceeds the cap", () => {
    expect(shouldInlineCsv(CSV_INLINE_ROW_LIMIT + 1, 1024)).toBe(false);
  });

  it("takes reference path when byte size exceeds the cap", () => {
    expect(shouldInlineCsv(10, CSV_INLINE_BYTE_LIMIT + 1)).toBe(false);
  });
});

describe("classifyCsv", () => {
  it("classifies a small CSV as inline with correct metadata", () => {
    const buffer = makeCsv(
      ["id", "name", "score"],
      [
        ["1", "alice", "42"],
        ["2", "bob", "17"],
      ],
    );
    const result = classifyCsv(buffer);
    expect(result.mode).toBe("inline");
    expect(result.columns).toEqual(["id", "name", "score"]);
    expect(result.rowCount).toBe(2);
    expect(result.previewRows).toHaveLength(2);
    expect(result.inlineText).toContain("alice");
    expect(result.inlineText).toContain("bob");
  });

  it("classifies a header-only CSV as inline with zero rows", () => {
    const buffer = makeCsv(["col_a", "col_b"], []);
    const result = classifyCsv(buffer);
    expect(result.mode).toBe("inline");
    expect(result.rowCount).toBe(0);
    expect(result.columns).toEqual(["col_a", "col_b"]);
  });

  it("strips a UTF-8 BOM from the first column name", () => {
    const raw = "name,age\nalice,30";
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw, "utf-8")]);
    const result = classifyCsv(buffer);
    expect(result.columns[0]).toBe("name");
    expect(result.inlineText?.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("classifies a row-count-exceeding CSV as reference mode", () => {
    const rows = Array.from({ length: CSV_INLINE_ROW_LIMIT + 1 }, (_, i) => [String(i), "x"]);
    const buffer = makeCsv(["id", "val"], rows);
    const result = classifyCsv(buffer);
    expect(result.mode).toBe("reference");
    expect(result.rowCount).toBe(CSV_INLINE_ROW_LIMIT + 1);
    expect(result.previewRows).toHaveLength(5); // CSV_PREVIEW_ROW_COUNT
    expect(result.inlineText).toBeNull();
  });

  it("classifies a byte-limit-exceeding CSV as reference mode", () => {
    // A single very wide row exceeds the byte limit while staying well below
    // the row limit.
    const wideValue = "x".repeat(CSV_INLINE_BYTE_LIMIT + 100);
    const buffer = makeCsv(["id", "payload"], [["1", wideValue]]);
    const result = classifyCsv(buffer);
    expect(result.mode).toBe("reference");
    expect(result.rowCount).toBe(1);
  });

  it("throws a clear error on malformed CSV (unterminated quote)", () => {
    const buffer = Buffer.from('id,name\n1,"bob\n2,alice', "utf-8");
    expect(() => classifyCsv(buffer)).toThrow(/parse/i);
  });

  it("throws on empty input", () => {
    const buffer = Buffer.from("", "utf-8");
    expect(() => classifyCsv(buffer)).toThrow(/empty/i);
  });

  it("rejects buffers containing a null byte (binary masquerading as CSV)", () => {
    const buffer = Buffer.concat([
      Buffer.from("id,name\n1,a", "utf-8"),
      Buffer.from([0x00]),
      Buffer.from("\n2,b", "utf-8"),
    ]);
    expect(() => classifyCsv(buffer)).toThrow(/binary/i);
  });

  it("rejects CSVs with more than CSV_MAX_COLUMNS columns", () => {
    const headers = Array.from({ length: CSV_MAX_COLUMNS + 1 }, (_, i) => `col${i}`);
    const row = Array.from({ length: CSV_MAX_COLUMNS + 1 }, () => "x");
    const buffer = makeCsv(headers, [row]);
    expect(() => classifyCsv(buffer)).toThrow(/too many columns/i);
  });

  it("accepts CSVs with exactly CSV_MAX_COLUMNS columns", () => {
    const headers = Array.from({ length: CSV_MAX_COLUMNS }, (_, i) => `col${i}`);
    const row = Array.from({ length: CSV_MAX_COLUMNS }, () => "x");
    const buffer = makeCsv(headers, [row]);
    expect(() => classifyCsv(buffer)).not.toThrow();
  });

  it("truncates oversized preview cell values", () => {
    const wide = "a".repeat(CSV_PREVIEW_CELL_MAX_CHARS + 100);
    const buffer = makeCsv(["id", "note"], [["1", wide]]);
    const result = classifyCsv(buffer);
    const cell = result.previewRows[0][1];
    expect(cell.length).toBeLessThanOrEqual(CSV_PREVIEW_CELL_MAX_CHARS + 1);
    expect(cell.endsWith("…")).toBe(true);
  });
});

describe("truncatePreviewCell", () => {
  it("leaves short values unchanged", () => {
    expect(truncatePreviewCell("hello")).toBe("hello");
  });

  it("truncates values at the boundary", () => {
    const s = "x".repeat(CSV_PREVIEW_CELL_MAX_CHARS + 1);
    const truncated = truncatePreviewCell(s);
    expect(truncated.length).toBe(CSV_PREVIEW_CELL_MAX_CHARS + 1);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

describe("disambiguateColumns", () => {
  it("leaves unique names unchanged", () => {
    expect(disambiguateColumns(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("suffixes duplicates with _2, _3, …", () => {
    expect(disambiguateColumns(["id", "name", "id", "id"])).toEqual(["id", "name", "id_2", "id_3"]);
  });

  it("trims whitespace and replaces empty names with 'column'", () => {
    expect(disambiguateColumns(["  a  ", "", "b"])).toEqual(["a", "column", "b"]);
  });
});
