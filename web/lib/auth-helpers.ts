import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth } from "@/auth";
import { findApiKey } from "./api-key-store";
import type { Role } from "./permissions";

export interface ResolvedAuth {
  role: Role;
  name: string;
  provider: "entra-id" | "api-key";
}

// ── Entra ID token verification ───────────────────────────────

const tenantId = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.split("/").filter(Boolean).pop();
const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;

// JWKS endpoint for the tenant — cached by jose across calls
const jwks = tenantId
  ? createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
      )
    )
  : null;

/**
 * Verify a Bearer token as an Entra ID token (id_token sent by CLI).
 * Returns the decoded payload on success, null on failure.
 */
async function verifyEntraToken(
  token: string
): Promise<Record<string, unknown> | null> {
  if (!jwks || !tenantId || !clientId) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: clientId,
    });
    return payload as Record<string, unknown>;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error("[verifyEntraToken] JWT verification failed:", err);
    }
    return null;
  }
}

/**
 * Resolve the authenticated identity from either:
 * 1. Authorization: Bearer <api-key> header (direct lookup)
 * 2. Authorization: Bearer <entra-id-token> header (CLI PKCE flow)
 * 3. Auth.js session (Entra ID OAuth via browser)
 *
 * Returns null if unauthenticated.
 */
export async function resolveAuth(
  request: Request
): Promise<ResolvedAuth | null> {
  // Check for Bearer token in Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Try API key first (fast, in-memory lookup)
    const entry = findApiKey(token);
    if (entry) {
      return {
        role: entry.role,
        name: entry.label,
        provider: "api-key",
      };
    }

    // Try Entra ID token verification (CLI sends id_token via PKCE)
    const payload = await verifyEntraToken(token);
    if (payload) {
      // Map Entra ID app roles to our internal roles
      const roles = payload.roles as string[] | undefined;
      const role: Role = roles?.includes("Admin") ? "admin" : "reader";
      const name =
        (payload.preferred_username as string) ??
        (payload.name as string) ??
        "Unknown";
      return { role, name, provider: "entra-id" };
    }

    // Invalid bearer token — don't fall through to session
    return null;
  }

  // Check for Auth.js session (Entra ID via browser)
  const session = await auth();
  if (session?.user) {
    const user = session.user as Record<string, unknown>;
    // Allowlist role values to prevent unexpected JWT claims from bypassing RBAC
    const rawRole = user.role;
    const role: Role =
      rawRole === "admin" || rawRole === "reader" ? rawRole : "reader";
    return {
      role,
      name: (user.name as string) ?? "Unknown",
      provider: "entra-id",
    };
  }

  return null;
}
