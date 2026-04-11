# Spec for hybrid-csv-support

branch: claude/feature/hybrid-csv-support
Source: Notion feature request — "Hybrid CSV Support (Inline + DuckDB Tool)" (2026-04-10, High Impact)

## Summary

Add CSV upload support to Neo's web chat using a hybrid strategy: small CSVs are inlined directly into the Claude prompt as text content blocks, while large CSVs are uploaded to Azure Blob Storage and queried on demand via a new `query_csv` tool backed by **sql.js** (SQLite compiled to WebAssembly). The decision between the two paths happens transparently at upload time based on row count and byte size — the user never picks a mode.

This avoids burning context window on large datasets while preserving zero-latency answers for small ones. It builds on the already-shipped image/PDF upload feature, reusing the existing upload pipeline, validation plumbing, and Azure Blob Storage integration where possible.

**Why sql.js over DuckDB:** the original proposal used `duckdb` (native Node binding), which introduces deployment risk on Azure App Service Linux (glibc version sensitivity, ~50 MB install size). `sql.js` is pure WebAssembly (~1.4 MB wasm payload), has no native bindings, runs identically on every deployment target, and still gives Claude full SQLite SQL so its query-writing fluency is preserved. The one feature we give up is DuckDB's `read_csv_auto`; we replace it with a ~50-line CSV-to-SQLite loader built on `csv-parse` (already required by the inline path).

## Functional requirements

### Upload + classification
- `useFileUpload` (and the server-side validation path it triggers) must accept `text/csv` MIME type and `.csv` extension. Extension-based fallback is required because browsers frequently report CSVs as `application/vnd.ms-excel`, `application/octet-stream`, or empty strings.
- On upload, the backend parses and validates the CSV (strip BOM, normalize quoting, detect header row, count rows, count columns) using `csv-parse/sync`.
- Classification thresholds (both must be satisfied to inline):
  - `INLINE_ROW_LIMIT = 500`
  - `INLINE_BYTE_LIMIT = 100_000` (≈100 KB)
- If classification fails either threshold, the file takes the reference path. Both thresholds matter: 500 rows × 80 columns is still a context problem.

### Inline path (small CSVs)
- The parsed CSV is emitted as a single text content block prepended to the user's message, wrapped in `<csv_attachment mode="inline">` XML with metadata attributes: filename, column list, total row count.
- The full normalized CSV body sits inside the tag as UTF-8 text.
- Content block ordering in the Claude API request: existing media blocks (images/PDFs) → CSV text blocks → user question text. This must be deterministic so prompt caching behaves predictably.

### Reference path (large CSVs)
- Upload target: Azure Blob Storage container `neo-csv-uploads`, key pattern `{conversationId}/{csvId}/{filename}`. `csvId` is a new UUID per upload.
- A `CSVReference` record (`csvId`, `filename`, `blobUrl`, `rowCount`, `columns[]`, `sampleRows[5]`) is appended to a new `csvAttachments[]` field on the Cosmos DB conversation document. The preview rows are the **first 5 data rows** of the file (streamed read, no random sampling — cheaper and more predictable).
- The prompt receives a `<csv_attachment mode="reference">` text block containing the `csv_id`, column schema, and the 5-row preview. The full body is *not* sent.
- A new `query_csv` tool is conditionally registered in the tools list for that turn, but **only** when the conversation has at least one reference-mode CSV attachment. (Gates the tool surface area to conversations that actually need it.)
- **Per-conversation cap: 10 reference-mode CSV attachments.** Uploading an 11th returns a user-facing error asking them to start a new conversation. This keeps the Cosmos document comfortably under the 2 MB limit and avoids the need for a side container.

