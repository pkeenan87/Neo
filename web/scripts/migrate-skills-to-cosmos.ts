#!/usr/bin/env tsx
/**
 * Migrate skills from web/skills/*.md → Cosmos DB `skills` container.
 *
 * Idempotent — re-running upserts existing entries (unchanged content
 * produces an identical doc apart from updatedAt). Use this script
 * once per environment when cutting over from file-mode to Cosmos-
 * mode for the skill store. See _plans/multi-instance-deployment.md.
 *
 * Usage:
 *   cd web
 *   npm run migrate:skills           # real run
 *   npm run migrate:skills -- --dry-run  # report what would change
 *
 * Requires COSMOS_ENDPOINT set and the App Service's managed identity
 * (or a developer's az-login identity) to have Cosmos DB Built-in
 * Data Contributor on the target account.
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, basename } from "path";
import { parseSkillMarkdown, validateSkill, validateSkillId } from "../lib/skill-store";
import { upsertSkillInCosmos } from "../lib/skill-store-cosmos";

interface Summary {
  total: number;
  migrated: number;
  skippedInvalid: number;
  failed: number;
  failures: Array<{ id: string; error: string }>;
  dryRun: boolean;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  const skillsDir = resolve(process.cwd(), "skills");
  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    console.error(`Cannot read skills directory ${skillsDir}: ${(err as Error).message}`);
    return 2;
  }

  const summary: Summary = {
    total: files.length,
    migrated: 0,
    skippedInvalid: 0,
    failed: 0,
    failures: [],
    dryRun,
  };

  for (const file of files) {
    const id = basename(file, ".md");
    // Sanity-check the id derived from the filename. The admin route
    // already enforces this for create/update — apply it here too so
    // a developer can't accidentally migrate a file whose name would
    // be rejected by the Cosmos id constraints (`/`, `\`, `?`, `#`)
    // or by our slug rules (lowercase kebab-case only).
    const idError = validateSkillId(id);
    if (idError) {
      summary.skippedInvalid += 1;
      console.warn(`  skipped (invalid id): ${id} — ${idError}`);
      continue;
    }
    try {
      const raw = readFileSync(resolve(skillsDir, file), "utf-8");
      const skill = parseSkillMarkdown(id, raw);
      if (!validateSkill(skill)) {
        summary.skippedInvalid += 1;
        continue;
      }
      if (!dryRun) {
        await upsertSkillInCosmos(skill, raw);
      }
      summary.migrated += 1;
      console.log(`  ${dryRun ? "(dry-run) would migrate" : "migrated"}: ${id}`);
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ id, error: (err as Error).message });
      console.error(`  failed: ${id} — ${(err as Error).message}`);
    }
  }

  console.log("\n" + JSON.stringify({ summary }, null, 2));

  if (summary.failed > 0) return 1;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("migration crashed:", err);
    process.exit(1);
  },
);
