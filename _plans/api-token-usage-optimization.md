# API Token Usage Optimization

## Context

The Neo security agent uses `claude-opus-4-5` for every main agent loop call, sends the full system prompt (~8,200 chars / ~2,050 tokens) uncached on every turn, and tracks only `input_tokens` from API responses. The user wants prompt caching, user-selectable model tiering (Sonnet vs Opus), system prompt compression, tool description trimming, improved context compression, and a full usage monitoring system with per-user rate limits (2-hour and 1-week windows) backed by Cosmos DB. All API calls originate from the web layer — the CLI proxies through the web server.

---

## Key Design Decisions

- **Prompt caching via `cache_control`**: Add `cache_control: { type: "ephemeral" }` to the system prompt block. The system prompt is ~2,050 tokens which exceeds Anthropic's 1,024-token minimum for caching. Tools array should also be cached since it's static per role.
- **User-selectable model, not automatic**: The user explicitly wants a toggle (Sonnet vs Opus) rather than automatic model routing. Default to Sonnet. Store preference per-session in the conversation document.
- **Do NOT phase-filter destructive tools**: The user noted that users may come with destructive prompts on the first message. Only filter by role (admin vs reader), not by investigation phase. Focus tool optimization on description trimming only.
- **Per-user token budgets in Cosmos DB**: Two rolling windows (2-hour and 1-week) with defaults matching a $100/month Claude Max plan. Store usage records in a separate Cosmos container (`usage-logs`) partitioned by `userId`.
- **Usage tracking is non-blocking**: Record usage asynchronously after each API call — never block the response stream waiting for a Cosmos write.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/agent.ts` | Add prompt caching (`cache_control`) to system prompt and tools. Accept `model` parameter. Track full usage (input + output + cache tokens). Pass usage to tracker after each call. |
| `web/lib/config.ts` | Add `DEFAULT_MODEL`, `TOKEN_PRICING`, and `USAGE_LIMITS` constants. Compress `BASE_SYSTEM_PROMPT` by ~20%. |
| `web/lib/context-manager.ts` | Update `CHARS_PER_TOKEN` from 4 to 3.5. No other changes needed. |
| `web/lib/tools.ts` | Trim tool descriptions by ~30% — remove redundant phrasing while keeping semantic clarity. |
| `web/lib/types.ts` | Add `TokenUsage`, `UsageRecord`, `UsageSummary`, `ModelPreference` interfaces. Add `model` field to `Conversation` type. |
| `web/lib/usage-tracker.ts` | **New file.** Record per-call usage to Cosmos DB. Query rolling windows. Check budget. Calculate cost estimates. |
| `web/lib/conversation-store.ts` | Add `model` field to conversation creation. Add usage container lazy init. |
| `web/lib/permissions.ts` | Add token budget limits to `RATE_LIMITS` (2-hour and 1-week token caps per role). |
| `web/lib/logger.ts` | Add token-related fields to `SAFE_METADATA_FIELDS` allowlist. |
| `web/app/api/agent/route.ts` | Add budget check before agent loop. Pass model preference from request/session to `runAgentLoop`. Stream usage summary event to client. |
| `web/app/api/usage/route.ts` | **New file.** GET endpoint returning usage summary for the authenticated user. |
| `web/test/context-manager.test.ts` | Update expected token estimates to reflect new 3.5 chars/token ratio. |
| `web/test/usage-tracker.test.ts` | **New file.** Tests for usage recording, budget checking, and cost calculation. |
| `web/test/prompt-caching.test.ts` | **New file.** Tests verifying cache_control is present in API call params. |
| `docs/user-guide.md` | Add model selection docs, usage limits/budgets section, usage API endpoint. Update rate limits table. Add `usage` NDJSON event to stream events reference. |
| `docs/configuration.md` | Add `DEFAULT_MODEL` env var, `USAGE_LIMITS` constants table, usage-logs Cosmos container docs, provisioning instructions for the usage-logs container. |
| `scripts/provision-cosmos-db.ps1` | Add creation of the `usage-logs` container (partitioned by `/userId`, same TTL) as a new provisioning step. |

---

## Implementation Steps

### 1. Add types for usage tracking and model preference

In `web/lib/types.ts`:
- Add a `TokenUsage` interface with fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens` (optional), `cache_read_input_tokens` (optional).
- Add a `UsageRecord` interface with fields: `id`, `userId`, `sessionId`, `model`, `usage` (TokenUsage), `timestamp`, `ttl`.
- Add a `UsageSummary` interface with fields: `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `callCount`, `estimatedCostUsd`.
- Add `model?: string` as an optional field on the `Conversation` interface.
- Add `ModelPreference` type: `"claude-opus-4-5" | "claude-sonnet-4-5-20250514"`.
- Add an `AgentEvent` variant for `usage` that includes `TokenUsage` data so the client can display it.

### 2. Add constants for pricing, budgets, and default model

In `web/lib/config.ts`:
- Add a `DEFAULT_MODEL` constant set to `"claude-sonnet-4-5-20250514"`.
- Add a `SUPPORTED_MODELS` record mapping display names to model IDs for the two user-selectable options.
- Add a `TOKEN_PRICING` record with per-model input/output cost per 1K tokens (Opus: $15/$75, Sonnet: $3/$15, Haiku: $0.80/$4 per million tokens).
- Add `USAGE_LIMITS` constants for the two rolling windows. Default caps should approximate what a $100/month Claude Max plan allows. Calculate based on Sonnet pricing as the default model: roughly 6.6M input tokens or 1.3M output tokens per month. Split into 2-hour window (~55K input tokens) and 1-week window (~1.65M input tokens). These are starting defaults that can be tuned.

### 3. Compress the system prompt

In `web/lib/config.ts`, edit `BASE_SYSTEM_PROMPT`:
- Remove the `## YOUR ROLE` header line (the content below it is sufficient).
- Condense the `## INVESTIGATION METHODOLOGY` section — merge the bullet list into a single paragraph.
- Remove "You think like a seasoned SOC analyst: methodical, evidence-based, and threat-focused." — the detailed instructions below already convey this.
- Condense `## RULES OF ENGAGEMENT` — the arrow notation and numbering can be simplified.
- Keep `## SECURITY OPERATING PRINCIPLES` fully intact — this is security-critical.
- Keep `## CONTEXT` and `## RESPONSE FORMAT` intact — they're already concise.
- Target: reduce from ~8,200 chars to ~6,500 chars (20% reduction) while preserving all behavioral instructions.

