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

import { ALL_TOOL_NAMES, DESTRUCTIVE_TOOLS } from "./tools";
import type { Role } from "./permissions";
import type { Skill } from "./types";

const VALID_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const MAX_SKILL_ID_LENGTH = 60;
export const MAX_SKILL_CONTENT_BYTES = 32_000;
// Re-exported from ./tools under the legacy name so existing consumers
// (SkillEditor, ScheduledTaskEditor, inspectSkill) pick up the wider
// custom + server tool set without import-path churn. See the
// ALL_TOOL_NAMES doc comment in ./tools.ts for why this must include
// server tools — a local `new Set(TOOLS.map(...))` silently excluded
// web_search and broke skill / scheduled-task authoring.
export const TOOL_NAMES: ReadonlySet<string> = ALL_TOOL_NAMES;
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
  // The capture group is anchored to a non-space character (\S) so the
  // engine can't backtrack through a long run of whitespace looking
  // for a match that doesn't exist — closes CodeQL js/polynomial-redos
  // alert. Behaviour is unchanged for valid input: `\s*` still consumes
  // the optional leading whitespace, the capture starts at the first
  // non-space char, and the subsequent trim() is a no-op now that the
  // leading whitespace is already excluded.
  const match = /^#\s+Skill:\s*(\S.*)$/im.exec(raw);
  return match ? match[1].trim() : "";
}

// Strip a leading "- " bullet marker and a single pair of surrounding
// backticks from a list-item line. Replaces the previous regex-based
// approach — the `^-\s*`?` and `` `?\s*$ `` patterns tripped CodeQL's
// js/polynomial-redos heuristic, and deterministic string ops are both
// faster and easier to reason about for this fixed-shape input.
function stripBulletAndBackticks(line: string): string {
  let s = line.trimStart();
  if (s.startsWith("-")) s = s.slice(1).trimStart();
  if (s.startsWith("`")) s = s.slice(1);
  s = s.trimEnd();
  if (s.endsWith("`")) s = s.slice(0, -1);
  return s.trim();
}

export function parseSkillMarkdown(id: string, raw: string): Skill {
  const name = extractName(raw);
  const description = extractSection(raw, "Description");
  const instructions = extractSection(raw, "Steps");

  const toolsRaw = extractSection(raw, "Required Tools");
  const requiredTools = toolsRaw
    ? toolsRaw.split("\n").map(stripBulletAndBackticks).filter(Boolean)
    : [];

  const roleRaw = extractSection(raw, "Required Role");
  const requiredRole: Role = roleRaw.trim().toLowerCase() === "admin" ? "admin" : "reader";

  const paramsRaw = extractSection(raw, "Parameters");
  const parameters = paramsRaw
    ? paramsRaw.split("\n").map(stripBulletAndBackticks).filter(Boolean)
    : [];

  return { id, name, description, instructions, requiredTools, requiredRole, parameters };
}

// ── Serializer (inverse of parseSkillMarkdown) ───────────────

// Escape any line in a free-text field that begins with `## `, the
// section-heading marker the parser uses to delimit sections. Without
// this, a Description / Steps body containing
//   ## Required Role
//   admin
// would shadow the legit `## Required Role` section the form's Role
// select writes, because extractSection's regex uses first-match
// semantics. The escape prefixes a backslash; readers see `\## ...`
// inline. parseSkillMarkdown's regex requires the literal `## ` at
// line start so the backslash neutralises the match. The Skill author
// loses the ability to write a literal `## Required Role` heading
// inside Description / Steps, but that's exactly the structural
// ambiguity we're closing.
function escapeMarkdownHeadings(text: string): string {
  return text.replace(/^(##\s)/gm, "\\$1");
}

/**
 * Re-emit a Skill back to the canonical Markdown shape that
 * parseSkillMarkdown reads. Used by the structured Settings editor
 * to ship the same { id, content } payload the API has always
 * accepted, so the server-side prompt-injection scan and content
 * validators stay on the existing path.
 *
 * Round-trip contract: parseSkillMarkdown(id, serializeSkillMarkdown(s))
 * must produce a Skill deep-equal to `s` for any well-formed input.
 * Exercised by web/test/skill-parser-serialize.test.ts.
 */
export function serializeSkillMarkdown(skill: Skill): string {
  const lines: string[] = [];
  lines.push(`# Skill: ${skill.name}`);
  lines.push("");
  lines.push("## Description");
  lines.push("");
  lines.push(escapeMarkdownHeadings(skill.description));
  lines.push("");
  lines.push("## Required Tools");
  lines.push("");
  for (const t of skill.requiredTools) lines.push(`- ${t}`);
  if (skill.requiredTools.length === 0) lines.push("");
  lines.push("");
  lines.push("## Required Role");
  lines.push("");
  lines.push(skill.requiredRole);
  lines.push("");
  lines.push("## Parameters");
  lines.push("");
  for (const p of skill.parameters) lines.push(`- ${p}`);
  if (skill.parameters.length === 0) lines.push("");
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  lines.push(escapeMarkdownHeadings(skill.instructions));
  lines.push("");
  return lines.join("\n");
}

/**
 * After parse, verify that re-serializing produces a Skill deep-equal
 * to the parsed one. A drift means a free-text field smuggled a
 * heading marker past the escape (or that the parser's heading
 * extraction returned content from an unintended section). Used by
 * the POST/PUT route handlers as a write-time integrity check on
 * admin-supplied content; equality failure must reject the write.
 */
export function assertParseRoundTrip(skill: Skill): { ok: true } | { ok: false; reason: string } {
  const reSerialized = serializeSkillMarkdown(skill);
  const reParsed = parseSkillMarkdown(skill.id, reSerialized);
  const fields: Array<keyof Skill> = [
    "name",
    "description",
    "instructions",
    "requiredRole",
  ];
  for (const f of fields) {
    if (skill[f] !== reParsed[f]) {
      return { ok: false, reason: `Field "${String(f)}" did not round-trip — likely a stray "## " heading inside a free-text section.` };
    }
  }
  const arrayFields: Array<keyof Pick<Skill, "requiredTools" | "parameters">> = [
    "requiredTools",
    "parameters",
  ];
  for (const f of arrayFields) {
    const a = skill[f];
    const b = reParsed[f];
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      return { ok: false, reason: `Field "${String(f)}" did not round-trip — likely a stray "## " heading inside a free-text section.` };
    }
  }
  return { ok: true };
}

/**
 * Starting state for a new skill. Mirrors the shape the previous
 * DEFAULT_TEMPLATE string encoded; lives here so the form and any
 * future tooling share one source of truth.
 */
export const DEFAULT_SKILL: Skill = {
  id: "",
  name: "New Skill",
  description: "One-paragraph summary of when this skill applies.",
  instructions: "### 1. First step\n\nDescribe the first investigation step.",
  requiredTools: ["run_sentinel_kql"],
  requiredRole: "reader",
  parameters: ["example_param"],
};

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
