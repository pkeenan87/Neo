// ─────────────────────────────────────────────────────────────
//  Wiz Service Account OAuth2 (client_credentials)
//
//  Replaces the static `WIZ_MCP_TOKEN` bearer with a short-TTL
//  OAuth access token minted at request time. Mirrors the cache-
//  and-refresh shape of `getAzureToken` in ./auth.ts.
//
//  Wire contract (verified against Wiz's published curl example,
//  the queeno/wiz Terraform provider, and the 1Password shell-
//  plugin Wiz integration):
//
//      POST <WIZ_AUTH_URL>
//      Content-Type: application/x-www-form-urlencoded
//
//      grant_type=client_credentials
//      &client_id=<WIZ_CLIENT_ID>
//      &client_secret=<WIZ_CLIENT_SECRET>
//      &audience=<wiz-api | beyond-api>
//
//  Response (RFC 6749):
//      { "access_token": "...", "token_type": "Bearer",
//        "expires_in": 3600 }
//
//  `audience` depends on which IdP backs the auth URL:
//    - https://auth.app.wiz.io/oauth/token (Amazon Cognito) → wiz-api
//    - https://auth.wiz.io/oauth/token     (Auth0)           → beyond-api
//
//  This is the gotcha that the queeno/wiz Terraform provider
//  documents most clearly — sending `wiz-api` to an Auth0 tenant
//  (or `beyond-api` to a Cognito tenant) returns HTTP 400 with
//  no JSON body, which is the error we hit in production on the
//  initial deploy.
//
//  WIZ_AUTH_URL is operator-configurable but constrained to the
//  two documented endpoints via WIZ_AUTH_URL_ALLOWLIST (CodeQL-
//  compatible sanitisation for the credential-bearing fetch).
// ─────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { getToolSecret } from "./secrets";
import { logger } from "./logger";

// Wiz host allowlist. Matches `app.wiz.io`, `*.app.wiz.io`,
// `auth.wiz.io`, `api.us68.app.wiz.io`, etc. Rejects anything
// that doesn't end in `.wiz.io` — internal Azure endpoints,
// metadata services, attacker hosts. If Wiz adds a new TLD or
// your deployment uses a private host, extend the regex — do
// NOT remove the host check.
//
// Used by mcp-servers.ts to gate WIZ_MCP_URL at the agent-loop
// path. Lives here (not in mcp-servers.ts) so wiz-auth has no
// upward dependency: mcp-servers.ts and the integration probe
// route import this constant FROM wiz-auth, avoiding a cycle.
export const WIZ_ALLOWED_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i;

// SECURITY: literal allowlist for the OAuth token endpoint URL.
// The credentials we POST here are the long-lived service-account
// secret; an operator-supplied WIZ_AUTH_URL pointing at an
// attacker host would exfiltrate them. CodeQL's
// `js/request-forgery` rule rejects regex `.test()` as a
// sanitiser, so we keep this as a Set of literal strings —
// CodeQL accepts Set membership as a proof that the URL is one
// of N specific values. The two documented Wiz auth endpoints
// today are listed below; extend explicitly if Wiz publishes a
// new one.
export const WIZ_AUTH_URL_ALLOWLIST = new Set<string>([
  "https://auth.app.wiz.io/oauth/token",
  "https://auth.wiz.io/oauth/token",
]);

// Audience parameter value depends on which identity provider
// fronts the auth URL. Sending the wrong value produces an
// HTTP 400 with no JSON body — the silent-rejection mode the
// initial production deploy hit on 2026-05-14.
const WIZ_AUDIENCE_BY_AUTH_URL: Record<string, string> = {
  "https://auth.app.wiz.io/oauth/token": "wiz-api",   // Amazon Cognito
  "https://auth.wiz.io/oauth/token":     "beyond-api", // Auth0
};

const TOKEN_FETCH_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

// Keyed by sha256(client_id + ":" + client_secret).slice(0, 16).
// Rotating either credential produces a different key and the
// stale entry is left to be GC'd, so an attacker who captures
// the old token can't keep refreshing against the new creds.
const tokenCache = new Map<string, TokenCacheEntry>();

