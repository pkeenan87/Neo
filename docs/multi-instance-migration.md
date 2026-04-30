# Multi-Instance Migration

How to take an **existing** single-instance Neo deployment and scale
it horizontally to ≥ 2 App Service instances safely. This is the
operational runbook for the change set described in
[`_plans/multi-instance-deployment.md`](../_plans/multi-instance-deployment.md).

If you're standing up a fresh deployment from scratch, use
[`deployment.md`](./deployment.md) instead — it covers the same
ground for greenfield.

## Table of Contents

- [Why this migration is needed](#why-this-migration-is-needed)
- [Pre-migration checklist](#pre-migration-checklist)
- [What changes (and what doesn't)](#what-changes-and-what-doesnt)
- [Migration steps](#migration-steps)
  - [Step 1 — Add the new Cosmos containers](#step-1--add-the-new-cosmos-containers)
  - [Step 2 — Verify managed-identity RBAC](#step-2--verify-managed-identity-rbac)
  - [Step 3 — Migrate skills file → Cosmos](#step-3--migrate-skills-file--cosmos)
  - [Step 4 — Update App Service settings](#step-4--update-app-service-settings)
  - [Step 5 — Configure App Service Health Check](#step-5--configure-app-service-health-check)
  - [Step 6 — Deploy the new code](#step-6--deploy-the-new-code)
  - [Step 7 — Scale out (1 → 2 instances)](#step-7--scale-out-1--2-instances)
  - [Step 8 — Disable ARR Affinity](#step-8--disable-arr-affinity)
- [Verification](#verification)
- [Rollback](#rollback)
- [Watch-outs](#watch-outs)
- [What did NOT change](#what-did-not-change)

---

## Why this migration is needed

Neo previously assumed single-instance deployment. Six pieces of
state lived in process memory:

1. Triage **circuit breaker** (per-process trip flag).
2. Triage **rate limiter** (per-process `Map<callerId, window>`).
3. **Skill store** (file system + `fs.watch` hot reload).
4. **API key** file cache (re-read of `api-keys.json` only after
   restart — revocations didn't propagate).
5. **Teams session map** (`Map<conversationId, sessionId>`).
6. **Session store** could fall back to in-memory mock when
   misconfigured.

Behind a load balancer with traffic round-robining across instances,
each of these silently broke correctness — different instances saw
different states for the same conversation, the same caller, or the
same revoked API key. This migration moves all six to Cosmos-backed
shared state and adds a startup guard so a misconfigured
multi-instance deployment fails fast instead of silently degrading.

---

## Pre-migration checklist

Before you start:

- [ ] You have an existing Neo deployment running on a single
  App Service instance with Cosmos already configured (the
  `conversations`, `usage-logs`, `triageRuns`, `teams-mappings`,
  and `api-keys` containers exist). If you don't have Cosmos at
  all, follow [`deployment.md`](./deployment.md) for greenfield.
- [ ] App Service has a system-assigned managed identity enabled.
- [ ] You have `Contributor` + `User Access Administrator` on the
  resource group (the latter is needed if RBAC role assignment
  needs to be re-run).
- [ ] You have `az login` against the right subscription.
- [ ] You can run PowerShell 7+ (`pwsh`) on your workstation.
- [ ] **`AUTH_SECRET` is set** in App Service settings (it must be —
  the old single-instance deploy would have set it for cookie
  signing). Multi-instance requires the **same** value across all
  instances; you'll re-confirm this in Step 4.
- [ ] You're on a maintenance window or a low-traffic period. The
  migration is designed to be zero-downtime for users, but a
  config typo at this stage is easier to recover from when nobody
  is in a session.

---

## What changes (and what doesn't)

### What changes

- Two **new Cosmos containers** are provisioned: `skills` and
  `instance-shared`.
- **Skills move** from the local file system to the `skills`
  container (one-time migration).
- **API key store** stops consulting `api-keys.json` in production
  — Cosmos becomes the only source of truth, so revocations
  propagate immediately across instances.
- **Triage rate limiter and circuit breaker** read/write through
  the `instance-shared` container.
- **App Service Health Check path** is set to `/api/health` so
  misconfigured instances drop out of the LB rotation
  automatically.
- **`NODE_ENV=production` + `COSMOS_ENDPOINT` unset** now fails
  startup — previously the app silently fell back to in-memory
  mock storage.

### What doesn't change

- Cosmos schema for the existing five containers.
- Conversation storage (already multi-instance-safe via the v2
  migration; see
  [`conversation-storage-v2-migration.md`](./conversation-storage-v2-migration.md)).
- Auth setup (Entra ID app registration, redirect URIs).
- API key shape, encryption, hashing.
- Anything in `MOCK_MODE=true` dev workflows — file-mode skills
  and `fs.watch` hot-reload still work locally.

---

## Migration steps

### Step 1 — Add the new Cosmos containers

Re-run the provisioning script with the same parameters you used
originally. The script is idempotent — existing containers are
no-ops; only the two new ones (`skills`, `instance-shared`) are
created.

```powershell
./scripts/provision-cosmos-db.ps1 `
    -ResourceGroupName "neo-rg" `
    -AccountName "neo-cosmos" `
    -DatabaseName "neo-db" `
    -WebAppName "neo-web"
```

Verify both containers exist:

```bash
az cosmosdb sql container list \
  --account-name neo-cosmos \
  --resource-group neo-rg \
  --database-name neo-db \
  --query "[].name" -o tsv
```

You should see seven entries: `conversations`, `usage-logs`,
`triageRuns`, `teams-mappings`, `api-keys`, **`skills`**,
**`instance-shared`**.

### Step 2 — Verify managed-identity RBAC

Pre-existing deployments already have **Cosmos DB Built-in Data
Contributor** assigned to the App Service MSI (otherwise the old
deploy couldn't read the `conversations` container). The new
containers inherit that role assignment automatically — no extra
step needed. Confirm with:

```bash
az cosmosdb sql role assignment list \
  --account-name neo-cosmos \
  --resource-group neo-rg \
  --query "[].roleDefinitionId" -o tsv
```

You should see at least one assignment ending in
`/00000000-0000-0000-0000-000000000002` (the data-contributor
role). If empty, re-run the provisioning script with `-WebAppName`
set so it assigns the role.

### Step 3 — Migrate skills file → Cosmos

One-time. Run from a workstation that has `az login` + the same
data-contributor role on the Cosmos account.

```bash
cd web

# Dry run first — reports what would migrate without writing.
COSMOS_ENDPOINT="https://neo-cosmos.documents.azure.com:443/" \
MOCK_MODE=false \
  npm run migrate:skills -- --dry-run

# If the dry-run output looks right, real run:
COSMOS_ENDPOINT="https://neo-cosmos.documents.azure.com:443/" \
MOCK_MODE=false \
  npm run migrate:skills
```

The script:
- Reads every `.md` file from `web/skills/`.
- Validates the filename against the skill-id rules
  (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`). Invalid IDs are skipped with a
  warning — fix the filename and re-run.
- Validates the parsed skill (required tools, role, description).
- Upserts to the `skills` container. Re-running is safe; identical
  content produces identical docs apart from `updatedAt`.

After the script finishes, the existing `web/skills/*.md` files are
no longer consulted in production (`MOCK_MODE=true` dev workflows
still read them). Don't delete the files — they're the canonical
source for code review and dev work; Cosmos is the runtime source.

### Step 4 — Update App Service settings

Three settings need attention. Set them via portal or CLI.

```bash
# Required for the multi-instance correctness guard
az webapp config appsettings set \
  --resource-group neo-rg --name neo-web \
  --settings \
    NODE_ENV=production \
    MOCK_MODE=false
```

Why each matters:

- **`NODE_ENV=production`** — flips the `validateConfig` startup
  guard on. With this set, the app refuses to boot when
  `COSMOS_ENDPOINT` is missing. Without it, the boot guard is
  inert and the app silently falls back to in-memory mock state
  (which is the bug this migration fixes).
- **`MOCK_MODE=false`** — required for the rate limiter and
  circuit breaker to actually read/write Cosmos. With `MOCK_MODE`
  unset or `true`, both primitives are no-ops (the limiter
  always allows, the breaker never trips).
- **`AUTH_SECRET`** — re-confirm it's set and identical across
  any deployment slots you have. Mismatched secrets cause PKCE
  cookie decryption to fail when a sign-in starts on instance A
  and resumes on instance B:
  ```bash
  az webapp config appsettings list \
    --resource-group neo-rg --name neo-web \
    --query "[?name=='AUTH_SECRET'].value" -o tsv
  ```
  If empty, generate one with `openssl rand -hex 32` and set it.

### Step 5 — Configure App Service Health Check

The deploy adds a new `/api/health` endpoint. Point App Service
Health Check at it so misconfigured instances drop out of the LB
automatically.

```bash
az webapp config set \
  --resource-group neo-rg --name neo-web \
  --generic-configurations '{"healthCheckPath":"/api/health"}'
```

Or via the portal: App Service → Monitoring → **Health Check** →
*Enable* → Path: `/api/health`.

What it does:
- Returns 200 when `validateConfig()` passes (Cosmos endpoint set,
  `ANTHROPIC_API_KEY` set, `DEV_AUTH_BYPASS` not enabled outside
  development).
- Returns 503 with the failing-check message in the body
  otherwise. App Service stops routing traffic to that instance
  until the probe succeeds again.

### Step 6 — Deploy the new code

Deploy the multi-instance branch as you normally would:

```powershell
./scripts/deploy-azure.ps1 `
    -ResourceGroupName "neo-rg" `
    -WebAppName "neo-web"
```

Watch the deploy land. The instance restart triggers
`instrumentation.ts:register()`, which runs:

1. `validateConfig()` — throws if `NODE_ENV=production` and
   `COSMOS_ENDPOINT` is unset. (Step 4 set both correctly.)
2. `assertCosmosContainers(env.COSMOS_ENDPOINT)` — point-reads
   each required container; throws naming the missing one. (Step 1
   created the new ones.)

Tail the log stream to confirm:

```bash
az webapp log tail --resource-group neo-rg --name neo-web | \
  grep -E "Cosmos startup check passed|cosmos-startup-check"
```

Expect a single `"Cosmos startup check passed"` line per instance
boot. If you see a `"Cosmos startup check failed"` line, the
container check found something missing — re-check Step 1.

**Stay at one instance for now.** Don't scale out until the
single-instance deploy is healthy.

### Step 7 — Scale out (1 → 2 instances)

Once the single-instance deploy is verified healthy:

```bash
az appservice plan update \
  --resource-group neo-rg --name neo-plan \
  --number-of-workers 2
```

The new instance boots, runs the same `instrumentation.ts` boot
guard, and starts taking traffic once `/api/health` returns 200.
Watch the log stream — you should see two `"Cosmos startup check
passed"` lines.

For autoscale rules, use App Service Plan → **Scale out** in the
portal. Recommended starting policy: 2 minimum, 4 maximum, scale
up at 70% CPU, scale down at 30% CPU.

### Step 8 — Disable ARR Affinity

ARR Affinity (sticky sessions) was acceptable as belt-and-suspenders
during the previous single-instance era. With shared-state Cosmos
backing every singleton, sticky sessions are no longer needed and
should be turned off so the LB can balance freely.

> App Service → your Web App → **Configuration** → **General settings**
> → **ARR affinity** = Off → Save.

CLI alternative:

```bash
az webapp update \
  --resource-group neo-rg --name neo-web \
  --client-affinity-enabled false
```

Leaving it on is a valid temporary state if you want extra caution
during the soak. The app does not depend on it.

---

## Verification

After Step 7's scale-out, walk through this checklist before
declaring the migration done.

### V1 — Both instances pass health check

```bash
# Hit /api/health a handful of times — different App Service
# instances will respond. All should return 200.
for i in {1..10}; do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    https://neo.your-domain.com/api/health
done
# Expect: 200 ten times.
```

### V2 — Skills appear identically on both instances

Open the slash-command popover in two browser tabs (different
sessions force the LB to route to different instances). Each
should show the same skill list. If the lists differ, one
instance's skill cache hasn't refreshed yet — wait 15 s (the
read-through cache TTL) and retry.

### V3 — Triage rate limiter shares state

```bash
# Send 101 triage requests; expect the 101st to hit the cap.
for i in $(seq 1 101); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -X POST https://neo.your-domain.com/api/triage \
    -H "X-API-Key: <test-key>" \
    -H "Content-Type: application/json" \
    -d "{\"alertId\": \"smoke-$i\", \"title\": \"smoke\", \"severity\": \"low\"}"
done | tail -3
# Expect: 200, 200, 429
```

If the 101st returns 200, the limiter is bypassed across instances.
Most common cause: `MOCK_MODE` is still `true` or unset (Step 4).

### V4 — Circuit breaker shares state

Trigger 10 consecutive failures (e.g. with deliberately malformed
alert payloads against an account whose Sentinel skill always
fails) until the breaker trips on instance A. Then send a triage
request — it should be refused regardless of which instance it
lands on. Reset with the admin endpoint:

```bash
curl -X POST https://neo.your-domain.com/api/admin/triage/circuit-breaker/reset \
  -H "Authorization: Bearer <admin-token>"
```

A 200 means the reset wrote to Cosmos successfully. A 500 means
the Cosmos write failed — see Troubleshooting in
[`deployment.md`](./deployment.md#troubleshooting).

### V5 — API key revocation propagates immediately

Revoke a test API key via the admin UI on one instance. Try to use
the revoked key against any instance — it should return 401
immediately. Pre-migration this required a restart.

### V6 — Teams thread continuity

If you have Teams integration enabled: post 5 messages in the same
Teams thread. The LB will round-robin them across instances.
Confirm a single Neo session — the `/chat/[id]` page should show
all 5 turns in one conversation, not multiple.

---

## Rollback

If verification fails badly enough to need a rollback:

### Code-only rollback

The migration is **forward-compatible** — the new code reads from
Cosmos but the old code reads from files. Rolling back the code
without changing Cosmos is safe:

```bash
# Re-deploy the previous git ref
git checkout <pre-migration-sha>
./scripts/deploy-azure.ps1 -WebAppName "neo-web"

# Scale back to 1 instance
az appservice plan update \
  --resource-group neo-rg --name neo-plan \
  --number-of-workers 1
```

The `skills` and `instance-shared` containers stay in Cosmos but
are unused. They cost nothing on the serverless tier when idle.
Re-applying the migration later is a no-op for those containers.

### Data rollback (skills only)

If you need to also undo the skill migration: the original
`web/skills/*.md` files weren't deleted, so the file-mode source
is intact. Pre-migration code reads from there.

The `skills` Cosmos container can be dropped if you want a clean
state:

```bash
az cosmosdb sql container delete \
  --account-name neo-cosmos \
  --resource-group neo-rg \
  --database-name neo-db \
  --name skills --yes
```

The `instance-shared` container is rate-limit / breaker state only;
deleting it just resets all counters and breaker history. Pre-
migration code doesn't touch it.

### Settings rollback

Set `MOCK_MODE=true` (or unset `NODE_ENV`) to put the app back into
the pre-migration mode where the boot guards are inert. Note this
is a regression in the security posture — only do it as part of a
genuine rollback, not as a workaround for a config issue.

---

## Watch-outs

### `AUTH_SECRET` mismatch

The single most common multi-instance failure mode. Sign-ins fail
with cryptic state-mismatch errors when the cookie is signed by
instance A and decrypted by instance B with a different secret.
`AUTH_SECRET` MUST be the same string in every App Service
instance and slot. Use a Key Vault reference if you have multiple
slots.

### Slot warm-up after scale-out

A newly-scaled-out instance starts cold. The first request on each
instance pays single-RU Cosmos point-read latency to warm the skill
cache and Teams session map. At typical traffic levels this is
sub-second and not user-visible — but if you see brief latency
spikes during scale events, this is why.

### `MOCK_MODE` polarity

Two modules check `MOCK_MODE` differently:
- `api-key-store.ts:useCosmosOnly()` requires `MOCK_MODE === "false"`.
- `skill-store.ts:useCosmos()` (post-migration) also requires
  `MOCK_MODE === "false"`.

Both treat unset / any-other-value as "stay in dev mode". Always set
`MOCK_MODE=false` explicitly in production — don't rely on defaults.

### Cosmos serverless RU spikes

The migration adds ~2 Cosmos RUs per triage request (one for the
rate limiter, one for the breaker). At 100 req/s sustained that's
200 RU/s baseline on the `instance-shared` container. Verify
against your Cosmos serverless quota; throttling on this container
manifests as the rate limiter failing open (which is the documented
fail-safe but not what you want under sustained load).

### Don't delete the `web/skills/*.md` files

After Step 3 they're no longer the runtime source, but they are
still the canonical source for code review and dev workflows
(`MOCK_MODE=true` reads them). The migration script is idempotent
so re-running is safe; deleting the files only loses the
human-readable history.

---

## What did NOT change

- **Conversation storage** is already multi-instance-safe (v2
  migration, separate work).
- **Usage tracking** already wrote to Cosmos pre-migration.
- **Pending confirmations** for destructive Teams actions already
  stored in Cosmos; round-trip across instances was never broken.
- **Output budget / context compression** is per-request and
  stateless across instances.
- **Auth.js session cookies** sign correctly across instances as
  long as `AUTH_SECRET` is consistent (which it had to be even on
  single-instance deploys with deployment slots).

If you find a new singleton you suspect isn't covered, capture it
and the failure mode — adding a seventh shared-state container is
one provisioning script change, one `cosmos-startup-check.ts`
entry, and one library refactor. The pattern is well-trodden now.

---

## See also

- [`deployment.md`](./deployment.md) — full greenfield deploy
  guide. Use this if you're standing up Neo for the first time.
- [`configuration.md`](./configuration.md) — env var reference.
- [`_plans/multi-instance-deployment.md`](../_plans/multi-instance-deployment.md) —
  internals: which six singletons moved and why.
- [`_specs/multi-instance-deployment.md`](../_specs/multi-instance-deployment.md) —
  acceptance criteria + load-test plan.
