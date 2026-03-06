# Fix Skill Context Loading

## Context

Skills defined in `web/skills/` are not being loaded into the agent's system prompt in production. The `skill-store.ts` module resolves `SKILLS_DIR` relative to `__dirname` (via `import.meta.url`), but Next.js standalone builds bundle server code into `.next/standalone/` chunks and do not copy the `skills/` directory. The deployment script also does not include `skills/` in the zip artifact. Additionally, the system prompt's skill section text should instruct the agent to proactively suggest matching skills to users.

---

## Key Design Decisions

- Use `process.cwd()` as the base for resolving the skills directory instead of `__dirname` — the standalone server's working directory is the deployment root where `server.js` lives, and we'll copy `skills/` there during packaging
- Copy the `skills/` directory into the deployment staging area alongside `public/` and `.next/static/` in the deploy script
- Enhance the system prompt's `AVAILABLE SKILLS` section to instruct the agent to proactively suggest matching skills when a user's query aligns with one
- Convention-based path (`./skills/` relative to `process.cwd()`) is sufficient — no env var needed per user decision

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/skill-store.ts` | Change `SKILLS_DIR` resolution from `__dirname`-relative to `process.cwd()`-relative so it works in both dev and standalone production |
| `scripts/deploy-azure.ps1` | Add a packaging step to copy `web/skills/` into the staging directory |
| `web/lib/config.ts` | Update the `AVAILABLE SKILLS` section intro text to instruct the agent to proactively suggest matching skills |

---

## Implementation Steps

### 1. Fix SKILLS_DIR path resolution in skill-store.ts

- Remove the `__dirname` derivation (line 8: `const __dirname = dirname(fileURLToPath(import.meta.url));`)
- Remove the `fileURLToPath` and `dirname` imports (no longer needed; `resolve` and `basename` are still used)
- Change `SKILLS_DIR` (line 9) from `resolve(__dirname, "../skills")` to `resolve(process.cwd(), "skills")`
- This works because:
  - In development (`npm run dev`), `process.cwd()` is `web/` and `web/skills/` exists
  - In standalone production, `process.cwd()` is the deployment root where `server.js` lives, and we'll copy `skills/` there in step 2

### 2. Add skills/ directory to deploy-azure.ps1 packaging

- In the Package section of `deploy-azure.ps1`, after the block that copies `.next/static/` into the staging directory (around line 183), add a new block that copies the `skills/` directory
- The source path is `Join-Path $WebDir "skills"` (i.e., `web/skills/`)
- The destination is `Join-Path $StagingDir "skills"`
- Guard with `if (Test-Path $SkillsDir)` to avoid errors if no skills exist yet
- Add an informational write-host line indicating how many skill files were copied

### 3. Update system prompt skill section text in config.ts

- In the `getSystemPrompt` function (line 142–148 of `config.ts`), update the `AVAILABLE SKILLS` introduction text
- Change from: `"The following admin-defined investigation skills are available. When a user's request matches a skill, follow its steps precisely."`
- Change to text that instructs the agent to:
  - Proactively suggest a matching skill when the user's request aligns with one (e.g., "I have a TOR Login Investigation skill that covers this — would you like me to follow it?")
  - List available skills when the user asks about capabilities or what the agent can do
  - Follow the skill's steps precisely once the user confirms or when the match is unambiguous

---

## Verification

1. Run `cd web && npx tsc --noEmit` to confirm no type errors after the `skill-store.ts` changes
2. Run `cd web && npm run build` to confirm the production build succeeds
3. In development: run `cd web && npm run dev`, send a message to the agent asking "what skills do you have?" — confirm it lists the TOR Login Investigation skill
4. In development: ask the agent to "investigate a TOR login for user jsmith@contoso.com" — confirm it references the skill steps rather than improvising
5. Build and inspect the standalone output: verify that `process.cwd()` resolution would find `skills/` when the deploy script copies it to the staging root
6. Read through the deploy script changes to confirm `skills/` would be included in the zip artifact
