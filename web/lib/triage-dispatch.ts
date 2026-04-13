import { getSkill } from "./skill-store";
import { env } from "./config";
import type { Skill } from "./types";
import type { TriageSource } from "./types";

// ── Skill lookup table ───────────────────────────────────────
// Maps "product:alertType" → skill ID. Phase 1 ships with one
// specific mapping. Extend this table as new triage skills are added.

const TRIAGE_SKILL_MAP: Record<string, string> = {
  "DefenderXDR:DefenderEndpoint.SuspiciousProcess": "defender-endpoint-triage",
};

const GENERIC_SKILL_ID = "generic-alert-triage";

/**
 * Resolve the triage skill for an alert. Falls back to the generic
 * catch-all skill if no specific mapping exists. Returns null only if
 * neither the mapped skill nor the catch-all is registered.
 */
export function resolveTriageSkill(
  source: TriageSource,
): { skillId: string; skill: Skill } | null {
  const key = `${source.product}:${source.alertType}`;
  const mappedId = TRIAGE_SKILL_MAP[key];

  if (mappedId) {
    const skill = getSkill(mappedId);
    if (skill) return { skillId: mappedId, skill };
  }

  // Fall back to generic catch-all
  const generic = getSkill(GENERIC_SKILL_ID);
  if (generic) return { skillId: GENERIC_SKILL_ID, skill: generic };

  return null;
}

// ── Per-caller skill allowlist ───────────────────────────────
// Format: "appId1:skill1,skill2;appId2:*"
// Empty string = all callers allowed for all skills.

export function checkCallerAllowlist(
  callerId: string,
  skillId: string,
): boolean {
  const raw = env.TRIAGE_CALLER_ALLOWLIST;
  if (!raw) return true; // No allowlist = all allowed

  const entries = raw.split(";").filter(Boolean);
  for (const entry of entries) {
    const [appId, skillsCsv] = entry.split(":");
    if (appId?.trim() !== callerId) continue;
    if (!skillsCsv) continue;
    const allowed = skillsCsv.split(",").map((s) => s.trim());
    if (allowed.includes("*") || allowed.includes(skillId)) return true;
    return false; // Caller found but skill not in their list
  }

  // Caller not in the allowlist at all — if the list is non-empty,
  // unlisted callers are denied.
  return false;
}

// Re-export for the triage endpoint's "no_skill_registered" path
export { GENERIC_SKILL_ID };
