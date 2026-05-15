// ─────────────────────────────────────────────────────────────
//  Information Security Incident Response — OAuth helper
//
//  Mints Entra ID access tokens for the Logic App MCP server using
//  the agent's own app registration (AGENT_CLIENT_ID/SECRET) and
//  the Logic App's app reg as the audience
//  (api://<INFOSEC_LOGIC_APP_API_ID>/.default).
//
//  Wire contract (verified against the live Logic App via Postman
//  on 2026-05-15 — see _specs/infosec-incident-response-mcp.md):
//
//      POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
//      Content-Type: application/x-www-form-urlencoded
//
//      grant_type=client_credentials
//      &client_id=<AGENT_CLIENT_ID>
//      &client_secret=<AGENT_CLIENT_SECRET>
//      &scope=api://<INFOSEC_LOGIC_APP_API_ID>/.default
//
//  Response (Entra ID standard):
//      { "access_token": "...", "token_type": "Bearer",
//        "expires_in": 3599 }
//
//  Thin wrapper over getEntraTokenAs in auth.ts; the shared cache
//  there handles refresh-on-expiry. clearInfosecTokenCache evicts
//  just this integration's entries without disturbing Sentinel /
//  Defender / Entra tokens.
// ─────────────────────────────────────────────────────────────

import { getToolSecret } from "./secrets";
import { getEntraTokenAs, clearEntraTokenCacheFor } from "./auth";

/**
 * Mint (or fetch-cached) an Entra ID bearer scoped to the Infosec
 * Logic App's API. Throws with a precise message naming which
 * credential is missing — operators looking at the probe error
 * shouldn't have to guess.
 */
export async function getInfosecAccessToken(): Promise<string> {
  const clientId = await getToolSecret("AGENT_CLIENT_ID");
  const clientSecret = await getToolSecret("AGENT_CLIENT_SECRET");
  const audienceId = await getToolSecret("INFOSEC_LOGIC_APP_API_ID");

  if (!clientId) {
    throw new Error(
      "Missing AGENT_CLIENT_ID — required to mint a token for the Information Security Incident Response Logic App. Configure via /integrations or as an env var.",
    );
  }
  if (!clientSecret) {
    throw new Error(
      "Missing AGENT_CLIENT_SECRET — required to mint a token for the Information Security Incident Response Logic App. Configure via /integrations or as an env var.",
    );
  }
  if (!audienceId) {
    throw new Error(
      "Missing INFOSEC_LOGIC_APP_API_ID — required as the OAuth audience (api://<this-value>/.default) for the Logic App's MCP server. Configure via /integrations or as an env var.",
    );
  }

  return getEntraTokenAs(clientId, clientSecret, `api://${audienceId}`);
}

/**
 * Clear the cached Infosec bearer. Call this after rotating the
 * agent app registration's secret in Key Vault so the next agent
 * turn re-authenticates with the new value. Best-effort — if the
 * underlying secrets aren't readable (Key Vault outage) the cache
 * stays as-is and the next mint will fail loudly with a precise
 * error.
 */
export async function clearInfosecTokenCache(): Promise<void> {
  const clientId = await getToolSecret("AGENT_CLIENT_ID");
  const clientSecret = await getToolSecret("AGENT_CLIENT_SECRET");
  const audienceId = await getToolSecret("INFOSEC_LOGIC_APP_API_ID");
  if (!clientId || !clientSecret || !audienceId) return;
  clearEntraTokenCacheFor(clientId, clientSecret, `api://${audienceId}`);
}
