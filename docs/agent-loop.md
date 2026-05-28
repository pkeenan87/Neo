# Neo's Agentic Loop — End-to-End

This document walks through what happens between the moment a user sends a message and the moment Neo finishes its turn. It's written as a learning guide: each section names the files, shows the meaningful snippets, and calls out the safeguards, persistence writes, and compression behaviors that keep the loop reliable.

The CLI (`cli/`) is a thin REPL wrapper around the same web API, so this guide focuses on `web/`. CLI-specific quirks are noted inline where they matter.

---

## Mental Model

```
                        ┌─────────────────────────────────────┐
                        │ POST /api/agent  (or /api/agent/    │
                        │       confirm for resume)           │
                        └──────────────┬──────────────────────┘
                                       │
   ┌───────────────────────────────────┴────────────────────────────────────┐
   │                              SAFEGUARDS                                │
   │  resolveAuth → injection-guard.scanUserInput → checkBudget →           │
   │  createReservation (pessimistic, 8K input tokens)                      │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │  runAgentLoop()     │◀─────────────────┐
                            │  (web/lib/agent.ts) │                  │
                            └──────────┬──────────┘                  │
                                       │                             │
                  ┌────────────────────▼────────────────────┐        │
                  │ prepareMessages()                       │        │
                  │   • truncate tool_results > 50K tok     │        │
                  │   • Haiku-compress middle if > 140K tok │        │
                  └────────────────────┬────────────────────┘        │
                                       │                             │
                  ┌────────────────────▼────────────────────┐        │
                  │ Anthropic.messages.create()             │        │
                  │   • cache_control on system + tools     │        │
                  │   • createWithRetry: 429/5xx/529 only   │        │
                  └────────────────────┬────────────────────┘        │
                                       │                             │
                ┌──────────────────────┼──────────────────────┐      │
                │                      │                      │      │
        stop_reason ==          stop_reason ==        DESTRUCTIVE_TOOLS
          "end_turn"             "tool_use"            tool seen?     │
                │                      │                      │      │
                ▼                      ▼                      ▼      │
       return text       executeTool() → wrapAndMaybe   return       │
       to caller         OffloadToolResult() → push     "confirmation│
                         tool_result; continue ─────────────────────►│
                                       │                  required" │
                                       └──────────────────────────────┘
                                                         │
                                                         ▼
                                            POST /api/agent/confirm
                                            → resumeAfterConfirmation()
                                            → re-enters runAgentLoop

   ┌────────────────────────────────────────────────────────────────────────┐
   │                            PERSISTENCE                                 │
   │  DispatchingSessionStore.update() → CosmosV2 split-doc write +         │
   │  promoteOffloadedBlobsIn() → Cosmos points at blobs/<sha256>           │
   │  recordUsage() (fire-and-forget) → deleteReservation() in finally      │
   └────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Request Entry & Identity

`web/app/api/agent/route.ts` is the single entry point for new turns. The first thing it does is resolve auth and gate the entire handler behind it.

```ts
// web/app/api/agent/route.ts:28
export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  return withStoreModeFromRequest(request, identity, () =>
    handleAgentPost(request, identity),
  );
}
```

`withStoreModeFromRequest` is the v1/v2 storage-mode switch (see §8). Every read and write inside the handler will see the mode pinned by this wrapper, regardless of the global `NEO_CONVERSATION_STORE_MODE` env var — that lets a single user opt into v2 via header for canarying.

The body parser handles two shapes:

```ts
// web/app/api/agent/route.ts (handleAgentPost, ~line 60)
if (isMultipartRequest(request)) {
  const { fields, files } = await parseMultipart(request);
  body = { message: fields.message ?? "", sessionId: fields.sessionId, ... };
  attachedFiles = files;
} else {
  body = await request.json();
}
```

Multipart is for CSV/file attachments. File contents never get JSON-stringified into the prompt — they're stored separately and referenced by `csvAttachments` on the session document.

---

## 2. Safeguards Before the Loop

### 2.1 Injection guard on user input

`web/lib/injection-guard.ts` runs before the message is appended to the conversation. It's regex-based and intentionally conservative — it counts pattern matches and only blocks in `strict` mode when 2+ patterns trigger, so a single ambiguous phrase logs a warning without rejecting the request.

```ts
// web/lib/injection-guard.ts:43
const USER_INPUT_PATTERNS: PatternEntry[] = [
  { pattern: /(?:ignore|disregard|forget)\s+(?:your|previous|prior|all)\s+instructions/i,
    label: "instruction_override" },
  { pattern: /you\s+are\s+now\s+(?!investigating|analyzing|reviewing)(?:an?\s+)?\w+/i,
    label: "persona_reassignment" },
  { pattern: /new\s+(?:system\s+)?prompt:/i, label: "system_prompt_injection" },
  { pattern: /\[SYSTEM\]|^SYSTEM:/im,        label: "system_header_injection" },
  // …
];
```

Two scan surfaces exist:
- `scanUserInput()` runs against what the human typed.
- `wrapAndMaybeOffloadToolResult()` runs against every value returned from a tool, wrapping it in a `_neo_trust_boundary` envelope before the model ever sees it (§6.2).

### 2.2 Token-budget check (fail fast)

Two rolling windows are enforced per user, both keyed off Cosmos DB:

```ts
// web/lib/usage-tracker.ts:239
const [twoHour, weekly] = await Promise.all([
  getUserUsageWithReset(userId, USAGE_LIMITS.twoHourWindow.windowMs, "two-hour"),
  getUserUsageWithReset(userId, USAGE_LIMITS.weeklyWindow.windowMs, "weekly"),
]);

