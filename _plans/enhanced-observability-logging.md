# Enhanced Observability Logging

## Context

Enriches Neo's structured logging to support leadership dashboards, usage analytics, and security alerting. The current logger sends JSON events to Azure Event Hubs (Cribl → Log Analytics) but lacks consistent user identity context (logs hashed IDs instead of names), dedicated event types for tool/token/skill/destructive actions, and session lifecycle events. This plan adds a logging context system, 6 new event types, an optional second Event Hub topic for analytics, and session started/ended events — all without breaking the existing log pipeline.

---

## Key Design Decisions

- **Request-scoped logging context via `AsyncLocalStorage`** — avoids threading identity through every function signature. Set once in the API route middleware, automatically merged into every log entry for the request lifetime. Node.js `AsyncLocalStorage` works in Next.js server-side code.
- **`userName` logged as raw display name (not hashed)** — intentional per spec for dashboard readability. `userIdHash` remains for privacy-safe correlation.
- **Event type routing with optional dual Event Hub** — analytics events (`tool_execution`, `token_usage`, `skill_invocation`, `session_started`, `session_ended`) go to `neo-analytics` topic if configured; operational events (`destructive_action`, `budget_alert`, existing logs) stay on `neo-logs`. Falls back to single topic gracefully.
- **`toolCategory` derived at log time from integration registry** — a simple lookup function that maps tool name → integration slug. Built once lazily from the `INTEGRATIONS` array's `capabilities` lists.
- **Duration timing via `Date.now()` deltas** — simple and sufficient for millisecond-resolution tool execution timing; no need for `performance.now()` in a server context.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `LogIdentityContext` interface |
| `web/lib/config.ts` | Add `EVENT_HUB_ANALYTICS_CONNECTION_STRING` and `EVENT_HUB_ANALYTICS_NAME` env vars |
| `web/lib/logger.ts` | Add `AsyncLocalStorage`-based context, `eventType` field, dual Event Hub routing, new `emitEvent()` method, update `SAFE_METADATA_FIELDS`, session events |
| `web/lib/integration-registry.ts` | Add `getToolIntegration(toolName)` lookup function |
| `web/lib/agent.ts` | Replace ad-hoc tool/token logging with structured event emissions, add timing around tool execution |
| `web/app/api/agent/route.ts` | Set logging context on request entry, emit `session_started` event, emit `budget_alert` events with percentage details, emit `skill_invocation` events with duration |
| `web/app/api/agent/confirm/route.ts` | Emit `destructive_action` event with sanitized input and justification on confirm/cancel |
| `web/app/api/teams/messages/route.ts` | Set logging context for Teams requests |
| `web/lib/session-store.ts` | Emit `session_ended` event when session expires |
| `web/lib/usage-tracker.ts` | Add percentage calculation helper, emit `budget_alert` at 80% threshold |
| `.env.example` | Add `EVENT_HUB_ANALYTICS_CONNECTION_STRING` and `EVENT_HUB_ANALYTICS_NAME` |
| `README.md` | Document new env vars in the environment variables section |
| `docs/user-guide.md` | Add observability/logging section describing event types |
| `test/enhanced-observability-logging.test.js` | New test file |

---

## Implementation Steps

### 1. Add `LogIdentityContext` type to `web/lib/types.ts`

- Add a new `LogIdentityContext` interface in the types file with fields: `userName` (string), `userIdHash` (string), `role` (Role), `provider` ("entra-id" | "api-key"), `channel` (Channel), `sessionId` (string)
- Export the interface

### 2. Add analytics Event Hub env vars to `web/lib/config.ts`

- Add `EVENT_HUB_ANALYTICS_CONNECTION_STRING: process.env.EVENT_HUB_ANALYTICS_CONNECTION_STRING` to the `env` object
- Add `EVENT_HUB_ANALYTICS_NAME: process.env.EVENT_HUB_ANALYTICS_NAME` to the `env` object
- Add corresponding fields to the `EnvConfig` interface in `types.ts` (both `string | undefined`)

### 3. Add `getToolIntegration()` to `web/lib/integration-registry.ts`

- Create a lazily-built `Map<string, string>` that maps each tool name to its integration slug, built from iterating `INTEGRATIONS` and flattening each entry's `capabilities` array
- Export a `getToolIntegration(toolName: string): string | null` function that returns the integration slug for a tool name, or `null` if not found (e.g., `get_full_tool_result`)

### 4. Major rewrite of `web/lib/logger.ts`

