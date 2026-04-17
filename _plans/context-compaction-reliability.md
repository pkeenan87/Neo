# Context Compaction Reliability Fix

## Context

During extended incident investigations with heavy tool use (50+ tool calls per session), Neo crashes with three cascading failures: (1) context compression sends orphaned tool_use/tool_result blocks to Haiku, which rejects them with a 400 error, (2) the hard truncation fallback also produces orphaned blocks, causing the main Claude API call to fail, and (3) Cosmos DB rejects the full conversation document (>2 MB) so the session can't be persisted. These failures compound — once compression fails, the conversation is unrecoverable.

Root cause: `compressOlderMessages()` slices the message array at arbitrary indices without respecting tool_use→tool_result pairing boundaries. The `recent` and `cappedMiddle` slices can start or end in the middle of a tool call pair, producing invalid conversation shapes that both Haiku and Claude reject.

---

## Key Design Decisions

- **Pair-aware slicing** — All message slicing (anchor/middle/recent boundaries, cappedMiddle) must land on tool-pair boundaries. A tool_use message and its immediately following tool_result message are an atomic unit that must never be split.
- **Aggressive tool result truncation before persistence** — Apply the same `PER_TOOL_RESULT_TOKEN_CAP` truncation to messages before writing to Cosmos, not just before API calls. This prevents the 2 MB document limit from being hit.
- **Lower the compression trigger threshold** — Reduce `TRIM_TRIGGER_THRESHOLD` from 160K to 140K tokens and make it env-configurable. The current 20K buffer between trigger and hard limit is insufficient when a single turn can add 50K+ tokens of tool results.
- **Emergency truncation when compression fails** — After fallback, if estimated tokens still exceed the limit, progressively drop the oldest messages from the recent window until the estimate is under budget. Never send a request that is known to exceed the limit.
- **Validate conversation shape before API calls** — Add a pre-flight check that ensures every tool_use has a matching tool_result, and vice versa. Remove or repair orphaned blocks before sending.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/context-manager.ts` | Fix pair-aware slicing in `compressOlderMessages()`, add shape validation, add emergency truncation after fallback, lower trigger threshold |
| `web/lib/config.ts` | Make `TRIM_TRIGGER_THRESHOLD` and `PER_TOOL_RESULT_TOKEN_CAP` env-configurable via `parsePositiveInt()` |
| `web/lib/conversation-store.ts` | Truncate tool results in messages before persisting to Cosmos to prevent 2 MB document overflow |
| `web/lib/agent.ts` | Add conversation shape validation before each API call, handle repair of orphaned tool blocks |
| `web/test/context-manager.test.ts` | Add tests for pair-aware slicing, orphaned block repair, emergency truncation, and Cosmos size guard |

---

## Implementation Steps

### 1. Add pair-aware boundary finder to context-manager.ts

- Add a helper function `findPairBoundary(messages: Message[], targetIndex: number, direction: "before" | "after"): number` that adjusts a slice index to respect tool_use/tool_result pairing:
  - If the message at `targetIndex` is a user message containing tool_result blocks, move the boundary backward (for "before") to include the preceding assistant message with the matching tool_use blocks
  - If the message at `targetIndex` is an assistant message containing tool_use blocks, move the boundary forward (for "after") to include the following user message with the matching tool_result blocks
  - The function walks the message array to find the nearest safe boundary
- Use this helper in `compressOlderMessages()` when computing the `middle` and `recent` slices (lines 129-131)
- Also use it when computing `cappedMiddle` (line 136) — ensure the slice starts at a pair boundary

### 2. Add conversation shape validator

- Add a function `validateAndRepairConversationShape(messages: Message[]): Message[]` to context-manager.ts that:
  - Walks the message array and collects all tool_use IDs from assistant messages and all tool_result IDs from user messages
  - Identifies orphaned tool_use blocks (no matching tool_result in the next message) and orphaned tool_result blocks (no matching tool_use in the previous message)
  - Removes orphaned tool_result blocks from user messages (they reference tool_use blocks that were compressed away)
  - Removes orphaned tool_use blocks from assistant messages (their results were lost)
  - If removing all blocks from a message leaves it empty, coerce it to a placeholder via the existing sanitization pattern
  - Logs a warning for each repair with the orphaned tool IDs
- Call this function in `compressOlderMessages()` on the final output (after `[...anchor, summaryMessage, ...recent]` and after `[...anchor, fallbackMessage, ...recent]`)
- Also call it in `prepareMessages()` as a final safety net before returning

### 3. Add emergency truncation when compression fails to reduce size

- In `compressOlderMessages()`, after the catch block produces the fallback result, estimate the token count of `[...anchor, fallbackMessage, ...recent]`
- If the estimate still exceeds `TRIM_TRIGGER_THRESHOLD`, progressively remove the oldest messages from the `recent` array (respecting pair boundaries) until the estimate is under budget
- Log each progressive removal with the message index and estimated savings
- This ensures the fallback path always produces a result that fits within the context window

### 4. Make threshold constants env-configurable

- In `web/lib/config.ts`, change `TRIM_TRIGGER_THRESHOLD` from a hardcoded constant to use `parsePositiveInt("TRIM_TRIGGER_THRESHOLD", 140_000)` — lowered default from 160K to 140K for more headroom
- Change `PER_TOOL_RESULT_TOKEN_CAP` to use `parsePositiveInt("PER_TOOL_RESULT_TOKEN_CAP", 50_000)`
- Change `PRESERVED_RECENT_MESSAGES` to use `parsePositiveInt("PRESERVED_RECENT_MESSAGES", 10)`
- This allows tuning without redeployment

### 5. Truncate tool results before Cosmos persistence

- In `web/lib/conversation-store.ts`, in the `saveMessages()` method of the Cosmos implementation, apply `truncateToolResults()` (import from context-manager) to the messages array before writing
- This ensures that even if the in-memory messages have full-size tool results, the persisted document stays under Cosmos's 2 MB limit
- Add a comment explaining that the in-memory and API-bound messages retain full results for the current session, while persistence uses truncated copies
- Use a lower cap for persistence (e.g., 10K tokens per tool result) since persisted messages are for conversation history display, not for re-sending to the API

### 6. Write tests

- Add test: `compressOlderMessages` respects tool_use/tool_result pair boundaries — create a message array where the naive slice index would split a pair, verify the output keeps pairs together
- Add test: `validateAndRepairConversationShape` removes orphaned tool_result blocks and orphaned tool_use blocks
- Add test: emergency truncation progressively reduces recent messages when fallback output still exceeds threshold
- Add test: `prepareMessages` with a conversation containing 50+ tool calls produces valid output that passes shape validation
- Add test: Cosmos persistence truncation reduces document size below 2 MB for a large conversation

---

## Verification

1. Create a test conversation with 30+ tool call/result pairs totaling >160K tokens and verify `prepareMessages()` produces a valid, pair-respecting output
2. Verify that the Haiku compression call receives only complete tool_use/tool_result pairs (mock the Haiku API and inspect the input)
3. Verify that the fallback path also produces valid conversation shape (no orphaned tool blocks)
4. Run the test suite: `cd web && npx vitest run test/context-manager.test.ts`
5. Deploy to staging and run a heavy-tool-use conversation (20+ sequential KQL queries) to verify no 400 errors
6. Check Cosmos document sizes after a long conversation to verify they stay under 2 MB