if (twoHourExceeded) return { allowed: false, exceededWindow: "two-hour", ... };
if (weeklyExceeded)  return { allowed: false, exceededWindow: "weekly",   ... };
```

If exceeded, the route returns **HTTP 429** with a window-specific message *before* the agent loop runs. The `ENABLE_USAGE_LIMITS` env flag lets ops disable enforcement while still tracking — useful for soft-launches.

### 2.3 Pessimistic reservation (DB write #1)

Once the budget passes, the route writes a *reservation document* to Cosmos. This is the first DB write of the request:

```ts
// web/lib/usage-tracker.ts:83
const doc: UsageRecord = {
  id: reservationId,
  userId, sessionId, model,
  usage: { input_tokens: RESERVATION_ESTIMATE_TOKENS, output_tokens: 0 }, // 8,000
  timestamp: new Date().toISOString(),
  ttl: DEFAULT_TTL,
};
await container.items.create(doc);
```

This protects against race conditions where a user fires several parallel requests under their cap, but each one individually would exceed it once the others land. The reservation is **deleted in the `finally` block** of the route handler and replaced by real usage records (see §9).

---

## 3. Session Hydration

`session-factory.ts` returns a `DispatchingSessionStore` whose mode is pinned by the AsyncLocalStorage context from `withStoreModeFromRequest`. The route calls `sessionStore.get(sessionId)` (or `.create(...)` for new conversations) and back comes a `Session` object holding the message history, role, channel, model preference, pending confirmation, and CSV attachments.

```ts
// web/lib/session-factory.ts:103
async get(id: string): Promise<Session | undefined> {
  const mode = getActiveStoreMode();
  if (mode === "v2") return this.v2.get(id);
  if (mode === "dual-read") {
    const v2Result = await this.v2.get(id);
    if (v2Result) return v2Result;
    return this.v1.get(id);   // graceful fallback during cutover
  }
  return this.v1.get(id);
}
```

The session is read-through; messages are returned to the agent loop as a flat `Message[]` regardless of whether they live in v1's single document or v2's split documents.

---

## 4. The Agent Loop Core

`runAgentLoop` in `web/lib/agent.ts` is a `while (true)` that calls Claude, dispatches tool calls, and exits on either `end_turn` or a destructive tool. It carries six things into each iteration: messages, role (RBAC), session ID, model, abort signal, and options.

### 4.1 Setup & cache markers

Tools are filtered to the user's role and (optionally) a per-skill allowlist, then the **last** tool gets a `cache_control: { type: "ephemeral" }` marker so the entire prefix ends up in Anthropic's prompt cache:

```ts
// web/lib/agent.ts:~165
let filteredTools = getToolsForRole(role).filter((tool) => {
  if (tool.name === "query_csv" && !hasCsvAttachments) return false;
  if (toolAllowlist && !toolAllowlist.has(tool.name)) return false;
  return true;
});

const cachedTools = filteredTools.map((tool, i) =>
  i === filteredTools.length - 1
    ? { ...tool, cache_control: { type: "ephemeral" as const } }
    : tool
);
```

The system prompt gets the same treatment one block down:

```ts
// web/lib/agent.ts:255
const systemBlock: CacheableTextBlock = {
  type: "text",
  text: systemPrompt,
  cache_control: { type: "ephemeral" },
};
```

`max_tokens` per turn is resolved by `resolveMaxTokens(model, { skillInvocation })` — skills get 24,576 tokens, plain chat gets 16,384 (raised from 4,096 in early 2026 to stop long publisher / hunt / digest responses from truncating mid-output), both clamped to the model's published ceiling (`MODEL_OUTPUT_CEILINGS`: 32K Opus 4.6/4.7, 64K Sonnet 4.6, 8K Haiku). The clamp emits a one-time warning per `(model, budget-type)` pair so misconfigurations surface in logs.

**Per-conversation model selection.** The user picks a context tier before the first message (web: `<ContextTierSelector>` next to the send button; CLI: `neo --context 1m`). The selected model id is sent in `body.model`, persisted on the conversation root as `session.model`, and locked thereafter — the agent route reads `session.model` on every subsequent turn and ignores any divergent `body.model` (logged as a warn). Default is `claude-sonnet-4-6`; the opt-in 1M tier is `claude-opus-4-7[1m]`, which `createWithOptionalMcp` automatically routes through the beta API with the `context-1m-2025-08-07` header.

### 4.2 Context preparation (compression safeguard)

Every iteration starts with `prepareMessages()`. It does two jobs:

```ts
// web/lib/agent.ts:249
const prepared = await prepareMessages(localMessages, lastInputTokens, systemPromptTokenEstimate);
if (prepared.trimmed && callbacks.onContextTrimmed) {
  callbacks.onContextTrimmed(prepared.originalTokens, prepared.newTokens, prepared.method!);
}
```

**Job 1 — per-tool-result truncation.** Any single `tool_result` block above `PER_TOOL_RESULT_TOKEN_CAP` (default 50K) gets sliced inline with a marker pointing the agent at `get_full_tool_result`:

```ts
// web/lib/context-manager.ts:~80
const truncated = truncateToolResult(tr.content, capTokens);
if (truncated !== tr.content) {
  anyTruncated = true;
  return { ...tr, content: truncated };
}
```

**Job 2 — Haiku-powered rolling compression.** If the conversation estimate exceeds the active tier's `trimTriggerThreshold` (standard tier: 140K; 1M tier: 800K), the middle slice is sent to Haiku for a structured summary. The anchor (first user message) and the last 10 messages are preserved verbatim:

```ts
// web/lib/context-manager.ts (compressOlderMessages)
const response = await anthropicClient.messages.create({
  model: HAIKU_MODEL,
  max_tokens: 4096,                       // ← raised from 1024 so the
                                          //   IDENTIFIERS section can list
                                          //   every IP/UPN/hash verbatim
  system: HAIKU_COMPRESSION_SYSTEM_PROMPT, // demands a two-section output:
                                          //   ## IDENTIFIERS  (one per line,
                                          //   no aggregation — every IP,
                                          //   UPN, hostname, alert ID, file
                                          //   hash, URL, KQL table, tool
                                          //   name)
                                          //   ## NARRATIVE   (≤10 bullets,
                                          //   "(unverified)" marker on any
                                          //   finding without direct
                                          //   evidence in the conversation)
  messages: [...validatedMiddle, { role: "user", content: "Please summarise the conversation above using the IDENTIFIERS-first format from the system prompt." }],
});

