# Azure Event Hub Logging

## Context

The Neo web application has no structured logging — only scattered `console.warn` and `console.error` calls in a handful of files. For a security operations tool that executes destructive containment actions, this is an audit and compliance gap. This plan adds a structured logger module to the web project that sends JSON log events to Azure Event Hubs, plus a PowerShell provisioning script for the Event Hub infrastructure. All open questions from the spec have been resolved: web-only logger, 1-day retention, 2 partitions, allowlist-based field redaction, no consumer group provisioning.

---

## Key Design Decisions

- **Single logger module at `web/lib/logger.ts`** — no CLI logger; web-only per user decision. All files import from this single module.
- **Allowlist-based redaction** — only metadata fields on an explicit allowlist pass through to logs. Unknown fields are omitted rather than redacted. This is safer than a denylist because new sensitive fields cannot accidentally leak.
- **Dual sinks: Event Hub + console** — Event Hub is the durable sink; console output is always active in development (`MOCK_MODE=true` or `LOG_LEVEL=debug`) and can be disabled in production by setting `LOG_LEVEL=info` or higher.
- **Buffered batching** — log events are buffered in memory and flushed every 5 seconds or when the buffer reaches 50 events, whichever comes first. This avoids a network call per log line while keeping latency low.
- **Graceful degradation** — if `EVENT_HUB_CONNECTION_STRING` is not set, the logger operates in console-only mode with a single startup warning. If the Event Hub becomes unreachable at runtime, the logger logs the error once and continues with console output.
- **`@azure/event-hubs` as the SDK** — added to `web/package.json` and `serverExternalPackages` in `next.config.js`.
- **Provisioning script follows existing patterns** — matches `scripts/provision-azure.ps1` structure: parameterized, idempotent, validates prerequisites, outputs the connection string.
- **Instrumentation via explicit logger calls** — not monkey-patching `console.*`. Each instrumentation point gets a deliberate `logger.info(...)` or `logger.warn(...)` call with the appropriate component tag and metadata.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/logger.ts` | New — structured logger with Event Hub producer, console sink, buffering, flush, allowlist redaction |
| `web/lib/types.ts` | Add `EVENT_HUB_CONNECTION_STRING`, `EVENT_HUB_NAME`, `LOG_LEVEL` to `EnvConfig` |
| `web/lib/config.ts` | Add the three new env vars to the `env` object |
| `web/next.config.js` | Add `"@azure/event-hubs"` to `serverExternalPackages` |
| `.env.example` | Add `EVENT_HUB_CONNECTION_STRING`, `EVENT_HUB_NAME`, `LOG_LEVEL` with comments |
| `web/lib/agent.ts` | Add logger calls for agent loop start, tool call, confirmation gate, loop completion, and errors |
| `web/lib/executors.ts` | Add logger call in `executeTool` for tool execution start and error |
| `web/lib/session-store.ts` | Add logger calls for session creation, session expiry (in `sweep`), and pending confirmation set/clear |
| `web/lib/auth-helpers.ts` | Add logger calls for auth resolution success and failure across all three paths (API key, Entra token, Auth.js session) |
| `web/lib/teams-auth.ts` | Replace `console.warn` calls with `logger.warn` |
| `web/app/api/agent/route.ts` | Add logger calls for request received, session resolved, rate limit hit, and error |
| `web/app/api/agent/confirm/route.ts` | Add logger calls for confirmation received, ownership check, tool ID mismatch, permission denied, and result |
| `web/app/api/teams/messages/route.ts` | Add logger calls for message received, card submit, identity check, and replace `console.error` with `logger.error` |
| `web/lib/config.ts` (validateConfig) | Replace `console.warn` calls with `logger.warn` (or keep as console since logger depends on config — see step 3) |
| `scripts/provision-event-hub.ps1` | New — PowerShell script to create Event Hub Namespace, Hub, and Send-only auth rule |
| `web/package.json` | Add `@azure/event-hubs` dependency |

---

## Implementation Steps

### 1. Install the `@azure/event-hubs` dependency

- Run `cd web && npm install @azure/event-hubs`
- Add `"@azure/event-hubs"` to the `serverExternalPackages` array in `web/next.config.js` alongside the existing entries

### 2. Add environment variables to types and config

- In `web/lib/types.ts`, add to `EnvConfig`:
  - `EVENT_HUB_CONNECTION_STRING: string | undefined`
  - `EVENT_HUB_NAME: string | undefined`
  - `LOG_LEVEL: string | undefined`
- In `web/lib/config.ts`, add the three corresponding entries to the `env` object, reading from `process.env`
- In `.env.example`, add a new `# Logging` section with the three env vars and descriptive comments

