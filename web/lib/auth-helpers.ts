import { auth } from "@/auth";
import { findApiKey } from "./api-key-store";
import type { Role } from "./permissions";

export interface ResolvedAuth {
  role: Role;
  name: string;
  provider: "entra-id" | "api-key";
}

/**
 * Resolve the authenticated identity from either:
 * 1. Authorization: Bearer <api-key> header (direct lookup)
 * 2. Auth.js session (Entra ID OAuth)
 *
 * Returns null if unauthenticated.
 */
export async function resolveAuth(
  request: Request
): Promise<ResolvedAuth | null> {
  // Check for API key in Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const key = authHeader.slice(7);
    const entry = findApiKey(key);
    if (entry) {
      return {
        role: entry.role,
        name: entry.label,
        provider: "api-key",
      };
    }
    // Invalid bearer token — don't fall through to session (explicit auth failure)
    return null;
  }

  // Check for Auth.js session (Entra ID)
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
      // Hardcoded: only Entra ID reaches this code path
      provider: "entra-id",
    };
  }

  return null;
}
