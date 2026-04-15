# Multi-Tool Confirmation Fix

## Context

When Claude emits an assistant turn with multiple `tool_use` blocks — one of which is destructive — the confirmation gate in `runAgentLoop` bails out early on the destructive block, leaving the other `tool_use` blocks orphaned (no matching `tool_result`). On resume, only the destructive tool's result is appended. The next Claude API call then fails with `messages.N: tool_use ids were found without tool_result blocks immediately after: ...`, which breaks the conversation permanently. A secondary failure mode observed in the same incident (`messages.2: user messages must have non-empty content`) is a downstream symptom of a user/tool-result message being constructed with no content blocks.

This plan fixes the pairing invariant so that every persisted `tool_use` block has a matching `tool_result` on the next user message — regardless of whether the turn contains one destructive tool, many tools mixed with one destructive tool, or an unusual empty-content condition from trimming.

---

## Key Design Decisions

- **Invariant**: the assistant message we persist for any given turn contains exactly the `tool_use` blocks whose results we will provide in the next user message. Everything downstream (the Claude API call, the confirmation flow) must uphold this.
- **Approach for mixed turns**: when the for-loop in `runAgentLoop` encounters a destructive tool, execute all non-destructive tool_use blocks that appeared BEFORE it (preserving their results), REWRITE the assistant message to drop any tool_use blocks that appear AFTER the destructive one (since we won't be able to execute them before confirmation either), and pause for confirmation. This keeps the persisted shape consistent with what gets resumed.
- **Resume shape**: `resumeAfterConfirmation` must append ONE user message containing ALL the pre-executed results (captured in the pending state) PLUS the confirmed tool's result, in the correct order (matching the `tool_use` block order in the assistant message). Today it only appends the confirmed result.
- **Pending state expansion**: the `PendingTool` type currently carries only `{ id, name, input }`. It must also carry the pre-executed results that were gathered before the confirmation gate fired, so `resumeAfterConfirmation` can re-emit them. Stored in Cosmos alongside the existing pending confirmation.
- **Rejection path parity**: when the user *cancels* the destructive tool, the cancellation result still needs to be paired with the pre-executed results in the same user message.
- **Defensive empty-content guard**: add a small sanitizer in `prepareMessages` (context-manager) and at the agent-loop entry that replaces any `role: "user"` message with an empty string content or an empty array with a placeholder text block. This catches Error 2 regardless of its upstream cause, matching Anthropic's API contract.
- **No change to the system prompt, tool schemas, or skill content** — this is a message-shape bug, not a prompting bug.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Extend `PendingTool` to include an optional `preExecutedResults: ToolResultBlockParam[]` array. |
| `web/lib/agent.ts` | In `runAgentLoop`: before returning `confirmation_required`, (a) collect any `toolResults` already gathered from prior non-destructive tools in this turn, (b) rewrite the last assistant message in `localMessages` to drop any `tool_use` blocks that appear after the destructive one, (c) attach the collected results to the pending tool. In `resumeAfterConfirmation`: read the pre-executed results from `pendingTool` and prepend them to the single confirmed/cancelled tool_result when pushing the user message. |
| `web/lib/conversation-store.ts` | If `PendingTool` is serialized into Cosmos (it is, via `setConversationPendingConfirmation`), ensure the new `preExecutedResults` field round-trips. No schema migration needed — Cosmos is schemaless. |
| `web/lib/session-store.ts` | Same round-trip verification for the in-memory store. No behavior change expected — `PendingTool` is stored as-is. |
| `web/lib/context-manager.ts` | In `prepareMessages`, after all trimming/compression, walk the message list and coerce any `role: "user"` message whose content is `""` or `[]` to a placeholder text block (e.g., `"[empty user message]"`). Log a warn-level event when this fires. |
| `web/lib/agent.ts` | After `prepareMessages` returns, run the same empty-content sanitizer on the array before it's sent to the Anthropic SDK (belt-and-suspenders; context-manager may change). |
| `web/test/agent-multi-tool-confirmation.test.ts` | New vitest file with mocked Anthropic client. Covers: turn with [non-destructive, destructive] → confirmation pauses with pre-executed result stored; resume confirmed → user message has both results in order; resume cancelled → user message has pre-executed result + cancellation result. Also covers: turn with [destructive, non-destructive] → post-destructive block is dropped from assistant message; resume produces a structurally valid next-call payload. |
| `web/test/agent-empty-user-content.test.ts` | New vitest file. Covers: `prepareMessages` coerces empty-string user content to placeholder; agent loop never emits an empty-content user message to the SDK even if `localMessages` contains one. |

---

## Implementation Steps

### 1. Extend the `PendingTool` type

- In `web/lib/types.ts`, find the `PendingTool` interface (currently `{ id: string; name: string; input: Record<string, unknown> }`).
- Add an optional field `preExecutedResults?: Anthropic.Messages.ToolResultBlockParam[]`. Document via JSDoc that this captures tool results from the same assistant turn that ran BEFORE the destructive tool paused the loop. Include a note that this field is optional for backward compatibility with older persisted `pendingConfirmation` values in Cosmos.

### 2. Modify the confirmation gate in `runAgentLoop`

- In `web/lib/agent.ts`, in the `for (const block of toolUseBlocks)` loop at around line 283, the current code executes tools sequentially and returns `confirmation_required` as soon as it hits a destructive tool.
- Change the destructive branch so that BEFORE returning:
  1. Build the `PendingTool` object as today, but additionally attach `preExecutedResults: [...toolResults]` (the results accumulated from non-destructive tools that appeared earlier in this turn).
  2. Rewrite the last assistant message in `localMessages` so its `content` array contains only the blocks up to and INCLUDING the destructive `tool_use` block. This drops any `tool_use` blocks that appeared AFTER it (which would otherwise be unmatched). Preserve any interleaved `text` blocks that came before the destructive `tool_use`.
  3. Return `confirmation_required` with the modified `localMessages` and the expanded `pendingTool`.
- The rewrite must operate on the `response.content` index space, not a filter. Use the index of the destructive `tool_use` block found in `toolUseBlocks` mapped back to the index in `response.content`, and slice there.

### 3. Modify `resumeAfterConfirmation`

- In `web/lib/agent.ts`, the function currently pushes a single `tool_result` as the user message (line ~481).
- Change it so the user message content is an array of `tool_result` blocks: the entries from `pendingTool.preExecutedResults ?? []` followed by the single confirmed-or-cancelled result. Preserve the order.
- No logic change when `preExecutedResults` is undefined — empty array appended to one tool_result = one tool_result, matching existing behavior.

### 4. Add an empty-content sanitizer in `context-manager.ts`

- In `web/lib/context-manager.ts`, inside `prepareMessages` after all trimming/compression steps complete, add a final pass that iterates the resulting message array.
- For each message with `role: "user"`:
  - If `content` is a string and the string is empty (after trimming), replace it with the placeholder text `"[empty user message]"`.
  - If `content` is an array and the array is empty, replace it with `[{ type: "text", text: "[empty user message]" }]`.
  - If `content` is an array and ALL text blocks have empty `text` AND there are no non-text blocks, replace with the same placeholder array.
- Each coercion logs a `logger.warn` event with component `"context-manager"`, message `"Coerced empty user message to placeholder"`, and metadata including the message index and (if persistable) a hash of the session.

### 5. Add a belt-and-suspenders sanitizer in `agent.ts`

- In `web/lib/agent.ts`, after the line `const prepared = await prepareMessages(...)`, and before `createWithRetry(apiParams, ...)` is called, run the same sanitizer logic over `prepared.messages`. This catches any regression in `context-manager.ts` and any direct-to-SDK paths (triage route, resume-after-confirmation) that might not route through `prepareMessages`.
- Factor the sanitizer into a small helper function (e.g., `sanitizeEmptyUserMessages(messages)`) exported from `context-manager.ts` and called from both locations.

### 6. Verify Cosmos and session-store round-tripping

- `PendingTool` is serialized into the conversation document via `setConversationPendingConfirmation` (see `web/lib/conversation-store.ts`). Cosmos is schemaless, so the new `preExecutedResults` field will just appear on the document. No migration needed.
- In `web/lib/session-store.ts` (the in-memory store interface), confirm that `PendingTool` is stored by reference — no serialization, so the new field is preserved.
- Add a unit test (can live in the existing `web/test/conversation-store.test.ts` if present, otherwise a new file) that round-trips a `PendingTool` with a non-empty `preExecutedResults` through `setConversationPendingConfirmation` → `clearConversationPendingConfirmation` and asserts the array survives.

### 7. Write the confirmation test file

- New `web/test/agent-multi-tool-confirmation.test.ts` with a vitest-mocked Anthropic client.
- Test 1 — **pre-destructive non-destructive tool is preserved**: mock an assistant response with content `[text, tool_use(lookup_asset), tool_use(block_indicator, destructive)]`. Run `runAgentLoop`. Assert the returned result type is `"confirmation_required"`, the `pendingTool.preExecutedResults` has one entry (for `lookup_asset`), and `localMessages` has the unchanged assistant content.
- Test 2 — **post-destructive tool is dropped**: mock `[tool_use(block_indicator, destructive), tool_use(lookup_asset)]`. Run `runAgentLoop`. Assert the last assistant message in `localMessages` contains only the first `tool_use` block; `lookup_asset` is NOT present.
- Test 3 — **resume confirmed emits combined user message**: call `resumeAfterConfirmation` with a `pendingTool` that has `preExecutedResults: [lookup_asset_result]`. Mock a simple `end_turn` follow-up. Assert that the user message pushed onto `localMessages` is an array with exactly two tool_result blocks (pre-executed first, confirmed second), and the IDs match.
- Test 4 — **resume cancelled emits combined user message**: same as Test 3 but with `confirmed: false`. Assert the confirmed slot contains the `cancelled: true` payload.
- Test 5 — **invariant under single-destructive (backward-compat)**: mock assistant with only `[tool_use(block_indicator)]`. Run and resume. Assert the resumed user message has exactly one tool_result (no regression from the old behavior).

### 8. Write the empty-content test file

- New `web/test/agent-empty-user-content.test.ts`.
- Test 1 — **empty string user is coerced**: call `prepareMessages` with messages `[{role: "user", content: ""}, ...]`. Assert the returned first user message has a placeholder text block, not an empty string.
- Test 2 — **empty array user is coerced**: call `prepareMessages` with messages `[{role: "user", content: []}, ...]`. Assert the returned first user message has a placeholder text block.
- Test 3 — **agent-loop-level sanitizer catches empties not handled by context-manager**: call the standalone `sanitizeEmptyUserMessages` helper directly with an array containing an empty-content user message. Assert it is coerced.
- Test 4 — **non-empty content is untouched**: pass a user message with a normal string. Assert it is returned exactly as-is (no false positives).

### 9. Manual verification checklist

- Start the dev server (`cd web && npm run dev`), set `MOCK_MODE=true`.
- Send a message that causes Claude to emit a single destructive tool_use (e.g., "block this IP: 1.2.3.4"). Confirm the alert appears, click confirm, verify the conversation continues normally.
- Use a session that is known to have tripped the original bug (or reproduce via a skill that calls multiple tools at once). Confirm the conversation does NOT break with the 400 error.
- Inspect the persisted Cosmos document for a resumed conversation — verify the user message after the destructive tool contains all expected tool_result blocks.

---

## Verification

1. `npx tsc --noEmit` — must be clean.
2. `cd web && npx vitest run` — all existing tests plus the two new files must pass.
3. Specifically confirm the new tests `agent-multi-tool-confirmation` (5 tests) and `agent-empty-user-content` (4 tests) are present in the summary.
4. Manual smoke: with `MOCK_MODE=true`, walk a conversation that triggers the confirmation gate; confirm the next turn succeeds.
5. Log inspection after a production deploy: watch for the new `"Coerced empty user message to placeholder"` warn events. Non-zero occurrences indicate a lurking upstream bug to investigate next.
