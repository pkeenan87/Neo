import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CSVReference } from "../lib/types";

// The executor downloads blobs via upload-storage.downloadCsvByUrl. We stub
// it so tests can feed in raw CSV buffers without any network/storage.
const downloadMock = vi.fn();
vi.mock("../lib/upload-storage", () => ({
  downloadCsvByUrl: (url: string) => downloadMock(url),
}));

// Silence the logger to keep test output clean.
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { queryCsv, __internals } from "../lib/csv-query-executor";

function reference(csvId: string): CSVReference {
  return {
    csvId,
    filename: `${csvId}.csv`,
    blobUrl: `https://example.blob.core.windows.net/neo-csv-uploads/${csvId}`,
    rowCount: 5,
    columns: ["id", "name", "score"],
    sampleRows: [],
    createdAt: "2026-04-11T00:00:00Z",
  };
}

function csvBuffer(text: string): Buffer {
  return Buffer.from(text, "utf-8");
}

const SMALL_CSV = "id,name,score\n1,alice,42\n2,bob,17\n3,carol,88\n4,dave,55\n5,eve,30";

describe("query_csv executor — read-statement allowlist", () => {
  it("accepts SELECT statements", () => {
    expect(__internals.isReadOnlyStatement("SELECT * FROM csv")).toBe(true);
    expect(__internals.isReadOnlyStatement("  select id from csv")).toBe(true);
  });

  it("accepts WITH (CTE) statements", () => {
    expect(__internals.isReadOnlyStatement("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
  });

  it("accepts PRAGMA table_info(csv)", () => {
    expect(__internals.isReadOnlyStatement("PRAGMA table_info(csv)")).toBe(true);
    expect(__internals.isReadOnlyStatement("pragma table_info( csv );")).toBe(true);
  });

  it("rejects UPDATE / DELETE / DROP / ATTACH / COPY / CREATE", () => {
    for (const q of [
      "UPDATE csv SET score = 0",
      "DELETE FROM csv",
      "DROP TABLE csv",
      "ATTACH DATABASE 'x' AS y",
      "COPY csv TO '/tmp/out'",
      "CREATE TABLE evil (x INT)",
      "PRAGMA writable_schema = 1",
    ]) {
      expect(__internals.isReadOnlyStatement(q)).toBe(false);
    }
  });
});

describe("queryCsv", () => {
  beforeEach(() => {
    downloadMock.mockReset();
  });

  it("runs SELECT COUNT(*) FROM csv and returns the row count", async () => {
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));
    const result = await queryCsv(
      { csv_id: "abc", query: "SELECT COUNT(*) AS n FROM csv" },
      [reference("abc")],
    );
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toEqual([[5]]);
    expect(result.row_count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("enforces the 100-row result cap and sets truncated=true", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i + 1},row${i + 1}`).join("\n");
    downloadMock.mockResolvedValue(csvBuffer("id,val\n" + rows));
    const result = await queryCsv(
      { csv_id: "abc", query: "SELECT * FROM csv" },
      [reference("abc")],
    );
    expect(result.rows).toHaveLength(100);
    expect(result.row_count).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("returns truncated=false when result size is at or below the cap", async () => {
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));
    const result = await queryCsv(
      { csv_id: "abc", query: "SELECT id FROM csv" },
      [reference("abc")],
    );
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("rejects a csv_id that does not belong to the caller's attachments", async () => {
    // Note: the download stub is unset — if the executor tries to call it
    // the test fails implicitly because the mock returns undefined.
    await expect(
      queryCsv({ csv_id: "other-convo", query: "SELECT 1" }, [reference("abc")]),
    ).rejects.toThrow(/Unknown csv_id/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("rejects write-shaped statements before loading the database", async () => {
    await expect(
      queryCsv({ csv_id: "abc", query: "DELETE FROM csv" }, [reference("abc")]),
    ).rejects.toThrow(/read-only/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("surfaces clear errors for missing csv_id / query", async () => {
    await expect(
      queryCsv({ csv_id: "", query: "SELECT 1" }, [reference("abc")]),
    ).rejects.toThrow(/csv_id/);
    await expect(
      queryCsv({ csv_id: "abc", query: "" }, [reference("abc")]),
    ).rejects.toThrow(/query/);
  });

  it("propagates SQL errors (e.g. unknown table)", async () => {
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));
    await expect(
      queryCsv({ csv_id: "abc", query: "SELECT * FROM no_such_table" }, [reference("abc")]),
    ).rejects.toThrow();
  });

  it("supports PRAGMA table_info(csv) without the LIMIT wrapper", async () => {
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));
    const result = await queryCsv(
      { csv_id: "abc", query: "PRAGMA table_info(csv)" },
      [reference("abc")],
    );
    // SQLite returns cid, name, type, notnull, dflt_value, pk columns
    expect(result.columns).toContain("name");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("rejects stacked statements — the LIMIT-101 wrap cannot parse a subquery with ';'", async () => {
    // Even though the leading-keyword allowlist lets a SELECT through,
    // queryCsv wraps the user's statement as `SELECT * FROM (<query>) LIMIT 101`
    // before handing it to sql.js. A stacked payload like `SELECT 1; DROP TABLE csv`
    // therefore becomes `SELECT * FROM (SELECT 1; DROP TABLE csv) LIMIT 101` —
    // which is a SQL syntax error (';' is illegal inside a subquery), so
    // prepare() throws before any statement runs. This pins that defense:
    // if a future refactor stopped wrapping the query, this test would break.
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));

    await expect(
      queryCsv(
        { csv_id: "abc", query: "SELECT 1 AS one; DROP TABLE csv" },
        [reference("abc")],
      ),
    ).rejects.toThrow(/syntax/i);

    // Proof that no mutation escaped: a fresh call against a freshly loaded
    // database still returns the full row count. (Each query_csv call has
    // its own in-memory Database, so this is also documentary evidence that
    // per-call isolation holds alongside the wrap defense.)
    downloadMock.mockResolvedValue(csvBuffer(SMALL_CSV));
    const followUp = await queryCsv(
      { csv_id: "abc", query: "SELECT COUNT(*) AS n FROM csv" },
      [reference("abc")],
    );
    expect(followUp.rows).toEqual([[5]]);
  });
});
