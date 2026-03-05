import { getMSGraphToken } from "./auth";
import { env } from "./config";
import type { Role } from "./permissions";

// ─────────────────────────────────────────────────────────────
//  Role cache with active eviction
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  role: Role;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const roleCache = new Map<string, CacheEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of roleCache) {
    if (entry.expiresAt <= now) {
      roleCache.delete(key);
    }
  }
}, CACHE_TTL_MS);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Resolve a Teams user's role by looking up their Entra ID app role assignments
 * via Microsoft Graph. Falls back to "reader" if lookup fails.
 */
export async function resolveTeamsRole(aadObjectId: string): Promise<Role> {
  const cached = roleCache.get(aadObjectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.role;
  }

  let role: Role = "reader";

  try {
    const spObjectId = env.MICROSOFT_APP_SP_OBJECT_ID;

    if (!spObjectId) {
      console.warn(
        "[teams-auth] MICROSOFT_APP_SP_OBJECT_ID is not set — all Teams users will be assigned 'reader' role."
      );
      roleCache.set(aadObjectId, { role, expiresAt: Date.now() + CACHE_TTL_MS });
      return role;
    }

    const token = await getMSGraphToken();

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(aadObjectId)}/appRoleAssignments`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.ok) {
      const data = await res.json();
      const assignments = data.value as Array<{
        resourceId: string;
        appRoleId: string;
      }>;

      // Filter by service principal object ID (not the OAuth client/app ID)
      const appAssignments = assignments.filter(
        (a) => a.resourceId === spObjectId
      );

      if (appAssignments.length > 0) {
        role = await resolveRoleFromAssignments(
          token,
          appAssignments.map((a) => a.appRoleId)
        );
      }
    } else {
      console.warn(
        `[teams-auth] Graph lookup failed for user ${aadObjectId.slice(0, 8)}...: ${res.status} ${res.statusText}`
      );
    }
  } catch (err) {
    console.warn(
      `[teams-auth] Could not resolve role for user ${aadObjectId.slice(0, 8)}..., defaulting to reader:`,
      (err as Error).message
    );
  }

  roleCache.set(aadObjectId, { role, expiresAt: Date.now() + CACHE_TTL_MS });
  return role;
}

// ─────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Given a set of appRoleIds assigned to a user for our app,
 * resolve whether any of them correspond to "Admin".
 */
async function resolveRoleFromAssignments(
  token: string,
  appRoleIds: string[]
): Promise<Role> {
  try {
    const appId = env.MICROSOFT_APP_ID;
    if (!appId || !UUID_RE.test(appId)) return "reader";

    // Use URL + searchParams for proper OData query encoding
    const url = new URL("https://graph.microsoft.com/v1.0/servicePrincipals");
    url.searchParams.set("$filter", `appId eq '${appId}'`);
    url.searchParams.set("$select", "appRoles");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return "reader";

    const data = await res.json();
    const sps = data.value as Array<{
      appRoles: Array<{ id: string; value: string }>;
    }>;

    if (sps.length === 0) return "reader";

    const appRoles = sps[0].appRoles;
    const assignedRoleValues = appRoles
      .filter((r) => appRoleIds.includes(r.id))
      .map((r) => r.value);

    if (assignedRoleValues.includes("Admin")) {
      return "admin";
    }
  } catch {
    // Fall through to reader
  }

  return "reader";
}
