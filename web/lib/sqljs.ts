import path from "path";
import initSqlJs, { type SqlJsStatic } from "sql.js";

/**
 * Lazy singleton for the sql.js module. Initialization is expensive
 * (~20ms + wasm fetch), so the `SQL` constructor is held across
 * concurrent callers. The wasm binary ships in the web/public/ folder
 * and is resolved via locateFile at init time.
 *
 * Each query_csv call creates its own in-memory Database instance via
 * `new SQL.Database()` so state never leaks between invocations.
 */

let sqlPromise: Promise<SqlJsStatic> | null = null;

export function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(process.cwd(), "public", file),
    }).catch((err) => {
      // Reset on failure so the next call can retry — otherwise a single
      // transient error (missing wasm, permissions) would poison the
      // singleton for the life of the process.
      sqlPromise = null;
      throw err;
    });
  }
  return sqlPromise;
}
