# Lansweeper Asset Lookup & Risk Profile Tool

## Context

This is a **net new integration** — Lansweeper has no existing presence in the codebase. The tool adds a read-only `lookup_asset` executor that queries the Lansweeper GraphQL API to return a combined asset profile (identity, custom field tags, primary user, and vulnerability summary). It follows the established ThreatLocker integration pattern: secrets via Key Vault with env var fallback, mock/live dual-path, and registration across tools, executors, types, and integration-registry. The user's open question answers confirm: serial number lookup is supported, vulnerability pagination goes beyond 100, and both `LANSWEEPER_API_TOKEN` and `LANSWEEPER_SITE_ID` are stored in Key Vault.

---

## Key Design Decisions

- **Single tool, three internal queries**: The agent calls one `lookup_asset` tool. Internally the executor orchestrates up to three GraphQL calls (search → detail → vulnerabilities) so the agent gets a complete profile in one turn.
- **Search-type auto-detection**: Accept a single `search` string and optionally a `search_type` hint (`name`, `ip`, `serial`). If omitted, auto-detect by checking if the input matches an IP pattern or serial format, defaulting to name.
- **Full vulnerability pagination**: Iterate pages (100 per page) until all CVEs are fetched, then sort by `riskScore` descending. Return the full count and severity breakdown but only surface the top 10 CVEs in the response to keep output manageable.
- **Key Vault for secrets**: Use `getToolSecret("LANSWEEPER_API_TOKEN")` and `getToolSecret("LANSWEEPER_SITE_ID")` — the existing `secrets.ts` module handles Key Vault lookup with env var fallback, so no new Key Vault plumbing is needed.
- **Graceful degradation**: If vulnerability query fails (permissions/plan), still return asset identity and tags. If custom fields are missing, show "Not set". If no user data, report that clearly.
- **Read-only tool**: No confirmation gate needed — this tool only reads data.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `LookupAssetInput` interface and `LansweeperAssetProfile` response type |
| `web/lib/tools.ts` | Add `lookup_asset` tool schema to the `TOOLS` array |
| `web/lib/executors.ts` | Add `lookup_asset` executor with mock and live paths, `getLansweeperConfig()` helper, three GraphQL query functions, mock data function, and register in `executors` object |
| `web/lib/integration-registry.ts` | Add Lansweeper integration entry with slug, name, icon, description, capabilities, and secrets |
| `.env.example` | Add `LANSWEEPER_API_TOKEN` and `LANSWEEPER_SITE_ID` env var placeholders with comments |
| `test/lansweeper-asset-lookup.test.js` | New test file for mock response structure, search-type detection, custom field extraction, user fallback logic, and vulnerability aggregation |

---

## Implementation Steps

### 1. Define TypeScript types

In `web/lib/types.ts`:

- Add `LookupAssetInput` interface with fields: `search` (required string) and `search_type` (optional union: `"name" | "ip" | "serial"`).
- Add it in the tool input interfaces section alongside existing types like `ListThreatLockerApprovalsInput`.

### 2. Add tool schema

In `web/lib/tools.ts`:

- Add a new entry to the `TOOLS` array for `lookup_asset`.
- Description should explain it looks up an asset by hostname, IP, or serial number and returns identity, ownership tags, primary user, and vulnerability summary.
- Input schema: `search` (string, required — the hostname, IP address, or serial number to look up) and `search_type` (string enum, optional — hint for search type if ambiguous).
- Do NOT add to `DESTRUCTIVE_TOOLS` — this is read-only.

### 3. Implement the executor

In `web/lib/executors.ts`:

- **`getLansweeperConfig()` helper** — follows the `getThreatLockerConfig()` pattern. Fetches `LANSWEEPER_API_TOKEN` and `LANSWEEPER_SITE_ID` via `getToolSecret()`. Throws descriptive error if either is missing.

- **`lansweeperGraphQL()` helper** — accepts the config and a GraphQL query string + variables. POSTs to `https://api.lansweeper.com/api/v2/graphql` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Checks for HTTP errors and GraphQL `errors[]` in the response. Returns the `data` field.

- **Search-type detection** — if `search_type` is not provided, check if `search` matches an IPv4 pattern (`/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`). If so, treat as IP. Otherwise default to name. Serial number requires explicit `search_type: "serial"` or can be added to auto-detection if a pattern is identifiable.

- **`searchAsset()` function** — builds the `assetResources` GraphQL query with OR conditions for name (EQUAL), IP (LIKE), and serial number (EQUAL on `assetCustom.serialNumber` when search type is serial). Limit 5 results. Returns the items array.

- **`getAssetDetails()` function** — builds the `assetDetails` GraphQL query by asset key. Returns the full asset object including `assetBasicInfo`, `assetCustom` (with `fields[]`), `operatingSystem`, `loggedOnUsers`, `userRelations`.

