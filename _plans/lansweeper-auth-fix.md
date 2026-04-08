# Lansweeper Auth Fix

## Context

The `lansweeperGraphQL()` helper in `web/lib/executors.ts` sends `Authorization: Bearer <token>`, but the Lansweeper GraphQL API v2 requires `Authorization: Token <token>` when authenticating with a Personal Access Token (PAT). OAuth-issued JWTs use `Bearer`; PATs use `Token`. This is a one-line header fix plus the same change in the integration test probe.

---

## Key Design Decisions

- **Header-only change**: No token exchange, no new secrets, no caching needed. PATs are long-lived and sent directly in the `Token` scheme.
- **Both call sites updated together**: `lansweeperGraphQL()` in `executors.ts` and the Lansweeper probe in `test/route.ts` both send the wrong header — fix both in the same change so they stay in sync.
- **No impact on mock mode**: The mock path in `lookup_asset` short-circuits before `lansweeperGraphQL()` is called. No mock changes needed.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/executors.ts` | In `lansweeperGraphQL()`, change the `Authorization` header value from `Bearer ${config.apiToken}` to `Token ${config.apiToken}` |
| `web/app/api/integrations/[slug]/test/route.ts` | In the `"lansweeper"` probe, change the `Authorization` header value from `Bearer ${apiToken}` to `Token ${apiToken}` |

---

## Implementation Steps

### 1. Fix `lansweeperGraphQL()` in `executors.ts`

- Locate `lansweeperGraphQL()` around line 1748.
- Change the `Authorization` header from `Bearer ${config.apiToken}` to `Token ${config.apiToken}`.
- No other changes to this function.

### 2. Fix the Lansweeper probe in `test/route.ts`

- Locate the `"lansweeper"` probe entry in the `PROBES` object.
- Change the `Authorization` header from `Bearer ${apiToken}` to `Token ${apiToken}`.
- No other changes to the probe.

---

## Verification

1. In the web UI, go to Settings > Integrations > Lansweeper and click **Test Connection** — it should return success.
2. In live mode (`MOCK_MODE=false`), ask Neo to look up an asset — `lookup_asset` should return real asset data.
3. Run existing tests to confirm mock mode is unaffected: `node --test test/`

Sources:
- [Lansweeper API Quickstart](https://developer.lansweeper.com/docs/data-api/get-started/quickstart/)
- [Lansweeper GraphQL Endpoint](https://developer.lansweeper.com/docs/data-api/get-started/endpoint/)
