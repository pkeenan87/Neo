# Defender XDR Indicator Blocking

## Context

SOC analysts need to block malicious domains, IPs, URLs, and file hashes at the endpoint level via Defender for Endpoint custom indicators, without depending on VPN connectivity. This plan adds four tools: `block_indicator` (single), `import_indicators` (batch), `list_indicators`, and `delete_indicator`. Auth reuses the existing `getAzureToken("https://api.securitycenter.microsoft.com")`. The app registration needs `Ti.ReadWrite.All` (WindowsDefenderATP) added. Indicator types include CertificateThumbprint. The deprecated Graph `tiIndicator` API is NOT used.

---

## Key Design Decisions

- **Four tools** — `block_indicator` (destructive, single IoC), `import_indicators` (destructive, batch up to 500), `list_indicators` (read-only), `delete_indicator` (destructive). Three destructive tools require admin + confirmation.
- **Existing Defender auth** — same `getAzureToken("https://api.securitycenter.microsoft.com")` already used for isolation tools. Only new permission is `Ti.ReadWrite.All`.
- **API base URL** — `https://api.securitycenter.microsoft.com` (same host as machine/isolation endpoints).
- **Indicator type mapping** — tool accepts short names (`domain`, `ip`, `url`, `sha1`, `sha256`, `md5`, `cert`) and maps to Defender enums (`DomainName`, `IpAddress`, `Url`, `FileSha1`, `FileSha256`, `FileMd5`, `CertificateThumbprint`).
- **Smart action mapping** — for file hash types with `action: "block"`, automatically uses `BlockAndRemediate`; for network types stays with `Block`. The `warn` and `audit` actions pass through as-is.
- **Input validation** — validate hash lengths (SHA-1=40, SHA-256=64, MD5=32), IP format, domain format before API call. CertificateThumbprint validated as 40-char hex (SHA-1 thumbprint).
- **All Devices** — `rbacGroupNames` hardcoded to `["All Devices"]`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `BlockIndicatorInput`, `ImportIndicatorsInput`, `ListIndicatorsInput`, `DeleteIndicatorInput` interfaces |
| `web/lib/tools.ts` | Add 4 tool schemas; add `block_indicator`, `import_indicators`, `delete_indicator` to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add 4 executor functions with indicator type/action mapping, validation, mock/live paths; register in executors record |
| `cli/src/index.js` | Add TOOL_COLORS (4 entries) and TOOL_DESCRIPTIONS (3 destructive entries) |
| `docs/configuration.md` | Add `Ti.ReadWrite.All` to API permissions table |
| `docs/user-guide.md` | Add 4 tools to tool reference table |
| `README.md` | Add 4 tools to tools table |
| `test/defender-xdr-indicators.test.js` | New test file |

---

## Implementation Steps

### 1. Add input types in `web/lib/types.ts`

- `BlockIndicatorInput`: `value` (required string), `indicator_type` (required, enum: `"domain" | "ip" | "url" | "sha1" | "sha256" | "md5" | "cert"`), `action` (optional: `"block" | "warn" | "audit"`, default `"block"`), `title` (required string), `description` (optional string), `severity` (optional: `"informational" | "low" | "medium" | "high"`, default `"high"`), `expiration` (optional ISO-8601 string), `generate_alert` (optional boolean, default true)
- `ImportIndicatorsInput`: `indicators` (required array of objects, each with `value`, `indicator_type`, `action`, `title`, `severity`), `description` (optional shared description), `expiration` (optional shared expiration)
- `ListIndicatorsInput`: `indicator_type` (optional filter), `top` (optional number, default 25)
- `DeleteIndicatorInput`: `indicator_id` (required number)

### 2. Add tool schemas in `web/lib/tools.ts`

- Add `block_indicator` after the existing Defender tools:
  - Description: "⚠️ DESTRUCTIVE — Create a custom indicator in Microsoft Defender for Endpoint to block, warn, or audit a domain, IP, URL, or file hash at the endpoint level."
  - Properties: `value` (required), `indicator_type` (required, enum), `action` (optional), `title` (required), `description`, `severity`, `expiration`, `generate_alert`
- Add `import_indicators`:
  - Description: "⚠️ DESTRUCTIVE — Batch import up to 500 custom indicators into Defender for Endpoint."
  - Properties: `indicators` (required array), `description`, `expiration`
