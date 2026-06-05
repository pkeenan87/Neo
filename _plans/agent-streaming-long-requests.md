# Agent Streaming for Long Requests

## Context

Production hit a hard ceiling on a skill invocation:

```
ERROR [api/agent] Agent loop error
{"errorMessage":"Streaming is required for operations that may take longer
than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests"}
```

The Anthropic SDK enforces a client-side 10-minute wall-clock ceiling on
non-streaming `messages.create()` calls. Skills hit this because they
combine a larger output budget (`MAX_TOKENS_SKILL = 24_576`), Opus 4.8's
default `effort = high`, and multi-step reasoning — long enough that a
single turn can exceed 10 min. The fix is structural: route every
Anthropic call through the streaming API. Aggregating the stream server-
side produces the identical `Anthropic.Messages.Message` shape the agent
loop already consumes, so downstream code (cache breakpoint stamping,
content-block parsing, token-usage logging, MCP audit) needs no changes.

This change does NOT surface streaming to the client — that is a separate
UX project (SSE end-to-end + incremental rendering). The immediate fix
just removes the 10-min wall.

---

## Key Design Decisions

- **Always stream, never `.create()`.** A conditional (skills-only)
  branch would mean two code paths sharing the same retry / error /
  audit surface — twice the bugs for no benefit. Stream is a wire-
  format choice; the aggregated `finalMessage()` matches the existing
  Message contract. Default chat turns gain the same protection
  (an Opus 4.8 deep-investigation turn could conceivably hit 10 min
  too, especially with extended thinking).
- **Server-side aggregation, single boundary.** Keep `runAgentLoop` and
  every downstream consumer ignorant of the change. Inside
  `createBetaWithRetry`, replace the `await client.beta.messages.create(...)`
  call with the stream-and-await-finalMessage idiom. Cast back to
  `Anthropic.Messages.Message` at the existing boundary.
- **Retry semantics unchanged.** The current `createBetaWithRetry`
  catches request-time errors (4xx/5xx/network) and retries with
  exponential backoff. Streams introduce a new failure mode: mid-stream
  errors after partial bytes are received. `finalMessage()` rejects
  with the same `APIError` shape on those, so the existing retry filter
  works as-is. One nuance: if the stream errored AFTER content was
  emitted, the partial output is discarded by the retry — same as
  today.
- **Cancellation: signal still pipes through.** The SDK accepts
  `{ signal }` on `.stream()` the same way as `.create()`. Existing
  Abort plumbing (per-turn timeout from `AbortSignal.timeout(maxSec *
  1000)` in `scheduled-task-runner`, plus user-cancel from the chat
  client) keeps working — the stream is cancelled mid-flight and
  `finalMessage()` rejects with an AbortError.
- **MCP server-side execution unchanged.** The MCP-connector beta
  responds with the same shape over stream events; `auditMcpInvocations`
  reads `response.content` after aggregation. No code change needed.
- **Test mock strategy.** ~10 test files currently mock
  `betaCreateMock` returning a complete `Message`. Add a tiny shared
  helper `mockBetaStream(message)` that returns an object exposing a
  `finalMessage()` method resolving to the message (plus
  `[Symbol.asyncIterator]` returning an empty iterator so any
  iter-based test code stays happy). Each test swaps
  `mockResolvedValue(msg)` → `mockReturnValue(mockBetaStream(msg))`.
  Mechanical, ~15 LoC per file.
