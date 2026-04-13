# Spec for alert-triage-api

branch: claude/feature/alert-triage-api
Source: Notion feature request — "Alert Triage API" (2026-04-12, High Impact)

## Summary

Add a new authenticated endpoint `POST /api/triage` to the Neo web app that accepts structured security alerts from external orchestrators (primarily Azure Logic Apps reacting to Sentinel, Defender XDR, Entra ID Protection, and Purview alerts), runs them through the appropriate Neo investigation skill, and returns a structured JSON verdict that the caller can act on — auto-closing benign alerts or escalating to analysts with Neo's reasoning and evidence attached.

This is tier-1 triage augmentation, not replacement. Neo's verdict is advisory, guardrails prevent auto-closure of anything medium+ severity, and every run is fully auditable in Cosmos DB. Paired with the future Scheduled Tasks feature (proactive hunting), this gives Neo both halves of the SOC workflow: reactive triage on demand, and proactive discovery on a cadence.

** User feedback. I am fine closing out alerts that are medium+ automatically

## Functional requirements

### Endpoint and authentication
- New route: `POST /api/triage` on the Next.js web app.
- Authentication: Entra ID app-only token via Managed Identity. Logic Apps authenticate as service principals against Neo's app registration. No user-interactive login — this is machine-to-machine.
- The endpoint must validate the Entra token, extract the caller identity (app ID / service principal name), and log it on every run.

### Request contract
- The request body carries three top-level objects: `source` (alert metadata — product, alertType, severity, tenantId, alertId, detectionTime), `payload` (a standardized `essentials` block with entities, MITRE tactics, title/description, plus a `raw` escape hatch for the full vendor payload and a `links` object), and `context` (requesterId, playbookRunId, dryRun flag, optional analystNotes).
- `source.alertId` is the idempotency key. Duplicate requests within a configurable window must return the original verdict from Cosmos rather than re-investigating.
- The `payload.essentials.entities` structure covers users, devices, IPs, files (name + SHA256), URLs, and processes — the common pivot points across all Microsoft-family alert types.
- `payload.raw` passes the full vendor payload untouched for skill-specific fields (sensitivity labels for DLP, process trees for endpoint, token claims for sign-ins).

### Skill dispatch
- A versioned lookup table maps `source.product` + `source.alertType` → skill name (e.g., `defender-endpoint-triage`, `entra-risky-signin-triage`, `purview-dlp-triage`).
- If no skill matches the alertType, return `verdict: inconclusive` with reason `no_skill_registered` and escalate by default.
- For Phase 1, dispatch synthesizes an internal slash-command-style invocation to reuse the existing skills loading path. A programmatic skill invocation API is a Phase 2 cleanup.
- Each triage skill declares its required tool scopes. The dispatch layer enforces the tool allowlist regardless of what's loaded globally.

### Triage-mode wrapper
- A thin system prompt wrapper applied only on this endpoint that defines the JSON output contract, the confidence rubric, and the escalation criteria.
- Skills stay focused on investigative procedure; the wrapper owns the response shape.
- The wrapper is separate from the base Neo system prompt and the skill content — it layers on top.

### Structured output
- Assistant turn prefilled with the opening of a JSON code fence to force JSON output.
- Stop sequence set to the closing code fence to terminate cleanly.
- Response parsed and validated against the response schema.
- Fail-safe on parse/schema error: return `verdict: escalate` with reason `neo_parse_failure`. For a triage endpoint gating auto-close, failing safe to escalate is the correct default.
- Optional one-shot retry with a correction prompt before falling back to the escalate fail-safe.

### Response contract
- Top-level fields: `verdict` (benign | escalate | inconclusive), `confidence` (0.0–1.0), `reasoning` (free-text), `evidence` (array of source/query/finding objects), `recommendedActions` (array of action/reason objects), `neoRunId`, `skillUsed`, `durationMs`.
- The Logic App caller branches on `verdict`: benign + severity in allowlist + confidence above threshold → auto-close with reasoning appended as a Sentinel incident comment; otherwise → assign to analyst queue with reasoning and evidence pre-populated.