const summaryMessage: Message = {
  role: "user",                            // ← user-role with system_notice
  content:                                 //   envelope (NOT a disguise as
    `<system_notice type="context_compressed" dropped_messages="${droppedCount}">\n` +
    `This block is a system-generated lossy summary of ${droppedCount} earlier ` +
    `conversation messages that were dropped to fit the context window. ` +
    `It is NOT the user's words. Treat it as a reminder of what was ` +
    `investigated, NOT as authoritative evidence.\n\n` +
    summaryText +
    `\n</system_notice>`,
};
```

Three safeguards worth memorizing:

1. **`<system_notice>` envelope, not an `assistant` impersonation.** The earlier design used `role: "assistant"` to "prevent injection", but that caused the downstream model to read the lossy bullet summary as its OWN remembered reasoning and confidently extrapolate specifics that weren't in the summary — the root cause of post-compaction hallucinations. The new design is a `user`-role message wrapped in `<system_notice type="context_compressed">`, and the system prompt explicitly teaches the model to treat the envelope as a lossy reminder and offer to re-run rather than infer specifics from it. Same trust-boundary pattern the org-context injection uses.
2. **Compression-failure notice is explicit, not casual.** When Haiku itself fails, the fallback isn't a casual `[Earlier context removed — key findings may need to be re-investigated]` line anymore; it's a `<system_notice type="context_compression_failed">` block with the instruction *"You have NO record of what was discussed before this point. ASK THE USER to restate the relevant findings. Do NOT infer or invent details."*
3. **Emergency progressive truncation.** If the post-Haiku result *still* exceeds the ceiling, a second loop drops the oldest preserved messages pair-aware (so a `tool_use` is never separated from its `tool_result`) until the budget is met or only `anchor + summary + 1 recent` remains.

**1M-tier behaviour.** When the active conversation's model is `claude-opus-4-7[1m]`, `getContextBudget(model)` returns the 1M-tier thresholds (900K ceiling, 800K trim trigger, 500K anchor cap, 100K per-tool-result cap). Compression still runs through the same `compressOlderMessages` path, but normal investigations rarely cross 800K so the Haiku call typically never fires.

`validateAndRepairConversationShape()` runs *before* the Haiku call to catch orphaned tool blocks — this is the fix for the "tool_use ids were found without tool_result blocks" bug recorded in `_plans/checkpoint-compaction.md`.

### 4.3 The API call & retry policy

```ts
// web/lib/agent.ts:50
const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503]);

async function createWithRetry(params, signal) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try { return await client.messages.create(params, { signal }); }
    catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      const status = (err as { status?: number }).status;
      if (status === 400) { /* deterministic — never retry */ throw … }
      // exponential backoff on retryable, otherwise rethrow
    }
  }
}
```

Three things to notice:
- **400 errors are never retried.** If Claude says "prompt too long," we bubble it up immediately so the user sees a "start a new session" message instead of three identical failures.
- **AbortError propagates.** The user clicking "Stop" must take effect within the current API call.
- **`signal?.aborted` is also checked at the top of every loop iteration** (line 244), so abort wins even between iterations.

Token usage is recorded every iteration (in-memory) and an `onUsage` callback fires for the SSE stream:

```ts
// web/lib/agent.ts:283
const usage: TokenUsage = {
  input_tokens: response.usage.input_tokens,
  output_tokens: response.usage.output_tokens,
  cache_creation_input_tokens: usageRaw.cache_creation_input_tokens,
  cache_read_input_tokens: usageRaw.cache_read_input_tokens,
};
logger.emitEvent("token_usage", "API usage", "agent", { …, model });
```

### 4.4 Stop-reason dispatch

```ts
// web/lib/agent.ts:301
if (response.stop_reason === "end_turn") {
  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text).join("\n");
  return { type: "response", text, messages: localMessages };
}

