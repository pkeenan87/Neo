# Conversation Storage Split Blob Offload

## Context

Restructure Neo's Cosmos persistence layer so a single conversation isn't a single growing doc bounded by the 2 MB per-item ceiling. Per `_specs/conversation-storage-split-blob-offload.md`, this plan introduces a new `neo-conversations-v2` container partitioned by `/conversationId` with four co-located doc types (conversation root + per-turn docs + blob-ref docs + checkpoint docs), a `maybeOffloadToBlob` helper for oversized tool results wired into `wrapToolResult`, a runtime `NEO_CONVERSATION_STORE_MODE` toggle (`v1` / `v2` / `dual-read` / `dual-write`), and a standalone idempotent migration script. Critical constraint: the external `SessionStore` interface and `Conversation` shape must remain byte-for-byte identical to all callers (Teams bot, web agent, confirm, triage, conversations REST) — all schema knowledge stays inside the Cosmos adapter.

---

## Key Design Decisions

- **Adapter duality inside `lib/conversation-store.ts`**: rather than rewriting the file, introduce a new `CosmosV2SessionStore` class alongside the existing `CosmosSessionStore` and add a dispatch layer that picks one (or coordinates both for `dual-*` modes) based on `NEO_CONVERSATION_STORE_MODE`. The module-level CRUD functions (`createConversation`, `getConversation`, …) each grow a single dispatch switch at the top. Keeps v1 behavior reachable with zero edits to v1-era code paths.
- **Single file for the v2 adapter** (`lib/conversation-store-v2.ts`): document-shape helpers (split a `Conversation` into root+turns+blobrefs+checkpoints and vice versa) plus the `CosmosV2SessionStore` class live together so the schema and the adapter stay co-located. Module-level v2 functions (`createConversationV2`, etc.) are exported for the top-level dispatch to call.
- **Mode dispatcher lives in `lib/conversation-store-mode.ts`** (new): resolves the effective mode from env var, admin header (`X-Neo-Store-Mode`), and per-request context (AsyncLocalStorage). Single source of truth for "which adapter do I use right now", so every CRUD function can just ask `resolveStoreMode()`.
- **Blob offload is new module, not bolted into `upload-storage.ts`**: `lib/tool-result-blob-store.ts` wraps the existing managed-identity pattern from `lib/upload-storage.ts` but introduces SHA-256-keyed immutable paths and a separate container. Reuses the credential + container-client setup pattern, doesn't pollute the file-upload API. Container name configurable via env (`NEO_TOOL_RESULT_BLOB_CONTAINER`, default `neo-tool-results`).
- **Offload hook at `wrapToolResult` boundary**: `wrapToolResult` in `lib/injection-guard.ts` keeps its signature and stays synchronous; the async offload is done by a new `wrapAndMaybeOffloadToolResult` helper called from the agent loop where `wrapToolResult` is currently called (agent.ts:389, 404, 471, 543, 563). Threading async through the existing injection-guard call sites is simpler than making `wrapToolResult` itself async and rewriting every caller.
- **Hydration stays lazy for the agent**: blob-ref descriptors in persisted turn docs are kept as descriptors on reload; the agent sees them as small JSON stubs. When the model calls `get_full_tool_result`, the tool walks the in-memory messages first (current behavior), and on miss calls `resolveBlobRef` using the descriptor's SHA. This keeps hydration cheap and the model's token budget small.
- **Partial-failure strategy: staging-blob-promotion** (per the spec's recommendation). Offload writes to `staging/<sha256>` first, the Cosmos turn/blob-ref write commits, then a `promoteBlob` call renames to the immutable `blobs/<sha256>` path. Lifecycle policy on `staging/*` GCs orphans after 24h. Resolver reads the immutable path.
- **Checkpoint compaction is deferred** to a follow-on plan (`_plans/checkpoint-compaction.md` stub). The v2 schema defines the checkpoint doc shape and the root's `latestCheckpointId` pointer, but the compaction trigger (when to checkpoint) and the summarization call are not implemented in this plan. Conversations in v2 steady state simply accumulate turn docs; at current RU rates and 1–5 KB turn sizes, a 500-turn conversation fits in partition constraints. Unblocks the launch without demanding the full checkpoint algorithm upfront.
- **Mock store mirrors v2 shape**. `lib/mock-conversation-store.ts` gains a "storage mode" like the real adapter and represents the same root + turn + blob-ref split in the file-backed JSON. Tests run identically against mock and real. The mock skips blob offload entirely (results stay inline in the JSON file regardless of size) — acceptable for dev because the mock is single-user, single-machine.
- **Admin-only `X-Neo-Store-Mode` header gate** uses the existing `identity.role === "admin"` check from `resolveAuth` in `lib/auth-helpers.ts`. Non-admin requests silently ignore the header (no error) so a misconfigured proxy can't accidentally leak the override path. Each override logs a `conversation_store_mode_override` event for audit.
- **Admin REST routes keep their "cross-partition list"** (admin-only `sessionStore.list()` in the v1 `CosmosSessionStore`): the v2 adapter implements `list()` by cross-partition-querying the v2 container for root docs only (partition-scoped query won't help across conversations). Not hot-path; admin-only.
- **Migration script is standalone Node** under `scripts/migrate-cosmos-v1-to-v2.mjs` (ESM). Reuses compiled `lib/` via explicit imports; does NOT depend on Next's bundler. Run via `npm run migrate:conversations` from `web/`. Idempotence, dry-run, resume, reverse, RU throttle per the spec.
- **`NEO_RETENTION_CLASS_DEFAULT`** env var sets the default `retentionClass` written to new root docs. Migration applies the same default to existing v1 conversations that lack a class. Cosmos TTL resolution from class → seconds lives in a new small `lib/retention.ts` helper.
- **Observability**: new log events via the existing `logger.emitEvent(...)` pattern, with new `LogEventType` union members (`conversation_blob_offload`, `conversation_blob_resolve`, `conversation_checkpoint_written`, `conversation_store_mode_override`, `conversation_dual_write_divergence`). No new log sink — reuses the central logger.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` (lines 135-143, 244-269, 290-306, plus new adjacent block) | Add new types: `ConversationV2Root`, `TurnDoc`, `BlobRefDoc`, `CheckpointDoc`, `BlobRefDescriptor`, `ConversationStoreMode` union, `RetentionClass` union. Add 5 new `LogEventType` members. Do NOT modify existing `Conversation` / `ConversationMeta` / `Session` shapes — they stay as-is. |
| `web/lib/config.ts` (lines 141-176 area) | Add parsing for `NEO_CONVERSATION_STORE_MODE` (enum, default `v1`), `NEO_BLOB_OFFLOAD_THRESHOLD_BYTES` (default 256_000), `NEO_RETENTION_CLASS_DEFAULT` (string, default `standard-7y`), `NEO_TOOL_RESULT_BLOB_CONTAINER` (string, default `neo-tool-results`), `NEO_CONVERSATIONS_V2_CONTAINER` (string, default `neo-conversations-v2`). Export a `resolveRetentionTtlSeconds(class)` helper or delegate to `lib/retention.ts`. |
| `web/lib/retention.ts` (new) | Single-purpose module: `RETENTION_CLASSES` map (`standard-7y` → 7*365*86400 seconds, `legal-hold` → infinite/null, `client-matter` → configurable, `transient` → 30 days), `resolveRetentionTtlSeconds(className)`, `isLegalHold(className)` (used by blob lifecycle tagging). |
| `web/lib/conversation-store-mode.ts` (new) | Resolver: `getActiveStoreMode(): ConversationStoreMode` returns the effective mode from an `AsyncLocalStorage` context (if set by middleware/route) else from `env.NEO_CONVERSATION_STORE_MODE`. Helper `withStoreMode(mode, fn)` used by routes to scope a per-request override. Helper `setPerRequestMode(mode)` called by the route guard after validating the admin header. |
| `web/lib/tool-result-blob-store.ts` (new) | Blob offload module. Exports: `maybeOffloadToolResult(wrappedResult, { conversationId, sourceTool }) → Promise<string | BlobRefDescriptor>` (returns inline string below threshold, descriptor above), `resolveBlobRef(descriptor) → Promise<string>`, `promoteStagingBlob(sha256) → Promise<void>`, plus an internal `getToolResultContainer()` lazy client similar to `getCsvContainerClient()` in upload-storage.ts. Uses SHA-256 keying, writes first to `staging/<sha>` then promotes to `blobs/<sha>`. Emits `conversation_blob_offload` / `conversation_blob_resolve` log events. |
| `web/lib/conversation-store-v2.ts` (new) | V2 schema helpers and `CosmosV2SessionStore` class. Exports all the same function names as v1 (`createConversationV2`, `getConversationV2`, `listConversationsV2`, `appendMessagesV2`, `updateTitleV2`, `deleteConversationV2`, `setConversationPendingConfirmationV2`, `clearConversationPendingConfirmationV2`, `appendCsvAttachmentV2`, `getCsvAttachmentsV2`, `isConversationRateLimitedV2`). Internal helpers: `splitConversationToDocs(conv) → { root, turns, blobRefs, checkpoints }`, `rebuildConversationFromDocs({root, turns, blobRefs}) → Conversation`, `nextTurnNumber(conversationId, ownerId) → Promise<number>`. Contains `CosmosV2SessionStore implements SessionStore`. |
| `web/lib/conversation-store.ts` (all 11 module exports + `CosmosSessionStore`) | At the top of EACH module-level function, add a mode-dispatch branch: `const mode = getActiveStoreMode(); if (mode === "v2") return conversationV2.<fn>(...); if (mode === "dual-read") { ... }; if (mode === "dual-write") { ... }; // else fall through to v1`. `CosmosSessionStore` class stays; a sibling dispatching store (or the factory) is introduced in `session-factory.ts`. Untouched: all v1 Cosmos interaction code. |
| `web/lib/session-factory.ts` (lines 6-21) | Return a new dispatching store when `COSMOS_ENDPOINT` is set: `DispatchingSessionStore` that picks `CosmosSessionStore` vs. `CosmosV2SessionStore` per-call via `getActiveStoreMode()`. Mock mode unchanged (returns `mockStore`). |
| `web/lib/injection-guard.ts` (lines 185-214 `wrapToolResult`) | Add new exported helper `wrapAndMaybeOffloadToolResult(toolName, result, { sessionId, conversationId, sourceTool }) → Promise<string | BlobRefDescriptor>` that calls the existing sync `wrapToolResult` then `maybeOffloadToolResult`. Leave `wrapToolResult` untouched so existing non-offload callers aren't forced to go async. |
| `web/lib/agent.ts` (lines 389, 404, 471, 543, 563) | Replace the five `wrapToolResult(name, ..., { sessionId })` calls with `await wrapAndMaybeOffloadToolResult(name, ..., { sessionId, conversationId, sourceTool: name })`. The `conversationId` is threaded from `sessionId` (they're the same value today). For the agent-loop path, ensure the `content` field on the `tool_result` block carries the offloaded descriptor as a stringified JSON sentinel when offloaded — the context manager's `get_full_tool_result` tool reads this. |
| `web/lib/executors.ts` (lines 3241-3270 `get_full_tool_result`) | Extend the function so when the matching `tool_result` `content` is a blob-ref descriptor (detect by the `_neo_blob_ref` sentinel), it `await`s `resolveBlobRef(descriptor)` and returns the full content. Requires the function to become async (it is currently sync). All callers (`executeTool` in the same file, line ~3345) become async — verify there's no sync-in-loop call path that breaks. |
| `web/lib/stream.ts` (lines 23-63 `writeAgentResult`) | No structural change required — it calls `sessionStore.saveMessages` which dispatches via the new layer. Verify the auto-title logic still works correctly when the v2 adapter is active (title lives on the root doc). |
| `web/lib/context-manager.ts` (lines 480-543) | No change — operates on in-memory messages before the save-to-store boundary. Blob descriptors are string JSON inside `tool_result` content and pass through unchanged. |
| `web/lib/mock-conversation-store.ts` (lines 52-400) | Add v2-shape storage: a parallel `TurnsMap` alongside the existing `conversations` map. When `env.NEO_CONVERSATION_STORE_MODE !== "v1"`, the mock writes + reads the split shape. Blob offload is a no-op in mock mode (results stay inline in the JSON file, ignoring the threshold). File format version bumped to `2` when split shape is used; old `version: 1` files are auto-migrated on first load. |
| `web/app/api/agent/route.ts` (skill detection area ~line 85, middleware area, + saveMessages calls) | Add a guard at request entry: if header `X-Neo-Store-Mode` present AND `identity.role === "admin"`, wrap the rest of the handler in `withStoreMode(header-value, …)`. If the header value is invalid, return 400. Non-admin header is silently stripped (log the attempt). No changes to business logic. |
| `web/app/api/agent/confirm/route.ts` (top of handler) | Same header-guard wrapping pattern. |
| `web/app/api/conversations/route.ts` (top of handler) | Same. |
| `web/app/api/conversations/[id]/route.ts` (top of each of GET/PATCH/DELETE) | Same, applied per HTTP method. |
| `web/app/api/teams/messages/route.ts` (top of handler, before the 17 sessionStore call sites) | Same, BUT Teams auth doesn't use standard `resolveAuth` — confirm via the bot's service-principal role check that the header is supported OR explicitly NOT supported (bot messages can't carry the header anyway; noop). |
| `web/app/api/triage/route.ts` (top of handler) | Same guard pattern. |
| `web/scripts/migrate-cosmos-v1-to-v2.mjs` (new) | Standalone ESM node script. CLI flags per spec (`--dry-run`, `--since`, `--conversation-id`, `--owner-id`, `--ru-budget`, `--direction`, `--resume`). Reads v1 Cosmos, uses `splitConversationToDocs` from `lib/conversation-store-v2.ts`, writes via `TransactionalBatch` keyed on `/conversationId`, offloads oversized tool results via the same blob-store helper. Checkpoint file `scripts/.migration-checkpoint.json`. Emits structured JSON logs per conversation. Idempotence: marks v1 doc with `migrated=true`, checks v2 for pre-existing root. Reverse direction pre-flight rejects conversations whose reconstituted v1 size would exceed 2 MB with a listed-IDs exit code. |
| `web/package.json` (scripts section, lines 6-10) | Add `"migrate:conversations": "node --experimental-vm-modules scripts/migrate-cosmos-v1-to-v2.mjs"`. Dev dependency additions: none (reuses `@azure/cosmos` + `@azure/storage-blob` + `@azure/identity` already present). |
| `web/.env.example` (or root `.env.example`) | Document the five new env vars (`NEO_CONVERSATION_STORE_MODE`, `NEO_BLOB_OFFLOAD_THRESHOLD_BYTES`, `NEO_RETENTION_CLASS_DEFAULT`, `NEO_TOOL_RESULT_BLOB_CONTAINER`, `NEO_CONVERSATIONS_V2_CONTAINER`) with sensible defaults and a rollout-sequence comment. |
| `web/test/conversation-store-v2-schema.test.ts` (new) | Unit tests on `splitConversationToDocs` / `rebuildConversationFromDocs` and the v2 adapter's read/write paths using an in-memory mock Cosmos container. Six test cases per spec. |
| `web/test/conversation-store-blob-offload.test.ts` (new) | Unit tests on `maybeOffloadToolResult` / `resolveBlobRef`. Five test cases per spec. Mocks Azure Blob Storage via an in-memory stand-in. |
| `web/test/conversation-store-mode-toggle.test.ts` (new) | Unit tests on `getActiveStoreMode` + the dispatch layer. Five test cases per spec, including the admin header override and its admin-only gate. |
| `web/test/conversation-store-migration.test.ts` (new) | Tests the migration script's pure functions (split/rebuild idempotence, RU-throttle pause, reverse-mode pre-flight). Mocks both Cosmos containers. Five test cases per spec. |
| `web/test/conversation-hydration-render.test.tsx` (new) | Mini-harness: a persisted message whose `tool_result.content` is a blob-ref descriptor round-trips, and `get_full_tool_result` (with a mock `resolveBlobRef`) fetches the full content. Tool-trace accordion UI is unaffected (descriptor still renders as the `input`/`output` JSON that fits the existing rendering path). |
| `web/test/teams-bot-v2-integration.test.ts` (new) | The Teams bot is the highest-risk caller per the spec. Covers: resume-across-pod-restart (getExpired), pending-confirmation round-trip, CSV attachment path, and the partial-failure scenario where blob write succeeds but Cosmos patch fails (orphan blob must be staged and never promoted). |
| `web/test/agent-blob-offload-integration.test.ts` (new) | Integration test that pushes a large tool result through the agent loop with offload enabled; verifies the persisted turn doc contains the descriptor (not the payload), verifies `get_full_tool_result` resolves via blob, verifies the in-memory stream to the model contains the full payload (context-manager doesn't pre-truncate). |
| `web/test/chat-attachments.test.ts` (existing) | No change expected. Verify still green under `NEO_CONVERSATION_STORE_MODE=v2`. Listed as a checkpoint. |
| `_plans/checkpoint-compaction.md` (new, stub) | Documents the deferred compaction plan: trigger logic, summarization model choice, supersededBy pointer semantics. Not implemented in this plan. |

---

## Implementation Steps

### 1. Types and config scaffolding

- In `web/lib/types.ts`, add new interface block near line 308 (after `ConversationMeta`): `ConversationV2Root`, `TurnDoc`, `BlobRefDoc`, `CheckpointDoc`, `BlobRefDescriptor`, `ConversationStoreMode` union (`"v1" | "v2" | "dual-read" | "dual-write"`), `RetentionClass` union.
- Add 5 new members to the `LogEventType` union: `conversation_blob_offload`, `conversation_blob_resolve`, `conversation_checkpoint_written`, `conversation_store_mode_override`, `conversation_dual_write_divergence`.
- In `web/lib/config.ts`, add parsing for the 5 new env vars using the existing `parsePositiveInt` / enum pattern.
- Create `web/lib/retention.ts` exporting the retention-class map and resolver.
- Type-check from `web/` (`npx tsc --noEmit`).

### 2. Mode resolver

- Create `web/lib/conversation-store-mode.ts` with `AsyncLocalStorage<ConversationStoreMode>` + `getActiveStoreMode()` + `withStoreMode(mode, fn)` + `parseModeHeader(value)` (rejects invalid strings).
- Add the admin-header guard wrapper used by routes: `withStoreModeFromRequest(request, identity, fn)` that reads `X-Neo-Store-Mode`, validates role, logs `conversation_store_mode_override` if applied, falls through to env otherwise.
- Unit test in `test/conversation-store-mode-toggle.test.ts`.

### 3. Blob offload module

- Create `web/lib/tool-result-blob-store.ts`:
  - Lazy `getToolResultContainer()` mirroring `getCsvContainerClient()` in `lib/upload-storage.ts`. Container name from `env.NEO_TOOL_RESULT_BLOB_CONTAINER`.
  - `maybeOffloadToolResult(wrappedJson, { conversationId, sourceTool })`:
    - Compute byte size of the wrapped JSON; if under threshold, return the string unchanged.
    - Else compute SHA-256, write to `staging/<sha>`, return a `BlobRefDescriptor` stringified JSON wrapped in the `_neo_blob_ref` sentinel envelope (so `wrapToolResult`'s trust-boundary wrapper pattern is preserved).
  - `resolveBlobRef(descriptor)` reads from `blobs/<sha>`, with fallback to `staging/<sha>` (within a short TTL) for the tolerate-promotion-race case.
  - `promoteStagingBlob(sha)` renames staging → blobs; called by the v2 store adapter after the Cosmos write commits.
  - Emit `conversation_blob_offload` on write, `conversation_blob_resolve` on read.
- Unit test in `test/conversation-store-blob-offload.test.ts`.

### 4. V2 schema helpers + adapter

- Create `web/lib/conversation-store-v2.ts`:
  - `splitConversationToDocs(conv)` → { root, turns, blobRefs, checkpoints }. Each `Message` in `conv.messages` becomes one `TurnDoc` with a monotonic `turnNumber`.
  - `rebuildConversationFromDocs({ root, turns, blobRefs })` → `Conversation`. Turns sorted by `turnNumber`; `csvAttachments` come off the root; `pendingConfirmation` comes off the root.
  - `CosmosV2SessionStore implements SessionStore`. Methods mirror the v1 class but operate on the split shape.
  - Module-level functions `createConversationV2`, `getConversationV2`, `listConversationsV2`, `appendMessagesV2` (turn-append + root patch for turn count/timestamp), `updateTitleV2` (root patch), `deleteConversationV2` (partition-scoped delete iterator), `setConversationPendingConfirmationV2` (root patch), `clearConversationPendingConfirmationV2` (root patch returning prior value), `appendCsvAttachmentV2` (root patch with etag retry), `getCsvAttachmentsV2` (delegates), `isConversationRateLimitedV2` (root point-read).
  - For each write that depends on a blob ref being written, call `promoteStagingBlob` AFTER the Cosmos commit.
- Unit test in `test/conversation-store-v2-schema.test.ts`.

### 5. Dispatch layer

- In `web/lib/conversation-store.ts`, add a top-of-function dispatch in each of the 11 module functions:
  - `v1`: existing code path (no change).
  - `v2`: delegate to the v2 module function.
  - `dual-read`: call v2; on null read, fall back to v1. On write: call v2 only.
  - `dual-write`: call v1 (authoritative for reads in this mode); also call v2 as best-effort. On v2 failure, log `conversation_dual_write_divergence` (WARN) but don't fail the request.
- Create a `DispatchingSessionStore` class — or wire the same dispatch into `CosmosSessionStore` vs. `CosmosV2SessionStore` — via `lib/session-factory.ts`.
- Unit tests cover all four modes.

### 6. Blob-offload wiring into the agent loop

- In `web/lib/injection-guard.ts`, export a new `wrapAndMaybeOffloadToolResult` that is async and composes `wrapToolResult` + `maybeOffloadToolResult`. Keep `wrapToolResult` untouched so other synchronous callers aren't forced to go async.
- In `web/lib/agent.ts`, replace the five existing `wrapToolResult(name, result, { sessionId })` sites (lines 389, 404, 471, 543, 563) with the async wrapper. Thread `conversationId` (same value as `sessionId` in today's data model) and `sourceTool: name` into the helper. The `content` field of each `tool_result` block now holds either the inline JSON string or the stringified blob-ref envelope.
- In `web/lib/executors.ts`, convert `get_full_tool_result` (line 3241) to async. When the matched `tool_result.content` parses as a blob-ref envelope, `await resolveBlobRef(descriptor)` and return the resolved content. Propagate async up to `executeTool` (line ~3345) and any sync callers — verify there are none that expected sync-return.

### 7. Mock store parity

- In `web/lib/mock-conversation-store.ts`, detect `env.NEO_CONVERSATION_STORE_MODE` at load and either (a) use the existing single-doc shape when mode is `v1`, or (b) persist the split shape (root + turns) when mode is anything else. Auto-migrate the existing `version: 1` JSON file on first load by splitting each stored conversation into the new shape and bumping `version: 2`.
- Mock store skips blob offload entirely — inline all results regardless of size.
- Update `test/mock-conversation-store.test.ts` (if it exists) or add a new `test/mock-conversation-store-v2.test.ts` covering the auto-upgrade path.

### 8. Route-layer admin-header guard

- In each of `agent/route.ts`, `agent/confirm/route.ts`, `conversations/route.ts`, `conversations/[id]/route.ts`, and `triage/route.ts`, wrap the handler body in `withStoreModeFromRequest(request, identity, handler)`.
- Teams route (`teams/messages/route.ts`): Teams bot messages don't carry custom headers in practice, so wrap with the no-op variant that just uses env-var mode. Document this in the file.
- Admin-header gate: non-admin callers with the header get a `WARN` log and the header is silently ignored (not an error).

### 9. Migration script

- Create `web/scripts/migrate-cosmos-v1-to-v2.mjs`. CLI parsing (no external deps — use `process.argv` + small parser).
- Wire the same imports as production — the v2 split helper, the blob offload helper, the existing Cosmos client factory. Use `--experimental-vm-modules` node flag via the npm script.
- Modes:
  - `--dry-run`: emit a diff summary per conversation, no writes.
  - Full run: for each v1 conversation (filter by `--since`, `--conversation-id`, `--owner-id`), split into v2 docs, offload oversized tool results, write via `TransactionalBatch` keyed on `/conversationId`, mark v1 doc with `migrated=true`.
  - Resume: `scripts/.migration-checkpoint.json` stores the last-processed conversation id; subsequent runs skip earlier ids unless `--force-rerun`.
  - RU throttle: sleep between batches when requested RU exceeds `--ru-budget`.
  - Reverse (`--direction v2-to-v1`): rebuild a v1 doc from v2 partition; pre-flight check rejects conversations whose rebuilt size would exceed 2 MB; exits non-zero with the offending IDs.
- Add `"migrate:conversations": "node --experimental-vm-modules scripts/migrate-cosmos-v1-to-v2.mjs"` to `package.json`.
- Unit tests for the pure split/rebuild/pre-flight functions in `test/conversation-store-migration.test.ts`.

### 10. Hydration + rendering test

- `test/conversation-hydration-render.test.tsx`: a persisted turn doc with a blob-ref `tool_result.content` hydrates through `rebuildConversationFromDocs`, and `get_full_tool_result` with a mock `resolveBlobRef` fetches the full content on demand. Assert the ChatInterface's tool-trace accordion renders a small "[offloaded — Nms to load]" input/output when the descriptor is present and the full payload when expanded.

### 11. Teams bot integration tests

- `test/teams-bot-v2-integration.test.ts`: four scenarios from the spec, each wrapping the Teams route handler with mocked Cosmos + mocked blob storage.
- Partial-failure scenario specifically uses the staging-blob promotion pattern — a mocked "Cosmos patch fails" path must leave the staging blob un-promoted; a subsequent successful retry re-uploads to the same SHA (idempotent) and promotes.

### 12. Agent-loop integration test

- `test/agent-blob-offload-integration.test.ts`: drives a mocked agent turn that returns a >256 KB tool result. Verifies: (a) the persisted `tool_result` carries the descriptor, (b) `get_full_tool_result` resolves via blob, (c) in-memory stream to the next model call still has the full payload (context-manager doesn't pre-truncate).

### 13. Env docs + rollout notes

- Update `web/.env.example` (or root `.env.example`) with the new variables, defaults, and a "# Rollout sequence:" commented block pointing operators through `v1` → `dual-write` → run migration → `dual-read` → `v2`.
- Add a `_plans/checkpoint-compaction.md` stub describing the deferred follow-on.

### 14. Verify, commit, push

- `npx tsc --noEmit` from `web/`.
- `npx vitest run` from `web/` — all existing tests pass PLUS the new suites (target ~225–240 total, up from 203).
- `npm run build` from `web/` — production build succeeds.
- Commit sequence (one commit per major phase so review is tractable):
  1. Types + config + retention module.
  2. Mode resolver.
  3. Blob-offload module + tests.
  4. V2 adapter + tests.
  5. Dispatch layer + factory + tests.
  6. Agent-loop offload wiring + get_full_tool_result async.
  7. Mock store parity.
  8. Route-layer admin-header guards.
  9. Migration script + tests.
  10. Integration tests (hydration render + Teams + agent-loop).
  11. Env docs + compaction stub.
- Push the branch; open a PR per-phase if the reviewer prefers stacked reviews.

---

## Verification

1. **Regression guard (`NEO_CONVERSATION_STORE_MODE=v1`)**: all existing tests pass unchanged. Existing chat conversations persist, reload, and tool-trace correctly with no behavior drift. `npx vitest run` green.
2. **V2 round-trip (`NEO_CONVERSATION_STORE_MODE=v2`)**: a fresh conversation with 5 user turns, 4 tool calls (1 under threshold, 1 over, 2 near threshold) persists, reloads, renders tool traces, and (post-reload) the offloaded tool result is correctly resolved when the model calls `get_full_tool_result`.
3. **Dual-read safety**: seed v1 with a conversation, flip mode to `dual-read`, append a user message (writes to v2), reload — reads v2; delete only from v2, reload — falls back to v1. Flip to `v2` — v1 reads fail, v2 reads succeed.
4. **Dual-write divergence**: under `dual-write`, simulate a v2 write failure; request still succeeds (v1 wrote), `conversation_dual_write_divergence` WARN log fires with the failing conversation id.
5. **Migration script — dry run**: point at a populated v1 container, `npm run migrate:conversations -- --dry-run`. Diff summary per conversation shows expected turn count, blob offload count, RU estimate. No writes. Log file populated.
6. **Migration script — full run**: same container, full run. V2 container populated. V1 docs carry `migrated=true`. Re-running is a no-op (skips migrated conversations). Interrupt mid-run, re-run with `--resume` — picks up from checkpoint.
7. **Migration reverse — too big**: pick a v2 conversation whose reconstituted v1 size > 2 MB. `migrate:conversations -- --direction v2-to-v1 --conversation-id <id>` exits non-zero with the offending id listed.
8. **Admin header override**: admin request with `X-Neo-Store-Mode: v2` against a `v1`-default deployment uses v2 for that request, logs `conversation_store_mode_override`. Non-admin request with same header silently ignored, logs an attempted-override warn.
9. **Blob offload partial-failure**: mock the Cosmos write to fail immediately after a staging blob write. The staging blob lifecycle eventually GCs it (simulated). Client retries and re-offloads (idempotent — same SHA).
10. **2 MB ceiling sanity**: construct a synthetic conversation with 500 turns and a 10 MB tool result. Write under `v2` — no errors; blob offload kicks in for the 10 MB result. Reload — conversation renders, tool-trace offers "click to load raw" for the offloaded result.
11. **Teams bot end-to-end**: `test/teams-bot-v2-integration.test.ts` passes all four scenarios (resume-across-restart, pending-confirmation round-trip, CSV attachment, blob-write-succeeds + Cosmos-fails).
12. **Test commands** (from `web/`, per phase):
    - `npx tsc --noEmit`
    - `npx vitest run`
    - `npm run build`
    - `npm run migrate:conversations -- --dry-run` against a staging Cosmos endpoint.
13. **Manual check**: flip `NEO_CONVERSATION_STORE_MODE=v2` on a dev server, send a prompt that triggers a skill (which tends to produce large tool results). Tool-trace accordion expands the offloaded result. Reload the page — badge, trace, offload resolution all intact.