### 3. Create `web/lib/logger.ts`

This is the core module. It must have zero import-time side effects that depend on the Event Hub being available (since config may not have the connection string set).

**Exports:**
- `logger` object with methods: `debug(message, component, metadata?)`, `info(...)`, `warn(...)`, `error(...)`
- `flushLogs(): Promise<void>` — manually flush the buffer (for graceful shutdown)

**Log entry interface:**
- Define a `LogEntry` interface with fields: `timestamp` (ISO 8601 string), `level` (`"debug" | "info" | "warn" | "error"`), `component` (string), `message` (string), `metadata` (record of string to unknown, optional)

**Level filtering:**
- Read `LOG_LEVEL` from `env` at first call (lazy init), defaulting to `"info"` when `MOCK_MODE` is false and `"debug"` when `MOCK_MODE` is true
- Define a numeric priority map: debug=0, info=1, warn=2, error=3
- Skip entries below the configured level

**Allowlist-based metadata redaction:**
- Define a `SAFE_METADATA_FIELDS` Set containing allowed field names: `sessionId`, `role`, `ownerId`, `provider`, `toolName`, `toolId`, `hostname`, `upn`, `platform`, `severity`, `status`, `messageCount`, `component`, `errorMessage`, `statusCode`, `method`, `action`, `conversationId`, `aadObjectId`
- Before serialization, filter the metadata object to only include keys present in the allowlist
- This means any new field added to a `logger.info` call must be explicitly added to the allowlist if it should appear in logs

