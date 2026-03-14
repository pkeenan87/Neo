import { randomInt } from "crypto";
import { getToolSecret } from "./secrets";

// ─────────────────────────────────────────────────────────────
//  Azure AD / Entra ID Authentication
//  Uses OAuth2 client_credentials flow with token caching.
// ─────────────────────────────────────────────────────────────

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export async function getAzureToken(resource: string): Promise<string> {
  const cached = tokenCache.get(resource);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const AZURE_TENANT_ID = await getToolSecret("AZURE_TENANT_ID");
  const AZURE_CLIENT_ID = await getToolSecret("AZURE_CLIENT_ID");
  const AZURE_CLIENT_SECRET = await getToolSecret("AZURE_CLIENT_SECRET");

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error(
      "Missing Azure credentials. Configure them via /integrations or set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET in .env"
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: `${resource}/.default`,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure token request failed for ${resource} (${res.status}): ${err}`);
  }

  const data = await res.json();

  tokenCache.set(resource, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS,
  });

  return data.access_token;
}

/**
 * Flush the OAuth token cache. Call after rotating Azure credentials
 * so the next request re-authenticates with the new secrets.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
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
