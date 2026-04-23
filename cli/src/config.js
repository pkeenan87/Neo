// ─────────────────────────────────────────────────────────────
//  CLI Configuration
//
//  Resolves server URL and auth header from (in priority order):
//    1. CLI flags (--server, --api-key)
//    2. Environment variables (NEO_SERVER, NEO_API_KEY)
//    3. Config store (~/.neo/config.json)
// ─────────────────────────────────────────────────────────────

import { readConfig } from "./config-store.js";
import { getAccessToken } from "./auth-entra.js";

/**
 * Parse a named flag from process.argv.
 * Accepts both `--flag value` and `--flag=value`. Returns the value, or
 * undefined when the flag is absent.
 */
export function parseFlag(name) {
  const eqPrefix = `${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const tok = process.argv[i];
    if (tok === name) {
      return i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
    }
    if (tok.startsWith(eqPrefix)) {
      return tok.slice(eqPrefix.length);
    }
  }
  return undefined;
}

/**
 * Returns true if any form of the named flag (`--flag`, `--flag=...`) is
 * present in argv. Used for boolean flags that don't carry a value.
 */
export function hasFlag(name) {
  const eqPrefix = `${name}=`;
  return process.argv.some((t) => t === name || t.startsWith(eqPrefix));
}

/**
 * Validate and normalize a server URL.
 * Rejects non-http(s) schemes and requires HTTPS for non-localhost hosts.
 */
export function validateServerUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`\n  Invalid server URL: ${raw}\n`);
    process.exit(1);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    console.error(`\n  Server URL must use http or https (got ${parsed.protocol})\n`);
    process.exit(1);
  }

  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (!isLocal && parsed.protocol !== "https:") {
    console.error(`\n  Server URL must use HTTPS for non-localhost hosts: ${raw}\n`);
    process.exit(1);
  }

  return parsed.href.replace(/\/$/, ""); // normalized, trailing slash removed
}

/**
 * Resolve the server URL and auth getter for the current run.
 *
 * Returns { serverUrl: string, getAuthHeader: () => Promise<string>, authMethod: string }
 * getAuthHeader resolves a fresh auth header before each API call.
 * Exits the process if auth is not configured.
 */
export async function resolveServerConfig() {
  const config = readConfig();

  // ── Server URL ────────────────────────────────────────────
  const rawServerUrl =
    parseFlag("--server") ||
    process.env.NEO_SERVER ||
    config.serverUrl;

  const serverUrl = validateServerUrl(rawServerUrl);

  // ── Auth ──────────────────────────────────────────────────

  // CLI flag takes highest priority (dev-only convenience — visible in process table)
  const flagApiKey = parseFlag("--api-key");
  if (flagApiKey) {
    // Closure captures the key once at startup — the value is immutable for the session
    const header = `Bearer ${flagApiKey}`;
    return { serverUrl, getAuthHeader: async () => header, authMethod: "api-key" };
  }

  // Env var override
  const envApiKey = process.env.NEO_API_KEY;
  if (envApiKey) {
    const header = `Bearer ${envApiKey}`;
    return { serverUrl, getAuthHeader: async () => header, authMethod: "api-key" };
  }

  // Config store
  if (config.authMethod === "api-key" && config.apiKey) {
    const header = `Bearer ${config.apiKey}`;
    return { serverUrl, getAuthHeader: async () => header, authMethod: "api-key" };
  }

  if (config.authMethod === "entra-id") {
    // Verify a token can be obtained at startup — does not guarantee it stays valid
    try {
      await getAccessToken();
    } catch (err) {
      console.error(`\n  Auth error: ${err.message}`);
      if (err.message.includes("Not logged in") || err.message.includes("expired")) {
        console.error(`  To re-authenticate, run: node src/index.js auth login\n`);
      } else {
        console.error(`  If this is a network error, check connectivity to login.microsoftonline.com`);
        console.error(`  To re-authenticate, run: node src/index.js auth login\n`);
      }
      process.exit(1);
    }

    // Return a getter that resolves a fresh token before each API call
    const getAuthHeader = async () => {
      const token = await getAccessToken();
      return `Bearer ${token}`;
    };
    return { serverUrl, getAuthHeader, authMethod: "entra-id" };
  }

  // Nothing configured
  console.error(`
  No authentication configured.

  Option 1 — API Key:
    export NEO_API_KEY=<your-api-key>
    npm start

  Option 2 — Entra ID:
    node src/index.js auth login
    npm start
`);
  process.exit(1);
}
