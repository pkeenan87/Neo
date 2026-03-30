# Spec for Enhanced Observability Logging

branch: claude/feature/enhanced-observability-logging

## Summary

Enrich Neo's structured logging to support leadership dashboards, usage analytics, and security alerting. The current logger sends structured JSON to Azure Event Hubs (read by Cribl into Log Analytics), but logs are missing critical context: user display names are hashed object IDs instead of readable names, token usage isn't consistently attached to user/session context, tool invocations don't carry the full picture (user, role, channel, duration), and skill usage isn't logged at all.

This feature enriches every log event with a consistent identity envelope (username, role, provider, channel), adds dedicated event types for dashboarding (tool execution summaries, token consumption, skill invocations, destructive action audit, budget threshold alerts), and introduces a second Event Hub topic for high-volume analytics events to keep the existing operational log table lean.

## Functional Requirements

### 1. Consistent Identity Envelope on Every Log Event
- Every log entry sent to Event Hub should include a top-level `identity` object with:
  - `userName` — the human-readable display name (e.g., "Patrick Keenan"), NOT the hashed object ID. This is the `name` field from `ResolvedAuth`.
  - `userIdHash` — the hashed AAD object ID (keep for correlation, as today)
  - `role` — "admin" or "reader"
  - `provider` — "entra-id" or "api-key"
  - `channel` — "web", "cli", or "teams"
  - `sessionId` — current session UUID
- The logger currently accepts arbitrary metadata per call. Instead of requiring every callsite to pass identity fields, introduce a **logging context** that is set once per request and automatically merged into every log entry for that request's lifetime.
- The `userName` field should be the raw display name (NOT hashed) — this is intentional for dashboard readability. The `userIdHash` remains for privacy-safe correlation.

### 2. Tool Execution Event
- Emit a structured `tool_execution` event every time a tool completes (success or failure), containing:
  - All identity envelope fields
  - `toolName` — name of the tool executed
  - `toolCategory` — the integration it belongs to (e.g., "microsoft-defender-xdr", "appomni", "threatlocker")
  - `isDestructive` — boolean
  - `durationMs` — wall-clock execution time in milliseconds
  - `status` — "success" or "error"
  - `errorMessage` — if status is "error", the error message (truncated to 500 chars)
- This replaces the current ad-hoc `logger.info("Tool call: ${name}")` pattern in the agent loop

### 3. Token Usage Event
- Emit a structured `token_usage` event after each Claude API call, containing:
  - All identity envelope fields
  - `model` — the Claude model used
  - `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`
  - `estimatedCostUsd` — estimated cost for this call
  - `conversationId` — for grouping by conversation
  - `turnNumber` — which turn in the agent loop this represents
- This consolidates the current scattered token logging into a single, dashboardable event

### 4. Skill Invocation Event
- Emit a structured `skill_invocation` event when a skill is triggered, containing:
  - All identity envelope fields
  - `skillId` — the skill identifier
  - `skillName` — human-readable skill name
  - `durationMs` — execution time
  - `status` — "success" or "error"

### 5. Destructive Action Audit Event
- Emit a dedicated `destructive_action` event when a destructive tool is confirmed and executed, containing:
  - All identity envelope fields
  - `toolName` — the destructive tool
  - `toolInput` — sanitized input (with PII fields hashed)
  - `confirmed` — boolean (true if user confirmed, false if cancelled)
  - `justification` — the user-provided justification string
- This event type enables targeted alerting in Cribl/Sentinel for destructive actions

### 6. Budget Threshold Alert Event
- Emit a `budget_alert` event when a user approaches or exceeds their token budget, containing:
  - All identity envelope fields
  - `windowType` — "2-hour" or "weekly"
  - `budgetLimit` — the configured limit
  - `currentUsage` — current usage in the window
  - `percentUsed` — percentage of budget consumed
  - `action` — "warning" (approaching limit) or "blocked" (exceeded limit)
- This enables proactive alerting before users are blocked

