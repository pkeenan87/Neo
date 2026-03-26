# Spec for AppOmni App Registration & Integration Risk Analyzer

branch: claude/feature/appomni-risk-analyzer

## Summary

Add AppOmni as a net-new integration to Neo, giving the SOC analyst agent visibility into the organization's SaaS security posture. AppOmni is a SaaS Security Posture Management (SSPM) platform that monitors connected SaaS applications for misconfigurations, excessive permissions, data exposure, and threats. This integration surfaces monitored services, posture findings, policy issues, insights, unified identities, and SaaS app discovery data directly into the Neo investigation workflow — enabling the agent to correlate SaaS posture issues with active security incidents.

This is a large feature: it adds a new integration entry, 12 new tools (11 read-only + 1 destructive), and the full mock/live executor dual-path implementation.

## API Details (from AppOmni API documentation)

### Authentication
- **OAuth2 Bearer Token** — access tokens obtained via refresh token grant flow (`POST /oauth/token/`) or manually granted with custom expiration (`POST /api/v1/core/oauthaccesstoken/manual/`)
- Auth header: `Authorization: Bearer <access_token>`
- Required secrets: access token (or refresh token + client ID + client secret for auto-refresh)

### Base URL Pattern
- `https://[subdomain].appomni.com/api/v1/...`
- The subdomain is the customer's instance name (e.g., `acme` for `acme.appomni.com`)

### Pagination
- **Offset-based pagination** throughout: `limit` (max results per page) + `offset` (items to skip)
- Default limits vary by endpoint (50–100), max limits vary (100–1000)
- Responses include `count`, `next`, `previous`, `results` fields

### Key API Domains

| API Area | Base Path | Key Endpoints |
|----------|-----------|---------------|
| Monitored Services | `/core/monitoredservice/` | List, detail (with annotations for risk scores, user counts) |
| Posture Findings | `/findings/finding/` | Unified view of policy issues + insights. List, detail, occurrences |
| Finding Occurrences | `/findings/occurrence/` | Individual violation instances. Update status, close by exception |
| Policy Issues | `/core/ruleevent/` | Open policy violations. Allow, close, list compliance controls |
| Insights | `/insights/discoveredinsight/` | Data exposure and risk insights. Dismiss, list occurrences |
| Unified Identities | `/core/unifiedidentity/` | Cross-service identity view. List, detail, linked service users |
| App Discovery | `/discovery/apps/` | Discovered SaaS apps, user activity pages, review status |
| Audit Logs | `/core/auditlogs/` | Platform audit trail with action type filtering |
| Policies | `/core/policy/` | Posture policies, scan initiation, scan status |

## Functional Requirements

### Integration Registration
- Add an "AppOmni" entry to the integration registry with slug `appomni`, icon, and description
- Required secrets:
  - `APPOMNI_ACCESS_TOKEN` — Bearer token for API authentication
  - `APPOMNI_SUBDOMAIN` — Tenant subdomain (e.g. `acme` for `acme.appomni.com`)
- Add the AppOmni logo to the public assets directory

### Read-Only Tools

1. **`list_appomni_services`** — List all monitored SaaS services. Calls `GET /api/v1/core/monitoredservice/?annotations=1`. Returns service ID, name, service type, score, connection state, open issues count, total/inactive/elevated-perm user counts. Supports filters: `service_type`, `integration_connected`, `score__gte`, `score__lte`, `search`. Paginated with `limit`/`offset`.

2. **`get_appomni_service`** — Get detailed info for a single monitored service. Calls `GET /api/v1/core/monitoredservice/{serviceType}/{serviceType}org/{id}`. Returns full metadata, sync status, user stats, preferences, and policy posture. Service ID is an integer.

3. **`list_appomni_findings`** — List posture findings (unified policy issues + insights). Calls `GET /api/v1/findings/finding/`. Returns finding ID (UUID), risk score, risk level, category, description, compliance frameworks, status, assignee, source type (scanner/insight), occurrence counts. Rich filtering: `status`, `risk_score__gte/lte`, `monitored_service__in`, `category__in`, `compliance_frameworks__in`, `source_type`, `first_opened__gte/lte`, date ranges. Max 100 per page.

4. **`get_appomni_finding`** — Get full details of a specific finding by UUID. Calls `GET /api/v1/findings/finding/{id}/`. Returns complete finding context including compliance controls, occurrence counts, external ticket data.

5. **`list_appomni_finding_occurrences`** — List violation instances for findings. Calls `GET /api/v1/findings/occurrence/`. Returns occurrence ID (UUID), context (user/resource details), detailed status (new/in_research/in_remediation/done), finding association. Supports filters: `finding_id`, `status`, `detailed_status_name__in`, `monitored_service__in`, date ranges. Max 100 per page.

6. **`list_appomni_insights`** — List data exposure and risk insights. Calls `GET /api/v1/insights/discoveredinsight/`. Returns insight ID, label, status (open/dismissed/closed), first/last seen dates, monitored service associations. Supports filters: `status`, `first_seen__gte/lte`, `last_seen__gte/lte`, `monitored_service__in`, `monitored_service__tags__in`. Max 500 per page.

7. **`list_appomni_policy_issues`** — List open policy issues (rule events). Calls `GET /api/v1/core/ruleevent/`. Returns issue ID, policy name, rule name, severity, status. Supports filters: `policy__in`, `service_org__in`, `service_org__type__in`, `service_org__tags__in`.

8. **`list_appomni_identities`** — List unified identities across all monitored services. Calls `GET /api/v1/core/unifiedidentity/annotated_list/`. Returns identity ID, name, email (identity_signature), status, permission level, last login, linked service count. Supports filters: `identity_status__in`, `permission_level__in`, `services_linked__in`, `service_types__in`, `last_login__gte/lte`, `search`, `tags__in`. Paginated.

