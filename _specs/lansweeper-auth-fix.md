# Spec for lansweeper-auth-fix

branch: claude/feature/lansweeper-auth-fix

## Summary

The `lookup_asset` tool (and the integration test probe) return HTTP 401 when calling the Lansweeper GraphQL API v2, even though the same personal access token works in Postman. The current implementation sends `Authorization: Bearer <token>`, but Lansweeper's v2 API may require a different auth header format. This spec covers the investigation and fix to align the authentication with the working Postman configuration.

## Functional Requirements

- The `lansweeperGraphQL()` helper in `web/lib/executors.ts` must send the correct auth headers so that `POST https://api.lansweeper.com/api/v2/graphql` returns 200 instead of 401.
- The Lansweeper integration test probe in `web/app/api/integrations/[slug]/test/route.ts` must use the same corrected auth scheme.
- The fix must not break mock mode — the mock path is unaffected and must continue to return mock data.
- No new secrets or configuration fields should be required unless the Lansweeper auth scheme fundamentally requires a token exchange step (e.g., PAT → OAuth2 access token). If a token exchange is needed, document it clearly and add the exchange step inside `getLansweeperConfig()`.

## Investigation Notes (Required Before Implementation)

Before writing code, verify the correct authentication mechanism:

1. **Check Lansweeper's API docs** for their personal access token (PAT) auth header format. Common patterns for GraphQL APIs:
   - `Authorization: Bearer <token>` — currently used, returns 401
   - `Authorization: Token <token>` — alternative scheme some APIs use
   - A custom header like `X-API-Key: <token>`
   - OAuth2 client credentials exchange: POST the PAT to a token endpoint and use the returned JWT as the Bearer token

2. **Inspect the working Postman request** — the user has confirmed Postman works. The Postman Authorization tab header scheme and value format is the source of truth for the fix.

3. **Lansweeper PAT documentation**: Lansweeper personal access tokens (generated in Settings > Developer Tools) are used for API authentication. Verify whether they are used directly in the header or must be exchanged first.

## Possible Edge Cases

- If Lansweeper requires a PAT-to-JWT exchange, the token will have an expiry. The fix should cache the JWT in memory (similar to the Azure token cache pattern in `auth.ts`) and refresh when expired.
- The site probe query (`query { site(id: "...") { name } }`) must also use the corrected auth — update `web/app/api/integrations/[slug]/test/route.ts` alongside `executors.ts`.
- If the token format is `Token <pat>` (not `Bearer`), the existing `LANSWEEPER_API_TOKEN` secret field is correct and no UI changes are needed.

## Acceptance Criteria

- `Test Connection` on the Lansweeper integration settings page returns success.
- `lookup_asset` successfully returns asset data in live mode (`MOCK_MODE=false`) with a valid token.
- The fix is limited to `lansweeperGraphQL()` and the probe — no other callers need changes.
- No `any` types introduced. No new env vars unless a token exchange step is confirmed necessary.

## Open Questions

- Does Lansweeper's v2 GraphQL API require `Token` vs `Bearer` or something else entirely? - research the docs to get this answer
- Does the PAT need to be exchanged for a short-lived JWT, or is it used directly? - not sure research
- Is the Postman request using `Authorization: Bearer <pat>` verbatim, or a different scheme? not sure, do some research

## Testing Guidelines

No new test file needed — the existing integration test probe (`POST /api/integrations/lansweeper/test`) is the acceptance test. Verify it passes after the fix. The existing mock-mode unit tests for `lookup_asset` are unaffected.
