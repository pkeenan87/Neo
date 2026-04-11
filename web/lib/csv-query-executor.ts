import type { Database, SqlValue } from "sql.js";
import type { CSVReference, QueryCsvInput } from "./types";
import { CSV_QUERY_RESULT_LIMIT } from "./types";
import { downloadCsvByUrl } from "./upload-storage";
import { getSqlJs } from "./sqljs";
import { loadCsvIntoDb } from "./csv-sqlite-loader";
import { logger } from "./logger";

// Leading-keyword allowlist for the query_csv tool. We accept SELECT,
// WITH (common table expressions), and `PRAGMA table_info(csv)` for
// schema introspection. Anything else — UPDATE, DELETE, DROP, ATTACH,
// COPY, CREATE, EXPLAIN, VACUUM — is rejected before the database is
// loaded. This keeps the tool contract explicit even though the
// database is in-memory and disposed per-call.
const READ_KEYWORD_RE = /^\s*(select|with)\b/i;
const PRAGMA_ALLOWLIST_RE = /^\s*pragma\s+table_info\s*\(\s*csv\s*\)\s*;?\s*$/i;

function isReadOnlyStatement(query: string): boolean {
  if (READ_KEYWORD_RE.test(query)) return true;
  if (PRAGMA_ALLOWLIST_RE.test(query)) return true;
  return false;
}

export interface QueryCsvResult {
  columns: string[];
  rows: SqlValue[][];
  row_count: number;
  truncated: boolean;
}

/**
 * Execute a read-only SQL query against a reference-mode CSV
 * attachment. The attachment must belong to the caller's conversation
 * (passed via executor context). The function downloads the blob,
 * loads it into an in-memory SQLite database, wraps the user query
 * with `SELECT * FROM (<query>) LIMIT 101`, and returns up to 100
 * rows with a `truncated` flag.
 *
 * Downloads are buffered in memory (no temp files). Each invocation
 * creates its own Database instance which is closed in a finally
 * block so state never leaks between calls.
 */
export async function queryCsv(
  input: QueryCsvInput,
  csvAttachments: CSVReference[],
): Promise<QueryCsvResult> {
  const { csv_id, query } = input;
  if (typeof csv_id !== "string" || csv_id.length === 0) {
    throw new Error("csv_id is required");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("query is required");
  }

  const reference = csvAttachments.find((c) => c.csvId === csv_id);
  if (!reference) {
    throw new Error(
      `Unknown csv_id: ${csv_id}. The query_csv tool can only read CSV attachments belonging to the current conversation.`,
    );
  }

  if (!isReadOnlyStatement(query)) {
    throw new Error(
      "query_csv only accepts read-only SQL: SELECT, WITH (CTE), or PRAGMA table_info(csv). Write statements (UPDATE, DELETE, DROP, ATTACH, COPY, CREATE) are not permitted.",
    );
  }

  const buffer = await downloadCsvByUrl(reference.blobUrl);
  const SQL = await getSqlJs();
  const db: Database = new SQL.Database();
  try {
    loadCsvIntoDb(buffer, db);

    // Wrap the user query to enforce the row cap without parsing SQL.
    // For PRAGMA we skip wrapping — pragmas don't support being wrapped
    // in a subquery.
    const wrapped = PRAGMA_ALLOWLIST_RE.test(query)
      ? query
      : `SELECT * FROM (${query}) LIMIT ${CSV_QUERY_RESULT_LIMIT + 1}`;

    const stmt = db.prepare(wrapped);
    const rows: SqlValue[][] = [];
    let columns: string[] = [];
    try {
      while (stmt.step()) {
        if (columns.length === 0) columns = stmt.getColumnNames();
        rows.push(stmt.get());
        if (rows.length > CSV_QUERY_RESULT_LIMIT) break;
      }
      if (columns.length === 0) columns = stmt.getColumnNames();
    } finally {
      stmt.free();
    }

    const truncated = rows.length > CSV_QUERY_RESULT_LIMIT;
    const capped = truncated ? rows.slice(0, CSV_QUERY_RESULT_LIMIT) : rows;

    return {
      columns,
      rows: capped,
      row_count: capped.length,
      truncated,
    };
  } catch (err) {
    logger.warn("query_csv execution failed", "csv-query-executor", {
      csvId: csv_id,
      errorMessage: (err as Error).message,
    });
    throw err;
  } finally {
    db.close();
  }
}

// Exported for tests.
export const __internals = { isReadOnlyStatement };