function credentialCacheKey(clientId: string, clientSecret: string): string {
  return createHash("sha256")
    .update(`${clientId}:${clientSecret}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Mint (or fetch-cached) a Wiz OAuth bearer token. The caller
 * passes it to Anthropic's MCP connector as `authorization_token`
 * (becomes `Authorization: Bearer <token>` on the request to the
 * Wiz MCP server).
 *
 * Throws when:
 *  - Any of WIZ_CLIENT_ID / WIZ_CLIENT_SECRET / WIZ_AUTH_URL is
 *    missing or empty.
 *  - WIZ_AUTH_URL parses as something other than https:// with a
 *    hostname matching WIZ_ALLOWED_HOST_RE.
 *  - The token endpoint returns non-2xx.
 *  - The token endpoint hangs longer than TOKEN_FETCH_TIMEOUT_MS.
 *
 * Callers in the agent loop must treat throws as a fail-open
 * signal (skip Wiz for this turn) — see WIZ_ENTRY.getToken in
 * mcp-servers.ts.
 */
export async function getWizAccessToken(): Promise<string> {
  const clientId = await getToolSecret("WIZ_CLIENT_ID");
  const clientSecret = await getToolSecret("WIZ_CLIENT_SECRET");
  const authUrl = await getToolSecret("WIZ_AUTH_URL");

  if (!clientId || !clientSecret || !authUrl) {
    throw new Error(
      "Missing Wiz service account configuration. Configure WIZ_CLIENT_ID, " +
        "WIZ_CLIENT_SECRET, and WIZ_AUTH_URL via /integrations or env vars.",
    );
  }

  const cacheKey = credentialCacheKey(clientId, clientSecret);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // SECURITY: literal allowlist for the token endpoint. The
  // operator-supplied URL must match one of WIZ_AUTH_URL_ALLOWLIST
  // exactly — CodeQL recognises this as a sanitiser for the
  // js/request-forgery rule. Protocol is implicitly https because
  // both allowlist entries start with https://. Trim the input so
  // a trailing newline (common when pasting from clipboard into
  // the admin UI) doesn't break an otherwise-valid value.
  const normalisedAuthUrl = authUrl.trim();
  if (!WIZ_AUTH_URL_ALLOWLIST.has(normalisedAuthUrl)) {
    throw new Error(
      `WIZ_AUTH_URL '${normalisedAuthUrl}' is not in the Wiz auth-URL allowlist. ` +
        `Today only https://auth.app.wiz.io/oauth/token and https://auth.wiz.io/oauth/token ` +
        `are accepted; if Wiz publishes a new auth endpoint, extend WIZ_AUTH_URL_ALLOWLIST in wiz-auth.ts.`,
    );
  }

  const audience = WIZ_AUDIENCE_BY_AUTH_URL[normalisedAuthUrl];
  if (!audience) {
    // Should be impossible — the WIZ_AUTH_URL_ALLOWLIST check above
    // guarantees membership, and every member has a matching
    // audience here. If this ever fires, it means someone extended
    // WIZ_AUTH_URL_ALLOWLIST without updating WIZ_AUDIENCE_BY_AUTH_URL.
    throw new Error(
      `Wiz auth URL '${normalisedAuthUrl}' has no audience mapping. Update WIZ_AUDIENCE_BY_AUTH_URL in wiz-auth.ts.`,
    );
  }

  // SECURITY / wire contract: Wiz's token endpoint expects a form-
  // urlencoded body, NOT JSON. Sending JSON returns HTTP 400 with
  // no JSON body, which is hard to diagnose — see the comment at
  // the top of this file. URLSearchParams handles the encoding.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    audience,
  });

  let res: Response;
  try {
    res = await fetch(normalisedAuthUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new Error(
      `Wiz OAuth token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    // Read body for the error message — capped so a misbehaving
    // server can't OOM us with a huge response.
    const bodyText = (await res.text().catch(() => "")).slice(0, 500);
    if (res.status === 401 || res.status === 403) {
      logger.warn(
        "wiz-auth: token endpoint rejected credentials — rotate or fix WIZ_CLIENT_ID/SECRET",
        "wiz-auth",
        { mcpServer: "wiz", statusCode: res.status },
      );
    }
    throw new Error(
      `Wiz OAuth token request failed (HTTP ${res.status}): ${bodyText}`,
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error(
      "Wiz OAuth token response is missing access_token or expires_in",
    );
  }

  const expiresAt = Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });

  logger.info("wiz-auth: minted new access token", "wiz-auth", {
    mcpServer: "wiz",
    wizDatacenter: await getWizDatacenter(),
    wizTokenExpiry: new Date(expiresAt).toISOString(),
  });

  return data.access_token;
}

/**
 * Drop every cached Wiz token. Call after rotating credentials
 * so the next request re-authenticates with the new client_id /
 * client_secret. Intentionally synchronous — operators who hit
 * this path want immediate eviction, not a deferred clear.
 */
export function clearWizTokenCache(): void {
  tokenCache.clear();
}

// ─────────────────────────────────────────────────────────────
//  Data center parsing
//
//  WIZ_API_URL is operator-supplied (e.g.
//  https://api.us68.app.wiz.io/graphql). The second hostname
//  label is the tenant's data center identifier (e.g. `us68`).
//  We parse it on demand for audit-event tagging — no separate
//  `WIZ_DATACENTER` secret that operators must keep in sync.
// ─────────────────────────────────────────────────────────────

const WIZ_API_HOSTNAME_RE = /^api\.([a-z0-9-]+)\.app\.wiz\.io$/i;

/**
 * Extract the Wiz data center label from `WIZ_API_URL`. Returns
 * `undefined` when the URL is unset, unparseable, or its host
 * doesn't fit the `api.<dc>.app.wiz.io` shape. Never throws —
 * audit tagging is a nice-to-have, not load-bearing.
 */
export async function getWizDatacenter(): Promise<string | undefined> {
  const apiUrl = await getToolSecret("WIZ_API_URL");
  if (!apiUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    logger.debug("wiz-auth: WIZ_API_URL is not parseable — skipping DC tag", "wiz-auth");
    return undefined;
  }

  const match = WIZ_API_HOSTNAME_RE.exec(parsed.hostname);
  if (!match) {
    logger.debug(
      "wiz-auth: WIZ_API_URL hostname does not match api.<dc>.app.wiz.io — skipping DC tag",
      "wiz-auth",
      { hostname: parsed.hostname },
    );
    return undefined;
  }
  return match[1].toLowerCase();
}
