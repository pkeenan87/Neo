import { readFileSync, readdirSync, writeFileSync, unlinkSync, watch, mkdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { logger } from "./logger";
import {
  listSkillsFromCosmos,
  getSkillFromCosmos,
  upsertSkillInCosmos,
  createSkillInCosmos,
  deleteSkillFromCosmos,
} from "./skill-store-cosmos";
import type { Role } from "./permissions";
import type { Skill, SkillMeta } from "./types";
import {
  parseSkillMarkdown,
  validateSkillId,
  validateSkillContent,
  inspectSkill,
} from "./skill-parser";

// Re-export the browser-safe parser + validators so existing callers
// (route handlers, migration script, agent loop) keep one import path.
export {
  parseSkillMarkdown,
  validateSkillId,
  validateSkillContent,
  inspectSkill,
};

// NOTE: skill-store cannot import from `./config` because config imports
// getSkillsForRole back from this module — that would be a circular
// import. Read the two relevant env vars directly so the dispatch
// decision lives independently of the config module's bootstrap.

// ─────────────────────────────────────────────────────────────
//  Skill store — dual-source dispatch.
//
//  Cosmos-mode (production): the `skills` Cosmos container is the
//  source of truth, with a 15s read-through cache per instance so a
//  skill update via the admin API propagates to all instances within
//  one cache window. The 15s window is a deliberate cap on the
//  role-downgrade exploitation window for destructive admin skills:
//  if an admin tightens `requiredRole` from analyst → admin, every
//  instance enforces the new value within 15 s. See
//  _plans/multi-instance-deployment.md.
//
//  File-mode (dev / MOCK_MODE / no Cosmos): legacy behaviour — read
//  from `skills/*.md` and hot-reload via `fs.watch`. Preserves the
//  contributor workflow of editing markdown locally.
//
//  The choice is driven by `useCosmos()`: production with Cosmos
//  configured AND not in MOCK_MODE.
// ─────────────────────────────────────────────────────────────

const SKILLS_DIR = resolve(process.cwd(), "skills");

// 15s read-through cache for the Cosmos backend. Skill updates take
// effect on every instance within one cache window without restart.
// Tuned to bound the role-downgrade exploitation window — see the
// header comment above.
const COSMOS_CACHE_TTL_MS = 15 * 1000;

function useCosmos(): boolean {
  // Match `api-key-store.useCosmosOnly`: Cosmos kicks in only when
  // BOTH the endpoint is configured AND MOCK_MODE is the literal
  // string "false". `MOCK_MODE` defaults to enabled (matches
  // `env.MOCK_MODE = process.env.MOCK_MODE !== "false"` in config.ts)
  // — without the explicit opt-out, both stores stay file-mode in
  // sync. Reading process.env directly avoids the config↔skill-store
  // import cycle.
  return (
    Boolean(process.env.COSMOS_ENDPOINT) &&
    process.env.MOCK_MODE === "false"
  );
}

// ── File-mode cache (legacy) ─────────────────────────────────

let fileSkillCache = new Map<string, Skill>();

// ── Cosmos-mode cache (15s read-through) ────────────────────

interface CosmosCache {
  byId: Map<string, Skill>;
  loadedAt: number;
}
let cosmosCache: CosmosCache | null = null;

async function refreshCosmosCache(): Promise<CosmosCache> {
  const skills = await listSkillsFromCosmos();
  const byId = new Map<string, Skill>();
  for (const s of skills) byId.set(s.id, s);
  cosmosCache = { byId, loadedAt: Date.now() };
  return cosmosCache;
}

function invalidateCosmosCache(): void {
  cosmosCache = null;
}

async function getCosmosCache(): Promise<CosmosCache> {
  if (cosmosCache && Date.now() - cosmosCache.loadedAt < COSMOS_CACHE_TTL_MS) {
    return cosmosCache;
  }
  return refreshCosmosCache();
}

// ─────────────────────────────────────────────────────────────
//  Server-side validation (logs + returns boolean)
//
//  The pure-data check is `inspectSkill` (in ./skill-parser); this
//  wrapper logs the same findings via the project's logger so the
//  file-loader and Cosmos refresh paths leave a trail when a skill
//  is rejected.
// ─────────────────────────────────────────────────────────────

export function validateSkill(skill: Skill): boolean {
  const result = inspectSkill(skill);
  if (result.ok) return true;
  for (const issue of result.issues) {
    logger.warn(`Skill "${skill.id}" — ${issue} (skipped)`, "skill-store");
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
//  File-mode disk I/O (legacy)
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
    fileSkillCache = next;
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
      logger.warn(`Failed to load ${file}: ${(err as Error).message}`, "skill-store");
    }
  }

  fileSkillCache = next;
}