This is the core change. Modify the logger module in the following order:

#### 4a. Add AsyncLocalStorage context

- Import `AsyncLocalStorage` from `node:async_hooks`
- Import `LogIdentityContext` from `./types`
- Create a module-level `const logContext = new AsyncLocalStorage<LogIdentityContext>()`
- Export a `setLogContext(context: LogIdentityContext, fn: () => T): T` function that runs `fn` inside `logContext.run(context, fn)` — this lets API route handlers wrap their entire request processing in a context
- Export a `getLogContext(): LogIdentityContext | undefined` function for internal use

#### 4b. Add event types

- Define a `LogEventType` union type: `"operational" | "tool_execution" | "token_usage" | "skill_invocation" | "destructive_action" | "budget_alert" | "session_started" | "session_ended"`
- Add `eventType` as an optional field on `LogEntry` (defaults to `"operational"` for backward compatibility)
- Add `identity` as an optional field on `LogEntry` (auto-populated from `AsyncLocalStorage` context)

#### 4c. Update SAFE_METADATA_FIELDS

- Add all new fields to the allowlist: `userName`, `channel`, `toolCategory`, `isDestructive`, `durationMs`, `conversationId`, `turnNumber`, `skillId`, `skillName`, `confirmed`, `justification`, `windowType`, `budgetLimit`, `currentUsage`, `percentUsed`, `eventType`, `toolInput`

#### 4d. Add analytics Event Hub producer (optional dual sink)

- Add a second lazy-init producer: `_analyticsProducer` with its own `_analyticsBuffer`, `_analyticsFlushTimer`, initialized from `EVENT_HUB_ANALYTICS_CONNECTION_STRING` / `EVENT_HUB_ANALYTICS_NAME`
- Define which event types go to analytics: `tool_execution`, `token_usage`, `skill_invocation`, `session_started`, `session_ended`
- Define which go to operational: `destructive_action`, `budget_alert`, `operational` (existing logs)
- In the `log()` function, after building the entry, route it to the correct buffer based on `eventType`. If the analytics producer is not configured, all events go to the existing operational buffer (graceful fallback).

#### 4e. Modify core `log()` function

- After building the `LogEntry`, auto-populate `identity` from `logContext.getStore()` if available
- Set `eventType` to `"operational"` if not explicitly provided
- The identity fields should be merged into the top-level entry (not nested in metadata) for easy Log Analytics querying

#### 4f. Add `emitEvent()` public method

- Add a new method to the `logger` export: `emitEvent(eventType: LogEventType, message: string, component: string, metadata?: Record<string, unknown>): void`
- This bypasses level filtering (events are always emitted) and sets the `eventType` field on the entry
- Uses the same dual-sink routing based on event type

#### 4g. Update shutdown

- The `flushLogs()` function should flush both buffers and close both producers
- The `shutdown()` handler should call the updated `flushLogs()`

### 5. Update `web/lib/agent.ts` — tool execution events

