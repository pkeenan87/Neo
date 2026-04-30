# Multi-Instance Deployment Support

## Context

Today Neo is ~85% safe to run on multiple Azure App Service instances behind a load balancer — conversations, browser auth (JWT), API/CLI auth (JWKS + Cosmos), the agent loop, the context manager, blob storage, and Event Hub logging are all already stateless or externalised. Six in-process singletons remain that today silently break correctness or open security gaps when traffic round-robins across instances. Per `_specs/multi-instance-deployment.md`, this plan migrates those singletons to Cosmos-backed shared state, adds a startup guard against the misconfigured-in-prod case, ships a load-test plan, and updates the operator runbook. Effort sized at ~200–300 lines across ~5–6 files; no architectural rewrite.

---

## Key Design Decisions

- **Cosmos over Redis for the two counter use cases (circuit breaker, rate limiter).** Open Question 1 in the spec — the Cosmos approach uses `Patch` operations (atomic on a single field, no etag fight), keeps the existing Cosmos hard-dependency posture, avoids introducing a new infra component, and stays inside the existing serverless-tier RU envelope at expected triage volume (≤200 RU/s baseline). Re-evaluate only if RU profiling under load shows pressure.
- **Single new container `instance-shared` partitioned on `/key`** holds the rate-limiter and circuit-breaker docs (and any future per-instance-shared counters). One new container is cheaper than two per-feature ones; the `/key` partition gives single-partition Patch performance for every counter operation.
- **Counter doc shape is opaque + atomic-Patchable.** Both counters use a doc with a numeric `count` field plus a `windowStart` timestamp; the Patch operation increments `count` atomically and conditionally resets when `windowStart` rolls past the window boundary. No read-modify-write loop required for the common path.
- **Skill store: dual-source dispatch with file-mode dev fallback.** Production with `COSMOS_ENDPOINT` set ⇒ Cosmos source of truth, ≤60 s read-through cache. `MOCK_MODE === true` OR no `COSMOS_ENDPOINT` ⇒ existing file-system path with `fs.watch` hot-reload preserved (Open Question 4 in the spec — initial rollout accepts the dispatch split rather than reshaping admin CRUD). One-time migration script copies `skills/*.md` into Cosmos on cutover.
- **Sync → async migration for `getSkill` / `getAllSkills` / `getSkillsForRole`.** All three current callers (`getSystemPrompt`, `triage-dispatch.ts`, `app/api/agent/route.ts`) are already in async contexts. The cache lookup stays synchronous on the hot path; only the cache miss is async. Function signatures change to return `Promise<Skill | undefined>` (etc.) so the cache miss can fall through cleanly.
- **API key store becomes Cosmos-only in production.** Net deletion of the `readFileSync` + `watch(KEY_FILE)` block when `COSMOS_ENDPOINT` is set AND `MOCK_MODE === false`. The existing Cosmos lookup path stays as-is and is now load-bearing. File path remains for `MOCK_MODE === true`.
- **Teams session map: keep the read-through cache, drop the writer-cache trap.** `teams-session-map.ts` already does the right thing on read (cache hit fast-path, Cosmos fallback). The bug is that `setSessionId` populates the in-memory cache on instance A but not B, so B's first lookup may cache-miss to a stale Cosmos read window if Cosmos write-after-read consistency hasn't propagated. Lower the in-memory TTL from 35 min to 60 s so a cold-instance miss is the worst-case path, and document that the cache is best-effort for the local instance only.
- **`InMemorySessionStore` startup guard goes in `validateConfig`.** This is the existing boot-time validator (`web/lib/config.ts`) — adding the assertion there means it surfaces during Next.js startup before any route handler initialises. Throws (process exit), not warns, when `NODE_ENV === "production"` and `COSMOS_ENDPOINT` is empty.
- **Default ARR Affinity off in the runbook recommendation.** Open Question 2 — the steady-state target is round-robin LB routing. Affinity-on is documented as a valid temporary state operators can choose during initial rollout but no code change required.
- **PR staging.** Land all six blockers in one branch but commit phase-by-phase so each phase is independently reviewable and revertible. Keeps blast radius small without coordinating multiple PRs.
- **Cosmos counter-doc TTL.** Set Cosmos TTL on counter docs to ~24 h so abandoned caller buckets don't accumulate forever. Window-rollover already truncates the active count; TTL just garbage-collects long-idle keys.
- **Rate-limit identity unchanged (Open Question 6 deferred).** Today `callerId` is whatever the route's auth layer derives — keep that contract. Documenting as a deferred follow-up if it turns out to be wrong; not blocking on the answer for the migration.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/instance-shared-counter.ts` | **NEW** — shared Cosmos-backed counter primitive used by the rate limiter and circuit breaker. Exports `incrementCounter(key, windowMs, limit) => { count, allowed }`, `resetCounter(key)`, `readCounter(key)`. Internally uses Patch + ifMatch + 412 retry; lazy-init on Cosmos container. |
| `web/lib/triage-circuit-breaker.ts` | Replace module-level `outcomes`/`trippedAt` with calls into `instance-shared-counter.ts`. Shape stays — `checkCircuitBreaker()` and `recordTriageOutcome(success)` keep their signatures (one becomes async; trace callers below). Auto-reset semantics preserved. |
| `web/app/api/triage/route.ts` | Remove module-level `callerWindows: Map`. `checkCallerRateLimit` becomes async + delegates to `instance-shared-counter.ts`. Update the single call site. |
| `web/lib/skill-store.ts` | Add Cosmos-source path. `getAllSkills` / `getSkill` / `getSkillsForRole` become async, hit a 60 s read-through cache, fall through to Cosmos on miss. `createSkill` / `updateSkill` / `deleteSkill` already mutate the local cache; add a parallel Cosmos write. Dual-source dispatch on `MOCK_MODE` || `!COSMOS_ENDPOINT` keeping the current file path. `loadSkillsFromDisk()` + `fs.watch` only run in file-mode. |
| `web/lib/skill-store-cosmos.ts` | **NEW** — Cosmos CRUD for skills. Container `skills`, partition key `/id`. Mirror the `api-key-store.ts` pattern. |
| `web/lib/triage-dispatch.ts`, `web/app/api/agent/route.ts`, `web/lib/config.ts#getSystemPrompt` | Await the now-async `getSkill` / `getSkillsForRole`. All three sites are already in async contexts; one-line edits. |
| `web/app/api/skills/route.ts`, `web/app/api/skills/[id]/route.ts` | `await` the async getter calls. No other behaviour change — write methods (`createSkill`, etc.) already return synchronously (they'll keep doing so or become async in their own right; the test suite catches this). |
| `web/lib/api-key-store.ts` | Production path skips the file cache entirely (`if (cosmosConfigured && !MOCK_MODE) return findApiKeyFromCosmosOnly(...)`). Move the `loadKeys()` + `watch(KEY_FILE)` calls inside an `if (!cosmosConfigured || MOCK_MODE)` guard. The `findApiKeyFromFile` function stays for dev. |
| `web/lib/teams-session-map.ts` | Lower in-memory `TTL_MS` from 35 min to 60 s. Add a comment noting the cache is best-effort per-instance and the source of truth is Cosmos. No behaviour change in the read-through fast path; just shorter cache lifetime. |
| `web/lib/config.ts` (`validateConfig`) | Add boot-time assertion: when `NODE_ENV === "production"` and `COSMOS_ENDPOINT` is empty, throw with a clear `"Multi-instance deployment requires COSMOS_ENDPOINT in production. Set the env var or downgrade NODE_ENV for local dev."` message. Place it after the existing `ANTHROPIC_API_KEY` check so all hard prerequisites fail in one block. |
| `web/lib/session-store.ts` | Add a doc comment on the `InMemorySessionStore` class linking to the production-only restriction and the new startup assertion. No code change. |
| `scripts/provision-cosmos-db.ps1` | Add `instance-shared` and `skills` containers to the provisioning script, mirroring the existing `teams-mappings` / `usage-logs` / `api-keys` blocks. |
| `scripts/migrate-skills-to-cosmos.ts` | **NEW** — one-shot script (run via `tsx`) that reads `skills/*.md`, parses with `parseSkillMarkdown`, validates, and upserts each to the Cosmos `skills` container. Idempotent. |
| `web/package.json` | Add `migrate:skills` npm script (`tsx scripts/migrate-skills-to-cosmos.ts`), mirroring `migrate:conversations`. |
| `docs/configuration.md` | New "Horizontal scaling" subsection: Cosmos hard requirement in prod, recommended scale rules, ARR-affinity guidance, container provisioning steps, migration order. Update Environment Variables table for any new env vars. |
| `.env.example` | Document any new env vars (`SKILL_CACHE_TTL_MS`, `INSTANCE_COUNTER_CONTAINER`, etc.) introduced by the migration. |
| `web/test/instance-shared-counter.test.ts` | **NEW** — counter primitive: increment / read / reset, window rollover, atomic Patch under mock contention, retry-on-412 path. |
| `web/test/triage-circuit-breaker.test.ts` | Extend with a "shared trip" case — instance A increments past the threshold, instance B's `checkCircuitBreaker()` returns `open: true` without locally recording any outcomes. Mock the counter so both "instances" share state. |
| `web/test/triage-rate-limiter-shared.test.ts` | **NEW** — global-budget test: 50 + 50 across two simulated instances hits the cap on call 101. |
| `web/test/skill-store-shared.test.ts` | **NEW** — Cosmos-mode dispatch hits Cosmos; mock-mode dispatch hits the file system; cache TTL respected; admin write invalidates the local cache. |
| `web/test/api-key-store-cosmos-only.test.ts` | **NEW** — production-mode never consults `api-keys.json`; mock-mode does. |
| `web/test/teams-session-map.test.ts` (or extension) | Test that the in-memory cache TTL is 60 s and that a write-followed-by-read on a different "instance" still returns the mapping (via Cosmos fallback). |
| `web/test/startup-assertion.test.ts` | **NEW** — `validateConfig` throws when `NODE_ENV === "production"` && `COSMOS_ENDPOINT` is empty; passes otherwise. |
| `_plans/multi-instance-deployment.md` | This file. |

---

## Implementation Steps

### 1. Provision the shared counter primitive

- Create `web/lib/instance-shared-counter.ts` exporting:
  - `incrementCounter(key, windowMs, limit)` — returns `{ count, allowed }`. Reads the current doc on partition `/key` with `id = key`. If absent or `windowStart` is older than `windowMs`, write a fresh doc with `count: 1`. Otherwise Patch-increment `count`. Compare to `limit` to derive `allowed`.
  - `recordOutcome(key, success, windowMs)` for circuit breaker — appends `{ timestamp, success }` to a bounded array via Patch, with rolling-window prune handled by the read path.
  - `readCounterState(key, windowMs)` — returns the pruned outcome array, or counter snapshot.
  - `resetCounter(key)` — deletes the doc.
- Lazy-init the `instance-shared` container in the same pattern as `api-key-store.ts` (managed identity credential, container handle cached at module level).
- Set Cosmos doc TTL to 24 h on creation to garbage-collect long-idle keys.
- Use Cosmos `patch` with the `replace` operator for `count`; on 412 (etag conflict) retry once after a short backoff (the conflict means another instance also incremented — re-read and re-Patch). Cap at 3 retries.
- Add unit test `web/test/instance-shared-counter.test.ts` with a fake Cosmos container exercising: cold-doc create, hot-path increment, window rollover, concurrent increments via Patch, and reset.

### 2. Migrate the triage circuit breaker

- Replace the `outcomes` array and `trippedAt` module-level state in `web/lib/triage-circuit-breaker.ts` with calls into `instance-shared-counter.ts`. Use a fixed key like `triage-circuit-breaker-global` (single global breaker today).
- `checkCircuitBreaker` becomes `async`. The existing auto-reset behaviour (read trip timestamp, compare against cooldown) becomes a single read of the counter doc's `trippedAt` field.
- `recordTriageOutcome(success)` becomes `async` and delegates to the counter's `recordOutcome`. Update the three call sites in `app/api/triage/route.ts` (lines 474, 489, 515) and the single check site (line 334) to `await`.
- Extend `web/test/triage-circuit-breaker.test.ts` with a shared-state case: simulate two "instances" by mocking the counter container, increment past the threshold from instance A's path, assert instance B's check returns `open: true`.

### 3. Migrate the triage rate limiter

- Remove the `callerWindows` Map and `RATE_LIMIT_PER_CALLER` / `RATE_LIMIT_WINDOW_MS` constants from `web/app/api/triage/route.ts` (move the constants into the rate-limiter wrapper).
- `checkCallerRateLimit(callerId)` becomes `async` and calls `incrementCounter('rate:triage:' + callerId, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_PER_CALLER)`. Returns whether the caller is still under cap.
- Update the single call site to `await`.
- Add `web/test/triage-rate-limiter-shared.test.ts`: 50 + 50 across two simulated instances hits the cap on call 101 (not call 201).

### 4. Skill store: Cosmos-backed dual-source

- Create `web/lib/skill-store-cosmos.ts`:
  - Lazy-init the `skills` Cosmos container (partition key `/id`).
  - Export `getAllSkillsFromCosmos`, `getSkillFromCosmos`, `upsertSkillInCosmos(skill)`, `deleteSkillFromCosmos(id)`.
- Refactor `web/lib/skill-store.ts`:
  - Module-level `useCosmos()` helper checks `!env.MOCK_MODE && env.COSMOS_ENDPOINT`.
  - `getSkill` / `getAllSkills` / `getSkillsForRole` become `async` — file-mode keeps in-memory `skillCache`; Cosmos-mode hits a new `cosmosSkillCache` Map with `{ skill, cachedAt }` entries and a 60 s TTL.
  - On cache miss, Cosmos-mode reads the full skill set from Cosmos and refreshes the cache (one query per refresh, not per skill, since skills are <100 entries).
  - `createSkill` / `updateSkill` / `deleteSkill`: in file-mode, keep current behaviour. In Cosmos-mode, write to Cosmos (`upsertSkillInCosmos`), invalidate the local `cosmosSkillCache`, and skip the file-system write entirely.
  - Wrap the initial `loadSkillsFromDisk()` and `watch(SKILLS_DIR, ...)` calls in `if (!useCosmos()) { ... }` so production never touches the file system.
- Update consumers:
  - `web/lib/config.ts#getSystemPrompt` (line 570) — already async; just `await`.
  - `web/lib/triage-dispatch.ts` (lines 28, 33) — already in async context; `await` both calls.
  - `web/app/api/agent/route.ts` (line 97) — already async; `await`.
  - `web/app/api/skills/route.ts` and `web/app/api/skills/[id]/route.ts` — `await` all `getSkill` / `getAllSkills` calls.
- Add test `web/test/skill-store-shared.test.ts` covering both modes, TTL, and cache invalidation on write.

### 5. Skill migration script

- Create `web/scripts/migrate-skills-to-cosmos.ts`:
  - Read `skills/*.md` files from disk using the existing `parseSkillMarkdown` + `validateSkill` helpers.
  - For each valid skill, `upsertSkillInCosmos`. Idempotent — re-running is a no-op for already-migrated skills (Cosmos `upsert` overwrites on conflict).
  - Log a summary at the end (count migrated, count skipped due to validation failures).
- Add `migrate:skills` to `web/package.json` scripts: `"migrate:skills": "tsx scripts/migrate-skills-to-cosmos.ts"`.
- Mirror the bundling pattern from `migrate:conversations` (esbuild → `dist/migrate-skills.mjs`) so this can run on App Service via SSH without a local node_modules. Add a `build:migrate-skills` script too.

### 6. API key store: production-only Cosmos enforcement

- In `web/lib/api-key-store.ts`:
  - Add `useCosmosOnly()` helper returning `Boolean(env.COSMOS_ENDPOINT) && !env.MOCK_MODE`.
  - Wrap the top-level `loadKeys()` call and `watch(KEY_FILE, ...)` in `if (!useCosmosOnly()) { ... }`.
  - In `findApiKey`, when `useCosmosOnly()` is true, skip the file-fallback even on a Cosmos miss — return `undefined`. This is the security fix: in production, a key not in Cosmos is not a key, period.
  - When `useCosmosOnly()` is false (dev/mock), the existing dual-path logic (Cosmos-first then file-fallback) stays.
- Add test `web/test/api-key-store-cosmos-only.test.ts` covering both modes + the "Cosmos miss in production returns undefined regardless of file" case.

### 7. Teams session map: tighter TTL + best-effort comment

- Lower `TTL_MS` in `web/lib/teams-session-map.ts` from `35 * 60 * 1000` to `60 * 1000` (60 s).
- Add a doc comment at the top of the file noting the in-memory cache is per-instance best-effort and Cosmos is the source of truth — explicitly call out that round-robin LB routing is supported because the Cosmos fallback is fast.
- Extend `web/test/teams-session-map.test.ts` (create if absent) with a test that: instance A `setSessionId`, simulate cache expiry, instance B's `getSessionId` reads from Cosmos and re-warms its own cache.

### 8. Startup assertion

- In `web/lib/config.ts#validateConfig`, add a new assertion immediately after the `ANTHROPIC_API_KEY` check:
  - If `process.env.NODE_ENV === "production"` and `!env.COSMOS_ENDPOINT`, throw with the message: `"Multi-instance deployment requires COSMOS_ENDPOINT in production. Set the env var, or set NODE_ENV=development for local dev."`.
- Add a doc comment on the `InMemorySessionStore` class in `web/lib/session-store.ts` explaining the production restriction.
- Add `web/test/startup-assertion.test.ts` covering: assertion fires in prod with no Cosmos, doesn't fire with Cosmos set, doesn't fire when `NODE_ENV !== "production"`.

### 9. Container provisioning

- Update `scripts/provision-cosmos-db.ps1`:
  - Add a `-SkillsContainerName` parameter (default `"skills"`) and provisioning block matching the existing `MappingsContainerName` pattern (partition key `/id`, no TTL — skills don't expire).
  - Add a `-InstanceCounterContainerName` parameter (default `"instance-shared"`) and provisioning block (partition key `/key`, default TTL 86400 s = 24 h).
  - Update the post-script summary lines to mention both new containers.
- No application-side env var is needed if the names are hard-coded; document the override path in the runbook for operators who picked custom names.

### 10. Documentation + env

- `docs/configuration.md` — new "Horizontal scaling" subsection under "Chat Persistence (Cosmos DB)":
  - Cosmos as a hard production dependency (mention the new startup assertion).
  - Recommended App Service scaling rules — start with min 2, max 4 instances, CPU autoscale at 70% sustained for 5 min.
  - ARR Affinity guidance: default off for steady-state; affinity-on is a valid temporary state during initial rollout.
  - Container provisioning steps (provision-cosmos-db.ps1 already creates the new ones).
  - Skill migration: run `npm run migrate:skills` (or the bundled equivalent on App Service) on the cutover from file-mode to Cosmos-mode.
  - Cross-reference the deferred follow-up on rate-limit identity choice (Open Question 6).
- `.env.example` — add documentation comments for any new env vars introduced (likely just clarifying that `COSMOS_ENDPOINT` is now mandatory in production).

### 11. Tests

- Run the full test suite to confirm 386 existing tests still pass after async migration: `cd web && npx vitest run`.
- New tests: `instance-shared-counter`, `triage-rate-limiter-shared`, `skill-store-shared`, `api-key-store-cosmos-only`, `teams-session-map` extension, `startup-assertion`. Target: ≥25 new test cases total.
- Extend `triage-circuit-breaker.test.ts` with the shared-trip case.

### 12. Manual verification (staging)

- Deploy to a 2-instance staging slot.
- Drive the five acceptance-criteria scenarios from the spec:
  1. Trip the circuit breaker on instance A; verify instance B refuses traffic on the next request.
  2. Send 50 triage requests from one logical caller to instance A then 50 to instance B; verify the 101st request hits the rate limit.
  3. Save a skill via the admin API on instance A; verify instance B serves it on the next request after the 60 s cache window.
  4. Revoke an API key via the admin API; verify both instances reject the revoked key within 60 s.
  5. Open a Teams thread, route 10 messages alternating across instances, verify only one Neo session exists in Cosmos and conversation continuity is preserved.
- Run a 10-minute load test driving 2× single-instance QPS; check Cosmos RU consumption stays under the existing budget envelope and no etag-conflict warnings appear in logs.

### 13. Rollout sequencing

- Commit one phase per logical change (config + counter primitive → triage breaker → triage rate limit → skill store → API key store → Teams cache → startup guard → docs/tests). Each commit independently passes typecheck + tests + build.
- Deploy to staging after step 9 (provisioning) lands.
- Soak in staging for 48 h with the load test, then promote to prod.

---

## Verification

1. `cd web && npx tsc --noEmit` — clean. New `instance-shared-counter.ts`, `skill-store-cosmos.ts`, and the async migrations of `getSkill`/`getAllSkills`/`getSkillsForRole` introduce no `any` and no broken consumer signatures.
2. `cd web && npx vitest run` — all 386 existing tests pass plus the new test files green (≥25 new test cases). Target ~411 total.
3. `cd web && npm run build` — production build succeeds.
4. `cd web && npm run migrate:skills -- --dry-run` (after wiring) reports the count of skill files it would migrate without writing.
5. Staging deploy: `./scripts/deploy-azure.ps1` — App Service rolling restart with min 2 instances. Tail logs (`az webapp log tail`) and confirm no startup-assertion failures.
6. Run the five acceptance-criteria scenarios from step 12.
7. 10-min load test at 2× single-instance QPS — Cosmos RU consumption within budget, no `etag conflict` warnings, no `Cosmos query failed` errors, no `cache miss` storms beyond the first 30 s of any cold instance.
8. After 48 h soak, promote to prod with ARR Affinity off in the App Service config.