- **`createWithRetry` (stable, non-MCP path) stays as-is.** That helper
  is now only used by `summarizeConversation` with Sonnet — short
  summaries that comfortably fit under 10 min and benefit from the
  simpler error path. Adding stream support there is a separate
  cleanup item.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/agent.ts` | Replace the call inside `createBetaWithRetry` from `await client.beta.messages.create(params, { signal })` to a streaming idiom: `const stream = client.beta.messages.stream(params, { signal }); const message = await stream.finalMessage();`. Cast back to `Anthropic.Messages.Message` at the existing seam. Keep the surrounding `for (attempt...)` retry loop, retryable-status filter, prompt-too-long short-circuit, and AbortError re-throw exactly as they are today. Update the docstring above the helper to note the stream switch + rationale (10-min ceiling). |
| `web/lib/agent.ts` (imports) | If `Anthropic.Beta.Messages.MessageCreateParamsNonStreaming` is the current params type, switch to `MessageCreateParamsBase` (or the SDK's stream-params equivalent — whatever `.stream()` accepts). The `stream: true` discriminator is set by the SDK helper, not the caller, so the input params shape is unchanged. |
| `web/test/helpers/mock-beta-stream.ts` *(new)* | Shared test helper: `export function mockBetaStream(message: Anthropic.Messages.Message)` returns `{ finalMessage: () => Promise.resolve(message), [Symbol.asyncIterator]: function* () {} }` (or `async function*` if the tests iterate). One file, ~15 lines, exported for re-use. |
| `web/test/agent-mcp.test.ts` | Switch the existing `betaCreateMock` to behave as a stream: instead of `mockResolvedValue(buildResponse(params))` and `mockImplementationOnce(async (params) => ({...}))`, return `mockBetaStream(buildResponse(params))`. The test assertions on `capturedBetaCalls[0]` / `betaCreateMock.toHaveBeenCalledWith(...)` keep working because the mock is still called with the same params object. |
| `web/test/agent-anthropic-metadata.test.ts` | Same pattern — wrap the response in `mockBetaStream(...)`. The metadata assertions read `capturedCalls[0].metadata` from the params, which is unchanged. |
| `web/test/agent-max-tokens-handling.test.ts` | Same pattern. The stop-reason handling tests don't care about the wire format; they assert on the aggregated Message returned by the agent loop. |
| `web/test/agent-multi-tool-confirmation.test.ts` | Same pattern. The confirmation-gate test reads `result.toolUse` from the agent loop's return — unaffected by streaming. |
| `web/test/agent-plan-resumption.test.ts` | Same pattern. |
| `web/test/csv-conditional-tool-registration.test.ts` | Same pattern. |
| `web/test/prompt-caching.test.ts` | Same pattern. The cache-control assertions read from `mockCreate.mock.calls[0][0]` (the params) — unchanged because `stream()` accepts the same params object. |
| `web/test/opus-4-8-migration.test.ts` | No change — this test exercises pure helpers (`displayNameForTier`, `getContextBudget`, etc.), not the Anthropic SDK. |
| `web/test/p4-cache-optimisation.test.ts` | Mostly unaffected (tests `stampCacheBreakpointOnLastMessage` directly). Verify it still passes; no anticipated changes. |
| `web/test/logger-safe-metadata-fields.test.ts` | Unaffected. |
| `web/test/scheduled-task-runner.test.ts` *(if present)* | Likely uses a higher-level mock of `runAgentLoop`; unaffected. Verify. |
| `web/test/agent-empty-user-content.test.ts` | Same pattern (uses the beta mock). |
| `web/test/agent-streaming.test.ts` *(new)* | New regression tests: (a) `createBetaWithRetry` invokes `client.beta.messages.stream()` not `.create()`; (b) the aggregated `finalMessage()` value is returned unchanged to the caller; (c) AbortSignal is forwarded into the stream call; (d) a mid-stream rejection from `finalMessage()` triggers the same retry policy as a request-time rejection; (e) prompt-too-long errors short-circuit retries identically to the pre-change behaviour. |
| `docs/agent-loop.md` | Add a short subsection (`### 4.4` or extend `### 4.3`) explaining that every Anthropic call now uses the streaming API server-side, with the SDK aggregating to a final Message that the loop consumes. Note that this removes the 10-minute non-streaming ceiling and is invisible to the client (no SSE yet). |

---

## Implementation Steps

### 1. Add the streaming-aware retry helper

- In `web/lib/agent.ts`, modify `createBetaWithRetry`:
  - Inside the `try` block, replace the `.create()` call with `const stream = client.beta.messages.stream(params, { signal })` followed by `const resp = await stream.finalMessage()`.
  - Cast `resp` to `Anthropic.Messages.Message` at the same boundary the current code uses.
  - Leave the entire retry loop / error filter / prompt-too-long short-circuit / AbortError re-throw untouched.
  - Update the docstring to call out the change: streaming is the only way to bypass the SDK's 10-min non-streaming limit; aggregating server-side keeps downstream consumers unchanged.

### 2. Verify type compatibility

- Confirm that the SDK's `client.beta.messages.stream(params)` accepts the exact same `MessageCreateParamsBase`-shaped object the existing code passes. If the type narrows to `MessageCreateParamsStreaming`, the SDK sets `stream: true` internally so the caller doesn't need to. If a cast is required at the call site, add one with a comment explaining why.
- Confirm the returned object has `finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage>` (or equivalent) and that the structural cast to `Anthropic.Messages.Message` still works the same way as for the current `.create()` return.

### 3. Add the test helper

