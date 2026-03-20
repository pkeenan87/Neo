# Customizable System Prompt

## Context

The system prompt in `web/lib/config.ts` hardcodes "Goodwin Procter LLP" and lacks organizational context that would help Neo answer questions more accurately. This plan makes the company name configurable via `ORG_NAME` env var, adds support for injecting organizational context via `ORG_CONTEXT` env var / `ORG_CONTEXT_FILE` file path / admin settings UI, and adds a new "Organization" admin tab in `/settings`. The CLI delegates to the web server, so this is a web-only change. Storage for admin-edited context uses Key Vault (via the existing `secrets.ts` pattern), with env var and file as lower-priority fallbacks.

---

## Key Design Decisions

- **Three-tier context resolution**: Admin UI (Key Vault) > `ORG_CONTEXT_FILE` > `ORG_CONTEXT` env var. Admin UI takes priority so runtime edits override static config.
- **`ORG_NAME` stays as env var only** — it's a single short string, doesn't need UI editing. Changing it requires a restart, which is acceptable.
- **Org context stored in Key Vault** as a single secret `ORG_CONTEXT` via the existing `getToolSecret`/`setToolSecret` pattern. This gives admin editability, persistence, and encryption for free.
- **New settings tab** "Organization" (admin-only) with a textarea for editing the context block and a read-only display of the current `ORG_NAME`.
- **2000-char warning, 5000-char hard limit** on org context to prevent system prompt bloat.
- **Context injected as `## ORGANIZATIONAL CONTEXT` section** after the existing `## CONTEXT` section in the system prompt, before `## RESPONSE FORMAT`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/config.ts` | Read `ORG_NAME` from env var; make `getSystemPrompt` async; load org context from Key Vault / file / env var; inject into prompt |
| `web/lib/agent.ts` | Update `runAgentLoop` to await the now-async `getSystemPrompt` |
| `web/app/api/agent/route.ts` | Update agent route to await `getSystemPrompt` if the call site needs updating |
| `web/app/api/admin/org-context/route.ts` | **New** — GET/PUT endpoint for admin-editable org context via Key Vault |
| `web/components/SettingsPage/OrgContextSection.tsx` | **New** — Admin settings tab component with textarea for org context |
| `web/components/SettingsPage/OrgContextSection.module.css` | **New** — Styles |
| `web/components/SettingsPage/SettingsPage.tsx` | Add "Organization" tab for admin users |
| `.env.example` | Add `ORG_NAME` and `ORG_CONTEXT` / `ORG_CONTEXT_FILE` with docs |
| `test/customizable-system-prompt.test.js` | **New** — Tests for prompt construction logic |

---

## Implementation Steps

### 1. Make `ORG_NAME` configurable in `web/lib/config.ts`

- Read `process.env.ORG_NAME` at the top of the file
- If empty string, use `"your organization"` as fallback; if undefined, use `"Goodwin Procter LLP"`
- Replace the hardcoded `"Goodwin Procter LLP"` in `BASE_SYSTEM_PROMPT` with the resolved org name
- Also update the `## CONTEXT` section's "Environment: Law firm" line to use the org name dynamically (e.g., "Environment: {orgName}")

### 2. Add org context loading function in `web/lib/config.ts`

- Create an `async function loadOrgContext(): Promise<string | null>` that resolves org context from three sources in priority order:
  1. Key Vault via `getToolSecret("ORG_CONTEXT")` — admin-edited value
  2. File via `ORG_CONTEXT_FILE` env var — read the file contents using `fs.readFile`
  3. Env var `ORG_CONTEXT` — direct string value (supports `\n` for newlines)
- Return `null` if no source provides content
- Log a warning via `console.warn` if the resolved content exceeds 2000 characters
- Throw if content exceeds 5000 characters with a clear error message
- Cache the result for 60 seconds to avoid hitting Key Vault on every agent loop iteration (use a simple timestamp + value cache, similar to the token cache in `auth.ts`)

### 3. Make `getSystemPrompt` async and inject org context

- Change `getSystemPrompt(role)` to `async getSystemPrompt(role)`
- After constructing the base prompt (with skills), call `loadOrgContext()`
- If org context is non-null, insert a `## ORGANIZATIONAL CONTEXT` section before `## RESPONSE FORMAT` in the prompt string
- Return the assembled prompt

### 4. Update callers of `getSystemPrompt`

- In `web/lib/agent.ts` `runAgentLoop()`: update `const systemPrompt = getSystemPrompt(role)` to `const systemPrompt = await getSystemPrompt(role)`
- Check `web/app/api/agent/route.ts` and any other callers — update to await if needed

### 5. Create admin API endpoint `web/app/api/admin/org-context/route.ts`

- **GET**: Admin-gated. Return `{ orgContext: string | null, orgName: string }` — read org context from Key Vault, org name from env var
- **PUT**: Admin-gated + CSRF Origin check. Accept `{ orgContext: string }` body. Validate length (max 5000 chars). Save to Key Vault via `setToolSecret("ORG_CONTEXT", orgContext)`. Clear the cached org context. Return `{ ok: true }`.
- Follow the existing admin endpoint auth pattern from `api/admin/usage/route.ts`

### 6. Create `OrgContextSection` component

- **File**: `web/components/SettingsPage/OrgContextSection.tsx`
- Client component with:
  - Fetch `GET /api/admin/org-context` on mount
  - Display read-only `ORG_NAME` value with a note that it's configured via env var
  - A textarea for `orgContext` with placeholder example text showing domain names, SAM format, etc.
  - Character count display showing current/max (5000)
  - Save button that PUTs to `/api/admin/org-context`
  - Success/error feedback matching existing patterns (ApiKeysSection)
- **File**: `web/components/SettingsPage/OrgContextSection.module.css` with dark mode support

### 7. Wire the tab into `SettingsPage.tsx`

- Add `'org-context'` to the `Tab` type union
- Add `{ value: 'org-context', label: 'Organization' }` to the admin-only tabs array, positioned before "Usage Limits"
- Add conditional render: `{activeTab === 'org-context' && <OrgContextSection />}`
- Import the new component

### 8. Update `.env.example`

- Add `ORG_NAME`, `ORG_CONTEXT`, and `ORG_CONTEXT_FILE` with descriptive comments and example values

### 9. Write tests in `test/customizable-system-prompt.test.js`

- Test the org name resolution logic (replicated since config.ts can't be imported directly):
  - Env var set → uses that value
  - Env var not set → defaults to "Goodwin Procter LLP"
  - Env var empty string → falls back to "your organization"
- Test org context injection:
  - Context present → `## ORGANIZATIONAL CONTEXT` section appears in prompt
  - Context absent → section is omitted
  - Context exceeds 2000 chars → warning threshold met
  - Context exceeds 5000 chars → rejected

---

## Verification

1. Run `node --experimental-strip-types --test test/customizable-system-prompt.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Set `ORG_NAME=Acme Corp` in `.env`, start dev server, send a message — verify system prompt in the agent's behavior references "Acme Corp"
4. Log in as admin, navigate to `/settings` → "Organization" tab — verify textarea loads, edit and save, verify next agent call uses the new context
5. Set `ORG_CONTEXT_FILE=./org-context.md` with sample content, restart — verify it's injected into the system prompt
6. Verify omitting all three sources produces the default Goodwin Procter behavior