### 4. Trim tool descriptions

In `web/lib/tools.ts`:
- `run_sentinel_kql`: Remove the explicit table name list from description. The model knows Sentinel table names. Reduce from ~305 chars to ~120 chars.
- `get_sentinel_incidents`: Already concise, leave as-is.
- `get_xdr_alert`: Shorten "Retrieve full alert details from Microsoft Defender XDR or CrowdStrike Falcon. Includes process tree, file hashes, network connections, and timeline." to "Get full alert details from Defender XDR, including process tree, hashes, network, and timeline."
- `search_xdr_by_host`: Already concise, leave as-is.
- `get_user_info`: Shorten "Look up Entra ID / Azure AD user account details, MFA status, group memberships, recent devices, and risk level." to "Look up Entra ID user details: MFA, groups, devices, and risk level."
- Destructive tools: Keep full descriptions including the warning emoji — clarity matters for safety.
- `get_full_tool_result`: Already concise, leave as-is.

### 5. Enable prompt caching in the agent loop

In `web/lib/agent.ts`, modify the `createWithRetry` call in `runAgentLoop` (line 82-88):
- Change the `system` parameter from a plain string to an array containing a single content block with `type: "text"`, `text: systemPrompt`, and `cache_control: { type: "ephemeral" }`.
- Cache the tools array: wrap the last tool in the array with `cache_control: { type: "ephemeral" }` so the entire tools prefix is cached.
- Add `model` as a parameter to `runAgentLoop` (default to `DEFAULT_MODEL` from config).
- Replace the hardcoded `"claude-opus-4-5"` with the `model` parameter.

### 6. Track full usage from API responses

In `web/lib/agent.ts`:
- After each `createWithRetry` response (line 90), capture `response.usage.input_tokens`, `response.usage.output_tokens`, and the cache fields (`cache_creation_input_tokens`, `cache_read_input_tokens`) if present.
- Add an `onUsage` callback to `AgentCallbacks` interface in `web/lib/types.ts` so the route can stream usage data to the client.
- Call the `onUsage` callback after each API response with the usage data.
- In the `summarizeConversation` function (line 172), also capture and return usage from the Sonnet call.

