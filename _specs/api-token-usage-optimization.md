# Spec for API Token Usage Optimization

branch: claude/feature/api-token-usage-optimization

## Summary

The Neo agent currently burns through Anthropic API credits faster than necessary. This spec covers a full review and implementation of token-saving optimizations across both the CLI and web projects, targeting prompt caching, model tiering, system prompt compression, dynamic tool filtering, and usage monitoring.

## Functional requirements

### 1. Prompt Caching (Highest Priority)
- Enable Anthropic's `cache_control` parameter on the system prompt so it is cached across turns within a session
- The system prompt (~1,300 tokens) is currently sent in full on every API call with no caching — this is the single largest quick win
- Expected savings: 40–60% reduction in input tokens over a multi-turn session

### 2. Model Tiering
- Evaluate switching the main agent loop from `claude-opus-4-5` to `claude-sonnet-4-5` for standard investigation turns
- Reserve Opus for complex reasoning tasks only (e.g., multi-step incident correlation, generating final reports)
- Provide a configuration option (env var or per-session toggle) to select model tier
- Expected savings: 25–35% per turn when using Sonnet

### 3. System Prompt Compression
- Audit the current system prompt in `web/lib/config.ts` (~5,200 characters) for verbose or redundant content
- Remove explanatory phrasing that doesn't affect model behavior (e.g., "You are a helpful..." preamble that Claude already knows)
- Move optional skill instructions to lazy injection — only include admin skill text when the user has triggered a relevant action
- Expected savings: 15–20% on system prompt tokens

### 4. Dynamic Tool Filtering
- Currently all 8 tool schemas are sent on every API call regardless of investigation phase
- Implement phase-aware tool selection: only include destructive tools (`reset_user_password`, `isolate_machine`, `unisolate_machine`) when the agent signals readiness for containment actions - DO NOT DO THIS - users may come with destructive prompts on the first prompt
- Trim verbose tool descriptions by 30–40% without losing semantic clarity
- Expected savings: 5–10% on input tokens per turn

### 5. Earlier Context Compression
- The current 160K token threshold before compression is very high — most value is lost by then
- Evaluate lowering the compression trigger threshold or implementing incremental summarization (compress in smaller batches as conversation grows)
- Improve token estimation accuracy: current `chars ÷ 4` heuristic overestimates by ~12%; consider using the Anthropic token counting API or a closer heuristic (~3.5 chars/token)

### 6. Usage Monitoring Dashboard
- Track both `input_tokens` and `output_tokens` from every API response (currently only input is captured)
- Aggregate token usage per session and per user
- Surface a simple usage summary in the web UI (e.g., tokens consumed in current session, cost estimate)
- Log per-turn token counts to enable cost analysis over time

## Possible Edge Cases
- Prompt caching has a minimum token threshold (~1,024 tokens) — verify the system prompt meets it
- Model tiering may degrade quality for nuanced KQL generation or complex multi-hop reasoning — need quality benchmarks
- Aggressive tool filtering could cause the agent to request a tool it wasn't given — need graceful fallback
- Lowering compression thresholds too aggressively could lose critical investigation context mid-session
- Token estimation changes could cause compression to trigger too early or too late during the transition

## Acceptance Criteria
- Prompt caching is enabled and verifiable via API response headers (`cache_read_input_tokens` > 0 on subsequent turns)
- A model tier configuration option exists and defaults to Sonnet, with Opus available as an override
- System prompt is reduced by at least 20% in character count without removing any functional instructions
- Tool schemas are filtered based on user role and investigation phase
- Both input and output token counts are logged per API call
- A session-level token usage summary is visible in the web UI
- All existing tests continue to pass with no regression in agent behavior quality

## Open Questions
- Should model tiering be automatic (agent self-selects based on task complexity) or manual (user/admin configurable)? user configurable, let them toggle between sonnet and opus
- What is the acceptable quality threshold when using Sonnet vs Opus for KQL generation? Let the user select the model. I think the token savings vs the potential drop off in quality is not worth it
- Should token usage data be persisted to Cosmos DB for long-term cost tracking, or is in-memory per-session sufficient for v1? cosmos db
- Is there a budget/quota system needed per user or per tenant? per user. I would like two hour limits and 1 week limits similar to claude. I want the default limits to match a 100/month claude max plan.

## Testing Guidelines
Create test file(s) in the ./test folder for the new feature, and create meaningful tests for the following cases, without going too heavy:
- Verify prompt caching headers are present in API responses after the first turn
- Verify tool filtering correctly excludes destructive tools for reader role and includes them for admin role
- Verify token estimation function accuracy against known string lengths
- Verify usage tracking captures both input and output tokens
- Verify system prompt is under the target character count
- Verify model selection respects the tier configuration
