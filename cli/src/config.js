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
 * e.g. parseFlag("--server") returns the value after --server, or undefined.
 */
export function parseFlag(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
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
 * Resolve the server URL and auth header for the current run.
 *
 * Returns { serverUrl: string, authHeader: string }
 * Exits the process if auth is not configured.
 */
export async function resolveServerConfig() {
  const config = readConfig();

  // ── Server URL ────────────────────────────────────────────
  const rawServerUrl =
    parseFlag("--server") ||
    process.env.NEO_SERVER ||
    config.serverUrl ||
    "http://localhost:3000";

  const serverUrl = validateServerUrl(rawServerUrl);

  // ── Auth ──────────────────────────────────────────────────

  // CLI flag takes highest priority (dev-only convenience — visible in process table)
  const flagApiKey = parseFlag("--api-key");
  if (flagApiKey) {
    return { serverUrl, authHeader: `Bearer ${flagApiKey}` };
  }

  // Env var override
  const envApiKey = process.env.NEO_API_KEY;
  if (envApiKey) {
    return { serverUrl, authHeader: `Bearer ${envApiKey}` };
  }

  // Config store
  if (config.authMethod === "api-key" && config.apiKey) {
    return { serverUrl, authHeader: `Bearer ${config.apiKey}` };
  }

  if (config.authMethod === "entra-id") {
    try {
      const token = await getAccessToken();
      return { serverUrl, authHeader: `Bearer ${token}` };
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