9. **`get_appomni_identity`** — Get detailed unified identity profile. Calls `GET /api/v1/core/unifiedidentity/{identity_id}/`. Returns full identity details. A follow-up call to `GET /api/v1/core/unifiedidentity/{identity_id}/users` returns all linked monitored service user accounts with service type, permission level, active status.

10. **`list_appomni_discovered_apps`** — List SaaS apps discovered by AppOmni's app discovery module. Calls `GET /api/v1/discovery/apps/`. Returns app name, domain, company, categories, review status (approved/pending/rejected), criticality, owner. Supports filters: `status`, `criticality`, `owner`, `search`, `ordering`.

11. **`get_appomni_audit_logs`** — Retrieve AppOmni platform audit logs. Calls `GET /api/v1/core/auditlogs/`. Returns action type, user, timestamp, affected service/policy. Supports filters: `since`, `before`, `action_type`, `monitored_service`, `user`, `policy`. Useful for investigating who changed what in the SSPM platform.

### Destructive Tool

12. **`action_appomni_finding`** — Update the detailed status of finding occurrences or close by exception. Supports two actions:
    - **update_status** — Calls `PATCH /api/v1/findings/occurrence/update_detailed_status/` with occurrence IDs and a `detailed_status` (one of: `new`, `in_research`, `in_remediation`, `done`).
    - **close_exception** — Calls `PATCH /api/v1/findings/occurrence/close_by_exception/` with occurrence IDs, a `reason` (one of: `risk_accepted`, `false_positive`, `compensating_controls`, `not_applicable`, `confirmed_intended`), optional `expires` (ISO datetime), and optional `message`.

### Shared Helpers
- `getAppOmniConfig()` — Resolves access token and subdomain from Key Vault (falling back to env vars), constructs base URL as `https://{subdomain}.appomni.com`, validates subdomain format (alphanumeric + hyphens only), returns `{ accessToken, baseUrl }`
- `appOmniApi()` — Thin fetch wrapper that handles `Authorization: Bearer` header, base URL construction, offset/limit pagination params, error handling (401→"token expired/invalid", 403→"insufficient permissions", 429→"rate limited"), and JSON parsing

## Possible Edge Cases

- Subdomain could include the full URL or just the subdomain — normalize to extract just the subdomain portion
- Access tokens expire — handle 401 with clear "token expired, regenerate in AppOmni Settings > API Settings" message
- Findings API max limit is 100 per page — clamp `limit` to 1–100 range
- Finding/occurrence IDs are UUIDs, but service/identity IDs are integers — validate format appropriately per endpoint
- Policy issues require `service_type` in the URL path — may need to resolve from monitored service data first
- Some annotation fields (like `open_issues_count`, `elevated_perm_user_count`) only appear when `annotations=1` query param is included — always include it for list_appomni_services
- Insights and policy issues APIs will be deprecated in favor of the unified Findings API — prefer Findings endpoints where possible
- `close_by_exception` requires all occurrence IDs to be in "open" status — entire request fails if any are closed
- `update_detailed_status` only works on open occurrences — validate status before attempting

## Acceptance Criteria

- [ ] AppOmni appears in the integrations page with logo, description, and correct secret fields
- [ ] All 12 tools appear in the tool registry with correct schemas
- [ ] `action_appomni_finding` is in the DESTRUCTIVE_TOOLS set; all other AppOmni tools are read-only
- [ ] All executors have complete mock implementations returning realistic data
- [ ] All executors have live implementations using the documented AppOmni REST API endpoints
- [ ] Input validation: integer IDs for services/identities, UUID format for findings/occurrences
- [ ] Pagination parameters are bounded (limit clamped to 1–100 for findings, 1–50 for others)
- [ ] `annotations=1` is always included in monitored services list requests
- [ ] CLI has TOOL_COLORS entries for all 12 tools and TOOL_DESCRIPTIONS for the destructive tool
- [ ] README.md and docs/user-guide.md tool tables include all 12 tools
- [ ] Tests cover: input validation, mock return shapes, destructive tool classification, pagination clamping, UUID/integer ID validation

## Open Questions

_All previously open questions have been resolved from the API documentation:_

- **Base URL pattern**: `https://[subdomain].appomni.com/api/v1/...` — confirmed
- **Pagination**: Offset-based (`limit`/`offset`) throughout — confirmed
- **Actions on findings**: `update_detailed_status` (new/in_research/in_remediation/done) and `close_by_exception` (risk_accepted/false_positive/compensating_controls/not_applicable/confirmed_intended) — confirmed
- **Identity filtering**: Yes, `permission_level__in` and `last_login__gte/lte` filters available on unified identities — confirmed
- **Webhooks**: Not exposed in the API — audit logs are sent to configured "Destinations" (SIEM sinks) but there's no webhook subscription API

Remaining questions:
- Should we include the `dismiss_insight` tool (PATCH on insights) or rely solely on the unified Findings API for actions? lets get rid of the tool. not needed.
- Do we need `start_policy_scan` as a destructive tool, or is scan initiation too administrative for the SOC workflow? too administrative, not needed.

## Testing Guidelines

Create a test file at `./test/appomni-risk-analyzer.test.js` with meaningful tests for:

- Input validation: empty/missing required fields throw errors
- ID format validation: integer IDs for services/identities, UUID strings for findings/occurrences
- Pagination: limit clamped to valid range per endpoint type
- Destructive tool classification: `action_appomni_finding` is destructive, all others are not
- Tool schema expectations: required fields match for each tool
- Finding action validation: only valid `detailed_status` and `reason` values accepted
- Subdomain format validation: rejects URLs, accepts alphanumeric+hyphen subdomains
