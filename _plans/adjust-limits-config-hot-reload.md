# Adjust Limits Config for Hot Reload

## Context

Token usage limits are hardcoded in `web/lib/config.ts` at values far too low (55K/2h, 1.65M/week), causing users to hit the 2-hour cap after ~$0.54 of work. This plan raises the defaults to approximate $10/2h and $100/week of Opus usage, makes them configurable via environment variables (no rebuild needed), and adds an admin "Usage Limits" tab to `/settings` for viewing all users' usage and resetting individual windows. The user's answers to open questions: admin role is already in the auth system (`role === "admin"`), the admin view is a new tab on the existing settings page, resets require a confirmation dialog, and only token caps are configurable (not warning threshold or window durations).

---

## Key Design Decisions

- **Env vars read at runtime via `process.env`** — not cached in a frozen `as const` object, so Next.js dev hot reload picks up changes automatically. The `USAGE_LIMITS` export becomes a getter function (or a plain object without `as const`) that reads `process.env` on each access.
- **Defaults calibrated to Opus pricing** — Opus input is $15/M tokens. $10 budget ≈ 667K tokens (2h), $100 budget ≈ 6.67M tokens (weekly). Rounding to 670,000 and 6,700,000.
- **Reset via "reset marker" document** — instead of deleting historical usage records, store a per-user reset timestamp in a separate Cosmos container or as a special document. The budget query uses `MAX(resetTimestamp, windowStart)` as the effective window start. This preserves audit history.
- **Admin tab follows existing pattern** — the API Keys tab is already conditionally rendered for admins; the new "Usage Limits" tab uses the same mechanism.
- **Cross-partition query for all users** — the admin endpoint queries Cosmos across partitions grouped by userId. This is acceptable because it's an admin-only, infrequent operation.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | Replace hardcoded `USAGE_LIMITS` with env-var-driven values; add `parsePositiveInt` helper; update comment |
| `web/lib/usage-tracker.ts` | Change `TWO_HOUR_MS`/`WEEKLY_MS` to read from `USAGE_LIMITS` dynamically (not cached at module top); add `getAllUsersUsage()` function; add `resetUserWindow()` function; update `getUserUsage()` to respect reset markers |
| `web/app/api/usage/route.ts` | Update to read limits dynamically (already imports `USAGE_LIMITS`, just needs the export to be dynamic) |
| `web/app/api/admin/usage/route.ts` | **New file** — GET endpoint returning all users' usage summaries, admin-gated |
| `web/app/api/admin/usage/reset/route.ts` | **New file** — POST endpoint to reset a user's window, admin-gated |
| `web/components/SettingsPage/SettingsPage.tsx` | Add `'admin-usage'` to the `Tab` type and conditionally add it for admin users |
| `web/components/SettingsPage/AdminUsageSection.tsx` | **New file** — component showing all users' usage with progress bars and reset buttons |
| `web/components/SettingsPage/AdminUsageSection.module.css` | **New file** — styles for the admin usage section |
| `web/components/SettingsPage/SettingsPage.module.css` | Add any additional styles needed for the new tab content |
| `.env.example` | Add `USAGE_LIMIT_2H_INPUT_TOKENS` and `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` with comments |
| `test/adjust-limits-config.test.ts` | **New file** — tests for config parsing, budget enforcement, reset, and admin gate |

---

## Implementation Steps

### 1. Make USAGE_LIMITS env-configurable in `web/lib/config.ts`

- Add a `parsePositiveInt(envVar, defaultValue)` helper that reads `process.env[envVar]`, parses it as an integer, returns the default if missing/NaN/negative, and logs a `console.warn` on invalid values
- Replace the `USAGE_LIMITS` frozen object with a function `getUsageLimits()` that returns the same shape but reads env vars on each call:
  - `USAGE_LIMIT_2H_INPUT_TOKENS` → `twoHourWindow.maxInputTokens` (default 670,000)
  - `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` → `weeklyWindow.maxInputTokens` (default 6,700,000)
  - `windowMs` values remain hardcoded (not configurable per spec answers)
  - `warningThreshold` remains hardcoded at 0.80
- Also export a backward-compatible `USAGE_LIMITS` as a getter-based object (using `Object.defineProperty` or a simple object with getters) so existing imports (`import { USAGE_LIMITS } from "./config"`) continue working without changing every call site. Alternatively, convert to a function and update the 3 import sites.

### 2. Update `web/lib/usage-tracker.ts` to use dynamic limits

- Remove the module-level `TWO_HOUR_MS` and `WEEKLY_MS` constants. Instead, read `USAGE_LIMITS.twoHourWindow.windowMs` and `USAGE_LIMITS.weeklyWindow.windowMs` inside the functions that need them (`checkBudget`, `getUserUsage` calls within `checkBudget`)
- In `checkBudget()`, read `maxInputTokens` and `warningThreshold` from the (now dynamic) `USAGE_LIMITS` at call time instead of referencing cached constants

