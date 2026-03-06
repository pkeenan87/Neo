import { readFileSync, readdirSync, writeFileSync, unlinkSync, watch, mkdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools";
import type { Role } from "./permissions";
import type { Skill, SkillMeta } from "./types";

const SKILLS_DIR = resolve(process.cwd(), "skills");

if (!existsSync(SKILLS_DIR)) {
  console.warn(`[skill-store] Skills directory not found at ${SKILLS_DIR}. No skills will be loaded.`);
}

const VALID_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const MAX_ID_LENGTH = 60;
const MAX_CONTENT_BYTES = 32_000;

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

let skillCache = new Map<string, Skill>();

// ─────────────────────────────────────────────────────────────
//  Markdown Parsing
// ─────────────────────────────────────────────────────────────

function extractSection(raw: string, heading: string): string {
  const pattern = new RegExp(
    `^##\\s+${heading}\\s*$`,
    "im"
  );
  const match = pattern.exec(raw);
  if (!match) return "";

  const start = match.index + match[0].length;
  // Find the next ## heading or end of string
  const nextHeading = raw.indexOf("\n## ", start);
  const section = nextHeading === -1
    ? raw.slice(start)
    : raw.slice(start, nextHeading);

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

// ─────────────────────────────────────────────────────────────
//  Validation
// ─────────────────────────────────────────────────────────────

export function validateSkill(skill: Skill): boolean {
  if (!skill.name) {
    console.warn(`[skill-store] Skill "${skill.id}" is missing a name — skipped`);
    return false;
  }
  if (!skill.description) {
    console.warn(`[skill-store] Skill "${skill.id}" is missing a description — skipped`);
    return false;
  }

  for (const tool of skill.requiredTools) {
    if (!TOOL_NAMES.has(tool)) {
      console.warn(`[skill-store] Skill "${skill.id}" references unknown tool "${tool}" — skipped`);
      return false;
    }
  }

  // Skills that require destructive tools must have admin role
  const usesDestructiveTool = skill.requiredTools.some((t) => DESTRUCTIVE_TOOLS.has(t));
  if (usesDestructiveTool && skill.requiredRole !== "admin") {
    console.warn(
      `[skill-store] Skill "${skill.id}" uses destructive tools but has role "${skill.requiredRole}" — skipped (must be "admin")`
    );
    return false;
  }

  return true;
}

export function validateSkillId(id: string): string | null {
  if (!id) return "ID is required";
  if (id.length > MAX_ID_LENGTH) return `ID must be ${MAX_ID_LENGTH} characters or fewer`;
  if (!VALID_ID.test(id)) {
    return "ID must be 2+ lowercase alphanumeric characters and hyphens, not starting or ending with a hyphen";
  }
  return null;
}

export function validateSkillContent(content: string): string | null {
  if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
    return `Skill content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Disk I/O
// ─────────────────────────────────────────────────────────────

function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

export function loadSkillsFromDisk(): void {
  ensureSkillsDir();

  const next = new Map<string, Skill>();

  let files: string[];
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    skillCache = next;
    return;
  }

  for (const file of files) {
    const id = basename(file, ".md");
    try {
      const raw = readFileSync(resolve(SKILLS_DIR, file), "utf-8");
      const skill = parseSkillMarkdown(id, raw);
      if (validateSkill(skill)) {
        next.set(id, skill);
      }
    } catch (err) {
      console.warn(`[skill-store] Failed to load ${file}: ${(err as Error).message}`);
    }
  }

  skillCache = next;
}

// Initial load
loadSkillsFromDisk();

// Debounced hot-reload on file changes
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

try {
  watch(SKILLS_DIR, { persistent: false }, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      loadSkillsFromDisk();
    }, 200);
  });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    console.warn(`[skill-store] Could not watch ${SKILLS_DIR} for changes: ${(err as Error).message}`);
    console.warn("[skill-store] Skills will not hot-reload; restart the server to pick up changes.");
  }
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

export function getAllSkills(): Skill[] {
  return Array.from(skillCache.values());
}

export function getSkillsForRole(role: Role): Skill[] {
  return getAllSkills().filter(
    (skill) => skill.requiredRole !== "admin" || role === "admin"
  );
}

export function getSkill(id: string): Skill | undefined {
  return skillCache.get(id);
}

export function createSkill(id: string, content: string): Skill {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  const contentError = validateSkillContent(content);
  if (contentError) throw new Error(contentError);

  // Parse and validate before writing to disk
  const skill = parseSkillMarkdown(id, content);
  if (!validateSkill(skill)) {
    throw new Error("Skill validation failed — check server logs for details");
  }

  ensureSkillsDir();
  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf-8");

  skillCache.set(id, skill);
  return skill;
}

export function updateSkill(id: string, content: string): Skill {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  const contentError = validateSkillContent(content);
  if (contentError) throw new Error(contentError);

  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Skill file not found on disk: ${id}`);
  }

  // Parse and validate before writing to disk
  const skill = parseSkillMarkdown(id, content);
  if (!validateSkill(skill)) {
    throw new Error("Skill validation failed — check server logs for details");
  }

  writeFileSync(filePath, content, "utf-8");
  skillCache.set(id, skill);
  return skill;
}

export function deleteSkill(id: string): void {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // File already gone — treat as idempotent, still evict from cache
  }
  skillCache.delete(id);
}

export function toSkillMeta(skill: Skill): SkillMeta {
  const { instructions: _, ...meta } = skill;
  return meta;
}
