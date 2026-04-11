import { describe, it, expect, beforeAll } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import path from "path";
import { loadCsvIntoDb, inferColumnAffinities } from "../lib/csv-sqlite-loader";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () => path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
  });
});

function csv(text: string): Buffer {
  return Buffer.from(text, "utf-8");
}

describe("inferColumnAffinities", () => {
  it("infers INTEGER when all non-empty cells are integers", () => {
    const rows = [
      ["1", "10.5"],
      ["2", "20.5"],
      ["3", "30.5"],
    ];
    expect(inferColumnAffinities(rows, 2)).toEqual(["INTEGER", "REAL"]);
  });

  it("falls back to TEXT on mixed-type columns", () => {
    const rows = [
      ["1", "alice"],
      ["2", "bob"],
      ["x", "carol"],
    ];
    expect(inferColumnAffinities(rows, 2)).toEqual(["TEXT", "TEXT"]);
  });

  it("promotes INTEGER to REAL when any row has a decimal", () => {
    const rows = [["1"], ["2"], ["3.5"]];
    expect(inferColumnAffinities(rows, 1)).toEqual(["REAL"]);
  });

  it("defaults to TEXT for columns that are entirely empty", () => {
    const rows = [["1", ""], ["2", ""]];
    expect(inferColumnAffinities(rows, 2)).toEqual(["INTEGER", "TEXT"]);
  });
});

describe("loadCsvIntoDb", () => {
  it("loads a simple CSV and creates the csv table with inferred affinities", () => {
    const db = new SQL.Database();
    try {
      const result = loadCsvIntoDb(
        csv("id,name,score\n1,alice,42\n2,bob,17.5"),
        db,
      );
      expect(result.columns).toEqual(["id", "name", "score"]);
      expect(result.affinities).toEqual(["INTEGER", "TEXT", "REAL"]);
      expect(result.rowCount).toBe(2);

      const stmt = db.prepare("SELECT COUNT(*) AS n FROM csv");
      stmt.step();
      expect(stmt.getAsObject().n).toBe(2);
      stmt.free();
    } finally {
      db.close();
    }
  });

  it("disambiguates duplicate column names in the header", () => {
    const db = new SQL.Database();
    try {
      const result = loadCsvIntoDb(csv("id,id,id\n1,2,3"), db);
      expect(result.columns).toEqual(["id", "id_2", "id_3"]);
    } finally {
      db.close();
    }
  });

  it("handles a header-only CSV", () => {
    const db = new SQL.Database();
    try {
      const result = loadCsvIntoDb(csv("col_a,col_b"), db);
      expect(result.rowCount).toBe(0);
      expect(result.columns).toEqual(["col_a", "col_b"]);
    } finally {
      db.close();
    }
  });

  it("strips a UTF-8 BOM from the first column name", () => {
    const db = new SQL.Database();
    try {
      const withBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("name,age\nalice,30", "utf-8"),
      ]);
      const result = loadCsvIntoDb(withBom, db);
      expect(result.columns[0]).toBe("name");
    } finally {
      db.close();
    }
  });
});