// File-mode initial load + watcher. Skipped under Cosmos-mode so
// production never opens the local skills directory.
if (!useCosmos()) {
  if (!existsSync(SKILLS_DIR)) {
    logger.warn(`Skills directory not found at ${SKILLS_DIR} — no skills will be loaded`, "skill-store");
  }
  loadSkillsFromDisk();

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
      logger.warn(
        `Could not watch ${SKILLS_DIR} for changes: ${(err as Error).message} — ` +
          "skills will not hot-reload; restart the server to pick up changes.",
        "skill-store",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Public API (async)
//
//  Sync getters were migrated to async to support the Cosmos
//  read-through path. All current callers are already in async
//  contexts. See _plans/multi-instance-deployment.md.
// ─────────────────────────────────────────────────────────────

export async function getAllSkills(): Promise<Skill[]> {
  if (useCosmos()) {
    const cache = await getCosmosCache();
    return Array.from(cache.byId.values());
  }
  return Array.from(fileSkillCache.values());
}

export async function getSkillsForRole(role: Role): Promise<Skill[]> {
  const all = await getAllSkills();
  return all.filter((skill) => skill.requiredRole !== "admin" || role === "admin");
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  if (useCosmos()) {
    const cache = await getCosmosCache();
    const cached = cache.byId.get(id);
    if (cached) return cached;
    // Cache miss after a fresh refresh means the skill genuinely
    // doesn't exist (or was just deleted). Don't issue a per-id
    // point-read; the next refresh window will pick up creates.
    return undefined;
  }
  return fileSkillCache.get(id);
}

export async function createSkill(id: string, content: string): Promise<Skill> {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  const contentError = validateSkillContent(content);
  if (contentError) throw new Error(contentError);

  const skill = parseSkillMarkdown(id, content);
  if (!validateSkill(skill)) {
    throw new Error("Skill validation failed — check server logs for details");
  }

  if (useCosmos()) {
    // Atomic create — Cosmos returns 409 on collision, eliminating
    // the read-then-upsert race that would otherwise let two
    // concurrent admin POSTs for the same id silently overwrite
    // each other. See createSkillInCosmos for context.
    await createSkillInCosmos(skill, content);
    invalidateCosmosCache();
    return skill;
  }

  ensureSkillsDir();
  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf-8");
  fileSkillCache.set(id, skill);
  return skill;
}

export async function updateSkill(id: string, content: string): Promise<Skill> {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  const contentError = validateSkillContent(content);
  if (contentError) throw new Error(contentError);

  const skill = parseSkillMarkdown(id, content);
  if (!validateSkill(skill)) {
    throw new Error("Skill validation failed — check server logs for details");
  }

  if (useCosmos()) {
    const existing = await getSkillFromCosmos(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);
    await upsertSkillInCosmos(skill, content);
    invalidateCosmosCache();
    return skill;
  }

  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Skill file not found on disk: ${id}`);
  }
  writeFileSync(filePath, content, "utf-8");
  fileSkillCache.set(id, skill);
  return skill;
}

export async function deleteSkill(id: string): Promise<void> {
  const idError = validateSkillId(id);
  if (idError) throw new Error(idError);

  if (useCosmos()) {
    await deleteSkillFromCosmos(id);
    invalidateCosmosCache();
    return;
  }

  const filePath = resolve(SKILLS_DIR, `${id}.md`);
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  fileSkillCache.delete(id);
}

export function toSkillMeta(skill: Skill): SkillMeta {
  const { instructions: _, ...meta } = skill;
  return meta;
}

/** Test-only — force the Cosmos cache to refresh on next read. */
export function __invalidateCosmosCacheForTest(): void {
  invalidateCosmosCache();
}
