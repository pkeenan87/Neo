// ─────────────────────────────────────────────────────────────
//  Azure AD / Entra ID Authentication
//  Uses OAuth2 client_credentials flow with token caching.
// ─────────────────────────────────────────────────────────────

import { env } from "./config.js";
import { randomInt } from "crypto";

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
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
    special[randomInt(special.length)]
  ];

  // Fill remaining length with random chars from the full set
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