if (response.stop_reason === "tool_use") {
  // … see §5
}
```

There's also a third early-exit for **non-executable tools** like `respond_with_triage_verdict` — these are tool schemas where the `tool_use` block itself *is* the structured output. The check happens before any execution to prevent partial side-effects when Claude mixes a regular tool and a non-executable tool in the same turn.

---

## 5. Tool Execution & the Confirmation Gate

### 5.1 The destructive set

```ts
// web/lib/tools.ts:1369
export const DESTRUCTIVE_TOOLS = new Set([
  "reset_user_password", "dismiss_user_risk",
  "isolate_machine", "unisolate_machine",
  "report_message_as_phishing",
  "approve_threatlocker_request", "deny_threatlocker_request",
  "set_maintenance_mode", "schedule_bulk_maintenance",
  "enable_secured_mode",
  "block_indicator", "import_indicators", "delete_indicator",
  "remediate_abnormal_messages",
  "action_ato_case", "action_appomni_finding",
]);
```

If you add a tool that mutates external state, this set is the only place it has to be registered for the confirmation gate to apply.

### 5.2 Pause when destructive

When the loop hits a destructive tool, it must do three things atomically: (a) stop executing the rest of this turn's tools, (b) rewrite the assistant message so persisted state is structurally valid, and (c) capture any tool results from non-destructive tools that already ran in this turn so they can be replayed on resume.

```ts
// web/lib/agent.ts:345
if (DESTRUCTIVE_TOOLS.has(name)) {
  const lastAssistantIdx = localMessages.length - 1;
  const destructiveContentIdx = response.content.findIndex(
    (b) => b.type === "tool_use" && b.id === id,
  );
  // Drop tool_use blocks AFTER the destructive one — otherwise they'd be
  // persisted with no matching tool_result and the next API call would fail.
  localMessages[lastAssistantIdx] = {
    role: "assistant",
    content: response.content.slice(0, destructiveContentIdx + 1),
  };
  return {
    type: "confirmation_required",
    tool: { id, name, input, preExecutedResults: [...toolResults] },
    messages: localMessages,
  };
}
```

The route persists the pending tool on the session root and returns to the client. The audit trail captures any *additional* destructive tools that got silently dropped — those become a `destructive_action_dropped` log event for ops review.

### 5.3 Resume after confirmation

`POST /api/agent/confirm` is its own endpoint with its own auth check, and it carries three layers of validation:

```ts
// web/app/api/agent/confirm/route.ts:27
const pendingTool = await sessionStore.clearPendingConfirmation(body.sessionId);
if (!pendingTool) return 400 ("No pending confirmation");

if (pendingTool.id !== body.toolId) {
  // Mismatch — re-arm the pending tool so the user can retry,
  // and reject this confirm.
  await sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
  return 409 ("Tool ID mismatch");
}

