# Web Search Tool Integration Surfaces

## Context

PR #111 / #113 shipped `web_search` as an Anthropic-hosted server tool, but the registration only wired it into the agent loop's per-request `tools` array via `getEnabledServerTools(toolAllowlist)`. Every other surface that knows about the tool catalogue — skill validation, the skill editor dropdown, the scheduled-task picker, the scheduled-task runner's allowlist intersector, and the role-based permission gate — was built off `TOOLS` (custom-tool array) and silently excludes anything in `SERVER_TOOLS`. As a result, admins cannot list `web_search` in a skill's `Required Tools` (validator rejects it), cannot select it in the scheduled-task editor (not in the dropdown), and if they hand-edit a task's `allowedTools` JSON to include it the runner strips it before dispatch. This plan unifies all of those surfaces around a single `ALL_TOOL_NAMES` set so the server tool participates uniformly.

The scope is integration plumbing only — no changes to how `web_search` is executed, sanitised, or persisted. The fixes are MOCK_MODE-aware: in mock mode `getEnabledServerTools` still strips the tool at the agent boundary, which is the correct behaviour (we don't want admin UIs to look broken in mock mode, but we also don't want the model to think it has the tool when it doesn't).

---

## Key Design Decisions

- **One shared `ALL_TOOL_NAMES` set in `tools.ts`.** Today three files independently build `new Set(TOOLS.map(t => t.name))` (`permissions.ts:57`, `skill-parser.ts:19`, `scheduled-task-runner.ts:46`). Each missed `SERVER_TOOLS`. Export a `ALL_TOOL_NAMES` constant (TOOLS ∪ SERVER_TOOLS, by name) from `tools.ts` and import it everywhere. This is the smallest change that makes "is `web_search` a real tool?" answer the same way at every layer.
- **MOCK_MODE strip stays at the agent boundary, not at the editor/validator layer.** `getEnabledServerTools` already filters server tools out of the API call when `MOCK_MODE !== "false"`. We deliberately do NOT also filter the editor dropdown or the skill validator on `MOCK_MODE`, because (a) the dropdown is rendered by a server component reading `process.env` at module load and would force a redeploy to toggle, and (b) an admin should be able to author a skill in mock mode and have it work the moment they flip to live. The "advertised to Claude or not?" decision lives in one place: `getEnabledServerTools`.
- **`web_search` stays non-destructive and admin-not-required.** No entry in `DESTRUCTIVE_TOOLS`, no entry in `ADMIN_ONLY_TOOLS`. The chat surface already exposes it for every role via the existing role-based filter, so the only thing blocking authoring is the validator. Permissions.ts only needs `TOOL_NAMES` widened — no role-table changes.
- **Scheduled-task validator: no new rejection.** `web_search` is not destructive and not a routing tool, so the existing validation passes it through. The only fix is making the runner's intersector treat it as a known name.
- **Triage skills get web_search transitively.** Once `inspectSkill` accepts `web_search` in `requiredTools`, the triage route already forwards `skill.requiredTools` to `runAgentLoop`'s `toolAllowlist`, which already calls `getEnabledServerTools(toolAllowlist)`. No triage-route changes needed.
- **No integration-registry entry.** `INTEGRATIONS` enumerates customer-managed credential-bearing integrations (Sentinel, Defender, ThreatLocker, etc.). `web_search` has no credentials, no host, and no per-tenant configuration — it's an Anthropic-hosted server tool gated only by the project's Anthropic API key. Adding it to the registry would imply configurability that doesn't exist. Document this in a code comment so a future maintainer doesn't re-litigate the decision.
- **CLI: already covered.** `cli/src/index.js:92` already has `web_search: chalk.cyanBright` in `TOOL_COLORS`. No `TOOL_DESCRIPTIONS` entry is needed because that map is only consulted by `promptForConfirmation`, and `web_search` is non-destructive. No change.
- **Default-task seed values: keep `web_search` OUT of `DEFAULT_NEW_FORM.task.allowedTools`.** The default new-task scaffold uses Sentinel + Defender hunting — keep it scoped. Admins who want web_search will add it explicitly through the picker.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/tools.ts` | Export a `ALL_TOOL_NAMES: ReadonlySet<string>` constant = `new Set([...TOOLS.map(t=>t.name), ...SERVER_TOOLS.map(t=>t.name)])`. Add a short header comment explaining that it is the canonical set every editor / validator / runner should use, and why server tools must be included. |
| `web/lib/skill-parser.ts` | Replace the locally-built `TOOL_NAMES = new Set(TOOLS.map(t=>t.name))` with a re-export of `ALL_TOOL_NAMES` (preserving the export name so the SkillEditor import keeps working). `inspectSkill` now passes `web_search` as a valid `Required Tool`. |
| `web/lib/permissions.ts` | Replace the locally-built `TOOL_NAMES` with `ALL_TOOL_NAMES`. `canUseTool("reader" \| "admin" \| "triage", "web_search")` now returns `true`. Add a one-line comment that server tools also satisfy `canUseTool`. |
| `web/lib/scheduled-task-runner.ts` | Replace `const allToolNames = new Set(TOOLS.map((t) => t.name))` in `computeAllowedTools` with `ALL_TOOL_NAMES`. Now a task with `allowedTools: ["run_sentinel_kql", "web_search"]` retains `web_search` through the intersection. Add a comment that server tools are passed through this filter for consistency, and that the agent-loop's `getEnabledServerTools(toolAllowlist)` is what actually decides whether the tool reaches Anthropic. |
| `web/components/SettingsPage/ScheduledTaskEditor.tsx` | Existing line `const SORTED_TOOL_OPTIONS = Array.from(TOOL_NAMES).filter(t => !DESTRUCTIVE_TOOLS.has(t)).sort()` now picks up `web_search` because the imported `TOOL_NAMES` is the wider set. No code change required, but verify the picker shows `web_search` and that selecting it round-trips through save → reload. |
| `web/components/SettingsPage/SkillEditor.tsx` | Same situation: `SORTED_TOOL_OPTIONS = Array.from(TOOL_NAMES).sort()` now includes `web_search`. No code change; verify via manual smoke test. |
| `web/lib/integration-registry.ts` | No change. Add only an inline comment near `INTEGRATIONS` explaining that `web_search` is intentionally NOT registered here — it's an Anthropic-hosted server tool with no credentials or per-tenant config — to head off a future maintainer's "why isn't web_search in INTEGRATIONS?" PR. |
| `web/test/web-search-tool.test.ts` | Add a new `describe` block for "integration surfaces" with the cases listed in the Verification section. Re-use the existing test scaffold — no new test file. |
| `web/test/scheduled-task-validators.test.ts` | Add one test: a task whose `allowedTools` contains `web_search` passes `validateTaskShape` (server tool is admissible). |

No changes to: `agent.ts`, `config.ts` (system prompt already covers EXTERNAL ENRICHMENT), `injection-guard.ts`, `context-manager.ts`, `cli/src/index.js`, conversation-store, chat UI.

---

## Implementation Steps

### 1. Add `ALL_TOOL_NAMES` to `tools.ts`

- In `web/lib/tools.ts`, after the `SERVER_TOOLS` const and `getEnabledServerTools` function, export a new constant `ALL_TOOL_NAMES: ReadonlySet<string>` that is the union of `TOOLS.map(t => t.name)` and `SERVER_TOOLS.map(t => t.name)`.
- Add a header comment immediately above it explaining:
  - This is the canonical "is X a real tool?" set.
  - Editors, validators, runners, and the permission gate should all import this — not rebuild it from `TOOLS` (which excludes server tools and produces the bug fixed in this plan).
  - This set says nothing about whether a given tool is currently *advertised* to Claude — that decision is `getEnabledServerTools(toolAllowlist)` for server tools and the role / allowlist filter in `runAgentLoop` for custom tools.

### 2. Rewire `skill-parser.ts`

- In `web/lib/skill-parser.ts`, change line 19 from `export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name))` to `export { ALL_TOOL_NAMES as TOOL_NAMES } from "./tools"` (or import + re-export under the same name) so every existing consumer (`SkillEditor.tsx`, `ScheduledTaskEditor.tsx`, `inspectSkill`) sees the wider set without import-path churn.
- Verify `inspectSkill(skill)` no longer emits `Required Tool "web_search" is not a registered tool name` when a skill lists `web_search` in `requiredTools`.

### 3. Rewire `permissions.ts`

- In `web/lib/permissions.ts`, replace the local `const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))` at line 57 with an import of `ALL_TOOL_NAMES` from `./tools`.
- Update `canUseTool` to use `ALL_TOOL_NAMES`.
- `getToolsForRole` continues to filter `TOOLS` only (it returns `Anthropic.Messages.Tool[]` for the custom-tool prefix that gets cached; server tools are appended separately by `runAgentLoop` and must NOT be returned here, or the agent-loop's manual append would double-register them).
- Add a one-line comment near `canUseTool` clarifying that server tools (currently just `web_search`) satisfy `canUseTool` for every role — they are not subject to the destructive or admin-only gates.

### 4. Fix `scheduled-task-runner.ts`'s intersector

- In `web/lib/scheduled-task-runner.ts`, change line 46 from `const allToolNames = new Set(TOOLS.map((t) => t.name))` to `const allToolNames = ALL_TOOL_NAMES` (with the corresponding import from `./tools`).
- Add a comment block explaining:
  - `computeAllowedTools` is only the *persistence* filter (do we recognise this name at all?). The *advertisement* filter for server tools is `getEnabledServerTools(toolAllowlist)`, which runs inside `runAgentLoop` and additionally strips server tools in MOCK_MODE.
  - The destructive / routing-tool exclusions still apply; `web_search` is neither, so it passes.

### 5. Verify the editor pickers transparently

- Open `web/components/SettingsPage/SkillEditor.tsx` and `web/components/SettingsPage/ScheduledTaskEditor.tsx` in a browser via `npm run dev`.
- Skill editor: confirm `web_search` appears in the "Add a tool…" dropdown alphabetically between `unisolate_machine` and the next alphabetical entry. Select it. Save the skill. Reload. Confirm `web_search` is rendered as a chip in the `Required Tools` list.
- Scheduled-task editor: confirm `web_search` appears in the "Add a tool…" picker (and is not destructive, so the destructive filter does not strip it). Select it. Save. Reload. Confirm round-trip.

### 6. Annotate `integration-registry.ts`

- Add a short comment block above the `INTEGRATIONS` array export in `web/lib/integration-registry.ts` stating that `web_search` is deliberately omitted — it is an Anthropic-hosted server tool with no credentials, host, or per-tenant configuration, and the registry's job is to enumerate credential-bearing customer integrations.

### 7. Tests — add the integration-surface assertions

- In `web/test/web-search-tool.test.ts`, append a new `describe("web_search integration surfaces", ...)` block with these cases:
  - `ALL_TOOL_NAMES` from `tools.ts` includes `web_search` AND all custom tool names.
  - `permissions.canUseTool("reader", "web_search")` returns `true`.
  - `permissions.canUseTool("admin", "web_search")` returns `true`.
  - `permissions.canUseTool("triage", "web_search")` returns `true`.
  - `permissions.getToolsForRole("admin")` does NOT contain `web_search` (server tools are not returned here; the agent loop appends them separately to avoid double-registration).
  - `inspectSkill({ ...skill, requiredTools: ["run_sentinel_kql", "web_search"], requiredRole: "reader" })` returns `{ ok: true, issues: [] }`.
  - `computeAllowedTools(["run_sentinel_kql", "web_search"])` (exported or tested via a small re-export hook in the runner) returns `["run_sentinel_kql", "web_search"]`.
  - `computeAllowedTools(["reset_user_password", "web_search"])` returns `["web_search"]` (destructive is stripped, server tool survives).
- In `web/test/scheduled-task-validators.test.ts`, add a case asserting `validateTaskShape({ promptTemplate: "...", allowedTools: ["run_sentinel_kql", "web_search"], maxDurationSeconds: 60 })` returns `null` (no error).

### 8. End-to-end smoke

- Live mode (`MOCK_MODE=false`):
  - Create a skill via the Skills tab named e.g. `cve-lookup` that lists `run_sentinel_kql` and `web_search` in Required Tools. Confirm the save succeeds.
  - From the chat, invoke the skill (or just ask a CVE question with the skill applied). Confirm Neo issues a `web_search`, returns a Sources footer with real URLs.
  - Create a scheduled task with `allowedTools: ["run_sentinel_kql", "web_search"]`, set to run-on-demand. Trigger the task (existing "run now" affordance, if any, or just wait one cron tick). Confirm the run record's output references external sources cited from web search.
  - Create a second scheduled task scoped to `["run_sentinel_kql"]` ONLY. Trigger. Inspect Anthropic request logs (or rely on the integration test from step 7) to confirm `web_search` is NOT in the tools array for that run — proves the per-task allowlist still scopes server tools correctly.
- Mock mode (`MOCK_MODE=true`):
  - The editor pickers should still offer `web_search` (UI is not MOCK_MODE-gated). Save a skill listing it. Open the chat. Confirm Neo does NOT advertise `web_search` to the model on the API call (the `getEnabledServerTools` filter strips it).

---

## Verification

1. `cd web && npm run typecheck && npm run lint` — no new errors. The `tools.ts` re-export from `skill-parser.ts` must not introduce a circular import (current chain: `config → skill-store → skill-parser → tools`; `tools.ts` does not import any of those, so re-exporting `ALL_TOOL_NAMES` is safe).
2. `cd web && npm run test` — full suite green. Newly added cases in `web/test/web-search-tool.test.ts` and `web/test/scheduled-task-validators.test.ts` pass.
3. Manual smoke per step 8 above:
   - Skill with `web_search` in Required Tools saves cleanly (proves `inspectSkill` widened).
   - Scheduled task with `web_search` in `allowedTools` saves AND its runner does not strip it (proves `computeAllowedTools` widened).
   - A scheduled task scoped to `["run_sentinel_kql"]` does NOT see `web_search` (proves `getEnabledServerTools` allowlist intersection still tight).
   - Mock-mode chat does NOT receive `web_search` in its tools array even when a skill lists it (proves MOCK_MODE strip is still load-bearing at the agent boundary).
4. Triage regression check: trigger a triage with a skill whose `requiredTools` includes `web_search`. Confirm the run completes, the verdict is structured, and the audit event shows a `tool_execution` row with `toolName: "web_search"` if the skill chose to use it.
5. Code review checklist: `git grep "new Set(TOOLS.map"` returns zero matches in `web/lib/` and `web/components/` after this change — every consumer routes through `ALL_TOOL_NAMES`.
