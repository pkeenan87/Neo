import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth } from "@/auth";
import { findApiKey, hashApiKey, updateLastUsed } from "./api-key-store";
import { logger } from "./logger";
import type { Role } from "./permissions";

export type AuthProvider = "entra-id" | "api-key" | "service-principal";

export interface ResolvedAuth {
  role: Role;
  name: string;
  ownerId: string;
  provider: AuthProvider;
}

// ── Entra ID token verification ───────────────────────────────

// Issuer is a full URL like https://login.microsoftonline.com/{tenantId}/v2.0
const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;

// Extract tenant ID from the issuer URL (segment after login.microsoftonline.com)
function extractTenantId(issuerUrl: string | undefined): string | undefined {
  if (!issuerUrl) return undefined;
  try {
    const segments = new URL(issuerUrl).pathname.split("/").filter(Boolean);
    // pathname is /{tenantId}/v2.0 → segments[0] is the tenant ID
    return segments[0] || undefined;
  } catch {
    return undefined;
  }
}

const tenantId = extractTenantId(issuer);

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
  if (!jwks || !issuer || !clientId) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
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
  // Dev bypass — first check so it short-circuits all auth paths in local dev
  if (
    process.env.NODE_ENV === "development" &&
    process.env.DEV_AUTH_BYPASS === "true"
  ) {
    logger.debug("Auth bypassed (DEV_AUTH_BYPASS)", "auth");
    return { role: "admin", name: "dev-operator", ownerId: "dev-operator", provider: "entra-id" };
  }

  // Check for Bearer token in Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Try API key (Cosmos DB + JSON file fallback)
    const entry = await findApiKey(token);
    if (entry) {
      updateLastUsed(hashApiKey(token));
      logger.info("Auth resolved via API key", "auth", { role: entry.role, provider: "api-key" });
      return {
        role: entry.role,
        name: entry.label,
        ownerId: entry.label,
        provider: "api-key",
      };
    }

    // Try Entra ID token verification (CLI sends id_token via PKCE)
    const payload = await verifyEntraToken(token);
    if (payload) {
      // SECURITY: Use `idtyp` claim as the positive discriminant for
      // app-only tokens. This is the OIDC-standard indicator — never
      // rely on the *absence* of user claims as a proxy, because edge
      // cases (B2B guests, OBO, UPN-less service accounts) can lack
      // preferred_username / scp while still being user tokens.
      const isAppOnly = payload.idtyp === "app";

      if (!isAppOnly) {
        // Interactive user token (CLI PKCE, browser, or any non-app-only)
        const roles = payload.roles as string[] | undefined;
        const role: Role = roles?.includes("Admin") ? "admin" : "reader";
        const name =
          (payload.preferred_username as string) ??
          (payload.name as string) ??
          "Unknown";
        const ownerId =
          (payload.oid as string) ??
          (payload.sub as string) ??
          name;
        logger.info("Auth resolved via Entra ID token", "auth", { role, provider: "entra-id" });
        return { role, name, ownerId, provider: "entra-id" };
      }

      // App-only token (Managed Identity / service principal from Logic Apps).
      // Gets the dedicated "triage" role — scoped to read-only investigation
      // tools. If a broader role is needed in the future, map via app roles.
      const appId =
        (payload.appid as string) ??
        (payload.azp as string) ??
        (payload.sub as string);
      if (appId) {
        const name = (payload.app_displayname as string) ?? appId;
        logger.info("Auth resolved via service principal", "auth", {
          role: "triage",
          provider: "service-principal",
          appId,
        });
        return {
          role: "triage",
          name,
          ownerId: appId,
          provider: "service-principal",
        };
      }
    }

    // Invalid bearer token — don't fall through to session
    logger.warn("Invalid bearer token — auth rejected", "auth");
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
    // Use immutable AAD object ID persisted in JWT, fall back to sub/name
    const ownerId =
      (user.oid as string) ??
      (user.id as string) ??
      (user.name as string) ??
      "Unknown";
    logger.info("Auth resolved via Auth.js session", "auth", { role, provider: "entra-id" });
    return {
      role,
      name: (user.name as string) ?? "Unknown",
      ownerId,
      provider: "entra-id",
    };
  }

  logger.debug("No auth credentials found", "auth");
  return null;
}
