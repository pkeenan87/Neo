# Silent Injection Guard

## Context

The `wrapToolResult` function in `web/lib/injection-guard.ts` wraps every tool result in a `_neo_trust_boundary` envelope containing a `warning` field. When the scanner flags a result, the warning text includes an "INJECTION ALERT" message that the model echoes in its response, creating noisy output for SOC analysts. The fix is to remove the conditional warning text and the `warning` field entirely, keeping only the `source` and `injection_detected` fields in the envelope. All detection logic and audit logging remain unchanged.

---

## Key Design Decisions

- Remove the `warning` field from the trust boundary envelope entirely, per the user's decision that `"source": "external_api"` is sufficient context for the model
- Keep the `injection_detected` boolean in the envelope, per the user's decision — it provides a machine-readable signal without prompting the model to generate visible warnings
- Keep all scanning logic, pattern definitions, and `logger.warn` calls unchanged — admin audit visibility is preserved
- No changes to `scanUserInput`, `shouldBlock`, the system prompt, or `agent.ts`

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/injection-guard.ts` | Simplify `wrapToolResult` to remove the conditional warning string and the `warning` field from the trust boundary envelope |

---

## Implementation Steps

### 1. Simplify the `wrapToolResult` function

In `web/lib/injection-guard.ts`, modify the `wrapToolResult` function (lines 165–199):

- Remove the `warning` variable assignment (lines 182–184) — the conditional string that builds either the "INJECTION ALERT" text or the "Content below is retrieved" text
- In the returned JSON envelope (`_neo_trust_boundary` object), remove the `warning` property entirely
- Keep `source: "external_api"`, `tool: toolName`, and `injection_detected: scanResult.flagged`
- Keep the `data: result` field
- Keep the `scan()` call and the `logger.warn()` block above it — detection and logging must not change

---

## Verification

1. Run `cd web && npx tsc --noEmit` to confirm no type errors
2. Run `cd web && npm run build` to confirm the production build succeeds
3. Manual check: with `MOCK_MODE=true`, send a query through the web UI (e.g., "investigate user jsmith") and confirm the response does not contain any injection guard warnings or disclaimers about adversarial content
4. Manual check: inspect console logs during the above query and confirm `logger.warn` entries still appear for any tool results that match patterns (e.g., the `encoded_payload` pattern on base64-like strings)
