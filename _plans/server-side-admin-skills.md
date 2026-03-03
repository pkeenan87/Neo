# Server-Side Admin Skills

## Context

This plan implements admin-managed skills — markdown files stored on the server that describe multi-step investigation workflows. Skills are injected into the agent's system prompt so Claude follows admin-defined runbooks when a user's request matches. The feature reuses the existing hot-reload pattern from `api-key-store.ts` for filesystem watching and adds CRUD API endpoints gated by the `admin` role. No changes are made to the agent loop, tool execution, or confirmation gate — skills are purely system-prompt instructions that guide Claude's tool usage.

---

## Key Design Decisions

- **Skills are system-prompt context, not a new execution mechanism**: Skills are appended to the existing `SYSTEM_PROMPT` string before each agent loop call. Claude reads the instructions and follows them using existing tools. This avoids changes to `agent.ts`, `executors.ts`, or the tool dispatch system entirely.
- **Filesystem-first storage with API layer on top**: Skills live as `.md` files in `web/skills/`. The API endpoints write to the same directory, keeping filesystem and API management in sync. This follows the pattern established by `api-keys.json`.
- **Hot-reload via `fs.watch`**: The skill store watches the skills directory and reloads on change, matching the `api-key-store.ts` pattern. No server restart needed.
- **Skill ID derived from filename**: The skill's ID is its filename without the `.md` extension (e.g. `tor-login-investigation.md` → ID `tor-login-investigation`). This makes filesystem management intuitive and avoids a separate ID registry.
- **Load-time validation**: When a skill is loaded, the store validates that skills referencing destructive tools declare `admin` as their required role. Invalid skills are logged as warnings and excluded from the loaded set.
- **Role filtering happens at prompt injection time**: `getSkillsForRole(role)` filters skills before injecting them into the system prompt, so readers never see skills that require `admin`. This mirrors the `getToolsForRole(role)` pattern in `permissions.ts`.
- **Next.js dynamic route for single-skill operations**: `GET /api/skills/[id]`, `PUT /api/skills/[id]`, and `DELETE /api/skills/[id]` use a Next.js dynamic route segment at `web/app/api/skills/[id]/route.ts`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/skill-store.ts` | New file — skill loading, parsing, validation, hot-reload, CRUD operations, and role-filtered retrieval |
| `web/lib/types.ts` | Add the `Skill` interface |
| `web/lib/config.ts` | Modify `SYSTEM_PROMPT` export to become a function `getSystemPrompt(role)` that appends skill context |
| `web/lib/agent.ts` | Update `runAgentLoop` to call `getSystemPrompt(role)` instead of using the static `SYSTEM_PROMPT` |
| `web/app/api/skills/route.ts` | New file — `GET` (list all skills) and `POST` (create skill, admin only) |
| `web/app/api/skills/[id]/route.ts` | New file — `GET` (single skill), `PUT` (update, admin only), `DELETE` (delete, admin only) |
| `web/skills/` | New directory — stores skill markdown files; ships empty (or with an example skill) |
| `docs/user-guide.md` | Add "Skills" section documenting admin skill management and user invocation |
| `docs/configuration.md` | Add skill file format reference and API endpoints |

---

## Implementation Steps

### 1. Add the `Skill` interface to `types.ts`

- Add a `Skill` interface with fields: `id` (string, derived from filename), `name` (string, from the `# Skill:` heading), `description` (string, from `## Description`), `content` (string, the full raw markdown), `requiredTools` (string array, from `## Required Tools`), `requiredRole` (Role, from `## Required Role`, defaulting to `reader`), `parameters` (string array, from `## Parameters`)
- Add a `SkillMeta` interface with fields: `id`, `name`, `description`, `requiredRole`, `parameters` — used for list responses and system prompt summaries (excludes the full `content` body)

### 2. Create `web/lib/skill-store.ts`