### `query_csv` tool
- Input schema: `csv_id` (string), `query` (SQL string).
- Executor behavior:
  1. Look up the `CSVReference` by `csv_id` in the current conversation's `csvAttachments[]`. Reject if not found or `csv_id` isn't owned by the caller's conversation.
  2. Download the CSV blob into memory (a `Buffer`) via the existing `@azure/storage-blob` SDK. Temp-file spill is not required at this size envelope; keep it buffered.
  3. Reject the query if it is not a read-shaped statement. Allowlist the leading keyword: `SELECT`, `WITH`, or `PRAGMA table_info` (case-insensitive, leading whitespace trimmed). Any other statement — `UPDATE`, `DELETE`, `ATTACH`, `COPY`, `CREATE`, `DROP`, `PRAGMA` subcommands other than `table_info`, etc. — is rejected with a clear error. (See Open Question on whether to upgrade to a parser later.)
  4. Initialize `sql.js` (lazy singleton — wasm init is expensive, hold the `SQL` constructor on first use and reuse it across calls). Create a new in-memory `Database` per call so state never leaks between invocations.
  5. Load the CSV into the database via the **CSV loader helper**:
     - Stream-parse the buffer with `csv-parse` (sync mode is fine at this size).
     - Use the header row as column names. Handle duplicate column names by suffixing `_2`, `_3`, etc.
     - Default column affinity: `TEXT`. Optionally, if every non-empty cell in a column parses as a number, declare it `REAL`; if every non-empty cell parses as an integer, declare `INTEGER`. This keeps Claude's arithmetic queries idiomatic without requiring `CAST`.
     - `CREATE TABLE csv (...)` with the resolved schema. The table is always named `csv` so queries are portable across attachments.
     - Batch `INSERT` via a single prepared statement inside a transaction. Expect ~10–50K rows in practice.
  6. Wrap the user query with `SELECT * FROM (<user_query>) LIMIT 101` to enforce a result cap without parsing their SQL.
  7. Run the wrapped query. Return `{columns, rows, row_count, truncated}` where `truncated === true` iff the wrapped query returned 101 rows.
  8. Call `db.close()` in a `finally` block so the in-memory database is released immediately regardless of query success or failure.
- The tool must be classified as read-only (no confirmation gate). It cannot mutate anything: the database is in-memory, per-call, disposed immediately, and the read-statement allowlist makes the intent explicit.

### System prompt update
- Neo's base system prompt gains a CSV attachment directive (verbatim or near-verbatim):
  > When you see `<csv_attachment mode="inline">`, the full CSV contents are provided directly — analyze them as text. When you see `<csv_attachment mode="reference">`, only a 5-row preview is shown; the full dataset must be queried via the `query_csv` tool using the provided `csv_id`. The table name is always `csv`. Prefer SQL aggregations (COUNT, GROUP BY, AVG) over raw row dumps. Queries must be read-only (SELECT / WITH / PRAGMA table_info). Query results are limited to 100 rows.

### Cleanup / lifecycle
- Blob uploads inherit the conversation's TTL semantics: when a conversation is deleted or TTL-expires from Cosmos, the associated blobs must also be removed.
- Implementation: a daily Azure Function (new) that enumerates blob prefixes in `neo-csv-uploads`, checks whether the parent `conversationId` still exists in Cosmos, and deletes orphans. This is acceptable because Cosmos TTL is non-atomic with blob deletion.

### UI / upload progress
- The chat UI must show upload progress for CSV files using the same indicator component already used by the shipped image/PDF upload flow. Classification happens server-side after upload completes, so the progress indicator reflects byte-level transfer only, then transitions to a brief "processing" state while the server validates and — for the reference path — computes the row count and preview.

## Possible Edge Cases

- CSV uploaded with the wrong extension (`.txt` file that happens to be comma-separated): reject — rely on extension and a quick header-row sanity check.
- CSV declared as `text/csv` but is actually malformed (unterminated quotes, ragged rows): surface a user-facing validation error before the file hits Claude.
- CSV with a BOM or non-UTF-8 encoding (ISO-8859-1, Windows-1252): detect BOM, strip it; attempt UTF-8 decode and reject with a clear error if decoding fails. Don't silently mojibake.
- CSV exactly at the threshold boundary (500 rows, 100 KB): use `<=` for inline eligibility.
- Empty CSV (header only, zero data rows): still valid, inline it with `total_rows=0`.
- CSV with duplicate column names: the loader must disambiguate by suffixing `_2`, `_3`, etc., and the disambiguated names must be what gets stored on `CSVReference.columns[]` so preview and queries stay consistent.
- Very wide CSV (1000+ columns): classification should trip on byte limit even if row count is small, but confirm the `INLINE_BYTE_LIMIT` catches this.
- `query_csv` called with a non-read statement (UPDATE, DELETE, ATTACH, COPY, CREATE, DROP): rejected by the leading-keyword allowlist before the database is even loaded. Since the database is in-memory and disposed per call, a successful write-shaped query could not actually persist anything, but refusing them keeps the tool contract explicit.
- `query_csv` called with a `csv_id` that belongs to a different conversation (e.g., prompt injection attempting cross-conversation read): the lookup is scoped to the current conversation's `csvAttachments[]`, so this fails closed.
- `query_csv` SQL that produces no rows: return `{rows: [], row_count: 0, truncated: false}`, not an error.
- `query_csv` SQL that references a table name other than `csv` (e.g., Claude hallucinates `FROM users`): sql.js will throw a "no such table" error. Surface this as a structured tool error so the agent can retry with the correct table name.
- Blob download fails mid-query (network blip, missing blob, SAS expired): surface a clear tool error and let the agent retry or explain the failure to the user.
- User uploads the same CSV twice in one conversation: allow it; different `csvId`s, different blob keys. No deduplication.
- Multiple concurrent `query_csv` calls in the same turn (agent parallelizes): each call creates its own `sql.js` `Database` instance in memory. The `SQL` constructor from `initSqlJs` is a shared singleton and is safe to reuse across concurrent calls.
- Column with mixed types (most values numeric, one stray text): the loader's type-inference pass will fall back to `TEXT` for that column, so queries still work but arithmetic requires `CAST(col AS REAL)`. Claude's system-prompt guidance should mention this.
- `sql.js` wasm file fails to locate or load at runtime (Next.js bundling regression, path resolution issue): surface a tool-level error, not a 500, so the agent can tell the user that CSV querying is temporarily unavailable.
- Reference-path CSV referenced in a later conversation turn after the conversation was re-hydrated from Cosmos: `csvAttachments[]` must survive the same trim/compression path as messages in `context-manager.ts`.