### Guardrails
- **Severity-based auto-close allowlist**: configurable per environment. Default: only Informational and Low alerts are eligible for auto-close. Medium+ always escalates regardless of verdict.
- **Confidence threshold**: verdicts below a configurable threshold (default 0.80) are coerced to `escalate` even if Neo says benign. - This is good
- **Dry-run mode**: `context.dryRun: true` runs the full pipeline but marks the response as non-actionable. The Logic App logs the verdict but takes no action. Critical for shadow-mode validation before trusting Neo with auto-close.
- **Skill allowlist per caller**: optional — specific Logic Apps can be restricted to specific skills (e.g., a DLP-only Logic App can't invoke endpoint triage).
- **Circuit breaker**: if the triage failure rate exceeds a threshold over a rolling window, the endpoint returns `escalate` for all requests until manually reset.

### Persistence and audit
- New Cosmos DB container: `triageRuns`, partitioned by `alertId`.
- Every run persists: request payload, resolved skill, full tool-call trace, raw Claude response, parsed verdict, timings, caller identity.
- All runs flow into Neo's existing structured logging pipeline (Event Hub + Application Insights).
- Idempotency: duplicate alertId within the configurable dedup window returns the stored verdict without re-running.

### Observability
- Application Insights telemetry per triage run: duration, skill used, verdict distribution, confidence histograms.
- Dashboard view in Neo web UI (future phase): recent triage runs, verdict breakdown, auto-close vs escalate ratio per skill, failure rate.
- Teams alerts on circuit-breaker trip or sustained parse-failure rate.

## Possible Edge Cases

- Alert payload is malformed or missing required fields (e.g., no `source.alertId`): return 400 with a structured error. Never treat a malformed request as an investigation.
- Logic App submits the same alertId within the dedup window: return the cached verdict and 200 (not 409). The caller should see this as a successful idempotent response.
- Cosmos DB is unavailable: the triage endpoint must still respond. Treat as if idempotency cache is empty (re-investigate), log the Cosmos failure. If the verdict cannot be persisted post-run, log a warning but still return the verdict — don't fail the response because audit storage is down.
- Claude API is unavailable or returns a 5xx: return `verdict: escalate` with reason `neo_api_failure`. Never block the alert pipeline because the LLM is down.
- Claude response is valid JSON but doesn't match the response schema (e.g., missing `verdict` field, confidence outside 0–1): coerce to `verdict: escalate` with reason `neo_schema_violation`.
- Triage skill requires a tool that is currently misconfigured (e.g., missing secret in Key Vault): the tool call will fail within the agent loop. The failure propagates into the structured response as an evidence entry with a tool-error indicator; the triage wrapper should treat tool failures conservatively (degrade confidence, lean toward escalation).
- A skill invocation triggers a destructive tool (shouldn't happen — triage skills should only use read-only tools): the confirmation gate blocks execution. The triage wrapper should treat a confirmation-gate halt as `verdict: escalate` with reason `destructive_tool_blocked`.
- Alert arrives for a product/alertType combination with no registered skill: return `verdict: inconclusive`, reason `no_skill_registered`, and escalate. This is not an error — it's the expected behavior for alert types not yet covered.
- Circuit breaker is tripped: all requests return `verdict: escalate` with reason `circuit_breaker_open` regardless of alert content. Log at warn level so the operator can see the trip and the backlog.
- Concurrent duplicate requests (same alertId, both arrive before either completes): first-write-wins on the Cosmos dedup key. The second request may re-investigate but the stored verdict will be from whichever finishes first. This is acceptable — the verdicts should be consistent since the same alert produces the same investigation.
- Very large `payload.raw` (e.g., a Defender XDR incident with hundreds of evidence entries): the triage wrapper should truncate `raw` to a configurable byte limit before injecting into the prompt. The full `raw` is still persisted in Cosmos for auditability.
- Caller provides `analystNotes` in `context`: these are injected into the prompt as additional context for the skill. Since they come from an authenticated caller (not end users), they're trusted at the same level as the alert payload — but still wrapped in a trust-boundary tag.

## Acceptance Criteria

- [ ] `POST /api/triage` is live and rejects unauthenticated requests with 401.
- [ ] A valid request with `source.product: "DefenderXDR"` and `source.alertType: "DefenderEndpoint.SuspiciousProcess"` dispatches the `defender-endpoint-triage` skill and returns a valid verdict JSON.
- [ ] The response matches the response schema: `verdict`, `confidence`, `reasoning`, `evidence`, `recommendedActions`, `neoRunId`, `skillUsed`, `durationMs` are all present.
- [ ] A malformed Claude response (unparseable JSON or missing required fields) returns `verdict: escalate` with reason `neo_parse_failure` — never a 500.
- [ ] Duplicate `alertId` within the dedup window returns the cached verdict with the same `neoRunId`.
- [ ] `context.dryRun: true` produces the full verdict but the response includes a `dryRun: true` flag.
- [ ] Alerts with severity `Medium` or `High` have their verdict coerced to `escalate` regardless of Neo's assessment (severity guardrail).
- [ ] Verdicts with confidence below 0.80 are coerced to `escalate` regardless of Neo's assessment (confidence guardrail).
- [ ] An unrecognized `source.alertType` returns `verdict: inconclusive` with reason `no_skill_registered`.
- [ ] Triage runs are persisted to the `triageRuns` Cosmos container with full tool-call trace and caller identity.
- [ ] All runs emit structured logs to the existing Event Hub pipeline.
- [ ] A request with an invalid Entra token returns 401 and is not investigated.
- [ ] A request with a valid token but a caller not in the per-caller skill allowlist (if configured) returns 403.

## Open Questions

1. **Dedup window duration**: how long should the idempotency window be? 24 hours matches typical Sentinel incident retention for new incidents; 1 hour is safer if Logic Apps retry aggressively. Recommend 24 hours with a configurable override (`TRIAGE_DEDUP_WINDOW_MS`). 24 hours with configurable window
2. **Circuit breaker thresholds**: what failure rate over what window trips the breaker? Suggest 30% failure over a 15-minute window as a starting point. Should the breaker auto-reset after a cooldown, or require manual reset via an admin endpoint?use suggested, auto reset after cooldown and an admin endpoint for manual resets
3. **Cosmos RU provisioning for `triageRuns`**: serverless (like the existing containers) or provisioned throughput? If alert volume is expected to be bursty (10+ alerts/minute during an incident), provisioned with autoscale might be more cost-effective. Serverless is simpler for the initial rollout. autoscale
4. **Phase 1 skill scope**: the Notion request names `defender-endpoint-triage` as the proof-of-concept skill. Should Phase 1 also ship with a generic catch-all skill that runs a basic investigation on any alert type, or is `inconclusive` + escalate the right default for unregistered types? yes ship with generic catch all skill
5. **Prefill + stop sequence vs. tool_use for structured output**: the Notion request specifies prefill with a JSON code fence. An alternative is using Claude's tool_use with a response-schema tool. Tool_use has native JSON validation and avoids the parse/retry dance. Worth evaluating during implementation — prefill is simpler but tool_use is more robust. tool_use
6. **Per-caller skill allowlist storage**: should this live in environment variables, Key Vault, or a new Cosmos collection? Environment variables are simplest for Phase 1 with a small number of Logic Apps. env variable
7. **Token budget accounting for triage runs**: should triage runs count against the per-user token budget system? The caller is a service principal, not a human user. Suggest a separate budget pool or no budget enforcement for machine callers, with cost tracking only. no budget with cost tracking

## Testing Guidelines
Create test files under `web/test/` for the new feature, and create meaningful tests for the following cases, without going too heavy:

- `web/test/triage-endpoint.test.ts`
  - Valid request dispatches the correct skill and returns a well-formed verdict JSON.
  - Malformed request body (missing `source`, missing `alertId`) returns 400.
  - Unknown `alertType` returns `verdict: inconclusive` with `no_skill_registered`.
  - Duplicate `alertId` within dedup window returns cached verdict (mock Cosmos).
  - Claude parse failure returns `verdict: escalate` with `neo_parse_failure`.
  - Unauthenticated request returns 401.

- `web/test/triage-guardrails.test.ts`
  - Medium-severity alert with `verdict: benign` is coerced to `escalate`.
  - High-severity alert is always `escalate` regardless of Neo's output.
  - Confidence below 0.80 coerces to `escalate`.
  - `dryRun: true` produces full verdict with dryRun flag in response.
  - Circuit breaker: after N failures, all requests return `escalate` with `circuit_breaker_open`.

- `web/test/triage-dispatch.test.ts`
  - Correct skill resolution from the product + alertType lookup table.
  - Unmapped product/alertType → `no_skill_registered`.
  - Per-caller skill allowlist blocks a disallowed skill with 403.
  - Triage-mode wrapper is prepended to the system prompt (not replacing base prompt).