In `web/lib/context-manager.ts`:
- After the Haiku compression call (line 126-138), log the usage from that response using the logger with the new safe metadata fields.

### 7. Create the usage tracker module

Create `web/lib/usage-tracker.ts`:
- Lazy-init a separate Cosmos container called `usage-logs` in the `neo-db` database, partitioned by `userId`.
- Implement `recordUsage(userId, sessionId, model, usage)` — creates a `UsageRecord` document with a 90-day TTL. This function should be fire-and-forget (catch and log errors, never throw).
- Implement `getUserUsage(userId, windowMs)` — queries Cosmos for all usage records for this user within the time window, aggregates into a `UsageSummary`.
- Implement `checkBudget(userId)` — calls `getUserUsage` for both the 2-hour and 1-week windows, compares against `USAGE_LIMITS`, returns `{ allowed: boolean, twoHourRemaining: number, weekRemaining: number, warning: boolean }`. Warning is true when either window is above 80% usage.
- Implement `calculateCost(model, usage)` — returns estimated USD cost using `TOKEN_PRICING`.
- All Cosmos queries should use parameterized queries with `@userId` and `@since` timestamp parameters.

### 8. Add budget check to the API route

In `web/app/api/agent/route.ts`:
- After rate limit check (line 80-86), add a token budget check by calling `checkBudget(identity.ownerId)`.
- If `allowed` is false, return a 429 response with a message indicating which limit was exceeded (2-hour or weekly) and when it resets.
- If `warning` is true, include a warning in the NDJSON stream so the client can display it.
- Accept `model` from the request body (validate it's one of the supported models) or fall back to the session's stored model preference, or `DEFAULT_MODEL`.
- Pass the model to `runAgentLoop`.
- After the agent loop completes, call `recordUsage` with the accumulated usage from that loop (fire-and-forget).
- Add a new `usage` NDJSON event type to stream the per-turn usage back to the client.

### 9. Add usage API endpoint

Create `web/app/api/usage/route.ts`:
- GET handler authenticated via `resolveAuth`.
- Call `getUserUsage(identity.ownerId, TWO_HOUR_MS)` and `getUserUsage(identity.ownerId, ONE_WEEK_MS)`.
- Return JSON with: `twoHourUsage`, `weeklyUsage`, `twoHourLimit`, `weeklyLimit`, `estimatedMonthlyCost`.
- This endpoint is read-only and available to all authenticated users.

### 10. Update the logger metadata allowlist

In `web/lib/logger.ts`, add these fields to `SAFE_METADATA_FIELDS`:
- `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `estimatedCostUsd`, `model`, `budgetRemaining`, `budgetWarning`.

### 11. Update token estimation heuristic

In `web/lib/context-manager.ts`:
- Change `CHARS_PER_TOKEN` from `4` to `3.5` for more accurate estimation.
- Update `estimateTokens` to use `Math.ceil(totalChars / 3.5)` — this is still a heuristic but closer to Claude's actual tokenizer.

### 12. Add model field to conversation storage

In `web/lib/conversation-store.ts`:
- Add `model` as an optional field to the `createConversation` function signature.
- Store it in the Conversation document so the model preference persists across page reloads within a session.

In `web/lib/types.ts`:
- Add `model?: string` to the `Conversation` interface (already planned in step 1).

### 13. Update existing tests

In `web/test/context-manager.test.ts`:
- Update the `estimateTokens` test expectations to match the new 3.5 chars/token ratio. For example, 1200 chars / 3.5 = 343 tokens (was 300 with divisor of 4).
- Update the `truncateToolResult` tests where the char cap is derived from `capTokens * CHARS_PER_TOKEN`.

### 14. Write new tests

Create `web/test/usage-tracker.test.ts`:
- Mock the Cosmos container.
- Test `recordUsage` creates a document with correct fields and TTL.
- Test `getUserUsage` aggregates multiple records correctly.
- Test `checkBudget` returns `allowed: false` when 2-hour limit exceeded.
- Test `checkBudget` returns `allowed: false` when weekly limit exceeded.
- Test `checkBudget` returns `warning: true` at 80% threshold.
- Test `calculateCost` returns correct USD values for each model.

Create `web/test/prompt-caching.test.ts`:
- Mock the Anthropic client.
- Call `runAgentLoop` with a simple message.
- Verify the `system` parameter passed to `client.messages.create` is an array with `cache_control`.
- Verify the last tool in the `tools` array has `cache_control`.

### 15. Update the Cosmos DB provisioning script

In `scripts/provision-cosmos-db.ps1`:
- Add a new parameter `-UsageContainerName` with default `"usage-logs"`.
- Add a new provisioning step (between the teams-mappings container and the role assignment) that creates the `usage-logs` container with partition key `/userId` and the same `$DefaultTtl` (90 days).
- Follow the existing idempotent pattern: check if the container exists first, skip if it does, create if it doesn't.
- Update the step counter in the `Write-Host` headers (currently "1/6" through "6/6") to reflect the new step count ("1/7" through "7/7").
- Add the container name to the summary output at the top of the script.

### 16. Update the user guide

In `docs/user-guide.md`:
- Add a new section **Model Selection** under "Using the CLI" (after "Managing Sessions") explaining that users can choose between Sonnet (default, faster, cheaper) and Opus (most capable) via the web UI toggle or by passing `model` in the API request body.
- Update the **Rate Limits** reference table to add token budget rows:
  - Two-hour token budget per user (with the configured default values)
  - Weekly token budget per user (with the configured default values)
  - Explain that when a budget is exceeded, the user receives a 429 error indicating which limit was hit and when it resets.
- Add a `usage` row to the **NDJSON stream events** table with fields `inputTokens`, `outputTokens`, `cacheReadTokens`, `model` and description "Per-turn token usage summary".
- Add the `GET /api/usage` endpoint to the **API Endpoints** table with description "Get token usage summary for the authenticated user (two-hour and weekly windows)".

### 17. Update the configuration guide

In `docs/configuration.md`:
- Add `DEFAULT_MODEL` to the **Environment Variables** table with description "Default Claude model for the agent loop. Options: `claude-sonnet-4-5-20250514` (default), `claude-opus-4-5`. Users can override per-session."
- Add a new subsection **Token Usage Budgets** under "Web Server Configuration" (after "CLI Downloads Storage") documenting:
  - The two rolling windows (2-hour and 1-week) and their default values.
  - That budgets are per-user and enforced before each agent loop call.
  - The 80% warning threshold.
  - That usage data is stored in the `usage-logs` Cosmos DB container.
  - How to tune the defaults by editing `USAGE_LIMITS` in `web/lib/config.ts`.
- Update the **Context window thresholds** table to add the `DEFAULT_MODEL` and `USAGE_LIMITS` constants.
- Add a new subsection **Usage Logs Container** under "Chat Persistence (Cosmos DB)" documenting:
  - The `usage-logs` container with partition key `/userId`.
  - That it stores per-API-call token usage records with 90-day TTL.
  - That the provisioning script (`provision-cosmos-db.ps1`) creates this container automatically.
- Update the `provision-cosmos-db.ps1` parameter table to include the new `-UsageContainerName` parameter.
- Update the script description to mention the `usage-logs` container alongside `conversations` and `teams-mappings`.

---

## Verification

1. Run `cd web && npx vitest run` — all existing tests pass with updated expectations.
2. Run the dev server with `MOCK_MODE=true` and send a multi-turn conversation. Check server logs for:
   - `cache_read_input_tokens > 0` on the second and subsequent turns.
   - Both `inputTokens` and `outputTokens` in log output.
   - Budget check logs with remaining token counts.
3. Verify the system prompt character count is under 6,600 characters (measure with `getSystemPrompt("reader").length`).
4. Verify the `/api/usage` endpoint returns valid JSON with usage summaries for the authenticated user.
5. Verify that sending `{ model: "claude-opus-4-5" }` in the agent request body uses Opus, and omitting it defaults to Sonnet.
6. Verify that when a budget limit is exceeded, the API returns 429 with a clear message about which limit was hit and when it resets.
7. Verify `scripts/provision-cosmos-db.ps1` creates the `usage-logs` container when run (test with `-WhatIf` or review the script output steps).
8. Verify `docs/user-guide.md` includes model selection, usage budget rate limits, `usage` NDJSON event, and `/api/usage` endpoint.
9. Verify `docs/configuration.md` includes `DEFAULT_MODEL` env var, token usage budgets section, usage-logs container docs, and updated provisioning parameter table.
