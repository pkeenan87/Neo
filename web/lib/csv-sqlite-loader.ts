import { parse } from "csv-parse/sync";
import type { Database } from "sql.js";
import { disambiguateColumns } from "./csv-classifier";

/** SQLite column affinity types we support. */
export type ColumnAffinity = "INTEGER" | "REAL" | "TEXT";

export interface LoadedCsv {
  columns: string[];
  affinities: ColumnAffinity[];
  rowCount: number;
}

/**
 * Number of data rows to sample when inferring column types. The loader
 * scans exactly this many rows and commits to a schema, then loads the
 * full file against that schema. Mixed-type columns fall back to TEXT.
 *
 * Chosen so that type inference remains cheap even on large CSVs; the
 * spec calls this out as the "sample-and-commit" strategy.
 */
export const TYPE_INFERENCE_SAMPLE_SIZE = 200;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Probe a single cell for its most-specific numeric type. Returns
 * INTEGER for strings that parse as integers, REAL for strings that
 * parse as floats, TEXT for anything else (including empty strings —
 * empty cells do not constrain inference).
 */
function probeCell(value: string): ColumnAffinity | "EMPTY" {
  if (value === "") return "EMPTY";
  // Reject whitespace-only or values with internal spaces as numeric
  // — SQLite would coerce those to text anyway.
  if (/^\s|\s$/.test(value)) return "TEXT";
  if (/^-?\d+$/.test(value)) {
    // Must fit in a JS safe integer to avoid precision loss across the
    // sql.js boundary. Values outside the safe range fall back to TEXT.
    const n = Number(value);
    if (Number.isSafeInteger(n)) return "INTEGER";
    return "TEXT";
  }
  if (/^-?\d+\.\d+$/.test(value) || /^-?\d+(\.\d+)?[eE]-?\d+$/.test(value)) {
    return "REAL";
  }
  return "TEXT";
}

/**
 * Sample-and-commit type inference. Promotes INTEGER → REAL if any row
 * in the sample contains a float; demotes to TEXT as soon as any row
 * contains a non-numeric value.
 */
export function inferColumnAffinities(
  sampleRows: string[][],
  columnCount: number,
): ColumnAffinity[] {
  const affinities: ColumnAffinity[] = new Array(columnCount).fill("INTEGER");
  const sawAnyValue: boolean[] = new Array(columnCount).fill(false);

  for (const row of sampleRows) {
    for (let col = 0; col < columnCount; col++) {
      const cell = row[col] ?? "";
      const probe = probeCell(cell);
      if (probe === "EMPTY") continue;
      sawAnyValue[col] = true;

      const current = affinities[col];
      if (probe === "TEXT") {
        affinities[col] = "TEXT";
      } else if (probe === "REAL" && current === "INTEGER") {
        affinities[col] = "REAL";
      }
      // INTEGER + INTEGER stays INTEGER; REAL + INTEGER stays REAL; TEXT is terminal.
    }
  }

  // Columns with no observed values default to TEXT.
  for (let col = 0; col < columnCount; col++) {
    if (!sawAnyValue[col]) affinities[col] = "TEXT";
  }
  return affinities;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function coerceForInsert(value: string, affinity: ColumnAffinity): string | number | null {
  if (value === "") return null;
  if (affinity === "INTEGER") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  if (affinity === "REAL") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/**
 * Load a CSV buffer into an existing sql.js Database as a table named
 * `csv`. Uses sample-and-commit type inference (see
 * TYPE_INFERENCE_SAMPLE_SIZE). Duplicate column names are disambiguated
 * with _2, _3, etc.
 *
 * Throws on parse errors. The caller owns the Database lifecycle.
 */
export function loadCsvIntoDb(buffer: Buffer, db: Database): LoadedCsv {
  // Defense in depth: classifyCsv already rejects null-byte buffers at
  // upload time, but query_csv downloads blobs from storage and loads
  // them directly through this helper. Re-check here so that a blob
  // corrupted (or tampered with) after upload can't reach csv-parse.
  if (buffer.includes(0x00)) {
    throw new Error("CSV contains binary (null-byte) content and cannot be loaded.");
  }
  const text = stripBom(buffer.toString("utf-8"));
  let records: string[][];
  try {
    records = parse(text, {
      bom: false,
      relax_quotes: false,
      skip_empty_lines: true,
      trim: false,
    }) as string[][];
  } catch (err) {
    throw new Error(
      `CSV parse failed: ${(err as Error).message || "malformed content"}`,
    );
  }

  if (records.length === 0) {
    throw new Error("CSV is empty — no header row found.");
  }

  const columns = disambiguateColumns(records[0]);
  const dataRows = records.slice(1);
  const sample = dataRows.slice(0, TYPE_INFERENCE_SAMPLE_SIZE);
  const affinities = inferColumnAffinities(sample, columns.length);

  const createSql = `CREATE TABLE csv (${columns
    .map((c, i) => `${quoteIdent(c)} ${affinities[i]}`)
    .join(", ")})`;
  db.run(createSql);

  if (dataRows.length === 0) {
    return { columns, affinities, rowCount: 0 };
  }

  const placeholders = columns.map(() => "?").join(", ");
  const insertSql = `INSERT INTO csv (${columns
    .map(quoteIdent)
    .join(", ")}) VALUES (${placeholders})`;

  const stmt = db.prepare(insertSql);
  db.run("BEGIN");
  try {
    for (const row of dataRows) {
      const values: (string | number | null)[] = new Array(columns.length);
      for (let col = 0; col < columns.length; col++) {
        const raw = row[col] ?? "";
        values[col] = coerceForInsert(raw, affinities[col]);
      }
      stmt.run(values);
    }
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  } finally {
    stmt.free();
  }

  return { columns, affinities, rowCount: dataRows.length };
}
