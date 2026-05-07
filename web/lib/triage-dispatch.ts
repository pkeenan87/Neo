import { getSkill } from "./skill-store";
import { getMapping } from "./triage-mapping-store";
import { env } from "./config";
import { logger } from "./logger";
import type { Skill } from "./types";
import type { TriageSource } from "./types";

// ── Skill lookup ─────────────────────────────────────────────
// The previously-hardcoded TRIAGE_SKILL_MAP constant is gone; the
// "<product>:<alertType>" → skill ID lookup now lives in the Cosmos-
// backed `triage-mappings` container, fronted by a 15s read-through
// cache in triage-mapping-store.ts. See _specs/admin-ui-alert-triage-
// mapping.md for the full design.

const GENERIC_SKILL_ID = "generic-alert-triage";

/**
 * Resolve the triage skill for an alert. Falls back to the generic
 * catch-all skill if no specific mapping exists, the mapped skill
 * has been deleted (orphaned mapping), or any backing store throws.
 * Returns null only if neither the mapped skill nor the catch-all
 * is registered.
 *
 * The store-error path is a deliberate no-fail: triage requests
 * must always produce a verdict — losing the mapping table or the
 * skill cache to a Cosmos hiccup should not take the endpoint down.
 * We wrap the entire resolution in a single try/catch so the
 * guarantee is structural and resilient to a future change in
 * `getSkill`'s error-propagation behaviour. Mirrors the dedup-cache
 * fail-open posture described in _specs/alert-triage-api.md.
 */
export async function resolveTriageSkill(
  source: TriageSource,
): Promise<{ skillId: string; skill: Skill } | null> {
  const key = `${source.product}:${source.alertType}`;

  // Each external call is wrapped independently so a flaky mapping
  // store doesn't poison the generic-skill fallback (and vice
  // versa). The structural guarantee: any thrown exception in either
  // store degrades to the next step rather than escaping the
  // function. This keeps the no-fail contract resilient to future
  // changes in either helper's error-propagation behaviour.
  let mappedId: string | undefined;
  try {
    const mapping = await getMapping(key);
    mappedId = mapping?.skillId;
  } catch (err) {
    logger.warn(
      "triage-dispatch: mapping store error — falling back to generic",
      "triage-dispatch",
      {
        key,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (mappedId) {
    try {
      const skill = await getSkill(mappedId);
      if (skill) return { skillId: mappedId, skill };
      // Mapping points at a skill that no longer exists. Treat as a
      // miss and let an operator notice via the warning so they can
      // either re-create the skill or delete the orphan mapping.
      logger.warn(
        "triage-dispatch: mapped skill not found — falling back to generic",
        "triage-dispatch",
        {
          key,
          mappedSkillId: mappedId,
        },
      );
    } catch (err) {
      logger.warn(
        "triage-dispatch: skill store error on mapped lookup — falling back to generic",
        "triage-dispatch",
        {
          key,
          mappedSkillId: mappedId,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // Fall back to generic catch-all. Independently wrapped so a
  // skill-store outage here returns null cleanly rather than
  // escaping as a 500.
  try {
    const generic = await getSkill(GENERIC_SKILL_ID);
    if (generic) return { skillId: GENERIC_SKILL_ID, skill: generic };
  } catch (err) {
    logger.warn(
      "triage-dispatch: skill store error on generic lookup — returning no-skill",
      "triage-dispatch",
      {
        key,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
  }

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
