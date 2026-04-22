# Spec for conversation-storage-split-blob-offload

branch: claude/feature/conversation-storage-split-blob-offload

Notion issue: [Conversation storage: split documents + blob offload](https://www.notion.so/3467b36249e281809bbdf698223858ff) — category: Database, impact: High, date captured: 2026-04-18. Companion analysis doc: [Neo Database Idea](https://www.notion.so/3467b36249e280c78ceefa299200ab23).

## Summary

Restructure how Neo persists conversations in Cosmos DB so a single incident-response session can grow indefinitely without hitting the 2 MB per-item ceiling. Today every conversation is a single Cosmos document that grows with each turn — messages, tool results, CSV attachments, reasoning traces — and gets rewritten in full on every save. Long agentic IR sessions with EDR process trees, email header dumps, and KQL result sets will blow past 2 MB mid-incident; compaction into a rolling summary inside the same doc only delays the failure.

The new shape: one Cosmos container partitioned by `/conversationId`, four document types co-located in the same partition — a conversation root (metadata + rolling summary + latest checkpoint pointer), append-only per-turn documents, immutable checkpoint documents produced by compaction, and blob-ref documents that reference oversized tool outputs offloaded to Azure Blob Storage by SHA-256. Hydration becomes a point-read + partition-scoped ordered query; writes become appends (cheap, contention-free) and small root patches (narrow etag scope). Oversized tool results transparently offload via a `maybeOffloadToBlob` helper threaded into the existing `wrapToolResult` pipeline. A runtime toggle (`NEO_CONVERSATION_STORE_MODE`: `v1` | `v2` | `dual-read` | `dual-write`) lets us roll out and roll back without a deploy. A standalone migration script moves existing v1 documents into v2 idempotently, with dry-run, resume, RU throttle, and reverse modes.

## Functional requirements

- **New Cosmos container `neo-conversations-v2`** with `/conversationId` as the partition key. The v1 container (`/ownerId` partition, single-document-per-conversation) continues to exist during the rollout and is never destructively modified.
- **Four v2 document types** co-located under the conversation's partition:
  1. **Conversation root** — `id = conversationId`. Holds: `ownerId`, `title`, `createdAt`, `updatedAt`, `role`, `channel`, `schemaVersion: 2`, `retentionClass`, `turnCount`, `latestCheckpointId`, `rollingSummary` (short), `pendingConfirmation`, plus the other metadata fields already on v1 `ConversationMeta`.
  2. **Turn document** — `id = turn_<conversationId>_<turnNumber>`. Holds: `conversationId`, `turnNumber` (monotonic int), `role` ("user" | "assistant"), `content` (Anthropic content-block array — text / tool_use / tool_result), `parentTurnId`, `inputTokens`, `outputTokens`, `toolsUsed`, `interrupted?`, `truncated?`, `createdAt`. Append-only; never mutated after write.
  3. **Blob-ref document** — `id = blobref_<sha256>`. Holds: `conversationId`, `turnNumber` it was captured on, `uri` (blob storage URI), `sha256`, `sizeBytes`, `mediaType`, `sourceTool` (tool name that produced it), `shortSummary`, `expiresAt`. Separate documents because a single turn can reference N blobs, and checkpoint compaction needs to know which blobs a range of turns depends on.
  4. **Checkpoint document** — `id = ckpt_<conversationId>_<rangeEndTurn>`. Holds: `conversationId`, `rangeStartTurn`, `rangeEndTurn`, `summary`, `inputTokenSavings` (pre- vs post-compaction estimate), `createdAt`, `supersededBy?` (pointer to a later checkpoint that incorporated this one). Immutable once written; compaction produces new checkpoints rather than rewriting existing ones.
- **Blob offload at the executor layer**. A new `maybeOffloadToBlob(result, { conversationId, sourceTool })` helper wraps the current inline `wrapToolResult` flow. If the serialized tool result exceeds a configurable threshold (default 256 KB), the helper writes the raw bytes to Azure Blob Storage (immutable, keyed by SHA-256), creates a blob-ref document under the conversation's partition, and returns a `{ type: "blob_ref", sha256, sizeBytes, mediaType, shortSummary, uri }` descriptor in place of the full payload. Below the threshold, the helper is a pass-through. A lazy `resolveBlobRef(descriptor)` helper fetches the full payload on demand when the model re-reads a referenced result.
- **Blob storage config**. One container per environment, immutable/WORM objects keyed by SHA-256, accessed via App Service managed identity, CMK-encrypted via the existing Neo Key Vault, lifecycle policies (cool / archive) with a `legal-hold` tag that suppresses tiering. All reads and writes logged to the existing Sentinel workspace so the audit trail stays unified.
- **Write-path refactor in `lib/conversation-store.ts`**. Seven call sites switch from "read full doc → mutate → full replace" to either an append (turn doc) or a narrow Cosmos `patch` (root doc):
  - `saveMessages` / `appendMessages` / on-turn-complete in `stream.ts` → append new turn documents; no etag contention because turn docs are created, never updated.
  - `updateTitle` / `setPendingConfirmation` / `clearPendingConfirmation` → single-property patches on the root doc, narrow etag-retry.
  - `appendCsvAttachment` → blob-ref write + small root patch recording the attachment in `csvAttachments`.
  - `deleteConversation` → point-delete root + partition-scoped delete of all turns, checkpoints, and blob refs in the same partition (TransactionalBatch when under Cosmos' 100-op cap, iterated otherwise). Blob lifecycle handles orphan cleanup asynchronously.
- **Hydration refactor in `lib/conversation-store.ts` `getConversation`**. Replaces the single point-read with: point-read the root, partition-scoped query for turns ordered by `turnNumber`, and — only if the caller needs checkpointed history — a point-read for `latestCheckpointId`. Blob-ref descriptors in turn content stay as descriptors; the agent loop resolves them lazily via `get_full_tool_result` (already wired for the in-memory cap today).
- **`SessionStore` interface unchanged on the outside.** The `Session` and `Conversation` shapes returned to callers stay the same; the reconstruction happens inside the Cosmos adapter. Routes (Teams, web agent, confirm, triage) touch nothing in their call sites.
- **Runtime store-mode toggle `NEO_CONVERSATION_STORE_MODE`**. Env-var driven, read at each request (not cached at boot), four modes:
  - `v1` — reads and writes the current container. Default pre-migration.
  - `v2` — reads and writes the new container only. Post-cutover steady state.
  - `dual-read` — writes to v2 only; reads v2 first, falls back to v1 on miss. Safe rollout mode while the migration script is processing.
  - `dual-write` — writes to both containers, reads from v1. Canary validation before cutover — lets us validate v2 writes against live production traffic without reading from v2 yet.
- **Per-request override header `X-Neo-Store-Mode`**. Admin-only; when present, overrides the env-var mode for that single request. Used for targeted debugging against a specific conversation without flipping the whole deployment.
- **Standalone migration script `scripts/migrate-conversations-v1-to-v2.ts`** (runs from `web/` via `npm run migrate:conversations`). Requirements:
  - Reads from v1 container, writes to v2 via `TransactionalBatch` keyed on `/conversationId`.
  - Offloads oversized tool results encountered in the v1 payload to blob storage during the split.
  - Idempotent: marks the v1 document with `migrated=true` on success; checks v2 for pre-existing root docs before writing.
  - Incremental flags: `--since <ISO-timestamp>`, `--conversation-id <id>`, `--owner-id <id>` for scoped runs.
  - Dry-run (`--dry-run`) emits a per-conversation diff summary — source doc size, turn count, estimated v2 doc count, estimated blob-offload count, estimated RU cost — without writing.
  - RU throttle (`--ru-budget <int>` per batch) so the script can run alongside production without starving live traffic.
  - Structured JSON log per conversation (source RU, dest RU, turn count, blob-offload count, any skip reason) appended to a file and also shipped to Log Analytics via the existing logger.
  - Resumable: checkpoint file (`.migration-checkpoint.json`) records the last-processed conversationId so an interrupted run picks up where it stopped.
  - Reverse mode (`--direction v2-to-v1`) for emergency rollback. Pre-flight checks reject any v2 conversation whose reconstituted v1 doc would exceed the 2 MB ceiling; in that case the tool prints the IDs and exits non-zero so the operator can decide.
- **Retention**. `retentionClass` on the conversation root (values: `standard-7y`, `legal-hold`, `client-matter`, or other Goodwin-defined classes) drives both Cosmos `ttl` on all docs in the partition AND blob storage lifecycle tagging. Default value is configurable; existing v1 conversations get the default on migration.
- **Schema versioning**. All v2 documents carry `schemaVersion: 2`. The store adapter refuses to hydrate documents with an unknown schema version and surfaces a descriptive error so a future v3 migration has a clean migration window.
- **Observability**. New log event types for the new paths: `conversation_blob_offload` (turn id, tool name, sha256, sizeBytes, duration), `conversation_blob_resolve` (turn id, sha256, duration, cache hit/miss), `conversation_checkpoint_written` (range, token savings), `conversation_store_mode_override` (request id, mode from header vs. env). Existing `token_usage` / `tool_execution` / `max_tokens_reached` events are unchanged.

## Figma Design Reference (only if referenced)

Not applicable — backend-only feature. No UI surface, no Figma reference.

## Possible Edge Cases

- **Partial-failure on blob offload.** Blob write succeeds but the subsequent Cosmos turn-doc write fails. The blob must not be orphaned with no reference. Either (a) write the turn doc first with the descriptor and then the blob with the matching SHA (descriptor points to a blob that doesn't exist yet — the resolver must handle "not yet" gracefully with a short retry), or (b) use a staging blob path that's promoted to the final immutable path only after the Cosmos write succeeds. The design must pick one and document it.
- **Partial-failure on migration**. Source doc read succeeds but destination write fails mid-batch. Script must re-process the conversation idempotently on the next run — no duplicate turn docs, no double-offload of the same tool result (SHA-256 keying makes this naturally idempotent for blobs but not for checkpoint docs).
- **Concurrent Teams + Web activity on the same conversation**. Append-only turns are contention-free, but two simultaneous `updateTitle` calls from different channels hit the same root-doc etag. Current etag-retry pattern narrows to only the root; turn docs can't contend. Confirm the retry limit is still sane (default 3 per the existing code).
- **Pending-confirmation round-trip across pod restart**. Pending-confirmation lives on the root doc. After a pod restart, the confirm-route hydrates by reading the root and iterating turns. Confirm the existing `resumeAfterConfirmation` flow works against the split-document reader — the whole test pass for the Teams bot hinges on this.
- **CSV attachment cap**. `CSV_MAX_REFERENCE_ATTACHMENTS` (10) is enforced by the current `appendCsvAttachment` against `csvAttachments` on the doc. In v2, the array lives on the root; the cap enforcement stays at the root-doc level, not blob-ref doc level.
- **Dual-write divergence**. Mid-flight between v1 and v2 writes: v1 succeeds, v2 fails (or vice versa). The request must not return success if the "reading" container (v1 in `dual-write`, v2 in `dual-read`) didn't persist. Decide whether the non-reading container write is best-effort (log-and-continue) or required; the choice affects cutover safety vs. availability.
- **Blob storage outage**. Write path must gracefully fall back to inline payload if the blob API returns non-retryable (e.g. auth failures) — at least for conversations small enough to fit without offload. For oversized payloads that genuinely won't fit, surface a tool error so the model sees it rather than silently truncating.
- **Reverse migration (v2 → v1) doesn't fit**. A conversation with many turns may not reconstruct into a valid v1 doc under 2 MB. Script must reject cleanly (exit non-zero) and list the offending conversation IDs.
- **Legal hold on an archived blob**. Lifecycle tier moves a blob to archive; a later model re-read has to rehydrate it, which is minutes of latency. The blob-ref descriptor should carry a tier hint so the agent loop can surface "this tool result is cold; allow extra time" vs. treat it as a hard failure.
- **Triage / CLI channels**. Triage is one-shot and short; CLI is interactive. Both hit the same `SessionStore` today; neither should notice the refactor. Confirm the triage route (which skips skillInvocation/max-tokens-skill logic) doesn't rely on incidental v1 behaviors.
- **Existing `resolveAuth` / `ownerId` authorization**. v1 routes check `conv.ownerId !== identity.ownerId`. In v2 that check still reads the root doc's `ownerId`, but the partition scope is `conversationId` now, so a malicious caller crafting a `conversationId` they don't own must still be rejected by the ownerId check on the root. Confirm no read path skips it.
- **`MockConversationStore` dev mode**. The existing file-backed mock (`.neo-mock-store/conversations.json`) models the v1 single-document shape. Either (a) mirror the split model in the mock to keep dev parity, or (b) declare mock mode stays on v1 semantics while real Cosmos runs v2 — decide.

## Acceptance Criteria

- A new Cosmos container `neo-conversations-v2` exists in every environment, with `/conversationId` as the partition key. The v1 container is unchanged and still readable.
- `lib/conversation-store.ts` has two adapter paths — v1 (unchanged) and v2 (new) — dispatched by the `NEO_CONVERSATION_STORE_MODE` env var. The external `SessionStore` / `Conversation` API is byte-for-byte identical from a caller's perspective; Teams / Web / CLI / triage routes require no changes at their call sites.
- Writing: `saveMessages`, `appendMessages`, the save-on-turn-complete in `stream.ts`, `updateTitle`, `setPendingConfirmation`, `clearPendingConfirmation`, `appendCsvAttachment`, and `deleteConversation` are refactored in the v2 adapter to the new doc shapes. No v2 write rewrites a full root doc on every turn.
- Reading: `getConversation` / `listConversations` in v2 do point-read + partition-scoped query; no cross-partition query is used anywhere in the v2 adapter.
- `maybeOffloadToBlob` is wired into `wrapToolResult` in `lib/injection-guard.ts`. Tool results larger than the configurable threshold (default 256 KB) are written to blob storage with a blob-ref doc; smaller results pass through inline unchanged.
- Blob storage access uses App Service managed identity. Blob objects are immutable / WORM, keyed by SHA-256, CMK-encrypted from the Neo Key Vault, with lifecycle policies and a `legal-hold` tag that suppresses tiering. All reads and writes log to the existing Sentinel workspace.
- `retentionClass` on the conversation root drives Cosmos TTL on every partition doc and blob lifecycle tagging. Default is configurable via env var.
- `scripts/migrate-conversations-v1-to-v2.ts` runs via `npm run migrate:conversations`, supports `--dry-run`, `--since`, `--conversation-id`, `--owner-id`, `--ru-budget`, `--direction {v1-to-v2|v2-to-v1}`, and `--resume`. It is idempotent, resumable, writes a structured log per conversation to a file + Log Analytics, and exits non-zero with an identified-conversations list when the reverse direction can't fit.
- `NEO_CONVERSATION_STORE_MODE` can be flipped between `v1`, `v2`, `dual-read`, and `dual-write` at runtime via App Service env var with no redeploy. Mode changes take effect on the next request.
- `X-Neo-Store-Mode` admin-only header overrides the env mode for a single request. Non-admin callers sending the header are ignored without error.
- New log events (`conversation_blob_offload`, `conversation_blob_resolve`, `conversation_checkpoint_written`, `conversation_store_mode_override`) fire correctly and show up in the central logger sink.
- Teams bot end-to-end test pass: conversation resume across a pod restart, pending-confirmation round-trip, CSV attachment path, and the partial-failure scenario where a blob write succeeds but the Cosmos patch fails (must not leave an orphan blob ref in a turn that was never persisted).
- No Neo conversation can be broken by the 2 MB Cosmos per-item limit regardless of turn count or tool-result size. Explicit test: a conversation with 500 turns and a 10 MB tool result hydrates and renders correctly in the web UI.
- All existing unit + integration tests pass against the v1 adapter and (under `NEO_CONVERSATION_STORE_MODE=v2`) against the v2 adapter — including `MockConversationStore` if it's kept in parity.

## Open Questions

- **Mock parity vs. simplicity.** Mirror the split-document shape in `MockConversationStore` for exact dev parity, or keep the mock on v1 semantics and document that mock mode is "close but not identical"? Recommend mirroring — the whole point of the mock is developer parity with prod. But it ~doubles the mock file size. mirror.
- **Checkpoint strategy.** When does compaction trigger — turn count threshold, token threshold, time-based? Proposed: turn-count (`NEO_CHECKPOINT_EVERY_N_TURNS`, default 50) AND token-count (`NEO_CHECKPOINT_AT_TOKENS`, default 120K input), whichever fires first. But this might be worth its own follow-on spec. agreed.
- **Blob resolve caching.** Should `resolveBlobRef` have an in-memory LRU across turns so the same blob read twice in one session isn't two blob fetches? Default: yes, bounded LRU (configurable size, default 32 MB total). Flagged because it interacts with the usage tracker — cached blob reads shouldn't double-count. yes.
- **Partial-failure resolution choice.** Staging-blob-promotion or write-turn-first? Recommend staging-blob-promotion: blob is written to a staging path first, then promoted to its immutable SHA-keyed path atomically only after the Cosmos write succeeds. Cleaner rollback semantics (staging blobs are garbage-collected by lifecycle policy) vs. write-turn-first which requires the resolver to treat "not yet" as a retryable state. Flagged for confirmation. agreed.
- **Dual-write failure semantics.** In `dual-write`, if v2 write fails, does the request fail? Recommend: no — log-and-continue (v1 is the reader in this mode), but surface a WARN log event `conversation_dual_write_divergence` so operators can spot drift. Flagged. no.
- **CSV attachment placement.** The CSV preview rows currently live on the conversation root (`csvAttachments`). With blob-ref docs now as first-class, should CSV previews also move into blob-ref docs, or stay on the root for query efficiency? Recommend stay on root — previews are small (100 KB cap today) and the root is queried every hydration. stay on root.
- **Cutover timing.** The "sit in dual-read for ~30 days" baking period named in the Notion doc — is that firm, or adjustable based on how migration goes? Flagged for the rollout plan, not blocking the spec. its adjustable.
- **Per-ownerId RU budget concerns.** The original `/ownerId` partition coupled a single user's conversations into a shared RU budget. Confirm that `/conversationId` partition shape doesn't create the opposite problem (too-small hot partitions per conversation). Short answer: should be fine, since a single conversation's throughput is bounded by human interaction rate, but worth a quick sanity check on the peak-RU-per-conversation metric during canary. ok.

## Testing Guidelines

Create test file(s) in `web/test/` for the new feature. Meaningful coverage without going too heavy:

- `test/conversation-store-v2-schema.test.ts` — unit tests on the v2 adapter's write / read paths using a mock Cosmos container:
  1. `createConversation` writes a root doc under `/conversationId` with `schemaVersion: 2`.
  2. `appendMessages` writes append-only turn docs, never a root-doc full replace.
  3. `updateTitle` uses Cosmos `patch`, not full replace.
  4. `setPendingConfirmation` / `clearPendingConfirmation` round-trip on the root doc.
  5. `getConversation` hydrates from root + partition-scoped turn query and reconstructs the expected `Conversation` shape.
  6. `deleteConversation` removes root + turns + blob refs + checkpoints in the same partition.
- `test/conversation-store-blob-offload.test.ts` — unit tests on `maybeOffloadToBlob`:
  1. Below-threshold payload passes through inline unchanged.
  2. Above-threshold payload offloads to blob and returns a blob-ref descriptor.
  3. SHA-256 keying is deterministic (same content → same blob URI) and idempotent (re-offload is a no-op).
  4. `resolveBlobRef` fetches and returns the full payload by URI.
  5. Partial-failure: blob write succeeds but Cosmos write fails → staging blob is not promoted (or: turn doc is retried on the next call, no orphan).
- `test/conversation-store-mode-toggle.test.ts` — unit tests on the `NEO_CONVERSATION_STORE_MODE` dispatch:
  1. `v1` → reads/writes only v1 adapter.
  2. `v2` → reads/writes only v2 adapter.
  3. `dual-read` → writes to v2; reads v2 first, falls back to v1 on `null`.
  4. `dual-write` → writes to both; reads from v1.
  5. `X-Neo-Store-Mode` header overrides env for an admin request; is ignored for a non-admin request.
- `test/conversation-store-migration.test.ts` — script-level tests against a mock v1 + v2 container pair:
  1. Dry run emits a diff summary without writing.
  2. Full run migrates a representative conversation (with a large tool result) and produces the expected root + turn + blob-ref + checkpoint document counts.
  3. Re-running the migration on an already-migrated conversation is a no-op.
  4. Reverse mode (`v2-to-v1`) reconstructs a small conversation; rejects a conversation that wouldn't fit under 2 MB with a non-zero exit and a listed ID.
  5. RU throttle pauses between batches when over-budget.
- `test/conversation-hydration-render.test.tsx` — the existing `ChatInterface` render path must cope with hydrated conversations that include blob-ref descriptors in tool traces (lazy-resolve on user expand). Mini-harness test that a tool trace containing a blob-ref descriptor renders a "Click to load raw" affordance rather than the full payload.
- `test/teams-bot-v2-integration.test.ts` — the Teams bot is the highest-risk caller. Covers the four scenarios named in the Acceptance Criteria: resume across a pod restart, pending-confirmation round-trip, CSV attachment path, and the blob-write-succeeds / Cosmos-patch-fails partial-failure scenario.
- No changes expected to existing `chat-attachments.test.ts`, `chat-tool-traces.test.tsx`, `copy-button.test.tsx`, or the agent-loop tests — they test code layers above the store adapter and should be schema-oblivious. Running the full existing suite under `NEO_CONVERSATION_STORE_MODE=v2` is part of the acceptance pass.