## Acceptance Criteria

- [ ] Uploading a 30-row, 5-column CSV through the web chat results in the full contents being available to Claude in the same turn, with no tool call required. The `<csv_attachment mode="inline">` block is visible in the serialized prompt (or verifiable via logging).
- [ ] Uploading a 5 000-row CSV does NOT inline the contents. The prompt shows a `<csv_attachment mode="reference">` block with exactly 5 preview rows, and `query_csv` is present in the tool schema list for that conversation.
- [ ] `query_csv` with a valid `csv_id` and a `SELECT COUNT(*) FROM csv` query returns the correct row count for the uploaded file.
- [ ] `query_csv` with a query returning >100 rows returns exactly 100 rows and `truncated: true`.
- [ ] `query_csv` with a query returning ≤100 rows returns the full result with `truncated: false`.
- [ ] `query_csv` is NOT present in the tool schema for conversations that have no reference-mode CSV attachments. (Confirms conditional registration.)
- [ ] `query_csv` called from conversation A with a `csv_id` owned by conversation B returns an error without reading the blob.
- [ ] `query_csv` rejects `UPDATE`, `DELETE`, `DROP`, `ATTACH`, and `COPY` statements via the leading-keyword allowlist with a clear error message, before any database is loaded.
- [ ] `query_csv` accepts `SELECT`, `WITH`, and `PRAGMA table_info(csv)` statements.
- [ ] An inline-path CSV column that is entirely numeric is stored with `INTEGER` or `REAL` affinity so aggregations work without `CAST`; a column with mixed types falls back to `TEXT`.
- [ ] A CSV with duplicate column names is loaded with suffixed names (`col`, `col_2`, `col_3`) and those names are reflected in `CSVReference.columns[]`.
- [ ] The `sql.js` WASM module is lazy-initialized once per process and reused across concurrent `query_csv` calls without cross-contamination.
- [ ] Each `query_csv` call calls `db.close()` in a `finally` block, including on query failures.
- [ ] An 11th reference-mode CSV upload in a single conversation returns a user-facing "attachment limit reached" error; the 10th succeeds.
- [ ] A CSV with a UTF-8 BOM is parsed correctly and the BOM does not appear in any column header.
- [ ] A malformed CSV (unterminated quoted field) surfaces a validation error to the user before reaching Claude.
- [ ] Uploading a CSV exactly at 500 rows and 100 KB takes the inline path (inclusive thresholds).
- [ ] Uploading a CSV through the chat UI shows upload progress using the same indicator as the existing image/PDF upload flow.
- [ ] Deleting a conversation via the existing conversation delete endpoint leaves the CSV blobs in place (Cosmos delete is immediate; blob cleanup is deferred to the daily Azure Function). A follow-up run of the cleanup function deletes the orphaned blobs.
- [ ] The base system prompt includes the new CSV directive and the directive survives prompt-cache boundary handling in `context-manager.ts`.
- [ ] Documentation in `CLAUDE.md`'s "Adding a New Tool" section is updated to note that `query_csv` is a conditionally registered tool — this is the first such tool and sets the pattern.