- Add `list_indicators`:
  - Description: "List current custom indicators in Defender for Endpoint. Filterable by indicator type."
  - Properties: `indicator_type` (optional), `top` (optional, default 25)
- Add `delete_indicator`:
  - Description: "⚠️ DESTRUCTIVE — Delete a custom indicator from Defender for Endpoint by its numeric ID."
  - Properties: `indicator_id` (required)
- Add `block_indicator`, `import_indicators`, `delete_indicator` to DESTRUCTIVE_TOOLS

### 3. Add executor functions in `web/lib/executors.ts`

- Import the 4 new input types
- Add an `INDICATOR_TYPE_MAP` constant mapping short names to Defender enums: `{ domain: "DomainName", ip: "IpAddress", url: "Url", sha1: "FileSha1", sha256: "FileSha256", md5: "FileMd5", cert: "CertificateThumbprint" }`
- Add a `FILE_INDICATOR_TYPES` set containing `"FileSha1"`, `"FileSha256"`, `"FileMd5"` — used to determine when `BlockAndRemediate` applies
- Add a `HASH_LENGTHS` map: `{ sha1: 40, sha256: 64, md5: 32, cert: 40 }` for validation
- Add validation functions: validate hash length for hash types, basic IP format check for ip type, basic domain format for domain type, URL must start with http(s) for url type

**`block_indicator`**:
- Validate inputs (type, value format, expiration not in past)
- Mock path: return success object with indicator ID, value, type, action
- Live path: get Defender token, determine `indicatorType` from map, determine `action` (if file type + block → `BlockAndRemediate`; else map block→Block, warn→Warn, audit→Audit), POST to `/api/indicators` with full body, return API response
- Log via `logger.info`

**`import_indicators`**:
- Validate each indicator in the array (same validation as block_indicator per item)
- Cap array at 500 items (API limit)
- Mock path: return success count
- Live path: get Defender token, map each indicator to the API format, POST to `/api/indicators/import` with `{ Indicators: [...] }`, return per-indicator results
- Log via `logger.info`

**`list_indicators`**:
- Mock path: return realistic array of 3 indicators
- Live path: get Defender token, build URL with OData params (`$filter=indicatorType eq 'DomainName'` if type provided, `$top=25`), GET `/api/indicators?...`, return value array

**`delete_indicator`**:
- Validate `indicator_id` is a positive integer
- Mock path: return success
- Live path: get Defender token, DELETE `/api/indicators/{id}`, expect 204, return success
- Log via `logger.info`

- Register all 4 in the executors record

### 4. Add CLI display config in `cli/src/index.js`

- TOOL_COLORS: `list_indicators: chalk.yellow`, `block_indicator: chalk.red.bold`, `import_indicators: chalk.red.bold`, `delete_indicator: chalk.red.bold`
- TOOL_DESCRIPTIONS: `block_indicator: "Block {indicator_type} indicator: {value}"`, `import_indicators: "Import {count} indicators into Defender"`, `delete_indicator: "Delete Defender indicator #{indicator_id}"`

### 5. Update docs

- `docs/configuration.md`: Add `Ti.ReadWrite.All` (WindowsDefenderATP) to the API permissions table, used by `block_indicator`, `import_indicators`, `list_indicators`, `delete_indicator`
- `docs/user-guide.md`: Add all 4 tools to the tool reference table (list as All, block/import/delete as Admin)
- `README.md`: Add all 4 tools to the tools table

### 6. Write tests in `test/defender-xdr-indicators.test.js`

- Indicator type mapping: all 7 types map correctly (including cert → CertificateThumbprint)
- File hash action: block + sha256 → BlockAndRemediate; block + domain → Block
- Warn and audit actions pass through for both file and network types
- Hash length validation: sha1=40 chars, sha256=64 chars, md5=32 chars, cert=40 chars
- Block, import, and delete are in DESTRUCTIVE_TOOLS
- List is NOT in DESTRUCTIVE_TOOLS
- Tool schemas: block requires value + indicator_type + title; list has no required params; delete requires indicator_id
- Import array capped at 500

---

## Verification

1. Run `node --experimental-strip-types --test test/defender-xdr-indicators.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "block the domain evil.example.com in Defender, high severity" — verify confirmation gate fires and mock success
4. Ask "list defender indicators" — verify mock list returns
5. Ask "delete defender indicator 12345" — verify confirmation gate fires
6. Verify docs have `Ti.ReadWrite.All` in the permissions table