- Define a `parseSkillMarkdown(id: string, raw: string)` function that extracts structured fields from the markdown format defined in the spec. Parse the `# Skill:` line for the name, `## Description` for the description, `## Required Tools` for a bullet list of tool names, `## Required Role` for `admin` or `reader` (default `reader`), `## Parameters` for a bullet list of parameter names and descriptions. Store the full raw markdown as `content`.
- Define a `validateSkill(skill: Skill)` function that checks: (a) required fields are present (name, description), (b) all entries in `requiredTools` exist in the tool name set imported from `tools.ts`, (c) if any entry in `requiredTools` is in `DESTRUCTIVE_TOOLS`, then `requiredRole` must be `admin` — otherwise log a warning to `console.warn` and return `null` to indicate rejection.
- Implement `loadSkillsFromDisk()` that reads all `.md` files from the `web/skills/` directory using `readdirSync` + `readFileSync`, parses each with `parseSkillMarkdown`, validates with `validateSkill`, and stores valid skills in an in-memory `Map<string, Skill>`.
- Call `loadSkillsFromDisk()` at module initialization (same pattern as `loadKeys()` in `api-key-store.ts`).
- Set up `fs.watch` on the skills directory to call `loadSkillsFromDisk()` on any change. Wrap in a try-catch so a missing directory doesn't crash the server — just log a message and leave the skill set empty.
- Export `getAllSkills(): Skill[]` — returns all loaded skills.
- Export `getSkillsForRole(role: Role): Skill[]` — filters skills by `requiredRole`. An `admin` gets all skills. A `reader` gets only skills where `requiredRole === "reader"`.
- Export `getSkill(id: string): Skill | undefined` — single skill lookup by ID.
- Export `createSkill(id: string, content: string): Skill` — writes the markdown to `web/skills/{id}.md`, parses and validates it, reloads the store, and returns the parsed skill. Throws if the ID is already taken or validation fails.
- Export `updateSkill(id: string, content: string): Skill` — overwrites the file, reloads, returns the updated skill. Throws if the skill doesn't exist or validation fails.
- Export `deleteSkill(id: string): void` — deletes the file from disk and removes from the in-memory map. Throws if the skill doesn't exist.
- Validate the skill `id` format: lowercase alphanumeric and hyphens only, 1–60 characters, matching `/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/` (or single character `[a-z0-9]`).

### 3. Modify `config.ts` — make the system prompt role-aware with skills

- Import `getSkillsForRole` from `./skill-store`.
- Rename the existing `SYSTEM_PROMPT` constant to `BASE_SYSTEM_PROMPT` (keep it as a non-exported constant).
- Export a new function `getSystemPrompt(role: Role): string` that:
  1. Starts with `BASE_SYSTEM_PROMPT`.
  2. Calls `getSkillsForRole(role)` to get skills available to this role.
  3. If skills exist, appends a `## AVAILABLE SKILLS` section to the prompt. For each skill, include the full markdown content (so Claude can follow the steps). Prefix with a brief instruction: "The following skills are pre-configured investigation workflows. When a user's request matches a skill, follow its steps closely. If the user asks what skills are available, list them with their descriptions."
  4. If no skills are loaded, omit the skills section entirely.
  5. Returns the assembled string.
- Keep exporting `SYSTEM_PROMPT` as a static constant for backward compatibility (in case any other file imports it directly), pointing to `BASE_SYSTEM_PROMPT`. Alternatively, do a project-wide search to confirm only `agent.ts` imports `SYSTEM_PROMPT` and remove the old export entirely.

### 4. Update `agent.ts` — use the role-aware system prompt

- Change the import from `{ env, SYSTEM_PROMPT }` to `{ env, getSystemPrompt }`.
- In `runAgentLoop`, replace the static `system: SYSTEM_PROMPT` in the `client.messages.create` call with `system: getSystemPrompt(role)`.
- No other changes to the agent loop — skills are purely context injected via the system prompt.

### 5. Create the skills directory

- Create the `web/skills/` directory.
- Add a `.gitkeep` file so the empty directory is tracked by git.
- Optionally add one example skill file (`web/skills/tor-login-investigation.md`) using the format from the spec, so admins have a template to follow.

### 6. Create `web/app/api/skills/route.ts` — list and create