### 7. Dual Event Hub Topics
- Introduce a second Event Hub topic (e.g., `neo-analytics`) for high-volume events: `tool_execution`, `token_usage`, `skill_invocation`
- Keep the existing `neo-logs` topic for operational events: `destructive_action`, `budget_alert`, errors, warnings, and existing operational logs
- New env vars: `EVENT_HUB_ANALYTICS_CONNECTION_STRING`, `EVENT_HUB_ANALYTICS_NAME` (optional — if not configured, all events go to the single existing topic)
- The logger should route events by type: analytics events → analytics topic, operational events → operational topic

### 8. Event Type Field
- Add a top-level `eventType` field to every log entry to enable easy filtering in Log Analytics:
  - `"operational"` — existing logs (info, warn, error from current callsites)
  - `"tool_execution"` — tool completed
  - `"token_usage"` — API call token consumption
  - `"skill_invocation"` — skill triggered
  - `"destructive_action"` — destructive tool confirmed/cancelled
  - `"budget_alert"` — budget threshold crossed

### 9. Update SAFE_METADATA_FIELDS Allowlist
- Add new fields to the allowlist: `userName`, `channel`, `toolCategory`, `isDestructive`, `durationMs`, `status`, `conversationId`, `turnNumber`, `skillId`, `skillName`, `confirmed`, `justification`, `windowType`, `budgetLimit`, `currentUsage`, `percentUsed`, `eventType`, `toolInput`

## Possible Edge Cases

- `userName` may be undefined for API key auth (use the key's `label` as fallback, which is already what `ResolvedAuth.name` returns)
- Teams thread sessions have synthetic owner IDs (`teams-thread:{conversationId}`) — `userName` should resolve to the actual Teams user's display name from the activity context, not the synthetic ID
- If the analytics Event Hub is not configured, all events should gracefully fall back to the single topic — no errors, no data loss
- High-volume tool execution events during heavy usage could increase Event Hub costs — the buffering/batching already in place (50 entries / 5s flush) mitigates this
- `toolInput` in destructive action events must be sanitized: hash any fields that match known PII patterns (upn, email, hostname) before logging
- `durationMs` for tool execution should use `performance.now()` or `Date.now()` delta, not rely on external timing

## Acceptance Criteria

- [ ] Every log event to Event Hub includes `identity.userName`, `identity.role`, `identity.provider`, `identity.channel`, `identity.sessionId`, `identity.userIdHash`
- [ ] `tool_execution` events emitted for every tool call with duration, status, and integration category
- [ ] `token_usage` events emitted after each Claude API call with full token breakdown
- [ ] `skill_invocation` events emitted when skills are triggered
- [ ] `destructive_action` events emitted with sanitized input and justification
- [ ] `budget_alert` events emitted at warning and blocked thresholds
- [ ] All events have an `eventType` field for Log Analytics filtering
- [ ] Optional dual Event Hub topic routing works (analytics vs. operational)
- [ ] Falls back to single topic gracefully when analytics hub not configured
- [ ] `userName` is human-readable (not hashed) in all events
- [ ] Existing console logging behavior unchanged
- [ ] No regression in existing log callsites

## Open Questions

- Should we emit a `session_started` / `session_ended` event pair for session lifecycle tracking in dashboards? yes.
- What percentage threshold should trigger a `budget_alert` warning (e.g., 80% of limit)? 80%
- Should `toolInput` in destructive action events include all input fields or just the key identifiers (e.g., upn, hostname, indicator value)? just key identifiers.
- Is there a preference for the analytics Event Hub topic name (e.g., `neo-analytics` vs. `neo-telemetry`)? neo-analytics

## Testing Guidelines

Create test files in `./test/` for the enhanced logging:

- Logger context: setting identity context applies to all subsequent log calls
- Event type routing: analytics events routed to analytics topic, operational to operational topic
- Fallback: all events go to single topic when analytics hub not configured
- Identity envelope: every event includes all required identity fields
- PII handling: `userName` is raw, `userIdHash` is hashed, `toolInput` PII fields are hashed
- SAFE_METADATA_FIELDS: new fields are in the allowlist
- Duration measurement: `durationMs` is a positive number
