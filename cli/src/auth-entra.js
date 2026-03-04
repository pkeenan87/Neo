// ─────────────────────────────────────────────────────────────
//  Entra ID Authentication — Authorization Code + PKCE
//
//  No third-party auth library.  Uses Node.js built-in crypto,
//  http, and fetch against the Microsoft identity platform.
//  Works the same way as `az login`.
// ─────────────────────────────────────────────────────────────

import http from "http";
import { randomBytes, createHash } from "crypto";
import { readConfig, writeConfig } from "./config-store.js";

const REDIRECT_PORT = 4000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

// ── PKCE helpers ──────────────────────────────────────────────

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier() {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ── Resolve tenantId/clientId ─────────────────────────────────
//
// Priority: env vars > saved config > server discovery

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function discoverEntraConfig(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/auth/discover`);
    if (!res.ok) {
      if (process.env.DEBUG) process.stderr.write(`[debug] Discovery returned HTTP ${res.status} from ${serverUrl}/api/auth/discover\n`);
      return null;
    }
    const data = await res.json();
    // Validate UUID format to prevent injection into auth URLs
    if (!GUID_RE.test(data.tenantId) || !GUID_RE.test(data.clientId)) {
      if (process.env.DEBUG) process.stderr.write(`[debug] Discovery response contained invalid tenant/client IDs — ignoring\n`);
      return null;
    }
    return { tenantId: data.tenantId, clientId: data.clientId };
  } catch (err) {
    if (process.env.DEBUG) process.stderr.write(`[debug] Discovery fetch failed: ${err.message}\n`);
    return null;
  }
}

function authorizeUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
}

function tokenUrl(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

// ── Interactive login ─────────────────────────────────────────

export async function login(options = {}) {
  const config = readConfig();

  // tenantId: flag > env > config > discovery
  // clientId:         env > config > discovery  (no CLI flag; server-provided)
  const flagTenantId = options.tenantId;
  const envTenantId = process.env.NEO_TENANT_ID;
  const savedTenantId = config.entraId?.tenantId;
  const envClientId = process.env.NEO_CLIENT_ID;
  const savedClientId = config.entraId?.clientId;

  let tenantId = flagTenantId || envTenantId || savedTenantId;
  let clientId = envClientId || savedClientId;

  // If either is missing, try server discovery
  if (!tenantId || !clientId) {
    const discovered = options.serverUrl
      ? await discoverEntraConfig(options.serverUrl)
      : null;

    if (discovered) {
      tenantId = tenantId || discovered.tenantId;
      clientId = clientId || discovered.clientId;
    }
  }

  if (!tenantId || !clientId) {
    throw new Error(
      "Could not resolve Entra ID configuration.\n" +
      "  Ensure the Neo server has Entra ID configured, or pass --tenant-id\n" +
      "  and set the NEO_CLIENT_ID environment variable."
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = base64url(randomBytes(16));

  // Start a one-shot local HTTP server for the redirect callback
  let timeoutHandle;
  const { code } = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const errorCode = url.searchParams.get("error") || "unknown_error";
        const desc = url.searchParams.get("error_description") || error;
        if (process.env.DEBUG) process.stderr.write(`[debug] Entra error: ${desc}\n`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Login failed. You can close this tab.", () =>
          srv.close(() => reject(new Error(`Entra ID login failed: ${errorCode}`)))
        );
        clearTimeout(timeoutHandle);
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("State mismatch — possible CSRF. Please try again.", () =>
          srv.close(() => reject(new Error("OAuth state mismatch")))
        );
        clearTimeout(timeoutHandle);
        return;
      }

      const authCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Login successful — you can close this tab.</h2></body></html>",
        () => srv.close(() => resolve({ code: authCode }))
      );
      clearTimeout(timeoutHandle);
    });

    srv.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${REDIRECT_PORT} is already in use. Close any other processes using that port and try again.`));
      } else {
        reject(err);
      }
    });

    srv.listen(REDIRECT_PORT, "127.0.0.1", () => {
      // Build the authorization URL
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: "openid profile offline_access",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });

      const authUrl = `${authorizeUrl(tenantId)}?${params}`;

      process.stderr.write("\nOpening browser for Entra ID login...\n");
      process.stderr.write(`If the browser doesn't open, visit:\n  ${authUrl}\n\n`);

      // Dynamic import so 'open' is only loaded when needed
      import("open").then((mod) => mod.default(authUrl)).catch(() => {
        // Browser open failed — the URL is already printed above
      });
    });

    // Timeout guard
    timeoutHandle = setTimeout(() => {
      srv.close(() =>
        reject(new Error("Login timed out after 5 minutes. Please try again."))
      );
    }, LOGIN_TIMEOUT_MS);
  });

  // Exchange the authorization code for tokens
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(tokenUrl(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    if (process.env.DEBUG) process.stderr.write(`[debug] Token exchange error: ${errText}\n`);
    throw new Error(`Token exchange failed (HTTP ${res.status}). Run with DEBUG=1 for details.`);
  }

  const tokens = await res.json();

  // Decode the ID token to extract display name. No signature verification needed
  // because this is used for display only — NEVER for authorization decisions.
  let displayName = "Unknown";
  try {
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
    );
    displayName = payload.preferred_username || payload.name || "Unknown";
  } catch {
    // ID token decode is best-effort for display only
  }

  // Persist tokens and config — cache discovered tenantId/clientId so
  // subsequent logins and token refreshes don't need discovery.
  // We store the id_token (not the access_token) because the server verifies
  // the token audience matches our app's clientId. The access_token from
  // "openid profile offline_access" scopes is a Microsoft Graph token whose
  // signature cannot be verified by third parties.
  if (!tokens.id_token) {
    throw new Error("No id_token in token response. Ensure 'openid' scope is requested.");
  }

  writeConfig({
    ...config,
    authMethod: "entra-id",
    entraId: {
      tenantId,
      clientId,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      displayName,
    },
  });

  return { displayName };
}