**Console sink:**
- Always write to console when `MOCK_MODE` is true
- Always write to console when `LOG_LEVEL` is `"debug"`
- In production (MOCK_MODE=false, LOG_LEVEL != debug), only write `warn` and `error` to console
- Format: `[TIMESTAMP] LEVEL [COMPONENT] MESSAGE {metadata}` — use plain text, no chalk (web project doesn't have chalk as a dependency)

**Event Hub sink:**
- On first log call, lazily initialize an `EventHubProducerClient` using `EVENT_HUB_CONNECTION_STRING` and `EVENT_HUB_NAME` from `env`
- If either env var is missing, log a single console warning ("Event Hub logging disabled — connection string not configured") and operate in console-only mode
- Buffer log entries in an array
- Set up a `setInterval` timer (5000ms) to flush the buffer
- Also flush when the buffer reaches 50 entries
- Flush implementation: create an `EventDataBatch`, add each buffered entry as a JSON-serialized event body, send the batch, clear the buffer
- If `createBatch` or `sendBatch` fails, log the error to console once (avoid recursive logging), and discard the batch
- Export `flushLogs()` for graceful shutdown scenarios

**Process shutdown:**
- Register `process.on("SIGTERM", ...)` and `process.on("SIGINT", ...)` handlers that call `flushLogs()` then close the `EventHubProducerClient`
- Use a flag to prevent double-flush

### 4. Instrument `web/lib/agent.ts`

- Import `logger` from `"./logger"`
- In `runAgentLoop`:
  - At function entry: `logger.info("Agent loop started", "agent", { sessionId: <not available here — see note>, role })`
    - Note: `runAgentLoop` does not receive a `sessionId` parameter. Log the role only. The caller (route handlers) logs sessionId.
  - After each `onToolCall` callback: `logger.info("Tool called", "agent", { toolName: name })`
  - When a destructive tool triggers the confirmation gate: `logger.info("Confirmation required for destructive tool", "agent", { toolName: name, toolId: id })`
  - On `end_turn`: `logger.info("Agent loop completed", "agent")`
  - On unexpected `stop_reason`: `logger.error("Unexpected stop reason", "agent", { errorMessage: response.stop_reason })`
- In `resumeAfterConfirmation`:
  - When confirmed: `logger.info("Destructive tool confirmed", "agent", { toolName: name, toolId: id })`
  - When cancelled: `logger.info("Destructive tool cancelled", "agent", { toolName: name, toolId: id })`
  - On tool execution error: `logger.error("Tool execution failed after confirmation", "agent", { toolName: name, errorMessage: (err as Error).message })`

### 5. Instrument `web/lib/executors.ts`

- Import `logger` from `"./logger"`
- In `executeTool`:
  - At entry: `logger.debug("Executing tool", "executor", { toolName })`
  - If the tool function is not found: `logger.error("Unknown tool", "executor", { toolName })`

### 6. Instrument `web/lib/session-store.ts`

- Import `logger` from `"./logger"`
- In `create`: `logger.info("Session created", "session", { sessionId: id, role, ownerId })`
- In `get` when the session is expired and deleted: `logger.info("Session expired", "session", { sessionId: id })`
- In `setPendingConfirmation`: `logger.info("Pending confirmation set", "session", { sessionId: id, toolName: tool.name, toolId: tool.id })`
- In `clearPendingConfirmation`: `logger.info("Pending confirmation cleared", "session", { sessionId: id })`
- In `sweep` when deleting expired sessions: `logger.debug("Session swept", "session", { sessionId: id })`

### 7. Instrument `web/lib/auth-helpers.ts`

- Import `logger` from `"./logger"`
- In `resolveAuth`:
  - After successful API key lookup: `logger.info("Auth resolved via API key", "auth", { role: entry.role, provider: "api-key" })`
  - After successful Entra ID token verification: `logger.info("Auth resolved via Entra ID token", "auth", { role, provider: "entra-id" })`
  - After failed Entra ID token verification (when DEBUG): `logger.warn("Entra ID token verification failed", "auth", { provider: "entra-id" })` — replace or supplement the existing `console.error`
  - After invalid bearer token (falls through both paths): `logger.warn("Invalid bearer token", "auth", { provider: "unknown" })`
  - After successful Auth.js session: `logger.info("Auth resolved via Auth.js session", "auth", { role, provider: "entra-id" })`
  - When no auth at all: `logger.debug("No auth credentials provided", "auth")`

### 8. Instrument `web/lib/teams-auth.ts`

- Import `logger` from `"./logger"`
- Replace the three `console.warn` calls with equivalent `logger.warn` calls using component `"teams-auth"`
- Add a `logger.info` call on successful role resolution: `logger.info("Teams role resolved", "teams-auth", { role, aadObjectId })`

### 9. Instrument `web/app/api/agent/route.ts`

- Import `logger` from `"@/lib/logger"`
- After successful auth resolution: `logger.info("Agent request received", "api", { sessionId, role: identity.role, provider: identity.provider })`
- On rate limit hit: `logger.warn("Rate limit exceeded", "api", { sessionId })`
- In the async IIFE catch block: `logger.error("Agent loop error", "api", { sessionId, errorMessage: (err as Error).message })`

### 10. Instrument `web/app/api/agent/confirm/route.ts`

- Import `logger` from `"@/lib/logger"`
- After successful auth: `logger.info("Confirmation request received", "api", { sessionId: body.sessionId, toolId: body.toolId, action: body.confirmed ? "confirm" : "cancel" })`
- On ownership failure: `logger.warn("Confirmation ownership check failed", "api", { sessionId: body.sessionId })`
- On tool ID mismatch: `logger.warn("Confirmation tool ID mismatch", "api", { sessionId: body.sessionId, toolId: body.toolId })`
- On permission denied: `logger.warn("Confirmation permission denied", "api", { sessionId: body.sessionId, toolName: pendingTool.name })`
- In the async IIFE catch: `logger.error("Confirmation processing error", "api", { sessionId: body.sessionId, errorMessage: (err as Error).message })`

### 11. Instrument `web/app/api/teams/messages/route.ts`

- Import `logger` from `"@/lib/logger"`
- In Branch A (card submit):
  - When received: `logger.info("Teams card submit received", "teams-bot", { action, sessionId: neoSessionId })`
  - On identity failure: `logger.warn("Teams card submit identity verification failed", "teams-bot")`
  - On ownership failure: `logger.warn("Teams card submit ownership check failed", "teams-bot", { sessionId: neoSessionId })`
- In Branch B (regular message):
  - When received: `logger.info("Teams message received", "teams-bot", { aadObjectId, conversationId })`
  - On rate limit: `logger.warn("Teams rate limit exceeded", "teams-bot", { sessionId: resolvedSessionId })`
- Replace the `console.error` in the POST catch block with `logger.error("Adapter process error", "teams-bot", { errorMessage: (err as Error).message })`

### 12. Handle `web/lib/config.ts` console.warn calls

- The `console.warn` calls in `validateConfig()` run at import/startup time, before the logger is fully initialized (since logger imports config). Keep these as `console.warn` to avoid a circular dependency. Add a comment explaining why.

### 13. Create `scripts/provision-event-hub.ps1`

Follow the same structure as `scripts/provision-azure.ps1`:

**Parameters:**
- `$ResourceGroupName` — default `"neo-rg"` (same default as provision-azure.ps1)
- `$NamespaceName` — default `"neo-eventhub-ns"`, with validation pattern for Event Hub Namespace naming rules (lowercase alphanumeric + hyphens, 6-50 chars)
- `$EventHubName` — default `"neo-logs"`
- `$Location` — default `"eastus"`
- `$Sku` — validate set `"Basic"`, `"Standard"`, default `"Basic"`
- `$PartitionCount` — default `2`
- `$MessageRetentionDays` — default `1`
- `$AuthRuleName` — default `"neo-send-policy"`

**Prerequisites section:**
- Check Azure CLI installed
- Check logged in (`az account show`)
- Display subscription name and ask for confirmation (matching provision-azure.ps1 pattern)

**Resource creation section (idempotent):**
- Create resource group if not exists (`az group create`)
- Create Event Hub Namespace if not exists (`az eventhubs namespace create` with the SKU)
- Create Event Hub within the namespace if not exists (`az eventhubs eventhub create` with partition count and retention days)
- Create or update the shared access policy with Send rights only (`az eventhubs namespace authorization-rule create` with `--rights Send`)

**Output section:**
- Retrieve the connection string for the Send policy (`az eventhubs namespace authorization-rule keys list`)
- Print the connection string and Event Hub name in a format the admin can copy into `.env`
- Print a summary of all resources created

### 14. Update `.env.example`

- Add a new `# Logging (optional — for Azure Event Hub log shipping)` section
- Add `EVENT_HUB_CONNECTION_STRING=` with comment
- Add `EVENT_HUB_NAME=` with comment (default: neo-logs)
- Add `LOG_LEVEL=` with comment explaining valid values and defaults

---

## Verification

1. `cd web && npm run build` — zero TypeScript errors, all routes compile
2. Start dev server with `MOCK_MODE=true` and no Event Hub env vars — verify console-only logging works, no crashes, and the "Event Hub logging disabled" warning appears once
3. Send a message via the web UI — verify log entries appear in the console for: auth resolved, session created, agent loop started, tool called, agent loop completed
4. Trigger a destructive tool — verify confirmation_required, confirm/cancel, and tool execution are all logged
5. Send a message via Teams bot — verify Teams-specific log entries appear
6. Run `scripts/provision-event-hub.ps1` against an Azure subscription — verify namespace, hub, and auth rule are created, and the connection string is output
7. Set `EVENT_HUB_CONNECTION_STRING` and `EVENT_HUB_NAME` in `.env`, restart the dev server, send a message, and verify events appear in the Event Hub (use Azure Portal's "Process Data" feature or `az eventhubs eventhub consumer-group` to read)
8. Re-run the provisioning script — verify it completes idempotently without errors
9. Kill the dev server with SIGTERM — verify the "flushing logs" message appears and no events are lost
