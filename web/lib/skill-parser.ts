// Browser-safe skill parser + validators.
//
// Extracted from skill-store.ts so the Settings UI can run the same
// parsing + validation client-side for the live preview, without
// pulling in the Node-only fs/path/Cosmos imports the store carries.
// All exports here are pure functions / pure data.
//
// skill-store.ts re-exports every symbol so existing call sites
// (route handlers, migration script, agent loop) keep their imports
// pointing at the same module they always have.

import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools";
import type { Role } from "./permissions";
import type { Skill } from "./types";

const VALID_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const MAX_SKILL_ID_LENGTH = 60;
export const MAX_SKILL_CONTENT_BYTES = 32_000;
export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));
export { DESTRUCTIVE_TOOLS };

// ── Heading-driven parser ────────────────────────────────────

function extractSection(raw: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const match = pattern.exec(raw);
  if (!match) return "";

  const start = match.index + match[0].length;
  const nextHeading = raw.indexOf("\n## ", start);
  const section = nextHeading === -1 ? raw.slice(start) : raw.slice(start, nextHeading);
  return section.trim();
}

function extractName(raw: string): string {
  const match = /^#\s+Skill:\s*(.+)$/im.exec(raw);
  return match ? match[1].trim() : "";
}

export function parseSkillMarkdown(id: string, raw: string): Skill {
  const name = extractName(raw);
  const description = extractSection(raw, "Description");
  const instructions = extractSection(raw, "Steps");

  const toolsRaw = extractSection(raw, "Required Tools");
  const requiredTools = toolsRaw
    ? toolsRaw.split("\n").map((l) => l.replace(/^-\s*`?/, "").replace(/`?\s*$/, "")).filter(Boolean)
    : [];

  const roleRaw = extractSection(raw, "Required Role");
  const requiredRole: Role = roleRaw.trim().toLowerCase() === "admin" ? "admin" : "reader";

  const paramsRaw = extractSection(raw, "Parameters");
  const parameters = paramsRaw
    ? paramsRaw.split("\n").map((l) => l.replace(/^-\s*`?/, "").replace(/`?\s*$/, "")).filter(Boolean)
    : [];

  return { id, name, description, instructions, requiredTools, requiredRole, parameters };
}

// ── Validators ───────────────────────────────────────────────

export function validateSkillId(id: string): string | null {
  if (!id) return "ID is required";
  if (id.length > MAX_SKILL_ID_LENGTH) {
    return `ID must be ${MAX_SKILL_ID_LENGTH} characters or fewer`;
  }
  if (!VALID_ID.test(id)) {
    return "ID must be 2+ lowercase alphanumeric characters and hyphens, not starting or ending with a hyphen";
  }
  return null;
}

// Browser-safe byte length — TextEncoder is universally available; the
// previous Buffer.byteLength implementation pinned this to Node.
export function skillContentByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function validateSkillContent(content: string): string | null {
  if (skillContentByteLength(content) > MAX_SKILL_CONTENT_BYTES) {
    return `Skill content exceeds maximum size of ${MAX_SKILL_CONTENT_BYTES} bytes`;
  }
  return null;
}

// ── Side-effect-free inspection (for the UI preview) ─────────

export interface SkillInspection {
  ok: boolean;
  issues: string[];
}

/**
 * Like validateSkill but returns structured findings instead of
 * logging + returning a boolean. The Settings UI uses this for the
 * live parser preview so client-side rendering can show *why* a
 * skill won't load. validateSkill (in skill-store.ts) wraps this
 * with logger.warn calls for the file-loader / Cosmos paths.
 */
export function inspectSkill(skill: Skill): SkillInspection {
  const issues: string[] = [];

  if (!skill.name) {
    issues.push("Missing skill name — add a `# Skill: <Title>` line.");
  }
  if (!skill.description) {
    issues.push("Missing description — add a `## Description` section.");
  }

  for (const tool of skill.requiredTools) {
    if (!TOOL_NAMES.has(tool)) {
      issues.push(`Required Tool "${tool}" is not a registered tool name.`);
    }
  }

  const usesDestructiveTool = skill.requiredTools.some((t) => DESTRUCTIVE_TOOLS.has(t));
  if (usesDestructiveTool && skill.requiredRole !== "admin") {
    issues.push(
      `Skill uses destructive tools but Required Role is "${skill.requiredRole}" — must be "admin".`,
    );
  }

  return { ok: issues.length === 0, issues };
}
