# Slash Commands

## Context

This plan adds slash command support for skills in both the Web chat and CLI interfaces. Users type `/<skill-id>` to directly invoke a skill, which prepends the skill's instructions to the message sent to the agent. The Web interface shows an autocomplete popover when `/` is typed; the CLI adds a `/skills` listing command. Slash command resolution happens server-side in the agent API route to ensure role enforcement and consistent behavior across channels. Teams is out of scope.

---

## Key Design Decisions

- **Server-side resolution** — The `/api/agent` route detects messages starting with `/`, resolves the skill, and prepends instructions. This ensures role enforcement and prevents CLI/Web divergence. The client-side popover is a UX convenience only.
- **Prepend to user message** — Skill instructions are prepended to the user's message as a `[SKILL INVOCATION]` block, not injected into the system prompt. This keeps the system prompt stable (cached) and makes skill invocations visible in the conversation history.
- **Skill badge in chat** — The server emits a new NDJSON event type `skill_invocation` before the agent processes, so both Web and CLI can display a visual indicator.
- **Graceful fallback** — If a `/` message doesn't match a skill, it's sent to the agent as-is. No error is shown.
- **Popover is client-side only** — The Web chat fetches skills via `GET /api/skills` on mount and filters locally. No new API endpoint needed.
- **CLI uses local `/skills` command** — The CLI fetches skills from the server and displays them in the terminal. Slash commands are sent as regular messages to `/api/agent`.

---

## Files to Change

| File | Change |
|------|--------|
| `web/app/api/agent/route.ts` | Add slash command detection after message validation. If message starts with `/`, extract skill ID, look up via `getSkill()`, check role, prepend instructions, emit `skill_invocation` event. |
| `web/components/ChatInterface/ChatInterface.tsx` | Add slash command popover: detect `/` at start of input, fetch skills, render floating autocomplete, handle selection. Add skill invocation badge in chat thread. |
| `web/components/ChatInterface/ChatInterface.module.css` | Add styles for the slash command popover, skill items, and invocation badge. |
| `cli/src/index.js` | Add `/skills` command to the REPL loop. No other CLI changes needed — slash commands are resolved server-side. |
| `cli/src/server-client.js` | Add `fetchSkills(serverUrl, getAuthHeader)` function to fetch `GET /api/skills` for the `/skills` listing. |
| `web/lib/types.ts` | Add `SkillInvocationEvent` to the NDJSON event types. |
| `test/slash-commands.test.js` | **New.** Tests for command detection, role filtering, instruction prepending, and passthrough. |

---

## Implementation Steps

### 1. Add slash command detection to the agent API route

- In `web/app/api/agent/route.ts`, after the message validation block (around line 33) and after auth resolution (line 16), add a slash command processing block.
- Check if `body.message.startsWith("/")`. If so:
  - Extract the command portion: split on whitespace, take the first token, strip the leading `/` to get the skill ID.
  - Capture the remainder of the message after the command as `userArgs` (the text after `/<skill-id> `).
  - Call `getSkill(skillId)` from `web/lib/skill-store.ts`.
  - If the skill is found:
    - Check if the user's role permits it: if `skill.requiredRole === "admin"` and `identity.role !== "admin"`, return a 403 error.
    - Construct a modified message: `[SKILL INVOCATION: ${skill.name}]\n\nFollow these steps precisely:\n\n${skill.instructions}\n\n---\n\nUser input: ${userArgs || "(no additional input)"}`.
    - Replace `body.message` with the modified message before pushing to session.
    - Before writing the NDJSON stream, emit a `skill_invocation` event: `{ type: "skill_invocation", skill: { id: skill.id, name: skill.name } }`.
    - Log the skill invocation via `logger.info("Skill invoked via slash command", "agent", { skillId, skillName: skill.name, ... })`.
  - If the skill is not found, leave the message as-is (graceful passthrough).

### 2. Add NDJSON event type for skill invocation

- In `web/lib/types.ts`, add `"skill_invocation"` to the `AgentEventType` union.
- The event shape is `{ type: "skill_invocation", skill: { id: string, name: string } }`.

### 3. Add slash command popover to the Web ChatInterface