### 3. Add reset capability to `web/lib/usage-tracker.ts`

- Define a new document type for reset markers: `{ id: "reset_{uuid}", userId, window: "two-hour" | "weekly", resetAt: ISO string, ttl }`
- Add `resetUserWindow(userId: string, window: "two-hour" | "weekly"): Promise<void>` — creates a reset marker document in Cosmos
- Add `getLatestReset(userId: string, window: "two-hour" | "weekly"): Promise<string | null>` — queries for the most recent reset marker for the user+window combo
- Modify `getUserUsage()` (or `checkBudget()`) to incorporate the reset marker: when computing the `since` timestamp, use `MAX(now - windowMs, resetTimestamp)` if a reset marker exists

### 4. Add `getAllUsersUsage()` to `web/lib/usage-tracker.ts`

- Add a cross-partition Cosmos query that groups usage records by `userId` for both the 2-hour and weekly windows
- Return an array of `{ userId, displayName (if available), twoHourUsage: UsageSummary, weeklyUsage: UsageSummary }`
- This function is only called from the admin endpoint, so performance concerns are secondary to correctness

### 5. Create admin API endpoint `web/app/api/admin/usage/route.ts`

- GET handler:
  - Authenticate via `resolveAuth(request)`
  - Return 401 if not authenticated, 403 if `identity.role !== "admin"`
  - Call `getAllUsersUsage()` and return the results along with the current configured limits from `USAGE_LIMITS`
- Follow the existing admin-gated API pattern from `app/api/api-keys/route.ts`

### 6. Create reset API endpoint `web/app/api/admin/usage/reset/route.ts`

- POST handler:
  - Authenticate and admin-gate (same pattern as step 5)
  - Parse request body for `{ userId: string, window: "two-hour" | "weekly" }`
  - Validate the inputs
  - Call `resetUserWindow(userId, window)`
  - Return 200 on success

### 7. Create `AdminUsageSection` component

- **File:** `web/components/SettingsPage/AdminUsageSection.tsx`
- Props: `AdminUsageSectionProps { className?: string }`
- On mount, fetch `GET /api/admin/usage` to get all users' usage
- Render a table/card list of users, each showing:
  - User identifier (userId or display name)
  - Two `ProgressBar` components (2-hour and weekly windows) reusing the existing `ProgressBar` component
  - A "Reset" button for each window
- Reset button opens a confirmation dialog (simple modal or inline confirm pattern matching the ApiKeysSection revoke pattern: "Reset 2-hour usage for {user}? Yes / Cancel")
- On confirm, POST to `/api/admin/usage/reset` with the userId and window
- Refresh the usage list after a successful reset
- Create accompanying `.module.css` file following the 3-class rule and project conventions

### 8. Wire the new tab into `SettingsPage.tsx`

- Add `'admin-usage'` to the `Tab` union type
- Add `{ value: 'admin-usage', label: 'Usage Limits' }` to the admin-only tabs array (alongside `api-keys`)
- Add the conditional render: `{activeTab === 'admin-usage' && <AdminUsageSection />}`
- Import `AdminUsageSection` from the local directory

### 9. Update `.env.example`

- Add commented entries for `USAGE_LIMIT_2H_INPUT_TOKENS` and `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` with descriptions

### 10. Write tests in `test/adjust-limits-config.test.ts`

- **Config parsing tests:**
  - When env vars are set to valid numbers, `USAGE_LIMITS` reflects them
  - When env vars are missing, defaults (670K / 6.7M) are used
  - When env vars are non-numeric or negative, defaults are used and a warning is logged
- **Budget enforcement tests:**
  - Mock `getUserUsage` to return values near the new limits and verify `checkBudget` correctly allows/denies
- **Reset tests:**
  - Verify `resetUserWindow` creates a reset marker
  - Verify that after a reset, `checkBudget` uses the reset timestamp as the window start
- **Admin gate tests:**
  - Verify GET `/api/admin/usage` returns 403 for non-admin roles
  - Verify POST `/api/admin/usage/reset` returns 403 for non-admin roles

---

## Verification

1. Set `USAGE_LIMIT_2H_INPUT_TOKENS=100000` in `.env`, run `npm run dev`, verify the `/api/usage` response shows `twoHourLimit: 100000`
2. Change the env var to a different value, restart the dev server, confirm the new value is reflected
3. Set an invalid value (e.g., "abc"), confirm it falls back to the default (670000) and a warning appears in the server console
4. Log in as an admin user, navigate to `/settings`, confirm the "Usage Limits" tab appears
5. Confirm the tab shows all users with progress bars and current usage
6. Click "Reset" on a user's 2-hour window, confirm the confirmation dialog appears, confirm the reset, verify the progress bar updates
7. Log in as a reader user, confirm the "Usage Limits" tab does not appear
8. Run `cd web && npx vitest run test/adjust-limits-config.test.ts` (or equivalent test runner) to verify all tests pass
