# Fix Tool API Endpoints

> Correct the API URLs and authentication targets for `run_sentinel_kql` and the MFA sub-call in `get_user_info` so that live mode (MOCK_MODE=false) hits the correct Microsoft endpoints.

## Problem

Two tool executors in `web/lib/executors.ts` use incorrect API URLs, causing failures when `MOCK_MODE=false`:

1. **`run_sentinel_kql`** targets the ARM management API (`https://management.azure.com/.../api/query`) instead of the dedicated Log Analytics query API (`https://api.loganalytics.io/v1/workspaces/{workspaceId}/query`). The ARM path requires a different resource scope and returns a different response shape than what the agent expects.

2. **`get_user_info`** — the MFA registration details sub-call uses a direct resource path (`/userRegistrationDetails/{encodedUpn}`) which does not exist. The correct endpoint is a collection filtered by UPN: `/reports/authenticationMethods/userRegistrationDetails?$filter=userPrincipalName eq '{upn}'`.

Both tools work correctly in mock mode. The bugs only surface with real Azure credentials.

## Goals

- Fix the `run_sentinel_kql` executor to call the Log Analytics API at `https://api.loganalytics.io/v1/workspaces/{workspaceId}/query` with the correct token scope (`https://api.loganalytics.io`)
- Fix the MFA sub-call in `get_user_info` to use the `$filter` query parameter instead of a direct resource path
- Remove any leftover debug logging statements (`console.error`) from the executor functions
- Ensure mock mode behaviour is unchanged

## Non-Goals

- Changing tool schemas, adding new tools, or modifying the agent loop
- Changing the mock data or mock implementations
- Altering the authentication module (`web/lib/auth.ts`)
- Modifying the CLI client (changes are server-side only)

## Changes Required

### 1. `run_sentinel_kql` — Switch to Log Analytics API

**Current**: Requests a token for `https://management.azure.com` and posts to the ARM workspace query endpoint.

**Correct**: Request a token for `https://api.loganalytics.io` and post to `https://api.loganalytics.io/v1/workspaces/{SENTINEL_WORKSPACE_ID}/query`.

The `SENTINEL_WORKSPACE_ID` environment variable already exists and contains the Log Analytics workspace GUID needed for this URL. The ARM-specific variables (`AZURE_SUBSCRIPTION_ID`, `SENTINEL_RG`, `SENTINEL_WORKSPACE_NAME`) are no longer needed by this function but are still used by `get_sentinel_incidents`.

### 2. `get_user_info` MFA sub-call — Use $filter query

**Current**: `GET /v1.0/reports/authenticationMethods/userRegistrationDetails/{encodedUpn}`

**Correct**: `GET /v1.0/reports/authenticationMethods/userRegistrationDetails?$filter=userPrincipalName eq '{upn}'`

The UPN in the filter value should be OData-escaped using the existing `escapeODataString` helper.

### 3. Remove debug logging

Remove `console.error` statements from executor functions that log internal details (token info, response bodies, debug context). Error handling should throw errors with descriptive messages, not log to stderr.

## Validation

- Run the web server with `MOCK_MODE=true` and verify all tools still return mock data
- With real Azure credentials (`MOCK_MODE=false`), confirm:
  - `run_sentinel_kql` successfully queries Log Analytics and returns the standard `{ tables: [...] }` response
  - `get_user_info` returns MFA registration details in the `mfa` field
  - No `console.error` output appears during normal tool execution