- In `web/components/ChatInterface/ChatInterface.tsx`:
  - Add state: `slashMenuOpen` (boolean), `slashMenuSkills` (array of `SkillMeta`), `slashFilter` (string), `slashSelectedIndex` (number for keyboard navigation).
  - On component mount (or when the user first types `/`), fetch `GET /api/skills` and cache the result in a ref. This returns `SkillMeta[]` (skills without instructions, filtered by role — the server already handles role filtering).
  - In the `onChange` handler for the textarea:
    - If the input value starts with `/` and the cursor is still in the first "word" (no space yet or still on the first token), set `slashMenuOpen = true` and `slashFilter` = the text after `/`.
    - If the input doesn't start with `/` or the user has moved past the command token, set `slashMenuOpen = false`.
  - Render the popover as an absolutely positioned `<div>` above the input container (inside `.inputGroup`, positioned relative). Show only when `slashMenuOpen` is true.
  - The popover lists skills filtered by `slashFilter` (case-insensitive match against `skill.id` and `skill.name`). Each item shows the skill name and description.
  - If the skill has parameters, show them inline as grayed placeholder text: `/<skill-id> <param1> <param2>`.
  - Show "No skills available" when the filtered list is empty.
  - Keyboard navigation: ArrowUp/ArrowDown change `slashSelectedIndex`, Enter/Tab selects the skill, Escape closes the popover.
  - On selection: if the skill has parameters, populate the input with `/<skill-id> ` (trailing space) and keep focus so the user can type arguments. If no parameters, set the input to `/<skill-id>` and submit immediately.

### 4. Add skill invocation badge in Web chat thread

- When the NDJSON stream emits a `skill_invocation` event, display a small badge/system message in the chat thread before the agent's response.
- The badge shows the skill name (e.g., "Skill: TOR Login Investigation") with a distinct visual style (use a pill/tag shape with `brand-100` background).
- Handle this in the stream processing logic alongside existing event types (`tool_call`, `thinking`, etc.).

### 5. Add styles for the popover and badge

- In `web/components/ChatInterface/ChatInterface.module.css`, add:
  - `.slashPopover` — positioned absolutely above the input, max-height with overflow scroll, rounded corners, shadow, white/dark background.
  - `.slashItem` — flex row with padding, hover highlight, cursor pointer.
  - `.slashItemActive` — keyboard-selected highlight.
  - `.slashItemName` — bold skill name.
  - `.slashItemDescription` — truncated description text, muted color.
  - `.slashItemParams` — grayed parameter placeholders.
  - `.slashEmpty` — "No skills available" message styling.
  - `.skillBadge` — pill-shaped tag for the invocation indicator in the chat thread.
  - Dark mode overrides for all new classes.

### 6. Add `/skills` command to the CLI REPL

- In `cli/src/index.js`, in the REPL loop (around line 339 where `clear`, `exit`, `history` are handled), add a check:
  - If `userInput.trim().toLowerCase() === "/skills"`, call a new `handleSkillsCommand()` function and `continue`.
- `handleSkillsCommand()`:
  - Call `fetchSkills(serverUrl, getAuthHeader)` (new function in server-client.js).
  - If the response has skills, print a formatted list: each skill shows `/<skill.id>` in green, the skill name, and the description (truncated).
  - If no skills, print "No skills configured."
  - Use `chalk` for formatting consistent with the rest of the CLI.

### 7. Add `fetchSkills` to the CLI server client

- In `cli/src/server-client.js`, add and export `fetchSkills(serverUrl, getAuthHeader)`:
  - `GET ${serverUrl}/api/skills` with the auth header.
  - Parse JSON response and return `data.skills` array.
  - On error, return an empty array.

### 8. Handle skill invocation display in CLI

- In `cli/src/index.js`, in the `callbacks` object passed to `runAgentLoop`, add an `onSkillInvocation` callback (or handle the `skill_invocation` event in the stream processing).
- Check `cli/src/server-client.js` `processStream` function — add a case for `event.type === "skill_invocation"` that calls a callback or prints a message.
- Print the skill invocation in the terminal: `[skill] <skill-name>` using `chalk.magenta` or similar.

### 9. Write tests

- Create `test/slash-commands.test.js` using `node:test`.
- Test: a message starting with `/tor-login-investigation` is detected as a slash command (extract skill ID `tor-login-investigation`).
- Test: a message starting with `/nonexistent-skill` passes through as a regular message.
- Test: a message not starting with `/` is unaffected.
- Test: extracting skill ID and user args from `/skill-id some user input here`.
- Test: skill filtering by role — admin skills excluded for reader role.
- Test: the instruction prepending format is correct.

---

## Verification

1. **Web popover**: Type `/` in the Web chat input. Verify the popover appears with skill names. Type more characters to filter. Press Enter to select. Verify the skill is invoked.
2. **Web badge**: After a slash command, verify a skill badge appears in the chat thread.
3. **Web role filtering**: Log in as a reader. Type `/`. Verify admin-only skills are not shown.
4. **CLI slash command**: In the CLI, type `/<skill-id>`. Verify the agent follows the skill's steps.
5. **CLI `/skills`**: Type `/skills` in the CLI. Verify the list shows available skills.
6. **Passthrough**: Type `/notarealskill` in either client. Verify the message is sent to the agent as-is.
7. **Audit log**: Check server logs for `"Skill invoked via slash command"` entries.
8. **Tests**: Run `node --test test/slash-commands.test.js` — all pass.
9. **Type check**: Run `cd web && npx tsc --noEmit` — no errors.