- In `runAgentLoop()`, wrap each tool execution (lines 167–183) with timing: record `startMs = Date.now()` before `executeTool()`, compute `durationMs = Date.now() - startMs` after
- After each tool execution (success or error), call `logger.emitEvent("tool_execution", ...)` with metadata: `toolName`, `toolCategory` (from `getToolIntegration(name)`), `isDestructive` (from `DESTRUCTIVE_TOOLS.has(name)`), `durationMs`, `status` ("success" or "error"), `errorMessage` (if error, truncated to 500 chars)
- Remove the existing `logger.info("Tool call: ${name}")` line — it's replaced by the structured event
- Keep the `logger.info("Confirmation gate triggered")` line as-is (that's operational)

- Similarly update `resumeAfterConfirmation()` (lines 270–288): add timing around the `executeTool()` call and emit a `tool_execution` event

### 6. Update `web/lib/agent.ts` — token usage events

- Replace the existing `logger.info("API usage", ...)` block (lines 120–126) with `logger.emitEvent("token_usage", ...)` with metadata: `model`, `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `sessionId` (from function param), and add `estimatedCostUsd` (compute from the existing cost estimation logic in usage-tracker, or use a simple per-model rate)
- Keep the `callbacks.onUsage` call unchanged

### 7. Update `web/app/api/agent/route.ts` — set logging context and emit events

- At the top of the POST handler, after `resolveAuth()` succeeds, call `setLogContext()` wrapping the rest of the request handler. Pass: `userName: identity.name`, `userIdHash: hashPii(identity.ownerId)`, `role: identity.role`, `provider: identity.provider`, `channel: body.channel ?? "web"`, `sessionId` (resolve this after session creation)
- After session creation/resolution, emit `logger.emitEvent("session_started", ...)` with `sessionId` and `conversationId` (if resuming an existing conversation)
- For the budget exceeded case: enhance the existing `logger.warn("Token budget exceeded")` to also emit `logger.emitEvent("budget_alert", ...)` with `windowType`, `budgetLimit`, `currentUsage`, `percentUsed: 100`, `action: "blocked"`
- For the skill invocation: wrap the skill's agent loop with timing, emit `logger.emitEvent("skill_invocation", ...)` with `skillId`, `skillName`, `durationMs`, `status`
- Note: since `sessionId` is resolved mid-handler, the logging context should be set in two stages — initial context with a placeholder sessionId, then updated after session resolution. Alternatively, set the context after session resolution and accept that the few log lines before that point won't have the full context.

### 8. Update `web/app/api/agent/confirm/route.ts` — destructive action events

- After a destructive tool is confirmed or cancelled, emit `logger.emitEvent("destructive_action", ...)` with: `toolName`, `confirmed` (boolean), `justification` (from tool input), `toolInput` (sanitized — only include key identifier fields like `upn`, `hostname`, `indicator_value`, `computer_id`, hashing PII fields with `hashPii()`)
- Set the logging context at the top of the handler, same as the agent route

### 9. Update `web/app/api/teams/messages/route.ts` — set logging context

- At the point where identity is resolved (after AAD object ID extraction), set the logging context with: `userName` (from Teams activity `from.name`), `userIdHash: hashPii(aadObjectId)`, `role`, `provider: "entra-id"`, `channel: "teams"`, `sessionId`

### 10. Update `web/lib/usage-tracker.ts` — budget warning at 80%

- In `checkBudget()`, after computing `twoHourRemaining` and `weeklyRemaining`, calculate percentage used for each window
- If either window is at or above 80% but below 100% (i.e., `warning: true` in the current logic), emit `logger.emitEvent("budget_alert", ...)` with `windowType`, `budgetLimit`, `currentUsage`, `percentUsed`, `action: "warning"`
- The existing `warning` field on `BudgetResult` should already flag this; just add the event emission

### 11. Update `web/lib/session-store.ts` — session ended events

- In the `sweepExpired()` method of `InMemorySessionStore` (where sessions are swept), emit `logger.emitEvent("session_ended", ...)` with `sessionId`, `messageCount` from the expired session
- In the `delete()` method, also emit `session_ended`

### 12. Update `.env.example`

- Add under the existing Event Hub section:
  - `EVENT_HUB_ANALYTICS_CONNECTION_STRING=` with comment "Optional — separate Event Hub for analytics events. If omitted, all events go to the primary topic."
  - `EVENT_HUB_ANALYTICS_NAME=neo-analytics`

### 13. Update documentation

- **`README.md`**: Add the two new env vars to the Environment Variables section
- **`docs/user-guide.md`**: Add a new "Observability & Logging" section describing the 8 event types, what fields each contains, and how they map to Log Analytics tables

### 14. Add test file

- Create `test/enhanced-observability-logging.test.js` with the following test groups:
  - **SAFE_METADATA_FIELDS**: verify all new fields are in the allowlist (import and check the set, or replicate and assert)
  - **Event type routing**: analytics events (`tool_execution`, `token_usage`, `skill_invocation`, `session_started`, `session_ended`) identified correctly; operational events (`destructive_action`, `budget_alert`, `operational`) identified correctly
  - **Tool integration lookup**: `getToolIntegration("block_indicator")` returns `"microsoft-defender-xdr"`, `getToolIntegration("list_appomni_services")` returns `"appomni"`, `getToolIntegration("get_full_tool_result")` returns `null`
  - **Budget percentage**: 80% threshold correctly triggers warning, 100% triggers blocked
  - **PII handling**: `userName` is raw string, `userIdHash` is 16-char hex hash

---

## Verification

1. Run tests: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/enhanced-observability-logging.test.js`
2. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
3. Run existing test suites to verify no regressions: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/appomni-risk-analyzer.test.js test/threatlocker-maintenance-mode.test.js`
4. Manual verification: run `npm run dev` in the web directory, trigger a chat interaction, and inspect console output for the new event types and identity envelope
5. If Event Hub is configured: verify events appear in Log Analytics with the expected schema
