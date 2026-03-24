# Spec for Defender XDR Indicator Blocking

branch: claude/feature/defender-xdr-indicator-blocking

## Summary

Add tools to create, list, and delete custom indicators in Microsoft Defender for Endpoint — covering domains, IP addresses, URLs, and file hashes. This enables SOC analysts to block malicious IoCs at the endpoint level (via Network Protection and Defender AV) directly from Neo, without relying on VPN connectivity or firewall rule propagation. Uses the native Defender for Endpoint API (`https://api.securitycenter.microsoft.com`) — NOT the deprecated Graph tiIndicator API.

## Functional requirements

- Add a new tool `block_indicator` (destructive, requires confirmation) that creates a Block indicator via `POST /api/indicators` on the Defender for Endpoint API
  - Accepts: `value` (the domain, IP, URL, or hash), `indicator_type` (domain, ip, url, sha1, sha256, md5), `title` (required), `description` (optional), `severity` (informational/low/medium/high, default high), `expiration` (optional ISO-8601 datetime), `action` (block/warn/audit, default block), `generate_alert` (boolean, default true)
  - Maps `indicator_type` to Defender enum: domain → DomainName, ip → IpAddress, url → Url, sha1 → FileSha1, sha256 → FileSha256, md5 → FileMd5
  - For file hash indicators with `action: "block"`, uses `BlockAndRemediate` action; for network indicators stays with `Block`
  - Sets `rbacGroupNames: ["All Devices"]` by default

- Add a new tool `list_indicators` (read-only) that queries `GET /api/indicators` with optional OData filters
  - Accepts: `indicator_type` (optional filter), `top` (optional limit, default 25)
  - Returns indicator list with id, value, type, action, title, severity, creation time, expiration

- Add a new tool `delete_indicator` (destructive, requires confirmation) that removes an indicator via `DELETE /api/indicators/{id}`
  - Accepts: `indicator_id` (required numeric ID)

- Auth uses the existing `getAzureToken("https://api.securitycenter.microsoft.com")` — same token endpoint and scope already used by Defender machine tools. Requires `Ti.ReadWrite.All` application permission.

- All tools follow the existing mock/live dual-path pattern
- `block_indicator` and `delete_indicator` are destructive (admin-only, require confirmation)
- `list_indicators` is read-only (available to all roles)
- Add all tools to the CLI color mappings and TOOL_DESCRIPTIONS

## Possible Edge Cases

- Duplicate indicator — the API may return a 400 if the same value+type already exists; handle gracefully with a clear message
- Tenant at the 15,000 indicator limit — the API returns a specific error; surface it clearly
- Rate limiting — 100 calls/min for submit, 30/min for batch; handle 429 responses
- Invalid indicator value — a domain that's not a valid domain, an IP that's not valid, a hash that's wrong length; validate before API call
- File hash action mismatch — `BlockAndRemediate` is only valid for file indicators, not network; ensure the tool maps correctly
- Expiration in the past — validate and reject before sending to the API
- Network Protection not enabled on endpoints — indicators will be created successfully but won't enforce; the tool can't detect this, just document the prerequisite

## Acceptance Criteria

- An analyst can say "block the domain evil.example.com in Defender, high severity, expires in 90 days" and Neo creates the indicator with confirmation
- `list_indicators` returns current custom indicators filtered by type
- `delete_indicator` removes an indicator by ID with confirmation
- All tools work in mock mode with realistic simulated data
- Block/delete go through the confirmation gate (destructive tools)
- Auth uses the existing Defender token (`api.securitycenter.microsoft.com` scope)
- Tool color mappings and descriptions are added to the CLI

## Open Questions

- Should we also support the batch `import` endpoint for bulk indicator creation? Defer to a follow-up — single indicator creation covers the primary use case. yes lets support batch also. 
- Should `rbacGroupNames` be configurable per-indicator, or always "All Devices"? Start with all devices, add group targeting later if needed. all devices.
- Should we add `CertificateThumbprint` as an indicator type? Defer — it's rare and can be added later. yes.
- Does the existing app registration already have `Ti.ReadWrite.All`? Needs to be added if not. No it does not, update the docs with the info needed.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Indicator type mapping: domain → DomainName, ip → IpAddress, etc.
- File hash action mapping: block + file type → BlockAndRemediate
- Block and delete are in DESTRUCTIVE_TOOLS set
- List is NOT in DESTRUCTIVE_TOOLS set
- Tool schemas have expected required/optional parameters
- Indicator value validation: domain format, IP format, hash lengths (SHA-1=40, SHA-256=64, MD5=32)
