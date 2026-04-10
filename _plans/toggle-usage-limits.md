# Toggle Usage Limits via Env Variable

## Context

Add an `ENABLE_USAGE_LIMITS` environment variable that enables or disables token budget enforcement across the entire application. When disabled, `checkBudget` always returns `{ allowed: true }` with infinite remaining tokens, budget alerts are not emitted, and the usage API still tracks consumption for reporting/dashboards but never blocks requests. This lets admins turn off rate limiting during demos, onboarding, or incident response without redeploying or changing per-user limits.

---

## Key Design Decisions

- **Single toggle in `checkBudget`** — Early-return the "all allowed" result when `ENABLE_USAGE_LIMITS` is false. This is the narrowest change possible: the agent route still calls `checkBudget`, reservations still track usage, dashboards still report cost — only the blocking behavior is disabled.
- **Default enabled for safety** — `ENABLE_USAGE_LIMITS` defaults to `true` when unset so existing deployments continue enforcing limits. Admins explicitly opt out.
- **Parse at env load time** — Follow the `MOCK_MODE` pattern: parse once into `env.ENABLE_USAGE_LIMITS` as a boolean, not at each call site.
- **Still track usage** — Cosmos writes for `recordUsage` and `createReservation` continue. This keeps dashboards accurate and lets admins flip the toggle back on without losing historical data.
- **Skip budget alerts when disabled** — The 80% warning events emitted from `checkBudget` should also be skipped when limits are off, since a "warning" with no enforcement is noise.
- **Usage API returns infinity for limits when disabled** — The `/api/usage` route should reflect the disabled state so the settings page UI can show "Limits disabled" instead of a progress bar.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `ENABLE_USAGE_LIMITS: boolean` to `EnvConfig` interface |
| `web/lib/config.ts` | Parse `ENABLE_USAGE_LIMITS` env var with default `true`; add to `env` object |
| `web/lib/usage-tracker.ts` | Early-return in `checkBudget` when limits are disabled; skip budget_alert emissions |
| `web/app/api/usage/route.ts` | Return an `enforced` flag so the UI knows whether limits are active |
| `web/components/SettingsPage/UsageSection.tsx` (if exists) | Show "Limits disabled" notice when `enforced` is false |
| `.env.example` | Document `ENABLE_USAGE_LIMITS` with comment explaining default and use cases |
| `docs/configuration.md` | Document the new toggle in the Usage Limits section |
| `test/toggle-usage-limits.test.js` | New test file verifying the toggle behavior |

---

## Implementation Steps

### 1. Add env var type to `web/lib/types.ts`

- Add `ENABLE_USAGE_LIMITS: boolean` to the `EnvConfig` interface next to `MOCK_MODE`

### 2. Parse env var in `web/lib/config.ts`

- Add a parsing line to the `env` object: `ENABLE_USAGE_LIMITS: process.env.ENABLE_USAGE_LIMITS !== "false"`
- This matches the `MOCK_MODE` pattern — defaults to `true` unless explicitly set to `"false"`
- Place it near `MOCK_MODE` for discoverability

### 3. Update `checkBudget` in `web/lib/usage-tracker.ts`

- At the top of the function, after the `getContainer()` null check, add an early return when `env.ENABLE_USAGE_LIMITS` is false
- The early return should still fetch usage via `getUserUsage` in parallel (so dashboards/reporting still get populated summaries) but return `allowed: true`, `twoHourRemaining: Infinity`, `weekRemaining: Infinity`, `warning: false`, and include the actual `twoHourUsage` and `weeklyUsage` summaries
- This means when limits are disabled, the function effectively becomes "track usage, never block, never warn"
- Skip the `budget_alert` event emissions entirely in this path

### 4. Update `/api/usage/route.ts`

- Add an `enforced` boolean field to the JSON response, set from `env.ENABLE_USAGE_LIMITS`
- The UI can use this to display a "Limits disabled" badge or hide progress bars

### 5. Update the settings page usage UI

- If `web/components/SettingsPage/UsageSection.tsx` exists and renders a usage chart, check the new `enforced` field
- When `enforced === false`, show a small "Usage limits are currently disabled" notice
- Keep the usage totals visible so users can still see their consumption

### 6. Update `.env.example`

- Add the new env var with a comment:
  ```
  # Usage limits — set to "false" to disable all token budget enforcement.
  # Default: true. Usage is still tracked for dashboards when disabled.
  ENABLE_USAGE_LIMITS=true
  ```
- Place it near the `MOCK_MODE` line

### 7. Update `docs/configuration.md`

- Find the Usage Limits section and add documentation for `ENABLE_USAGE_LIMITS`
- Explain the default, the three use cases (demos, onboarding, incident response), and the fact that usage tracking continues when disabled
- Note that per-user window overrides (`USAGE_LIMIT_2H_INPUT_TOKENS`, `USAGE_LIMIT_WEEKLY_INPUT_TOKENS`) have no effect when the global toggle is off

### 8. Create test file

- Create `test/toggle-usage-limits.test.js` with tests for:
  - Env parsing: `ENABLE_USAGE_LIMITS=false` → boolean `false`
  - Env parsing: `ENABLE_USAGE_LIMITS=true` → boolean `true`
  - Env parsing: unset → defaults to `true`
  - Env parsing: random string → defaults to `true` (only `"false"` disables)
  - Simulated `checkBudget` behavior: when disabled, `allowed` is `true` regardless of usage
  - Simulated `checkBudget` behavior: when enabled, existing enforcement applies

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Run tests: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/toggle-usage-limits.test.js`
3. Run existing tests for regressions: `cd /Users/pkeenan/Documents/Neo && /Users/pkeenan/.nvm/versions/node/v24.14.0/bin/node --test test/file-upload.test.js test/enhanced-observability-logging.test.js`
4. Manual: Set `ENABLE_USAGE_LIMITS=false`, run `npm run dev`, verify the agent works past the normal 2-hour budget limit
5. Manual: Set `ENABLE_USAGE_LIMITS=true` (or unset), verify budget enforcement still blocks at the limit
6. Manual: Check the settings page UI shows the "disabled" notice when limits are off
