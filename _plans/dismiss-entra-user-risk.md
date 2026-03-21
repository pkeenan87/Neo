# Dismiss Entra User Risk

## Context

High-risk users in Entra ID Identity Protection are blocked by conditional access policies. Analysts need to dismiss the risk after investigating, but currently must switch to the Entra portal. This plan adds a single new destructive tool `dismiss_user_risk` that resolves a user's object ID from their UPN via Graph, then calls `POST /beta/riskyUsers/dismiss` to clear the risk state. The tool follows the exact pattern of `reset_user_password` (same auth, same UPN validation, same destructive classification). Requires `IdentityRiskyUser.ReadWrite.All` application permission.

---

## Key Design Decisions

- **Single tool, not two** — no separate "get risk" tool needed since `get_user_info` already surfaces risk detections via the `/beta/identityProtection/riskDetections` query.
- **Resolve object ID from UPN** — the `riskyUsers/dismiss` endpoint requires user object IDs (not UPNs), so the tool does a `GET /v1.0/users/{upn}?$select=id` lookup first, matching the existing pattern in `reset_user_password`.
- **Beta endpoint** — `riskyUsers/dismiss` is only available on `/beta`. Add a comment documenting this dependency.
- **Destructive with justification** — classified as destructive because dismissing risk re-enables a potentially compromised account. Justification is required for the audit trail.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `DismissUserRiskInput` interface |
| `web/lib/tools.ts` | Add `dismiss_user_risk` schema to TOOLS array; add to DESTRUCTIVE_TOOLS |
| `web/lib/executors.ts` | Add `dismiss_user_risk` executor with mock/live paths; register in executors record |
| `cli/src/index.js` | Add TOOL_COLORS entry and TOOL_DESCRIPTIONS entry |
| `docs/user-guide.md` | Add tool to tool reference table |
| `docs/configuration.md` | Add `IdentityRiskyUser.ReadWrite.All` to API permissions table |
| `README.md` | Add tool to tools table |
| `test/dismiss-entra-user-risk.test.js` | New test file |

---

## Implementation Steps

### 1. Add input type in `web/lib/types.ts`

- Add `DismissUserRiskInput` interface near the existing `ResetPasswordInput`:
  - `upn` (required string)
  - `justification` (required string)

### 2. Add tool schema in `web/lib/tools.ts`

- Add `dismiss_user_risk` schema after `reset_user_password` (grouping Entra ID destructive tools):
  - Name: `dismiss_user_risk`
  - Description: "⚠️ DESTRUCTIVE — Dismiss the risk state for a user in Entra ID Identity Protection. This re-enables login for users blocked by conditional access risk policies."
  - Properties: `upn` (required), `justification` (required)
- Add `"dismiss_user_risk"` to the `DESTRUCTIVE_TOOLS` Set

### 3. Add executor function in `web/lib/executors.ts`

- Import `DismissUserRiskInput` type
- Add `dismiss_user_risk` function after `reset_user_password` (grouping Entra ID tools):
  - Validate UPN using existing `validateUpn`
  - **Mock path**: Return `{ dismissed: true, upn, justification, _mock: true }`
  - **Live path**:
    1. Get Graph token via `getMSGraphToken()`
    2. Resolve user object ID: `GET /v1.0/users/${encodedUpn}?$select=id` — extract `id` from response
    3. If user not found, throw clear error
    4. Call `POST https://graph.microsoft.com/beta/riskyUsers/dismiss` with body `{ userIds: [objectId] }` — add comment noting this is a beta endpoint
    5. If response is not OK, throw with status and error text
    6. Log the action via `logger.info`
    7. Return `{ dismissed: true, upn, justification }`
- Register in the `executors` record

### 4. Add CLI display config in `cli/src/index.js`

- Add `dismiss_user_risk: chalk.red.bold` to TOOL_COLORS (red bold, matching other Entra destructive tools)
- Add `dismiss_user_risk` entry to TOOL_DESCRIPTIONS: "Dismiss risk for {upn} in Entra ID"

### 5. Update docs

- Add `dismiss_user_risk` to the tool reference table in `docs/user-guide.md` (Admin role)
- Add `IdentityRiskyUser.ReadWrite.All` to the API permissions table in `docs/configuration.md` under Microsoft Graph
- Add `dismiss_user_risk` to the tools table in `README.md` (Destructive)

### 6. Write tests in `test/dismiss-entra-user-risk.test.js`

- UPN validation: accepts valid UPNs, rejects invalid formats
- Tool is in DESTRUCTIVE_TOOLS set
- Tool schema has `upn` and `justification` as required, no optional parameters
- Mock response has expected fields (`dismissed`, `upn`, `justification`, `_mock`)

---

## Verification

1. Run `node --experimental-strip-types --test test/dismiss-entra-user-risk.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Start dev server with `MOCK_MODE=true`, ask "dismiss the risk for jsmith@goodwin.com" — verify confirmation gate fires and mock success is returned
4. Verify the tool appears only for admin users (in DESTRUCTIVE_TOOLS)
