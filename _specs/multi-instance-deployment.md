# Spec for multi-instance-deployment

branch: claude/feature/multi-instance-deployment
figma_component (if used): —

## Summary

Make Neo safe to run across multiple Azure App Service instances behind a load balancer for horizontal scaling, zero-downtime rolling deploys, and a foundation for multi-region DR. The Notion feature request "Multi-instance deployment support (horizontal scaling behind load balancer)" identifies that ~85% of the system is already stateless at the instance level (Cosmos-backed conversations, JWT browser auth, stateless API/CLI auth, pure agent loop, per-request context manager, fire-and-forget Event Hub logging, content-addressed blob storage). The remaining ~15% lives in six in-process singletons that today assume single-instance affinity and either silently break correctness or open security gaps when traffic is round-robined across instances. This feature replaces those singletons with Cosmos-backed shared state, adds a startup guard against the misconfigured-in-prod case, and ships a load test + runbook proving multi-instance correctness.

## Functional requirements

- **Triage circuit breaker (`web/lib/triage-circuit-breaker.ts`)** — replace the per-instance rolling-window counter with a Cosmos-backed counter document keyed by integration / failure-class so a trip on instance A causes instance B to refuse traffic too. Same trip threshold + cooldown semantics as today; only the storage substrate moves.
- **Triage rate limiter (`web/app/api/triage/route.ts`)** — replace the module-level `callerWindows` Map with the same Cosmos-backed counter pattern (or a dedicated module if the access pattern differs). The 100-req-per-window cap must be a *global* cap, not 100-per-instance, so a caller hitting two instances doesn't double their budget.
- **Skill store (`web/lib/skill-store.ts`)** — move skills from the local `skills/` directory + `fs.watch` hot-reload to Cosmos (or a shared blob container; Cosmos is preferred because the admin CRUD routes already use it for other entities). Admin skill CRUD endpoints rewrite to read/write the shared store. Each instance reads from the shared store with a short TTL cache (≤15 s) so a skill update propagates within one cache window without a restart.
- **API key store (`web/lib/api-key-store.ts`)** — disable the file-based `api-keys.json` cache layer and go Cosmos-only. The Cosmos lookup already exists as a fallback; the file cache is the unsafe path that leaves a revoked key valid on instances that haven't re-read the file. Net change is mostly a deletion.
- **Teams session mapping (`web/lib/teams-session-map.ts`)** — remove the in-memory `teamsConversationId → neoSessionId` Map (or convert to a read-through cache with ≤60 s TTL backed by the existing Cosmos-backed `teams-mapping-store.ts`). Goal: a Teams thread that round-robin-routes to a different instance on the next message resolves the same Neo session without creating a duplicate or paying a cross-partition Cosmos query on every message.
- **`InMemorySessionStore` production guard (`web/lib/session-store.ts` / startup)** — add a startup assertion that fails fast when `NODE_ENV === "production"` and `COSMOS_ENDPOINT` is unset. The in-memory store is already the dev/mock-only path; this turns a silent multi-instance correctness bug ("each instance sees a different conversation") into an immediate boot failure with a clear error message.
- **Runbook + docs** — `docs/configuration.md` gains a "Horizontal scaling" subsection covering: Cosmos as a hard dependency in production, the no-session-affinity recommendation (LB routes round-robin), Azure App Service scaling rules (CPU/memory autoscale) appropriate for the hot path, and the order in which the six blockers must land if the rollout is staged. `.env.example` documents any new env vars the migration introduces.

## Figma Design Reference

Not applicable — server-side / infra concern, no UI surface.

## Possible Edge Cases

