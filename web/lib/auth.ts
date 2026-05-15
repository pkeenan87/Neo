import { createHash, randomInt } from "crypto";
import { getToolSecret } from "./secrets";

// ─────────────────────────────────────────────────────────────
//  Azure AD / Entra ID Authentication
//  Uses OAuth2 client_credentials flow with token caching.
//
//  Two public entry points:
//    - getAzureToken(resource) — reads AZURE_CLIENT_ID/SECRET from
//      Key Vault/env. Used by Sentinel/Defender/Entra executors.
//    - getEntraTokenAs(clientId, secret, resource) — parameterised;
//      used by integrations that have their own app registration
//      (Infosec Logic App via infosec-auth.ts). See
//      _plans/infosec-incident-response-mcp.md.
//
//  Both share one in-memory cache and the same wire shape; only the
//  cache key + credential source differ.
// ─────────────────────────────────────────────────────────────

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const TOKEN_FETCH_TIMEOUT_MS = 10_000;

/**
 * Private worker: POSTs the client_credentials body to the tenant's
 * token endpoint, caches the result keyed by `cacheKey`, returns the
 * bearer. Throws on non-2xx with the response body for diagnosis.
 */
async function mintEntraToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  resource: string,
  cacheKey: string,
): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${resource}/.default`,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Entra token request failed for ${resource} (${res.status}): ${err}`);
  }

  const data = await res.json();

  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS,
  });

  return data.access_token;
}

/**
 * Mint a token using the default agent credentials
 * (AZURE_CLIENT_ID/SECRET — the Sentinel/Defender/Entra app reg).
 * Cache key is just the resource string for backward compatibility
 * with the original implementation's shape.
 */
export async function getAzureToken(resource: string): Promise<string> {
  const AZURE_TENANT_ID = await getToolSecret("AZURE_TENANT_ID");
  const AZURE_CLIENT_ID = await getToolSecret("AZURE_CLIENT_ID");
  const AZURE_CLIENT_SECRET = await getToolSecret("AZURE_CLIENT_SECRET");

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error(
      "Missing Azure credentials. Configure them via /integrations or set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET in .env",
    );
  }

  return mintEntraToken(
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    resource,
    resource, // legacy cache key shape
  );
}

/**
 * Mint a token using caller-supplied credentials against the same
 * Entra tenant. Used by integrations that have their own app
 * registration (Infosec Logic App in particular). Cache key is
 * `sha256(clientId + ":" + clientSecret + ":" + resource).slice(0,16)`
 * so rotating either credential invalidates the cache cleanly without
 * affecting other callers using a different credential pair.
 *
 * Tenant ID is still read from AZURE_TENANT_ID — Neo is single-tenant
 * today. If multi-tenant becomes a thing, parameterise this too.
 */
export async function getEntraTokenAs(
  clientId: string,
  clientSecret: string,
  resource: string,
): Promise<string> {
  const AZURE_TENANT_ID = await getToolSecret("AZURE_TENANT_ID");
  if (!AZURE_TENANT_ID) {
    throw new Error(
      "Missing AZURE_TENANT_ID — required to mint Entra ID tokens for any integration.",
    );
  }

  const cacheKey = "entra:" + createHash("sha256")
    .update(`${clientId}:${clientSecret}:${resource}`)
    .digest("hex")
    .slice(0, 16);

  return mintEntraToken(AZURE_TENANT_ID, clientId, clientSecret, resource, cacheKey);
}

/**
 * Flush the OAuth token cache. Call after rotating credentials so
 * the next request re-authenticates. Clears entries for every caller
 * — both getAzureToken and getEntraTokenAs paths.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Targeted eviction for `getEntraTokenAs` callers. Wipes only the
 * cache entry for the given credential triple. Used by per-integration
 * `clear*TokenCache()` helpers (e.g. `clearInfosecTokenCache`) so
 * rotating one integration's secrets doesn't disturb others.
 */
export function clearEntraTokenCacheFor(
  clientId: string,
  clientSecret: string,
  resource: string,
): void {
  const cacheKey = "entra:" + createHash("sha256")
    .update(`${clientId}:${clientSecret}:${resource}`)
    .digest("hex")
    .slice(0, 16);
  tokenCache.delete(cacheKey);
}

export async function getMSGraphToken(): Promise<string> {
  return getAzureToken("https://graph.microsoft.com");
}

export function generateSecurePassword(length = 16): string {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*?";

  const all = upper + lower + digits + special;

  const required = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
    special[randomInt(special.length)],
  ];

  const remaining = Array.from({ length: length - required.length }, () =>
    all[randomInt(all.length)]
  );

  // Fisher-Yates shuffle with cryptographic randomness
  const chars = [...required, ...remaining];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}