if (!canUseTool(session.role, pendingTool.name)) {
  // Role downgrade between request and confirm? Re-arm and refuse.
  await sessionStore.setPendingConfirmation(body.sessionId, pendingTool);
  return 403 ("Forbidden");
}
```

A successful confirm emits a `destructive_action` audit event with hashed PII before resuming the loop:

```ts
// web/app/api/agent/confirm/route.ts:103
logger.emitEvent("destructive_action", `Destructive tool ${body.confirmed ? "confirmed" : "cancelled"}: ${pendingTool.name}`, "api/confirm", {
  toolName: pendingTool.name,
  confirmed: body.confirmed,
  justification: …,
  toolInput: JSON.stringify({
    ...(typeof toolInput.upn === "string" && { upn: hashPii(toolInput.upn) }),
    ...(typeof toolInput.value === "string" && { value: "[redacted]" }),
    // …
  }),
});
```

`resumeAfterConfirmation` then either executes the tool or synthesizes a "User cancelled" tool_result, attaches the `preExecutedResults` from the original turn, and recurses into `runAgentLoop`:

```ts
// web/lib/agent.ts:616
if (confirmed) {
  const result = await executeTool(name, input, { sessionMessages: localMessages, csvAttachments });
  // … success/error toolResult …
} else {
  toolResult = { type: "tool_result", tool_use_id: id,
    content: JSON.stringify({ cancelled: true, message: "User cancelled this action." }) };
}
const preExecuted = pendingTool.preExecutedResults ?? [];
localMessages.push({ role: "user", content: [...preExecuted, toolResult] });
return runAgentLoop(localMessages, callbacks, role, sessionId, model, undefined, options);
```

### 5.4 Non-destructive tool execution

For everything not in `DESTRUCTIVE_TOOLS`, the tool runs inline. Both success and error paths flow through the same `wrapAndMaybeOffloadToolResult` (see §6.2) so the model never sees a raw, unwrapped external payload:

```ts
// web/lib/agent.ts:419
const toolStart = Date.now();
try {
  const result = await executeTool(name, input, { sessionMessages: localMessages, csvAttachments });
  toolResults.push({
    type: "tool_result", tool_use_id: id,
    content: await wrapAndMaybeOffloadToolResult(name, result, { sessionId, conversationId: sessionId }),
  });
} catch (err) {
  toolResults.push({
    type: "tool_result", tool_use_id: id,
    content: await wrapAndMaybeOffloadToolResult(name, errorOutput, { … }),
    is_error: true,
  });
}
```

Each completion logs a `tool_execution` event with `durationMs`, `toolName`, `toolCategory`, `isDestructive: false`, and `status`.

---

## 6. Tool Implementations

### 6.1 The mock/live dual path

Every executor in `web/lib/executors.ts` checks `env.MOCK_MODE` first. This is what makes local dev and CI possible without Azure credentials:

```ts
// web/lib/executors.ts:120
async function run_sentinel_kql({ query, timespan = "PT24H" }): Promise<unknown> {
  if (env.MOCK_MODE) return mockSentinelKql(query);

  const token = await getAzureToken("https://api.loganalytics.io");
  const workspaceId = await getToolSecret("SENTINEL_WORKSPACE_ID");
  if (!workspaceId) throw new Error("Missing SENTINEL_WORKSPACE_ID. Configure via /integrations or .env");

  const res = await fetch(`https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, timespan }),
  });
  if (!res.ok) throw new Error(`Sentinel KQL query failed (${res.status}): ${await res.text()}`);
  return await res.json();
}
```

Pattern to repeat when adding a tool:
1. Schema → `web/lib/tools.ts`
2. Implementation → `web/lib/executors.ts` (mock + live branches)
3. Register in the `executors` map at the bottom of the file
4. If destructive → add to `DESTRUCTIVE_TOOLS`
5. If role-restricted → add to the role's allowlist in `web/lib/permissions.ts`

### 6.2 Trust boundaries on tool output

`wrapAndMaybeOffloadToolResult` is where every tool result picks up its trust envelope. This is *the* defense against indirect prompt injection — a malicious actor can't smuggle "ignore your instructions" into an alert's description and have Claude read it as a system instruction, because the entire payload is wrapped:

```ts
// web/lib/injection-guard.ts:185
export async function wrapAndMaybeOffloadToolResult(toolName, result, context) {
  const wrapped = wrapToolResult(toolName, result, { sessionId: context.sessionId });
  // wrapped is a JSON string with { _neo_trust_boundary: { source: "external_api",
  //   tool: toolName, injection_detected: bool }, data: <result> }

  const { maybeOffloadToolResult } = await import("./tool-result-blob-store");
  const outcome = await maybeOffloadToolResult(wrapped, {
    conversationId: context.conversationId, sourceTool: toolName, mediaType: context.mediaType,
  });

  if (typeof outcome === "string") return outcome;   // below threshold

  // Above 256 KB — outcome is a BlobRefDescriptor. Re-wrap it so the v2 store
  // recognizes this descriptor as server-generated (source: "tool_offload").
  return JSON.stringify({
    _neo_trust_boundary: { source: "tool_offload", tool: toolName, injection_detected: false },
    data: outcome,
  }, null, 2);
}
```

The `_neo_trust_boundary` envelope is also why the system prompt explicitly tells Claude that tool output is untrusted external data — the model is trained to recognize the marker.

### 6.3 Blob offload (DB write #2 — Azure Blob Storage)

When a single tool result exceeds `NEO_BLOB_OFFLOAD_THRESHOLD_BYTES` (default 256 KB), it gets pushed to Azure Blob Storage and replaced by a small descriptor. This is what stops Cosmos DB from blowing past its 2 MB document limit on long incidents.

```ts
// web/lib/tool-result-blob-store.ts:153
export async function maybeOffloadToolResult(wrappedJson, ctx): Promise<string | BlobRefDescriptor> {
  const sizeBytes = Buffer.byteLength(wrappedJson, "utf8");
  if (sizeBytes < NEO_BLOB_OFFLOAD_THRESHOLD_BYTES) return wrappedJson;

  const sha256   = sha256Hex(wrappedJson);
  const blobName = `staging/${sha256}`;     // ← uploaded to staging/
  await container.getBlockBlobClient(blobName)
    .uploadData(Buffer.from(wrappedJson, "utf8"), { blobHTTPHeaders: { blobContentType: "application/json" } });

  return {
    _neo_blob_ref: true,
    sha256, sizeBytes, mediaType, sourceTool, conversationId,
    rawPrefix: truncateRawPrefix(wrappedJson),    // first 280 chars for debugging
    uri: `${container.url}blobs/${sha256}`,        // ← but descriptor points at blobs/
  };
}
```

The two-phase write — upload to `staging/`, descriptor pointing at `blobs/` — is critical:

1. The Cosmos write happens with a descriptor pointing at `blobs/<sha256>`, which doesn't exist yet.
2. After Cosmos commits successfully, `promoteOffloadedBlobsIn()` (in `conversation-store-v2.ts`) moves the blob from `staging/` to `blobs/`.
3. If Cosmos fails, `staging/` is garbage-collected via blob TTL — no orphaned `blobs/` entries to clean up.

The same hash means the same blob: identical tool results across conversations dedupe naturally, but each conversation gets its own `BlobRefDoc` for retention bookkeeping.

The reverse path is `get_full_tool_result(tool_use_id)` — the agent calls it when it needs to read a truncated or offloaded value. Reads are capped at `NEO_BLOB_RESOLVE_MAX_BYTES` (default 20 MB).

---

## 7. Persistence: Conversation Store v2

This is the area that changed most recently — see `_plans/conversation-storage-split-blob-offload.md` for the full design.

### 7.1 The split-document schema

A conversation in v2 is **not** one Cosmos document. It's:

| Document | Purpose | Partition key |
|---|---|---|
| `ConversationV2Root` | Title, metadata, pending confirmation, rolling summary, model, CSV attachments | `/conversationId` |
| `TurnDoc` (one per message) | One Anthropic-shaped message; `content` may be a `BlobRefDescriptor` for offloaded results | `/conversationId` |
| `BlobRefDoc` (per offload) | Metadata for an offloaded tool result; lives independently for retention/audit | `/conversationId` |
| `CheckpointDoc` (future, compaction) | Pre-summarized turn ranges; reduces input tokens on long sessions | `/conversationId` |

The shapes:

```ts
// web/lib/types.ts:324
export interface ConversationV2Root {
  id: string;  docType: "root";  conversationId: string;  ownerId: string;
  title: string | null;
  createdAt: string;  updatedAt: string;
  role: Role;  channel: Channel;
  schemaVersion: 2;
  retentionClass: RetentionClass;
  turnCount: number;
  latestCheckpointId: string | null;
  rollingSummary: string | null;
  pendingConfirmation: PendingTool | null;
  model?: string;  ttl?: number;  csvAttachments?: CSVReference[];
}

export interface TurnDoc {
  id: string;  docType: "turn";  conversationId: string;
  turnNumber: number;                      // 1-based
  role: "user" | "assistant";
  content: unknown;                         // Anthropic content block array
  parentTurnId: string | null;
  inputTokens: number;  outputTokens: number;
  toolsUsed?: string[];  interrupted?: boolean;  truncated?: boolean;
  createdAt: string;  ttl?: number;
}
```

Why split? Two big reasons:
- **Cosmos document size limit** — long incidents would blow past 2 MB before the split; now each turn is its own doc, capped by the 256 KB blob offload.
- **Per-turn retention & audit** — `BlobRefDoc` and `CheckpointDoc` can have their own TTLs and audit lineage without rewriting the whole conversation.

### 7.2 Splitting on write

```ts
// web/lib/conversation-store-v2.ts:146
export function splitConversationToDocs(conv: Conversation): {
  root: ConversationV2Root; turns: TurnDoc[]; blobRefs: BlobRefDoc[]; checkpoints: CheckpointDoc[];
} {
  const retentionClass = NEO_RETENTION_CLASS_DEFAULT;
  const ttl            = resolveRetentionTtlSeconds(retentionClass);

  const root = { /* …conv metadata… */, schemaVersion: 2, turnCount: conv.messages.length, ttl };
  const turns = conv.messages.map((msg, idx) => ({
    id: turnDocId(conv.id, idx + 1), docType: "turn",
    conversationId: conv.id, turnNumber: idx + 1,
    role: msg.role, content: msg.content,
    parentTurnId: idx > 0 ? turnDocId(conv.id, idx) : null,
    inputTokens: 0, outputTokens: 0, createdAt: conv.createdAt, ttl,
  }));
  return { root, turns, blobRefs: [], checkpoints: [] };
}
```

The `BlobRefDoc[]` is empty here — it's populated by `promoteOffloadedBlobsIn()` after the split, by walking each turn's `content` for `_neo_blob_ref` markers and emitting a corresponding `BlobRefDoc` for each one.

### 7.3 Merging on read

```ts
// web/lib/conversation-store-v2.ts:212
export function rebuildConversationFromDocs({ root, turns }) {
  const sorted   = [...turns].sort((a, b) => a.turnNumber - b.turnNumber);
  const messages = sorted.map((t) => ({ role: t.role, content: t.content as Message["content"] }));

  return {
    id: root.id, ownerId: root.ownerId,
    title: root.title, createdAt: root.createdAt, updatedAt: root.updatedAt,
    messageCount: root.turnCount, role: root.role, channel: root.channel,
    messages, pendingConfirmation: root.pendingConfirmation,
    model: root.model, ttl: root.ttl, csvAttachments: root.csvAttachments,
  };
}
```

Notice: blob descriptors are *not* hydrated here. They stay as `_neo_blob_ref` markers in `content`. Hydration happens lazily — only when the agent calls `get_full_tool_result` or when the chat UI renders an expandable tool block.

### 7.4 Mode dispatch

`web/lib/conversation-store-mode.ts` exposes four modes for the v1→v2 cutover:

| Mode | Reads from | Writes to |
|---|---|---|
| `v1` | v1 only | v1 only |
| `dual-write` | v1 only | v1 + v2 (mirror) |
| `dual-read` | v2 → v1 fallback | v1 + v2 |
| `v2` | v2 only | v2 only |

The mode can be pinned per-request via the `X-Neo-Conversation-Store-Mode` header, which `withStoreModeFromRequest` reads into AsyncLocalStorage. This is how a single user gets canaried to v2 without flipping the global env.

### 7.5 Retention

```ts
// web/lib/retention.ts
const RETENTION_TTL_SECONDS: Record<RetentionClass, number> = {
  "ephemeral":   60 * 60 * 24 * 7,        // 7 days
  "standard":    60 * 60 * 24 * 30,       // 30 days
  "long-lived":  60 * 60 * 24 * 90,       // 90 days
  "audit":       60 * 60 * 24 * 365,      // 1 year
};
```

Every document type carries a `ttl` and Cosmos handles deletion. The migration script (`web/scripts/migrate-cosmos-v1-to-v2.ts`) reads v1 docs, runs them through `splitConversationToDocs`, and bulk-writes the v2 docs in the same partition.

---

## 8. Persistence Sequence Per Turn

Putting §6–7 together, here's the full sequence of writes for a successful turn that includes an offloaded tool result:

```
1. Cosmos: usage reservation (8K input tokens, deleted in finally)         ← §2.3
2. Blob:   staging/<sha256>           (oversized tool result)              ← §6.3
3. Cosmos: ConversationV2Root (updatedAt, turnCount, pendingConfirmation)  ← §7.2
4. Cosmos: TurnDoc(turnNumber=N)      (content includes blob descriptor)
5. Cosmos: BlobRefDoc                  (audit lineage)
6. Blob:   staging/<sha256> → blobs/<sha256>   (promotion)                 ← §6.3
7. Cosmos: usage records (one per Anthropic API call this turn)            ← §9
8. Cosmos: reservation deleted                                              ← §9
```

If anything fails between steps 3 and 6, the staging blob has its own short TTL and the Cosmos transaction either commits or rolls back atomically per document. The "orphan" failure modes are bounded.

---

## 9. Usage Reconciliation

After the loop returns (`type: "response"` or after streaming the last token), the route fires off the actual usage records, then deletes the reservation:

```ts
// web/app/api/agent/route.ts:525
for (const usage of accumulatedUsage) {
  void recordUsage(identity.ownerId, sessionId, model, usage);
}
// (deleteReservation runs in the route's finally block)
```

`accumulatedUsage` is a list — one entry per Anthropic API call inside this turn (compression Haiku calls included). They're written fire-and-forget so a Cosmos hiccup doesn't break the response stream. If they fail, the reservation's TTL still bounds the over-counting.

`emitEvent("token_usage", …)` from §4.3 is what feeds the per-user dashboard at `/settings → Usage`.

---

## 10. Hydration on Reload

When the chat UI loads `GET /api/conversations/:id`, the same dispatching store returns the merged shape. The renderer in `web/components/ChatInterface` walks `messages` and:

- Renders text blocks as markdown.
- For `tool_use` blocks, shows the tool name + collapsed input.
- For `tool_result` blocks, parses the JSON envelope. If `_neo_blob_ref: true`, it renders a "Click to load full result" affordance that lazy-fetches via the same `get_full_tool_result` mechanism the agent uses.
- For pending confirmations (root metadata), renders the confirm/cancel UI with the audit form.

The CSS is already covered in `CLAUDE.md` — the only thing peculiar to this flow is that **the UI never trusts `rawPrefix`**: it's a debugging affordance, may contain raw PII, and has to go through the same render-time scrubbing as any tool output.

---

## Reference: Safeguards Cheat Sheet

| # | Safeguard | Where | Purpose |
|---|---|---|---|
| 1 | `resolveAuth` gate | `app/api/agent/route.ts:30` | Reject unauthenticated requests at the door |
| 2 | `scanUserInput` (regex injection patterns) | `lib/injection-guard.ts:149` | Flag/block user-side prompt injection |
| 3 | Two-window rolling budget | `lib/usage-tracker.ts:checkBudget` | Prevent runaway spend; HTTP 429 |
| 4 | Pessimistic reservation | `lib/usage-tracker.ts:createReservation` | Race-safe budget under parallel requests |
| 5 | `prepareMessages` per-result truncation (50K) | `lib/context-manager.ts:truncateToolResults` | Stop one huge alert from poisoning context |
| 6 | Haiku-powered rolling compression (140K) | `lib/context-manager.ts:compressOlderMessages` | Stay under 180K hard ceiling |
| 7 | Compression role = `assistant`, not `user` | `lib/context-manager.ts:summaryRole` | Block injection-via-summary |
| 8 | Emergency progressive truncation | `lib/context-manager.ts` (post-compression while-loop) | Last-resort guarantee under threshold |
| 9 | `validateAndRepairConversationShape` | `lib/context-manager.ts` (pre-Haiku) | Avoid orphaned `tool_use`/`tool_result` |
| 10 | `createWithRetry` 400/abort policy | `lib/agent.ts:52` | Never retry deterministic errors; honor cancellation |
| 11 | Per-iteration abort check | `lib/agent.ts:244` | "Stop" button takes effect mid-turn |
| 12 | Confirmation gate on `DESTRUCTIVE_TOOLS` | `lib/agent.ts:345` | Human in the loop for state-changing actions |
| 13 | Trailing-tool-block rewrite | `lib/agent.ts:349`–`352` | Persisted state remains structurally valid |
| 14 | Confirm endpoint: tool ID match | `app/api/agent/confirm/route.ts:51` | Prevent confused-deputy on resume |
| 15 | Confirm endpoint: re-check `canUseTool(role)` | `app/api/agent/confirm/route.ts:66` | RBAC re-evaluation on resume |
| 16 | `destructive_action` audit event w/ hashed PII | `app/api/agent/confirm/route.ts:103` | Compliance trail |
| 17 | `MOCK_MODE` dual path on every executor | `lib/executors.ts` (every tool) | Safe local/CI without Azure creds |
| 18 | `_neo_trust_boundary` wrap on every tool result | `lib/injection-guard.ts:wrapToolResult` | Tool-side prompt injection defense |
| 19 | `TOOL_RESULT_PATTERNS` (extends user patterns) | `lib/injection-guard.ts:43` | Catch external-data-specific attacks (privilege grants, containment suppression) |
| 20 | Two-phase blob offload (`staging/` → `blobs/`) | `lib/tool-result-blob-store.ts` + `conversation-store-v2.ts:promoteOffloadedBlobsIn` | No orphan `blobs/` on Cosmos failure |
| 21 | `NEO_BLOB_RESOLVE_MAX_BYTES` cap on read-back | `lib/config.ts` | Bound memory for `get_full_tool_result` |
| 22 | TTL on every doc type (`retention.ts`) | `lib/retention.ts` | Auto-deletion per retention class |

---

## Reference: Database Writes Per Turn

| Order | Store | Write | Trigger |
|---|---|---|---|
| 1 | Cosmos `usage` | `UsageRecord` reservation (8K tokens, TTL'd) | Before agent loop |
| 2 | Blob `neo-tool-results` | `staging/<sha256>` upload (only if result > 256 KB) | Inside `wrapAndMaybeOffloadToolResult` |
| 3 | Cosmos `neo-conversations-v2` | `ConversationV2Root` upsert | After loop returns / on confirmation gate |
| 4 | Cosmos `neo-conversations-v2` | `TurnDoc` upserts (one per appended message) | Same write batch as root |
| 5 | Cosmos `neo-conversations-v2` | `BlobRefDoc` upsert per offloaded result | After turn write |
| 6 | Blob `neo-tool-results` | `staging/<sha256>` → `blobs/<sha256>` move | After Cosmos commit (`promoteOffloadedBlobsIn`) |
| 7 | Cosmos `usage` | `UsageRecord` per Anthropic API call (incl. Haiku compression calls) | Fire-and-forget after loop |
| 8 | Cosmos `usage` | reservation delete | Route handler `finally` block |

In `dual-write` mode, steps 3–5 also mirror to the v1 single-document store.

---

## Reference: Configuration Knobs

The complete list lives in `docs/configuration.md`. The ones that directly shape this loop:

| Env var | Default | What it controls |
|---|---|---|
| `NEO_CONTEXT_MAX_INPUT_TOKENS` | `180000` | Standard-tier hard ceiling — Anthropic API call must stay below. Auto-overridden to `NEO_CONTEXT_MAX_INPUT_TOKENS_1M` (900000) when the conversation's model id ends in `[1m]`. |
| `TRIM_TRIGGER_THRESHOLD` | `140000` | Standard-tier compression trigger. 1M-tier override: `TRIM_TRIGGER_THRESHOLD_1M` (default 800000). |
| `PER_TOOL_RESULT_TOKEN_CAP` | `50000` | Max tokens per single `tool_result` block in-flight (standard tier). 1M-tier override: `PER_TOOL_RESULT_TOKEN_CAP_1M` (default 100000). |
| `PERSISTENCE_TOOL_RESULT_TOKEN_CAP` | `10000` | Same, but for persisted form (smaller — favors readability). Not tiered. |
| `FIRST_MESSAGE_MAX_TOKENS` | `100000` | Standard-tier anchor-summary trigger. 1M-tier override: `FIRST_MESSAGE_MAX_TOKENS_1M` (default 500000). |
| `HAIKU_INPUT_MAX_TOKENS` | `160000` | Pre-trim cap for Haiku compression input. Not tiered — Haiku is still a 200K-window model. |
| `PRESERVED_RECENT_MESSAGES` | `10` | Tail kept verbatim during compression |
| `MAX_TOKENS_DEFAULT` | `16384` | Per-turn output budget for plain chat (raised from 4096) |
| `MAX_TOKENS_SKILL` | `24576` | Per-turn output budget for skill invocations |
| `CLAUDE_DEFAULT_MODEL` | `claude-sonnet-4-6` | Default tier when no explicit selection is made |
| `CLAUDE_OPUS_1M_MODEL` | `claude-opus-4-7[1m]` | Model id for the opt-in 1M-context tier |
| `NEO_CONVERSATION_STORE_MODE` | `v1` | One of `v1` / `dual-write` / `dual-read` / `v2` |
| `NEO_BLOB_OFFLOAD_THRESHOLD_BYTES` | `256000` | Above this, tool result moves to blob storage |
| `NEO_BLOB_RESOLVE_MAX_BYTES` | `20971520` | Cap for `get_full_tool_result` reads |
| `NEO_RETENTION_CLASS_DEFAULT` | `standard` | TTL class applied to new conversations |
| `NEO_TOOL_RESULT_BLOB_CONTAINER` | `neo-tool-results` | Azure Blob container for offloaded results |
| `NEO_CONVERSATIONS_V2_CONTAINER` | `neo-conversations-v2` | Cosmos container for split-doc conversations |
| `ENABLE_USAGE_LIMITS` | `true` | Track without blocking when `false` |
| `MOCK_MODE` | `true` | Tool executors return mock data; no Azure calls |

---

## Where to Read Next

- `_plans/conversation-storage-split-blob-offload.md` — design rationale and phase plan for v2.
- `_plans/checkpoint-compaction.md` — the in-flight follow-on that adds `CheckpointDoc` summarization.
- `docs/conversation-storage-v2-migration.md` — operational runbook for the v1→v2 cutover.
- `web/test/conversation-store-v2-schema.test.ts` — ground-truth examples of split/merge semantics.
- `web/test/agent-blob-offload-integration.test.ts` — end-to-end test of §6.3 plus §7.2.