- Create `web/test/helpers/mock-beta-stream.ts`:
  - Export `mockBetaStream(message: unknown)`: returns an object with `finalMessage: () => Promise.resolve(message)` and an empty `[Symbol.asyncIterator]` so tests that happen to iterate the stream don't blow up. Type the return value loosely (`unknown` or a small inline interface) since each test casts the SDK mock to a permissive shape anyway.
  - Add a short docstring explaining the helper exists to keep test mocks aligned with the production streaming path without each file re-implementing the wrapper.

### 4. Migrate each test mock file

For every test file in the table above:
  - Import `mockBetaStream` from the new helper.
  - Replace `betaCreateMock.mockResolvedValue(message)` with `betaCreateMock.mockReturnValue(mockBetaStream(message))`.
  - Replace `betaCreateMock.mockImplementationOnce(async (params) => responseFor(params))` with `betaCreateMock.mockImplementationOnce((params) => mockBetaStream(responseFor(params)))` (note: `.stream()` is **not** async — it returns the stream object synchronously; awaits happen on the stream's events / `finalMessage()`).
  - If the mock factory currently mocks both `messages = { create: betaCreateMock }` AND `beta = { messages: { create: betaCreateMock } }`, also mock `beta = { messages: { stream: betaCreateMock } }` (or alias the same fn).
  - Tests that read the captured call params (`capturedBetaCalls[0]`, `mock.calls[0][0]`) work unchanged — `.stream()` is called with the same params object.

### 5. Add new regression test file

- Create `web/test/agent-streaming.test.ts`:
  - Five cases covering the contract pinned in Key Design Decisions: (a) production code calls `stream()` not `create()`; (b) the aggregated message reaches the caller unchanged; (c) AbortSignal is forwarded; (d) mid-stream rejection retries identically to request-time rejection; (e) prompt-too-long errors short-circuit retries.

### 6. Run the full suite

- `npm run typecheck`, `npm run lint`, `npm run test`. Fix any test files that I missed in the migration sweep (any file that mocks `beta.messages.create` and expects a Promise-returning mock).

### 7. Docs

- Append a `### 4.X Streaming for long requests` subsection to `docs/agent-loop.md` under section 4: explain the 10-min SDK ceiling, the always-stream + server-aggregate approach, what's invisible to the client today, and what the future "stream to client" follow-up would change.

### 8. Manual verification

- Spin up `npm run dev`. Trigger a known-long skill (the production failure path was a skill invocation). Watch logs: no more "Streaming is required" error, even on turns that previously ran past 10 min.
- Verify a normal short chat turn still works — same response shape, same token-usage logging.
- Verify cancellation: open a long-running turn, hit the stop button in the chat UI, confirm the AbortSignal propagates and the request aborts cleanly.
- Verify a scheduled-task run: the runner's `AbortSignal.timeout(maxSec * 1000)` should fire and cancel the stream identically.

---

## Verification

1. `npm run typecheck` — clean (cron-parser pre-existing warning unchanged).
2. `npm run lint` — clean (ApiKeysSection pre-existing warning unchanged).
3. `npm run test` — all suites pass, including the new `agent-streaming.test.ts`.
4. Manual: long skill invocation that previously failed at the 10-min mark now completes (or fails on a different error — never the SDK's non-streaming guard).
5. Manual: cancel button in the chat UI aborts an in-flight stream within ~1s.
6. Manual: scheduled-task run hits its `maxDurationSeconds` timeout and surfaces `result: "timeout"` exactly as it does today (no `(Request was aborted.)` regression).
7. Post-deploy: monitor logs for 24h for any `finalMessage()` rejection patterns that don't match today's `messages.create` error surface (mid-stream errors are a new class).

---

## Out of Scope (deferred to follow-up plans)

- **Stream tokens through to the client (SSE).** Requires changes to the
  agent API route, the chat UI's response renderer, and the conversation-
  store write path (we currently persist a complete assistant message).
  Big UX win, separate change.
- **Switch `createWithRetry` (stable API) to streaming.** That helper now
  only powers `summarizeConversation` with Sonnet — short, well under
  10 min. Adding stream support is a small cleanup but not load-
  bearing.
- **Stream-aware token-usage events.** Today the `token_usage` event
  fires once per turn with the final aggregated counts. Streaming
  could surface partial usage during long turns, useful for live cost
  monitoring on big skill runs. Separate plan.
- **`effort` tuning for skills.** Opus 4.8 defaults to `effort: high`;
  skills are high-autonomy and might benefit from `xhigh`. Increases
  token usage. Already on the Opus 4.8 follow-up list.