- **Counter-document write contention.** Two instances incrementing the same circuit-breaker counter or rate-limiter window simultaneously will hit Cosmos `etag` conflicts. The fix uses Cosmos `Patch` operations (atomic on a single field) rather than read-modify-write so the 412 path is rare; for the rate-limiter window-rollover edge, a small retry loop covers the residual cases.
- **Hot-path RU cost.** Every triage request now does at least one Cosmos op for the rate limiter + one for the circuit breaker. At 100 req/s × 2 ops × ~1 RU each = 200 RU/s baseline. Verify against the existing serverless-tier budget and consider Redis if RU profiling shows pressure (Open Question #1).
- **Skill update propagation lag.** The 15 s cache TTL means a freshly-saved skill is invisible on other instances for up to 15 s. The admin who saved it sees their own write immediately (write-through their own instance's cache); other admins see it after refresh. The window was tightened from the originally-proposed 60 s to bound the role-downgrade exploitation window for destructive admin skills.
- **Skill `fs.watch` removal breaks dev hot-reload.** Local development relies on editing `skills/*.md` and seeing the change immediately. The migration must preserve a dev-mode path: when `MOCK_MODE === true` or `COSMOS_ENDPOINT` is unset, fall back to the file-system source so a contributor running `npm run dev` doesn't lose the workflow.
- **Teams mapping cache miss storm.** A cold instance that just started receiving traffic will cache-miss every Teams message until the read-through cache warms. The fallback Cosmos query must already be fast (single-key lookup on `/id` partition key); verify, and add a startup pre-warm only if measured cold-start latency is unacceptable.
- **API key file fallback in dev.** `api-keys.json` is sometimes used in single-developer environments without Cosmos. Removing it entirely breaks `MOCK_MODE` workflows. Treat the change as "production-only Cosmos enforcement" — the file path remains for `MOCK_MODE === true`, but production with `COSMOS_ENDPOINT` set must NOT consult the file at all.
- **Startup assertion ordering.** The `COSMOS_ENDPOINT` guard must fire before anything depends on the session-store choice (e.g., before `app/api/agent/route.ts` initialises). Place it in `lib/config.ts`'s already-existing boot-time validation block so it surfaces during Next.js startup, not on the first request.
- **Session affinity during rollout.** Some operators may want ARR Affinity / sticky sessions on as a belt-and-suspenders measure while we soak. Document the toggle in the runbook — affinity-on is a valid temporary state that doesn't require code changes; affinity-off is the steady-state target.
- **Conversation storage v2 interaction.** The Notion request explicitly notes that `/conversationId`-partitioned per-turn documents (already shipped — see `_plans/conversation-storage-split-blob-offload.md`) eliminate cross-instance write contention on the same conversation. Verify nothing in the multi-instance work re-introduces a single-document hot path.
- **Output-budget interaction (`_plans/output-budget.md`).** The new `inProgressPlan` field on the conversation root is patched on truncation. Two instances handling rapid back-to-back turns on the same conversation could race the patch — the existing dual-store dispatch already covers this, but confirm the rate-limit and circuit-breaker counters don't inadvertently key off the wrong identifier and let two truncation patches collide.
- **Teams bot proactive messages.** Adaptive cards are sent from one instance and the user's reply may land on another. Verify the `pendingConfirmation` round-trip (already Cosmos-backed) covers this; the new in-memory map removal must not regress it.

## Acceptance Criteria

- All six in-process singletons identified in the Notion request are migrated to Cosmos-backed shared state OR documented as deliberately deferred with a tracked follow-up.
- The web app runs on ≥2 App Service instances in a staging slot and passes a load-test plan that exercises:
  - Triage circuit breaker trips globally — trip on instance A causes instance B to refuse traffic within ≤5 s of the next request.
  - Rate limiter enforces a global budget — 50 reqs to instance A + 50 reqs to instance B hits the 100-req cap, not 200.
  - Skill update via admin API is visible on all instances within 15 s without restart, AND the saving admin sees their write immediately.
  - API key revocation is honoured on all instances within ≤60 s of revocation.
  - Teams thread continuity survives round-robin LB routing — 10 sequential messages on the same thread alternated across instances produce one Neo session, not multiple.
- Startup assertion fails fast (process exit with a clear error) when `NODE_ENV === "production"` and `COSMOS_ENDPOINT` is unset; verified by a CI test that boots the server in production mode with the env var stripped.
- Load test: 2 instances sustain ≥2× single-instance QPS for 10 minutes with no etag conflicts logged, no session bleed observed in test conversations, and Cosmos RU consumption within the existing budget envelope.
- All 386 existing tests continue to pass; new tests cover: counter dispatch (read-through cache hit/miss + Cosmos update), skill-store dual-source dispatch (file-mode vs Cosmos-mode), startup assertion behaviour, and the Teams mapping read-through cache.
- `docs/configuration.md` runbook subsection documents: Cosmos as a hard production dependency, recommended scaling rules, session-affinity guidance, and the migration order if the work ships in stages.
- `.env.example` documents any new env vars (TTLs, counter container name, etc.) introduced by the migration.

## Open Questions

1. **Redis vs Cosmos for the counter use cases (circuit breaker, rate limiter).** Cosmos adds RU on hot paths; Redis adds a dependency. Lean toward Cosmos unless RU profiling shows hot-path pressure. Decide before implementation begins so the storage abstraction matches. cosmos
2. **Session affinity during rollout.** Default ARR Affinity off (steady-state target) or on (belt-and-suspenders during the rollout window)? The code is identical either way; this is an operator preference + runbook recommendation. lets include a step in the docs to turn it off and then only set it back as a way to handle bugs that pop up while we find a fix
3. **Sequencing relative to other in-flight work.** This depends on storage-v2 (already shipped) and is parallel-safe with output-budget. Should the six blockers ship in one PR or staged (e.g., 1+2 first because they're tightly related counters; 3 separately because it touches admin CRUD)? Staging reduces blast radius but adds rollout coordination. v2 is live
4. **Skill admin CRUD shape.** Current admin endpoints assume the file-system source of truth. Moving to Cosmos requires a small API rework (POST creates, GET reads, PUT updates, DELETE removes). Is a server-restart-free path required for the initial rollout, or can a forced restart on each admin write be accepted as a starting point? forced restart is ok
5. **Cold-instance Teams mapping warm-up.** If measured cold-start cache-miss latency is acceptable, no warm-up needed. If not, do we pre-warm from Cosmos on boot, accept the warm-up RU spike, or use a longer-TTL read-through cache? Defer to load-test measurements. accept cold start cost.
6. **Rate-limit identity choice for global enforcement.** Today the rate limiter keys off `callerId` (typically the API key hash or user OID). Confirm this is the correct global identity — i.e., a CLI caller using two API keys against the same user should hit one budget or two? Spec the answer before migrating, since today's per-instance behaviour effectively gives them N × budget regardless. this is correct.

## Testing Guidelines

Create test files in `web/test/` for the new behaviour. Keep coverage focused on the multi-instance contract — don't re-test what the existing single-instance suite already covers.

- **`web/test/triage-circuit-breaker-shared.test.ts`** — counter dispatch tests using a fake Cosmos container: trip count from instance A's increments is visible to instance B's read on the next call; cooldown timer resets globally; concurrent increments use Patch and don't lose count under contention.
- **`web/test/triage-rate-limiter-shared.test.ts`** — global-budget test: 50 increments from one logical "instance" + 50 from another against the same caller-id key trigger the 100-req limit on call 101, not call 201.
- **`web/test/skill-store-shared.test.ts`** — dual-source dispatch: `MOCK_MODE` reads the file system; production (Cosmos configured) reads the Cosmos store. Admin write under production mode invalidates the local cache. Cache TTL respected (read-through up to 15 s).
- **`web/test/api-key-store-cosmos-only.test.ts`** — production-mode lookups never consult `api-keys.json`; the file-fallback fires only under `MOCK_MODE` or unset Cosmos.
- **`web/test/teams-session-map-shared.test.ts`** — read-through cache hit/miss path against a fake Cosmos store; cache invalidation on TTL expiry; round-robin scenario where instance A creates a mapping and instance B's first lookup finds it in Cosmos (not in memory).
- **`web/test/startup-assertion.test.ts`** — boot-time validation throws when `NODE_ENV === "production"` && `COSMOS_ENDPOINT` is empty; passes when one or both conditions are absent.
- **Manual / staging load test** (not a Vitest case — runbook entry): run a 10-minute load test against a 2-instance staging slot driving each of the five acceptance criteria above; capture Cosmos RU consumption and confirm no etag-conflict warnings in logs.