- **`getAssetVulnerabilities()` function** — builds the `vulnerabilities` GraphQL query filtered by asset key. Implements pagination: fetches pages of 100 using cursor-based pagination (`page: FIRST` then `page: NEXT` with cursor) until all results are collected. Returns the full list.

- **`extractCustomTags()` helper** — takes the `assetCustom.fields[]` array and extracts Business Owner, BIA Tier, Role, and Technology Owner by matching on `name`. Returns an object with these four keys, defaulting each to `"Not set"` if not found.

- **`identifyPrimaryUser()` helper** — takes the `loggedOnUsers` array and `assetBasicInfo.userName`. Sorts `loggedOnUsers` by `numberOfLogons` descending. Returns the top entry, or falls back to `assetBasicInfo.userName`, or returns `"No user data available"`.

- **`buildVulnSummary()` helper** — takes the full vulnerability list. Computes total count, breakdown by severity (Critical/High/Medium/Low), and selects top 10 by `riskScore`. Returns the structured summary.

- **`lookup_asset()` main executor** — orchestrates the flow:
  1. If mock mode, return `mockLookupAsset(input)`.
  2. Get config via `getLansweeperConfig()`.
  3. Search for the asset. If zero results, return a "no results" message. If multiple results, return the disambiguation list with name, type, IP, and key for each match.
  4. If exactly one result, fetch full details via `getAssetDetails()`.
  5. Fetch vulnerabilities via `getAssetVulnerabilities()` — wrap in try/catch so a permissions error doesn't block the rest.
  6. Assemble and return the four-section response object.

- **`mockLookupAsset()` function** — returns realistic sample data with a Windows workstation asset, all four custom tags populated, a primary user with logon count, and a vulnerability summary with 3 sample CVEs of mixed severity.

- **Register** `lookup_asset` in the `executors` object at the bottom of the file, casting input to `LookupAssetInput`.

### 4. Register the integration

In `web/lib/integration-registry.ts`:

- Add a new entry to the `INTEGRATIONS` array for Lansweeper.
- `slug`: `"lansweeper"`
- `name`: `"Lansweeper"`
- `iconName`: `"Monitor"` (represents asset/device management)
- `imageSrc`: `"/lansweeper-logo.png"` (logo file to be added later, or use a placeholder path)
- `description`: text explaining Lansweeper is an IT asset management platform for looking up device profiles, ownership, and vulnerability data.
- `capabilities`: `["lookup_asset"]`
- `secrets`: array with two entries — `LANSWEEPER_API_TOKEN` (label: "API Token", description about the PAT from Developer Tools, required: true) and `LANSWEEPER_SITE_ID` (label: "Site ID", description about the Lansweeper site identifier, required: true).

### 5. Update environment example

In `.env.example`:

- Add a `# Lansweeper asset management` comment section.
- Add `LANSWEEPER_API_TOKEN=` and `LANSWEEPER_SITE_ID=` placeholders.
- Add a note that these are optional and only needed when `MOCK_MODE=false`.

### 6. Write tests

Create `test/lansweeper-asset-lookup.test.js` using `node:test` and `node:assert/strict`:

- **Search-type auto-detection**: Test that an IPv4 string is detected as IP, a hostname string as name, and explicit `search_type` overrides auto-detection.
- **Custom field extraction**: Provide a mock `fields[]` array with all four tags and verify extraction. Provide an empty array and verify all return "Not set".
- **Primary user identification**: Test with a `loggedOnUsers` array (unsorted) and verify the highest `numberOfLogons` entry is selected. Test with an empty array and a `userName` fallback. Test with both empty and verify the "No user data available" message.
- **Vulnerability summary aggregation**: Provide a mock vulnerability list with mixed severities and verify the total count, severity breakdown counts, and that top 10 are sorted by `riskScore` descending.
- **Mock response structure**: Replicate the mock function logic and assert all four sections (Asset Identity, Tags, Primary User, Vulnerability Summary) are present with expected field names.
- **Disambiguation list**: Test that when multiple assets are returned from search, the result contains a list with name, type, IP, and key per entry.

### 7. Verify

- Run `node --test test/lansweeper-asset-lookup.test.js` and confirm all tests pass.
- Run `cd web && npm run build` to confirm no TypeScript compilation errors.
- Manually verify mock mode by starting the CLI or web dev server with `MOCK_MODE=true` and asking Neo to look up an asset.

---

## Verification

1. All tests pass: `node --test test/lansweeper-asset-lookup.test.js`
2. Web build succeeds: `cd web && npm run build`
3. Mock mode returns a complete four-section asset profile when asking "Tell me about asset YOURPC01"
4. The tool appears in the integration registry on the Settings page
5. No TypeScript errors, no `any` types, all inputs validated
