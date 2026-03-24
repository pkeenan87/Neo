# Fix CLI and Web UI Output

## Context

Four output formatting issues affect the CLI and web UI: (1) the login success message says "npm start" instead of "neo", (2) the CLI defaults to localhost with no easy way to save a default server, (3) the CLI shows raw `**bold**` markers instead of terminal bold in some contexts, and (4) the web UI tables overflow on narrow viewports. The CLI already uses `marked` + `marked-terminal` for markdown rendering and has a config store at `~/.neo/config.json` that already stores `serverUrl`. The web MarkdownRenderer already has a `tableWrapper` with `overflow-x: auto` but it needs a width constraint to activate.

---

## Key Design Decisions

- **Login message fix** — simple string change in `cli/src/index.js:223` from "npm start" to "neo"
- **Default server** — the config store already persists `serverUrl`. Add a `neo config set server <url>` command to save it, and update the login success message to mention `neo --server <url>` when the saved server differs from localhost.
- **Bold rendering** — the `marked-terminal` library should handle `**bold**`, but there may be edge cases where inline bold inside list items or mixed content doesn't render. Add a post-processing step in `printResponse` that converts any remaining raw `**text**` and `*text*` markers to chalk bold/underline as a safety net.
- **Table overflow** — add `max-width: 100%` to `.tableWrapper` and `white-space: nowrap` on `.tableHeader` / `.tableCell` so the table triggers horizontal scroll instead of pushing the container wider. Also add `min-width` on cells for readability.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/src/index.js` | Fix login message (line 223); add `neo config` command handling; add post-processing bold/italic fallback in `printResponse` |
| `cli/src/config.js` | Add `parseConfigCommand()` helper or extend `resolveServerConfig()` to expose a `set` path |
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | Fix table overflow: constrain `.tableWrapper` width, add cell min-width/max-width |
| `test/cli-web-ui-output.test.js` | New test file for markdown bold conversion and login message |

---

## Implementation Steps

### 1. Fix login success message in `cli/src/index.js`

- At line 223, change the string `"You can now run: npm start"` to `"You can now run: neo"`
- If the resolved server URL is not localhost, append `" --server <url>"` or mention `"neo config set server <url>"` to save it

### 2. Add `neo config` command for saving default server

- In `cli/src/index.js`, in the `handleAuthCommand` flow or a new `handleConfigCommand` function, add support for `neo config set server <url>` and `neo config get server`
- `set server` should call `writeConfig()` from `config-store.js` to persist the URL after validating it with `validateServerUrl()` from `config.js`
- `get server` should read and display the current saved server URL
- Parse this from `process.argv` alongside the existing `auth` command parsing

### 3. Add bold/italic fallback in CLI output

- In `printResponse()` in `cli/src/index.js`, after the `md.parse(formatted)` call, add a post-processing step that replaces any remaining raw `**text**` with chalk bold and `*text*` with chalk underline
- Use regex: replace `\*\*([^*]+)\*\*` with `chalk.bold("$1")` and `\*([^*]+)\*` with `chalk.underline("$1")`
- This is a safety net — `marked-terminal` handles most cases, but some edge cases (inline bold within structured content) may leak through

### 4. Fix web UI table overflow

- In `web/components/MarkdownRenderer/MarkdownRenderer.module.css`:
  - Add `max-width: 100%` to `.tableWrapper` to constrain it within its parent
  - Change `.table` from `width: 100%` to `width: auto; min-width: 100%` so narrow tables fill the space but wide tables trigger scroll
  - Add `white-space: nowrap` to `.tableHeader` so column headers don't wrap (keeps columns readable)
  - Add `max-width: 300px` and `white-space: normal` to `.tableCell` so cell content wraps at a reasonable width while headers stay compact
  - Add `word-break: break-word` to `.tableCell` for long unbroken strings (hashes, URLs)

### 5. Write tests

- Create `test/cli-web-ui-output.test.js` with:
  - Verify bold regex `**text**` converts to marked text
  - Verify italic regex `*text*` converts to marked text
  - Verify nested/adjacent bold markers are handled
  - Verify the login message contains "neo" and not "npm start"

---

## Verification

1. Run `node --experimental-strip-types --test test/cli-web-ui-output.test.js` — all tests pass
2. Run `cd web && npx next build` — build succeeds
3. Manual: run `neo auth login` — verify success message says "neo" not "npm start"
4. Manual: run `neo config set server https://neo.example.com` — verify it persists and is used on next `neo` start
5. Manual: ask the agent a question that produces bold text in CLI — verify no raw `**` markers
6. Manual: ask the agent a question that produces a wide table in web UI — verify horizontal scroll instead of overflow