## Resolved decisions (originally open questions)

- **SQL engine**: `sql.js` (SQLite compiled to WebAssembly). No native bindings, ~1.4 MB wasm, runs on every deployment target. Replaces the original `duckdb` proposal and the `better-sqlite3` fallback.
- **Per-conversation attachment cap**: hard cap of 10 reference-mode CSVs. Uploading an 11th is rejected.
- **Preview sample**: first 5 data rows (streamed read, no random sampling).
- **Upload progress UX**: yes — reuse the existing image/PDF upload progress indicator.
- **Write-statement rejection**: leading-keyword allowlist (`SELECT`, `WITH`, `PRAGMA table_info`), case-insensitive. No SQL parser dependency. The in-memory + per-call-disposed database means a successful write wouldn't persist anyway; the allowlist is belt-and-suspenders.
- **Blob auth**: the `query_csv` download path uses Managed Identity via the existing `@azure/storage-blob` client. No SAS URLs.
- **Cleanup function**: a new timer-triggered function is added to an existing Azure Function app (not a new app). Schedule: daily.
- **Type inference strategy**: sample-and-commit — scan the first N rows (e.g., 200) to pick `INTEGER` / `REAL` / `TEXT` per column, then commit that schema for the full load. Avoids a two-pass scan on large files.
- **`sql.js` wasm asset location**: placed in `public/` so Next.js serves it statically; `initSqlJs` resolves via `locateFile`.
- **Tool-call parallelism**: allow concurrent `query_csv` calls for now. Each call holds its own in-memory DB and buffer. Revisit only if OOM is observed.

## Testing Guidelines

Create test files under `web/test/` for the new feature, and create meaningful tests for the following cases, without going too heavy:

- `web/test/csv-classification.test.ts`
  - Row count below limit + byte size below limit → inline.
  - Row count at limit + byte size at limit → inline (boundary inclusive).
  - Row count above limit, byte size below → reference.
  - Row count below, byte size above → reference.
  - Empty CSV (header-only) → inline with `total_rows=0`.
  - CSV with BOM → BOM stripped, classification succeeds.

- `web/test/csv-inline-content-block.test.ts`
  - Built content block has the expected `<csv_attachment mode="inline">` wrapper with filename, columns, and total_rows metadata.
  - Content block ordering in the API request: media → CSV → user text.
  - Multiple CSVs in one turn are each wrapped individually.

- `web/test/query-csv-executor.test.ts`
  - Happy path: stub the blob download with a small in-memory CSV buffer, run `SELECT COUNT(*) FROM csv`, assert correct count.
  - Result truncation: query that would return 200 rows returns 100 rows + `truncated: true`.
  - Non-truncated: query returning 10 rows returns `truncated: false`.
  - Cross-conversation rejection: `csv_id` not in the caller's `csvAttachments[]` → error, no blob read.
  - `db.close()` is called on the failure path (spy on the `Database` instance and assert `close` was called when the query throws).
  - Write-statement rejection: `UPDATE`, `DELETE`, `DROP`, `ATTACH`, `COPY` all reject via the allowlist before the database loads. Assert the blob download is never invoked.
  - Read-statement allowlist: `SELECT`, `WITH`, and `PRAGMA table_info(csv)` all succeed (given a valid `csv_id`).
  - Missing `csv_id`: clean error path, no process crash.
  - Attachment cap: an 11th reference-mode upload into a conversation that already has 10 returns the expected error and does not mutate Cosmos.

- `web/test/csv-sqlite-loader.test.ts`
  - Column type inference: all-integer column → `INTEGER` affinity, all-decimal column → `REAL`, mixed column → `TEXT`.
  - Duplicate column names in the header: loader produces `col`, `col_2`, `col_3`, and the returned `columns[]` matches.
  - Empty CSV (header only): creates an empty table with the right schema and zero rows.
  - CSV with a UTF-8 BOM: BOM is stripped from the first column name.

- `web/test/csv-conditional-tool-registration.test.ts`
  - Conversation with zero reference-mode CSVs → `query_csv` not in the tools list sent to Claude.
  - Conversation with one reference-mode CSV → `query_csv` present with correct schema.
  - Conversation with only inline CSVs → `query_csv` NOT present.

Keep these focused on the unit-level behavior described above. End-to-end verification (real Blob Storage, real Cosmos, real Claude call) is a manual acceptance step against a deployed environment, not part of the automated suite.
