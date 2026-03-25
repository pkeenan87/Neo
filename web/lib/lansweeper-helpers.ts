// ── Lansweeper Pure Helpers ──────────────────────────────────
// Shared between executors.ts and tests. No I/O, no side effects.

// Classification-only regex: detects IP-like patterns for query routing.
// Does NOT validate octet ranges (0–255) — Lansweeper validates server-side.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function detectSearchType(
  search: string,
  searchType?: "name" | "ip" | "serial",
): "name" | "ip" | "serial" {
  if (searchType) return searchType;
  if (IPV4_RE.test(search)) return "ip";
  return "name";
}

export interface CustomTag {
  businessOwner: string;
  biaTier: string;
  role: string;
  technologyOwner: string;
}

export function extractCustomTags(fields: { name: string; value: string }[] | undefined): CustomTag {
  const tags: CustomTag = {
    businessOwner: "Not set",
    biaTier: "Not set",
    role: "Not set",
    technologyOwner: "Not set",
  };

  if (!fields) return tags;

  const map: Record<string, keyof CustomTag> = {
    "Business Owner": "businessOwner",
    "BIA Tier": "biaTier",
    "Role": "role",
    "Technology Owner": "technologyOwner",
  };

  for (const field of fields) {
    const key = map[field.name];
    if (key && field.value) {
      tags[key] = field.value;
    }
  }

  return tags;
}

export interface PrimaryUserInfo {
  userName: string;
  fullName: string | null;
  numberOfLogons: number | null;
  lastLogon: string | null;
}

export function identifyPrimaryUser(
  loggedOnUsers: { userName: string; fullName?: string; numberOfLogons?: number; lastLogon?: string }[] | undefined,
  fallbackUserName: string | undefined,
): PrimaryUserInfo | { message: string } {
  if (loggedOnUsers && loggedOnUsers.length > 0) {
    const sorted = [...loggedOnUsers].sort((a, b) => (b.numberOfLogons ?? 0) - (a.numberOfLogons ?? 0));
    const top = sorted[0];
    return {
      userName: top.userName,
      fullName: top.fullName ?? null,
      numberOfLogons: top.numberOfLogons ?? null,
      lastLogon: top.lastLogon ?? null,
    };
  }

  if (fallbackUserName) {
    return {
      userName: fallbackUserName,
      fullName: null,
      numberOfLogons: null,
      lastLogon: null,
    };
  }

  return { message: "No user data available" };
}

export interface VulnSummary {
  totalCount: number;
  bySeverity: { critical: number; high: number; medium: number; low: number };
  topCves: Record<string, unknown>[];
}

export function buildVulnSummary(items: Record<string, unknown>[]): VulnSummary {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const item of items) {
    const sev = (item.severity as string ?? "").toLowerCase();
    if (sev === "critical") bySeverity.critical++;
    else if (sev === "high") bySeverity.high++;
    else if (sev === "medium") bySeverity.medium++;
    else if (sev === "low") bySeverity.low++;
  }

  const sorted = [...items].sort((a, b) => ((b.riskScore as number) ?? 0) - ((a.riskScore as number) ?? 0));
  const topCves = sorted.slice(0, 10);

  return { totalCount: items.length, bySeverity, topCves };
}
