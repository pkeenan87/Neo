# Conversation Storage v1 → v2 Migration Guide

This guide walks an operator through the rolling migration from the single-document v1 conversation schema to the split-document v2 schema with blob offload for oversized tool results.

The migration is designed so every transition is reversible and every mode is safe to run for days. Do not skip steps; each phase is a checkpoint that lets you detect a problem before the next one makes recovery harder.

## Table of Contents

- [Overview](#overview)
- [What Changes Under the Hood](#what-changes-under-the-hood)
- [Prerequisites](#prerequisites)
- [Rollout Sequence at a Glance](#rollout-sequence-at-a-glance)
- [Phase 0 — Baseline (v1)](#phase-0--baseline-v1)
- [Phase 1 — Dual-Write](#phase-1--dual-write)
- [Phase 2 — Run the Migration Script](#phase-2--run-the-migration-script)
- [Phase 3 — Dual-Read](#phase-3--dual-read)
- [Phase 4 — v2 Only](#phase-4--v2-only)
- [Rollback (v2 → v1)](#rollback-v2--v1)
- [Monitoring and Observability](#monitoring-and-observability)
- [Testing at Each Phase](#testing-at-each-phase)
- [Troubleshooting](#troubleshooting)

---

## Overview

The migration is controlled by a single environment variable — `NEO_CONVERSATION_STORE_MODE` — that takes one of four values. Flipping it live (via App Service app settings, which trigger a rolling restart) moves the system between phases without a code deploy.

| Mode | Reads | Writes |
|------|-------|--------|
| `v1` | v1 container | v1 container |
| `dual-write` | v1 container | v1 AND v2 containers |
| `dual-read` | v2 first, v1 fallback | v2 container (falls back to v1 for v1-only conversations) |
| `v2` | v2 container | v2 container |

`dual-write` and `dual-read` are the transition modes. You should spend at least 24 hours in each so the monitor signals can prove the change is safe before continuing.

## What Changes Under the Hood

| | v1 | v2 |
|---|---|---|
| Cosmos container | `conversations` | `neo-conversations-v2` |
| Partition key | `/ownerId` | `/conversationId` |
| Document shape | One doc per conversation | Root + per-turn docs + blob-ref docs + (future) checkpoint docs |
| Size ceiling | 2 MB per conversation (hard Cosmos limit) | Unbounded — oversized tool results offload to Azure Blob Storage |
| TTL granularity | Whole conversation | Per-doc (root inherits retention class) |

The external API (sidebar, REST, Teams bot) is identical — all schema changes are contained inside `lib/conversation-store.ts` and `lib/conversation-store-v2.ts`. The dispatch layer keeps the `SessionStore` interface stable, so the agent loop and route handlers don't know which schema is active.

## Prerequisites

Complete all of these before starting Phase 1.

### 1. Provision the v2 Cosmos container

The `neo-conversations-v2` container must exist with partition key `/conversationId`. Add it to your existing Cosmos DB account alongside the legacy `conversations` container — both coexist during the migration.

```powershell
# From Azure CLI (or adapt your existing provisioning script)
az cosmosdb sql container create `
  --account-name neo-cosmos-db `
  --resource-group neo-rg `
  --database-name neo-db `
  --name neo-conversations-v2 `
  --partition-key-path /conversationId `
  --ttl-propertied true
```

### 2. Provision the tool-result blob container

Oversized tool results offload to Azure Blob Storage. Create a dedicated container (default name `neo-tool-results`) on the same storage account used for CLI downloads, and **attach a lifecycle policy that reaps anything under `staging/` after 7 days**. The staging lifecycle is the safety net that cleans up orphaned blobs when a Cosmos write fails between blob upload and commit.

```powershell
az storage container create `
  --account-name neostorage `
  --name neo-tool-results `
  --auth-mode login
```

Lifecycle rule (apply via portal or `az storage account management-policy create`):

```json
{
  "rules": [{
    "name": "reap-staging-orphans",
    "type": "Lifecycle",
    "enabled": true,
    "definition": {
      "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["neo-tool-results/staging/"] },
      "actions": { "baseBlob": { "delete": { "daysAfterModificationGreaterThan": 7 } } }
    }
  }]
}
```

### 3. Grant managed identity access

The App Service's managed identity needs:

- **Storage Blob Data Contributor** on the blob storage account (for the offload container).
- **Cosmos DB Built-in Data Contributor** on the Cosmos account — already granted during Neo's initial provisioning; no changes needed.

### 4. Set the new environment variables

Add these to your App Service app settings (values below are defaults — tune for your traffic):

```bash
NEO_CONVERSATION_STORE_MODE=v1
NEO_CONVERSATIONS_V2_CONTAINER=neo-conversations-v2
NEO_TOOL_RESULT_BLOB_CONTAINER=neo-tool-results
NEO_BLOB_OFFLOAD_THRESHOLD_BYTES=262144
NEO_BLOB_RESOLVE_MAX_BYTES=20971520
NEO_RETENTION_CLASS_DEFAULT=standard-7y
```

Valid retention classes: `standard-7y | legal-hold | client-matter | transient`. `transient` is the short-lived (30-day) class; `legal-hold` suppresses TTL entirely.

### 5. Confirm the build is caught up

Pull and deploy a build that contains the v2 code (any commit from the `conversation-storage-split-blob-offload` branch onward). If you don't have the v2 code deployed yet, `NEO_CONVERSATION_STORE_MODE=v1` leaves all v2 code paths idle — you can deploy safely ahead of time.

## Rollout Sequence at a Glance

```
          ┌───────────┐  flip env    ┌──────────────┐  flip env   ┌─────────────┐  flip env   ┌───────────┐
  v1  →   │    v1     │  ────────→   │ dual-write   │  ─────────→ │  dual-read  │  ────────→  │    v2     │
(start)   └───────────┘              └──────────────┘             └─────────────┘             └───────────┘
                                           │                             ↑
                                           └── run migration script ─────┘
                                              (dry-run, then real)
```

Each arrow is a single env-var change (flip → rolling restart → validate the monitor signal for 24 h → next flip). The migration script runs while you're in `dual-write` mode, before flipping to `dual-read`.

---

## Phase 0 — Baseline (v1)

**Goal:** Confirm your starting state and that the v2 wiring is reachable but idle.

1. Confirm the env var is set: `NEO_CONVERSATION_STORE_MODE=v1`.
2. Deploy the v2-capable build.
3. Use the app normally for ~15 minutes and confirm nothing has changed visibly.

### Validation

```
$ az cosmosdb sql container list --account-name neo-cosmos-db --database-name neo-db -g neo-rg --query "[].id" -o tsv
```

You should see both `conversations` and `neo-conversations-v2` listed. The v2 container should have zero docs (`Metrics > Document count` in the Azure portal).

**Log event to watch:** None for this phase — v2 code paths are inactive.

---

## Phase 1 — Dual-Write

**Goal:** Every new conversation (and every update to an existing one) writes to both v1 and v2. Reads still come from v1, so user-visible behavior is unchanged. This is your chance to detect v2-write bugs before any read traffic depends on v2.

1. Flip the app setting: `NEO_CONVERSATION_STORE_MODE=dual-write`.
2. App Service performs a rolling restart; let it finish.
3. Send a few test conversations through each channel (web, Teams bot) — include at least one with a large tool result (e.g. a KQL query returning >256 KB) to exercise the blob offload path.

### Validation

Query Cosmos and confirm that new conversations appear in both containers with matching IDs:

```
SELECT c.id FROM c WHERE c.createdAt >= "2026-04-22T00:00:00.000Z" ORDER BY c.createdAt DESC
```

Run this against both `conversations` (v1) and `neo-conversations-v2` (v2, filtered on `docType = "root"`). The ID sets should match for any conversation created post-flip.

### Monitor signal (critical)

Watch the `conversation_dual_write_divergence` log event for 24 hours:

```kql
CustomEvents_CL
| where EventType_s == "conversation_dual_write_divergence"
| where TimeGenerated > ago(24h)
| summarize count() by bin(TimeGenerated, 1h), Operation_s
```

**Expected:** zero or near-zero. This event fires when the v1 write succeeds but the parallel v2 write fails — the exact signal that tells you the v2 container is not keeping up with v1 in real time. A sustained rate of anything above occasional infrastructure blips indicates a bug; **do not proceed to Phase 2 until you understand and resolve it**.

### Acceptance criteria

- [ ] New conversations appear in both containers.
- [ ] Divergence event rate is near zero for 24 hours.
- [ ] Large tool results (>256 KB) produce entries in the `neo-tool-results` blob container under `blobs/<sha>` (not `staging/<sha>` — that would indicate the promote step is failing).
- [ ] No user-visible regressions in the web UI or Teams bot.

---

## Phase 2 — Run the Migration Script

**Goal:** Back-fill the v2 container with every existing v1 conversation. After this, dual-read (next phase) has complete coverage and isn't dependent on the v1 fallback.

The script is idempotent — re-running is safe. Each v1 doc is marked `migrated: true` once written to v2; a second run skips it. Oversized tool results (>256 KB) are offloaded to blob storage during migration, mirroring the runtime path exactly.

### 2a. Dry run

Always do this first. The dry run reads every v1 conversation, computes the v2 docs it would write, and reports a summary — but writes nothing.

```bash
cd web
npm run migrate:conversations -- --dry-run
```

Example output:

```json
{
  "summary": {
    "total": 12847,
    "migrated": 12847,
    "skipped": 0,
    "failed": 0,
    "dryRun": true,
    "rejectedOversized": [],
    "failures": []
  }
}
```

If `failed > 0` or `rejectedOversized` is non-empty, investigate the listed conversation IDs before proceeding. The common causes are (a) a malformed v1 doc that predates your schema validators, or (b) a conversation whose content exceeds the 2 MB v2 rebuild ceiling (only relevant in reverse; not possible on forward).

### 2b. Real run

Drop `--dry-run`:

```bash
npm run migrate:conversations
```

The script writes a checkpoint file at `scripts/.migration-checkpoint.json` after each conversation. On successful completion with zero failures, it auto-clears the checkpoint so a follow-up run starts from scratch. If the script crashes or is interrupted, the checkpoint preserves progress — **but see the note about UUID ordering below**.

### 2c. Useful flags

| Flag | Purpose |
|------|---------|
| `--dry-run` | Report what would change; write nothing. |
| `--direction v1-to-v2` | Default. Also accepts `v2-to-v1` for the rollback rebuild. |
| `--since 2026-01-01` | Only migrate conversations updated since this date. Useful for incremental runs. |
| `--conversation-id conv_abc…` | Restrict to one conversation (debugging). |
| `--owner-id user_xyz` | Restrict to one user. |
| `--ru-budget 500` | Sleep between batches when RU pressure exceeds this. Start coarse and tune. |
| `--force-rerun` | Re-migrate even if source doc is marked `migrated`. |

### 2d. The UUID-ordering caveat

Conversation IDs are random UUIDs (`conv_<uuid-v4>`), so the lex-based resume watermark can skip stragglers whose IDs sort below the checkpoint. After any **interrupted** run:

1. Complete the resumed run.
2. Delete `scripts/.migration-checkpoint.json`.
3. Run `npm run migrate:conversations` again from scratch — idempotent skips make this cheap, and it catches any conversation with a lex-low ID that was created during the gap.

On a clean completion (`failed === 0`), the script auto-clears the checkpoint so this second pass is still advisable but not strictly required.

### Validation

```
-- Every v1 doc that isn't marked migrated
SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.migrated) OR c.migrated = false
```

This should be `0` after a successful full migration. If non-zero, run the script again without `--force-rerun` to pick up the laggards.

```
-- v2 root-doc count should now be ≥ v1 conversation count
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "root"
```

### Acceptance criteria

- [ ] Script exit code is `0`.
- [ ] Summary shows `failed: 0`, `rejectedOversized: []`.
- [ ] Both Cosmos counts (v1 migrated and v2 roots) line up.
- [ ] Sample a handful of migrated conversations in the web UI — their titles, tool traces, and attachments render correctly.

---

## Phase 3 — Dual-Read

**Goal:** Move reads to v2 (with v1 fallback for any stragglers), while still dual-writing so a rollback is a single env-var flip.

1. Flip the app setting: `NEO_CONVERSATION_STORE_MODE=dual-read`.
2. Let the rolling restart finish.
3. Use the app normally — check sidebar, open older conversations, start new ones, send messages in existing sessions.

### How reads behave

- `getConversation(id)` point-reads v2 first. If the root doc is missing (migration miss, divergence orphan), it falls back to v1 automatically — the user never sees a failure.
- `listConversations` merges v2 roots with v1 docs, dedupes by ID. Duplicates are logged as an informational event so ops can spot drift.
- Writes dispatch to v2 first; if the v2 root is missing, an internal `ConversationNotFoundV2Error` triggers a v1 fallback write. That means **a v1-only conversation can keep appending turns without crashing**.

### Monitor signals

```kql
// Expected to be rare (near-zero in a clean migration)
CustomEvents_CL
| where Message contains "dual-read write fell back to v1"
| summarize count() by bin(TimeGenerated, 1h)
```

A non-trivial fallback rate means the migration missed some conversations. Re-run the script with no flags (idempotent; catches anything the first pass skipped), and the fallback rate should trend to zero.

### Acceptance criteria

- [ ] No user-visible regressions in the web UI or Teams bot for 24 hours.
- [ ] Fallback-to-v1 event rate is low and trending down.
- [ ] Dual-write divergence rate remains near zero.
- [ ] Sidebar shows both pre-migration and newly-created conversations.

---

## Phase 4 — v2 Only

**Goal:** Stop writing to v1 entirely. Once you're in `v2` mode, the v1 container is read-only (and gets deleted later, after a soak period).

1. Flip the app setting: `NEO_CONVERSATION_STORE_MODE=v2`.
2. Let the rolling restart finish.
3. Confirm new conversations write to v2 only (v1 container document count stops growing).

### Before flipping

- [ ] At least 7 days have passed in `dual-read` with zero regressions.
- [ ] Fallback-to-v1 event rate is zero (not just low).
- [ ] You have a recent Cosmos backup of the v1 container.

### After flipping

- [ ] Sanity-check the web UI and Teams bot for another 24 hours.
- [ ] Confirm the `conversation_blob_offload` event fires for oversized tool results.

### Deleting the v1 container

Only after **at least 30 days** in pure `v2` mode with zero rollbacks or issues:

```bash
az cosmosdb sql container delete \
  --account-name neo-cosmos-db \
  --resource-group neo-rg \
  --database-name neo-db \
  --name conversations
```

This is irreversible. Keep a Cosmos backup for at least one full retention window (7 years for `standard-7y`) before doing this if compliance requires it.

---

## Rollback (v2 → v1)

The rollback path is symmetric: flip `NEO_CONVERSATION_STORE_MODE` backward one step at a time.

| Starting from | Flip to | Notes |
|---|---|---|
| `v2` | `dual-read` | Immediate. v1 reads become available again; writes stop going to v1 but will on the next step. |
| `dual-read` | `dual-write` | Immediate. Writes resume to v1. New conversations from this point forward exist in both stores. |
| `dual-write` | `v1` | Immediate. v2 stops receiving writes. |

If you need to abandon v2 entirely after spending time in pure `v2` mode, the conversations created in that window exist only in v2 and need a reverse migration:

```bash
npm run migrate:conversations -- --direction v2-to-v1
```

The reverse rebuild resolves all blob-ref descriptors inline and runs a pre-flight **2 MB ceiling check**. Any conversation whose rebuilt v1 document would exceed the v1 per-item limit is reported as rejected; the script exits with code `3` and lists the offending IDs. These conversations cannot be rolled back without manual intervention (typically, splitting them into multiple v1 conversations or truncating historical tool results).

### When rollback is NOT enough

- Oversized conversations. If the reverse migration reports rejections, those sessions are v2-native and can't fit in v1. They will remain reachable only while v2 is dispatch-reachable. In practice: keep dispatch mode at `dual-read` indefinitely, which keeps both sides live.
- Blob-referenced tool results from v2. Rollback resolves them inline; the blob container must remain readable by the app's managed identity until rollback completes.

---

## Monitoring and Observability

Every phase has a specific log event to watch. Here's the consolidated set.

| Event | Emitted from | Meaning | Expected rate |
|-------|-------------|---------|---------------|
| `conversation_blob_offload` | `tool-result-blob-store.ts` | A tool result was offloaded to blob storage. | Per-large-result; trending with usage. |
| `conversation_dual_write_divergence` | `conversation-store.ts`, `session-factory.ts` | A v2 write failed while v1 succeeded under `dual-write`. | Near zero. Persistent non-zero = bug. |
| `conversation_blob_resolve` | `tool-result-blob-store.ts` | An offloaded blob was resolved back (via `get_full_tool_result`). | Per-agent-recall; bursty, small. |

KQL starter queries (adapt for your Log Analytics workspace schema):

```kql
// Last 24 h divergence summary
CustomEvents_CL
| where TimeGenerated > ago(24h)
| where EventType_s == "conversation_dual_write_divergence"
| summarize Count=count() by bin(TimeGenerated, 1h), Operation=tostring(Operation_s)
| render timechart

// Blob offload size histogram
CustomEvents_CL
| where EventType_s == "conversation_blob_offload"
| extend SizeKB = SizeBytes_d / 1024
| summarize count() by bin(SizeKB, 50)
| order by SizeKB asc
```

---

## Testing at Each Phase

The branch ships with a full test suite. Before flipping any phase in production, run:

```bash
cd web
npx tsc --noEmit       # type-check clean
npx vitest run         # 343 tests, all green
npm run build          # production build succeeds
```

Targeted suites per phase:

| Phase | Relevant suites |
|-------|----------------|
| 0 — v1 baseline | All existing v1 tests (`conversation-store-v2-schema.test.ts` covers the v2 adapter in isolation with mocked Cosmos). |
| 1 — dual-write | `conversation-store-dispatch.test.ts` (module-level dispatch), `dispatching-session-store.test.ts` (SessionStore dispatch). |
| 2 — migration | `conversation-store-migration.test.ts` (17 tests: offload dispatch, idempotent re-run, checkpoint resume, reverse-direction rejection). |
| 3 — dual-read | `conversation-store-dispatch.test.ts` (dual-read fallback), `teams-bot-v2-integration.test.ts` (4 scenarios: resume, pending confirmation, CSV attachment, partial-failure). |
| 4 — v2 only | `conversation-hydration-render.test.tsx` (client-side hydration with offloaded descriptors). |

### Manual smoke tests per phase

These cover the user-visible surfaces the automated tests can't. Run them against the App Service endpoint before flipping to the next phase.

**Web UI:**

1. Open the app and confirm the sidebar lists expected conversations.
2. Open a pre-existing conversation — verify the tool traces render.
3. Start a new conversation — ask a question that produces a small tool result.
4. Ask a question that produces a large (>256 KB) tool result. Confirm the response renders and the tool-trace accordion shows a short envelope (not the full payload).
5. Upload a CSV attachment and confirm the per-conversation cap still fires if you exceed it.

**Teams bot:**

1. Mention the bot in a channel; confirm it responds.
2. Continue the conversation in a thread; confirm the bot resumes correctly (session persistence).
3. Trigger a destructive tool (e.g. password reset) and confirm the confirmation gate fires. Approve it. Confirm the gated action completes.
4. Simulate a pod restart (restart the App Service or force a deployment swap) and confirm an in-progress conversation resumes.

**Observability:**

1. Query `conversation_dual_write_divergence` for the last hour.
2. Query `conversation_blob_offload` for the last hour.
3. Confirm both queries return sensible numbers (near-zero divergence, offloads scaled with traffic).

---

## Troubleshooting

### `conversation_dual_write_divergence` event firing on every create

**Cause:** v2 root already exists when the second create tries to insert (409). Likely indicates a duplicate-dispatch bug. Verify you're on a build that includes the ultrareview fixes — specifically commit `94c8be1` or later — which removed the duplicate call from `DispatchingSessionStore.create`.

### Script reports `rejectedOversized` during `v2-to-v1` rollback

**Cause:** The rebuilt v1 doc would exceed the 2 MB per-item limit. Options:

1. Keep those conversations in v2 (stay in `dual-read` rather than reverting to `v1`).
2. Manually truncate historical tool results and re-run.
3. Accept the list as "v2-only conversations" and proceed with rollback for the rest.

### User reports "my message disappeared"

**Cause:** Concurrent writers on the same conversation. v2 now throws a 409 for this case (previously silent drop), so clients retry. If you're seeing this post-Phase 2, check:

1. The client retry logic is present (standard `fetch` + NDJSON stream should handle it).
2. The `conversation_dual_write_divergence` rate isn't masking a real v2-side failure.

### Blob offload events visible but resolved reads fail

**Cause:** SSRF guard or managed identity missing permissions. Check:

1. Managed identity has `Storage Blob Data Contributor` on the offload account.
2. `NEO_TOOL_RESULT_BLOB_CONTAINER` matches the actual container name (prefix-anchored in the resolver).
3. Requested blob size is under `NEO_BLOB_RESOLVE_MAX_BYTES` (default 20 MB).

### Migration script "crashed mid-run"

1. The checkpoint file at `scripts/.migration-checkpoint.json` preserves progress.
2. Re-run the same command; it resumes from the watermark.
3. After completion, delete the checkpoint file and run once more (see the [UUID-ordering caveat](#2d-the-uuid-ordering-caveat)).

### `ConversationNotFoundV2Error` in dual-read logs

**Cause:** Expected in limited volume — the v2 store signals that a read/write hit a v1-only conversation. The dispatcher handles this by falling back to v1. A persistent high rate (post-migration) means the migration missed conversations; re-run the script.

---

## Summary Checklist

Use this as a pre-flight checklist for each phase transition:

- [ ] **Phase 0 → 1:** v2 container exists, blob container + lifecycle policy exist, env vars set.
- [ ] **Phase 1 → 2:** 24 hours elapsed, divergence rate near zero, large tool results offloading correctly.
- [ ] **Phase 2 → 3:** Migration script exit 0, `migrated: false` count is zero, sample conversations render.
- [ ] **Phase 3 → 4:** 7+ days elapsed, fallback-to-v1 rate at zero, no regressions reported.
- [ ] **Delete v1 container:** 30+ days in pure v2, Cosmos backup verified, no pending rollback scenarios.