- Import `resolveAuth` from `@/lib/auth-helpers`.
- Import `getAllSkills`, `createSkill` from `@/lib/skill-store`.
- `GET` handler: authenticate the request, return a JSON array of all skills in `SkillMeta` format (id, name, description, requiredRole, parameters — no full content). Available to all authenticated users.
- `POST` handler: authenticate, check `identity.role === "admin"` (return 403 otherwise). Parse the JSON body expecting `{ id: string, content: string }`. Validate that `id` matches the allowed format. Call `createSkill(id, content)`. On success, return 201 with the created skill meta. On validation failure, return 400 with an error message. On ID conflict, return 409.

### 7. Create `web/app/api/skills/[id]/route.ts` — get, update, delete

- Import `resolveAuth`, `getSkill`, `updateSkill`, `deleteSkill`.
- Extract the `id` parameter from the Next.js dynamic route context.
- `GET` handler: authenticate, look up the skill by ID. Return 404 if not found. Return the full skill object including `content`.
- `PUT` handler: authenticate, require `admin` role (403 otherwise). Parse body expecting `{ content: string }`. Call `updateSkill(id, content)`. Return 200 with updated skill meta. Return 404 if skill doesn't exist, 400 if validation fails.
- `DELETE` handler: authenticate, require `admin` role. Call `deleteSkill(id)`. Return 200 with `{ deleted: true }`. Return 404 if skill doesn't exist.

### 8. Update documentation

- In `docs/user-guide.md`:
  - Add a "Skills" section under "Administration" explaining how admins create skill files in `web/skills/`, the markdown format, and the API endpoints for CRUD management.
  - Add a "Using Skills" section under "Using the CLI" explaining that users can ask "what skills are available?" and invoke them naturally.
  - Add the skill API endpoints to the API Endpoints reference table.
- In `docs/configuration.md`:
  - Add a "Skills" section documenting the skill file format with all headings (`# Skill:`, `## Description`, `## Parameters`, `## Steps`, `## Output Format`, `## Required Tools`, `## Required Role`).
  - Document the `web/skills/` directory and hot-reload behavior.
  - Add the API endpoints to any existing API reference.

### 9. Verify

- Run `cd web && npm run build` to confirm all new files compile cleanly and routes are detected.
- Manually create a skill file in `web/skills/` (e.g. the TOR investigation example from the spec) and start the dev server — confirm the skill appears in `GET /api/skills`.
- Test `POST /api/skills` with an admin API key — confirm the file is created on disk and appears in subsequent GET requests.
- Test `DELETE /api/skills/{id}` — confirm the file is removed from disk.
- Test that a skill referencing a destructive tool with `Required Role: reader` is rejected at load time (console warning, excluded from list).
- Start an agent conversation and ask "what skills are available?" — confirm the agent lists loaded skills.
- Invoke a skill naturally (e.g. "run a TOR investigation on jsmith@contoso.com") — confirm the agent follows the skill's steps.

---

## Verification

1. `cd web && npm run build` — zero TypeScript errors, all routes detected including `/api/skills` and `/api/skills/[id]`
2. Create `web/skills/tor-login-investigation.md` with the example format — start the dev server and `curl http://localhost:3000/api/skills` with auth — should list the skill
3. `curl -X POST http://localhost:3000/api/skills -H "Authorization: Bearer <admin-key>" -d '{"id":"test-skill","content":"# Skill: Test\n\n## Description\nA test skill.\n\n## Steps\n1. Run get_user_info\n\n## Required Tools\n- get_user_info\n\n## Required Role\nreader"}'` — should return 201 and create `web/skills/test-skill.md`
4. `curl -X DELETE http://localhost:3000/api/skills/test-skill -H "Authorization: Bearer <admin-key>"` — should delete the file
5. Create a skill with `Required Role: reader` that lists `reset_user_password` in Required Tools — confirm it is rejected at load time with a console warning
6. In the CLI, ask "what skills are available?" — agent should list loaded skills with descriptions
7. In the CLI, invoke a skill by natural request — agent should follow the defined steps and use the specified tools
