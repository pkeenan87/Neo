# Conversation Checkpoint Compaction

> **Status:** deferred stub. Not scheduled.
> Follow-on to `_plans/conversation-storage-split-blob-offload.md`.

## Context

The v2 conversation store introduced `CheckpointDoc` (docType `checkpoint`) as a co-located partition doc. A checkpoint is an immutable, LLM-generated summary of a contiguous turn range (`rangeStartTurn`…`rangeEndTurn`). Storing one on the root (`latestCheckpointId`) lets subsequent turns skip re-reading superseded turn docs.

We shipped the schema and the reader path (`rebuildConversationFromDocs` is ready to thread checkpoints once present), but the **writer path** — deciding when to compact, calling Haiku, persisting the checkpoint doc, recomputing `inputTokenSavings` — is not implemented. Every read in v2 today re-fetches every turn doc in the partition, same as v1's full-message load.

This plan captures the shape of that follow-on so we don't lose context.

---

## Trigger policy (to be refined)

Compaction fires when BOTH are true:

- `turnCount >= 40` AND
- Projected context size on the next turn would exceed ~120K tokens (same watermark as `context-manager.ts` uses today for rolling summary fallback).

This gives a narrow overlap: compaction replaces rolling summaries as the primary compression mechanism once a conversation is long enough to benefit from content-addressable range snapshots.

Alternative: time-based trigger (compact anything >30d old regardless of turnCount). Simpler but creates compaction work at quiet hours that doesn't correlate with read amplification. Prefer the read-pressure trigger.

---

## Writer path

1. Fetch the turn range `[lastCheckpointRangeEnd+1 … currentTurn - 5]`. The 5-turn trailing window stays uncompacted so the most recent context is never summarized.
2. Serialize the range + a fixed instruction prompt to Haiku. Cache the system prompt via Anthropic prompt caching (`cache_control`).
3. Persist a new `CheckpointDoc` with:
   - `id = ckpt_<conversationId>_<rangeEndTurn>`
   - `summary = <model output>`
   - `inputTokenSavings = estimatedSupersededTokens - checkpointTokens`
   - `supersededBy = null` (set later when a later checkpoint absorbs this range)
4. In the same `TransactionalBatch`, patch the root:
   - `latestCheckpointId = <new ckpt id>`
   - Optionally clear `rollingSummary` (the checkpoint replaces it).

Idempotency: a repeat compaction for the same `rangeEndTurn` is a no-op (409 on the deterministic id). Callers can retry freely.

---

## Reader path integration

- `rebuildConversationFromDocs` accepts checkpoints. If a `latestCheckpointId` is set, load the checkpoint doc + only the turns strictly AFTER its `rangeEndTurn`. Prepend a synthetic assistant message containing the summary text.
- Older turn docs are NOT deleted — checkpoints are additive for auditability. A follow-on retention rule can TTL turn docs whose turn number is ≤ `latestCheckpointRangeEnd - N` if storage cost demands it, but default is keep-forever.

---

## Edge cases to handle in implementation

- **Haiku failure mid-compaction.** Transactional scope is only the batch — the Haiku call happens BEFORE the batch. A failure there just aborts the compaction for this turn; no cleanup required.
- **Concurrent compactions.** A second compaction fires before the first's batch lands. The second sees the first's `latestCheckpointId` already set and bails. Batch etag on the root provides the serialization guarantee.
- **Checkpoints superseding earlier ones.** When a new checkpoint covers a range that includes an older checkpoint, patch the older's `supersededBy` pointer. Reads only ever follow `latestCheckpointId` forward; `supersededBy` is for auditing.
- **Tool results with blob refs inside the compacted range.** The summary pass operates on the turn docs' content, which may include blob-ref descriptors. The descriptor's `rawPrefix` + `sourceTool` is what Haiku sees — NOT the full blob contents. Summary quality degrades slightly for huge tool outputs; acceptable tradeoff. A future version could pre-resolve blobs for compaction if quality proves insufficient.

---

## Cost model

- One Haiku call per compaction, cacheable system prompt. Typical cost: ~$0.002 per checkpoint (Haiku 4.5 pricing).
- Break-even vs. rolling re-reads: compaction pays for itself after ~3 reads of the same conversation.
- Storage: ~2 KB per checkpoint doc. Negligible.

---

## Non-goals

- **Cross-conversation compaction.** Every checkpoint is scoped to one partition. No global summarization.
- **User-visible "summary" feature.** Checkpoints are internal context engineering; the UI does not render them.
- **Reverse compaction.** No path to un-summarize. If a model needs the raw turns, it reads them individually — they still exist in the partition.

---

## Files to add (when this ships)

| File | Purpose |
|------|---------|
| `lib/conversation-checkpointer.ts` | Trigger policy + Haiku call + batch write. |
| `lib/conversation-store-v2.ts` | Extend `rebuildConversationFromDocs` to respect `latestCheckpointId`. |
| `test/conversation-checkpointer.test.ts` | Trigger policy, idempotency, batch failure paths. |
| `test/conversation-store-v2-schema.test.ts` | Hydration with a checkpoint + superseded-chain traversal. |

No new env vars expected. No migration required — checkpoints are append-only and read paths fall through when absent.
