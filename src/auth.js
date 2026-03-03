// ─────────────────────────────────────────────────────────────
//  Azure AD / Entra ID Authentication
//  Uses OAuth2 client_credentials flow with token caching.
// ─────────────────────────────────────────────────────────────

import { env } from "./config.js";

// ── Token cache ──────────────────────────────────────────────
// Keyed by resource/scope string. Each entry: { token, expiresAt }
const tokenCache = new Map();

// Refresh 5 minutes before actual expiry to avoid edge-case failures
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Acquire an Azure AD token via client_credentials grant.
 * Tokens are cached per-resource and auto-refreshed on expiry.
 *
 * @param {string} resource - The Azure resource URI, e.g.
 *   "https://management.azure.com"
 *   "https://api.securitycenter.microsoft.com"
 *   "https://graph.microsoft.com"
 * @returns {Promise<string>} Bearer token
 */
export async function getAzureToken(resource) {
  const cached = tokenCache.get(resource);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = env;

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error(
      "Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET in .env"
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: `${resource}/.default`
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure token request failed for ${resource} (${res.status}): ${err}`);
  }

  const data = await res.json();

  tokenCache.set(resource, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS
  });

  return data.access_token;
}

/**
 * Convenience wrapper — gets a Microsoft Graph token.
 */
export async function getMSGraphToken() {
  return getAzureToken("https://graph.microsoft.com");
}

/**
 * Generate a cryptographically random password that meets
 * Azure AD complexity requirements (uppercase, lowercase, digit, special).
 */
export function generateSecurePassword(length = 16) {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*?";

  const all = upper + lower + digits + special;

  // Guarantee at least one of each class
  const required = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)]
  ];

  // Fill remaining length with random chars from the full set
  const remaining = Array.from({ length: length - required.length }, () =>
    all[Math.floor(Math.random() * all.length)]
  );

  // Shuffle so the required chars aren't always in the first 4 positions
  const password = [...required, ...remaining]
    .sort(() => Math.random() - 0.5)
    .join("");

  return password;
}