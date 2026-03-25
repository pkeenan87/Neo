# Spec for Lansweeper Asset Lookup & Risk Profile Tool

branch: claude/feature/lansweeper-asset-lookup

## Summary

Neo executor that queries the Lansweeper GraphQL API to retrieve a comprehensive asset profile — including custom field tags (Business Owner, BIA Tier, Role, Technology Owner), vulnerability data, and most frequently logged-in user — all in a single conversational response. This bridges asset management context into security operations, eliminating manual Lansweeper portal lookups.

## Functional requirements

- **Asset lookup by name or IP**: When the asset key is unknown, use the `assetResources` query with OR filters on `assetBasicInfo.name` (EQUAL) and `assetBasicInfo.ipAddress` (LIKE) to resolve the asset key first. Return up to 5 matching results.
- **Asset detail retrieval**: Use the `assetDetails` query (no field limit) to pull full asset info by key, including `assetBasicInfo`, `assetCustom` (with custom fields), `operatingSystem`, `loggedOnUsers`, and `userRelations`.
- **Custom field tag extraction**: Extract Business Owner, BIA Tier, Role, and Technology Owner from `assetCustom.fields[]` by matching on field `name`. Surface these prominently in the response.
- **Primary user identification**: Determine the most frequently logged-in user from `loggedOnUsers` sorted by `numberOfLogons` descending. Fall back to `assetBasicInfo.userName` when `loggedOnUsers` is empty.
- **Vulnerability enrichment**: Run a separate `vulnerabilities` query filtered by asset key (up to 100 results). Return total count, breakdown by severity, and top 5 CVEs by risk score with affected product and attack vector.
- **Structured output**: Response should include four sections: Asset Identity, Tags/Custom Fields, Primary User, and Vulnerability Summary.
- **Mock/Live dual-path**: Mock mode returns realistic sample data; live mode calls `https://api.lansweeper.com/api/v2/graphql` with Bearer token auth.
- **Three coordinated GraphQL queries**: (1) `assetResources` for lookup by name/IP, (2) `assetDetails` for full profile, (3) `vulnerabilities` for CVE data. The tool orchestrates these internally — the agent calls one tool and gets the combined result.
- **Environment variables**: Requires `LANSWEEPER_API_TOKEN` (Bearer PAT) and `LANSWEEPER_SITE_ID` in `.env`.

## Possible Edge Cases

- Asset not found by name or IP — return a clear "no results" message rather than an error.
- Multiple assets match the search term — return a summary list of matches (up to 5) and ask the user to clarify by asset key or name.
- Custom fields (Business Owner, BIA Tier, etc.) not yet configured in Lansweeper — gracefully show "Not set" rather than failing.
- `loggedOnUsers` array is empty — fall back to `assetBasicInfo.userName`; if that is also empty, report "No user data available".
- Asset has more than 100 vulnerabilities — note the total count and indicate results are capped at 100, sorted by risk score.
- Lansweeper API returns auth errors (expired/invalid PAT) — surface a clear auth failure message.
- Site ID is invalid or the user lacks permissions — handle the GraphQL error response gracefully.
- Vulnerability data requires Pro/Enterprise plan — if the query fails with a permissions error, still return asset details and note that vulnerability data is unavailable.

## Acceptance Criteria

- Running `lookup_asset` with a hostname returns the full four-section profile (Identity, Tags, Primary User, Vulnerabilities).
- Running `lookup_asset` with an IP address resolves to the correct asset and returns the same profile.
- When multiple assets match, the tool returns a disambiguation list instead of arbitrarily picking one.
- Custom field tags are extracted and displayed when present; missing tags show "Not set".
- Vulnerability summary includes total count, severity breakdown, and top 5 CVEs.
- Mock mode returns believable sample data covering all four output sections without requiring API credentials.
- The tool is registered in `tools.js`, added to `executors.js`, and is read-only (no confirmation gate).
- Environment variable validation warns at startup if `LANSWEEPER_API_TOKEN` or `LANSWEEPER_SITE_ID` are missing when `MOCK_MODE=false`.

## Open Questions

- Should the tool support lookup by serial number in addition to name/IP? yes.
- Should vulnerability pagination beyond 100 be supported (iterating pages), or is a capped top-100-by-risk-score sufficient? yes, beyond 100.
- Is the Lansweeper PAT stored in Azure Key Vault and fetched at runtime, or read directly from `.env`? it should be in the key vault, this will be a net new integration
- Should the tool cache the site ID via the `authorizedSites` query, or always use the configured env var? it should be in the key vault and it should use that

## Testing Guidelines
Create a test file(s) in the ./test folder for the new feature, and create meaningful tests for the following cases, without going too heavy
- Mock executor returns all four sections with expected fields populated
- Search by hostname resolves correctly and triggers the detail + vulnerability queries
- Search by IP resolves correctly
- Multiple matches returns a disambiguation list
- Missing custom fields render as "Not set"
- Empty `loggedOnUsers` falls back to `assetBasicInfo.userName`
- Vulnerability count and severity breakdown are calculated correctly from mock data
- Auth/permission errors are handled gracefully without crashing the agent loop