// ── Silent token refresh / cached return ──────────────────────

export async function getAccessToken() {
  const config = readConfig();
  const entra = config.entraId;

  // Support both new (idToken) and legacy (accessToken) config shapes
  const cachedToken = entra?.idToken || entra?.accessToken;

  if (!cachedToken) {
    throw new Error("Not logged in. Run: node src/index.js auth login");
  }

  // Return cached token if still fresh
  if (entra.expiresAt && entra.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return cachedToken;
  }

  // Attempt silent refresh
  if (!entra.refreshToken) {
    throw new Error("Session expired and no refresh token available. Run: node src/index.js auth login");
  }

  // For token refresh, tenantId/clientId must already be saved from login
  const tenantId = entra.tenantId;
  const clientId = entra.clientId;
  if (!tenantId || !clientId) {
    throw new Error("Entra ID config incomplete. Run: node src/index.js auth login");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: entra.refreshToken,
    scope: "openid profile offline_access",
  });

  const res = await fetch(tokenUrl(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Clear stale tokens
    writeConfig({
      ...config,
      entraId: {
        ...entra,
        idToken: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
      },
    });
    throw new Error("Session expired. Run: node src/index.js auth login");
  }

  const tokens = await res.json();

  if (!tokens.id_token) {
    throw new Error("No id_token in refresh response. Re-login required: node src/index.js auth login");
  }

  writeConfig({
    ...config,
    entraId: {
      ...entra,
      idToken: tokens.id_token,
      accessToken: undefined, // clear legacy field
      refreshToken: tokens.refresh_token || entra.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    },
  });

  return tokens.id_token;
}

// ── Logout ────────────────────────────────────────────────────

export function logout() {
  const config = readConfig();
  delete config.entraId;
  if (config.authMethod === "entra-id") {
    config.authMethod = null;
  }
  writeConfig(config);
}

// ── Status ────────────────────────────────────────────────────

export function status() {
  const config = readConfig();
  const entra = config.entraId;

  if (!entra?.idToken && !entra?.accessToken) {
    return { loggedIn: false, expiresAt: null, username: null };
  }

  return {
    loggedIn: true,
    expiresAt: entra.expiresAt ? new Date(entra.expiresAt) : null,
    username: entra.displayName || null,
  };
}
