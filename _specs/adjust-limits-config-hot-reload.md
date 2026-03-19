# Spec for Adjust Limits Config for Hot Reload

branch: claude/feature/adjust-limits-config-hot-reload

## Summary

Token usage limits are currently hardcoded in `web/lib/config.ts` at values far too low (55K input tokens per 2 hours, 1.65M per week). Users are hitting the 2-hour cap after only ~$0.54 of usage. This feature raises the limits to act as genuine safety guardrails (not day-to-day throttles), makes them configurable via environment variables so they can be adjusted without a rebuild, and adds an admin view under `/settings` for per-user limit visibility and manual resets.

## Functional requirements

- Move the two-hour and weekly token budget values out of hardcoded constants and into environment variables with sensible defaults
- New env vars: `USAGE_LIMIT_2H_INPUT_TOKENS` (default ~670,000) and `USAGE_LIMIT_WEEKLY_INPUT_TOKENS` (default ~6,700,000), calibrated to approximate $10 and $100 of Opus usage respectively
- `USAGE_LIMITS` in `web/lib/config.ts` should read from `process.env` at runtime so that changing the env var and restarting the server (or leveraging Next.js hot reload in dev) takes effect without a code change or rebuild
- The warning threshold (currently 0.80) should also be configurable via env var (`USAGE_LIMIT_WARNING_THRESHOLD`, default 0.80)
- Add a new "Admin: Usage Limits" section to the existing `/settings` page (or a new tab) that:
  - Lists all users with their current 2-hour and weekly token usage vs. the configured limits
  - Shows progress bars for each window
  - Provides a "Reset" action per user that clears their usage counters for the selected window
- The admin section should be gated behind an admin check (define approach based on existing auth patterns)

## Possible Edge Cases

- Env var values that are non-numeric or negative should fall back to defaults with a console warning
- Resetting a user's usage mid-window should not affect their historical usage records, only the current rolling window counters
- If limits are lowered while a user is mid-session, the next budget check should enforce the new lower limit
- Race condition: two concurrent reset requests for the same user should be idempotent

## Acceptance Criteria

- Two-hour and weekly token limits are read from environment variables at server start
- Changing the env vars and restarting the Next.js server updates the enforced limits without any code change
- Default limits approximate $10 of Opus usage per 2-hour window and $100 per weekly window
- The `/settings` page has an admin-visible section showing per-user usage and limits
- Admins can reset a specific user's usage for a specific window from the settings UI
- Existing usage tracking logic (`usage-tracker.ts`) continues to work with the new configurable values
- Invalid env var values fall back to defaults gracefully

## Open Questions

- What determines admin status? Is there an existing role/claim in the auth context, or do we need a new mechanism (e.g., an `ADMIN_EMAILS` env var)? read my code, they will have a role of admin.
- Should the admin usage view be a new tab on `/settings` or a separate `/admin/usage` route? new tab on settings
- Should the reset action require a confirmation dialog? yes.
- Do we also want to make `warningThreshold` and `windowMs` durations configurable, or just the token caps? just token caps.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Config parsing: valid env vars override defaults, missing env vars use defaults, invalid (non-numeric/negative) env vars fall back to defaults with warning
- Usage limit enforcement: verify that the usage tracker respects the new configurable values rather than the old hardcoded ones
- Reset endpoint: calling reset clears the rolling window for the targeted user and window, does not affect other users or other windows
- Admin gate: non-admin users cannot access the usage list or trigger resets
