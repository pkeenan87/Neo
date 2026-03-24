# Spec for Fix CLI and Web UI Output

branch: claude/fix/cli-web-ui-output

## Summary

Several output formatting issues affect the CLI and web UI. The Notion issue documents four specific problems with screenshots: (1) the CLI login success message references `npm start` instead of the `neo` command, (2) the CLI defaults to `localhost:3000` with no way to save a default server URL, (3) the CLI renders raw `**bold**` markdown markers instead of converting them to terminal bold formatting, and (4) the web UI does not constrain markdown table width, causing tables to overflow the chat container on narrow/mobile viewports.

## Functional requirements

### CLI: Fix login success message
- After `neo auth login`, the success message says "You can now run: npm start" — change to "You can now run: neo" (or "neo --server <url>" if no default server is saved)

### CLI: Save default server URL
- Add a `neo config set server <url>` command (or similar) that persists a default server URL to the CLI config store
- When no `--server` flag is provided, the CLI should use the saved default instead of falling back to `http://localhost:3000`
- The startup banner should show the configured server URL

### CLI: Render bold markdown in terminal output
- The CLI currently displays raw `**text**` markers in agent responses
- Convert `**text**` to chalk bold rendering when displaying agent output
- Also handle `*italic*` markers by converting to chalk italic or underline

### Web UI: Constrain markdown table overflow
- Tables rendered by the MarkdownRenderer component in the chat UI overflow the container width on narrow viewports
- Wrap rendered tables in a horizontally scrollable container (`overflow-x: auto`) so they don't break the layout
- The table should scroll independently without pushing the chat container wider

## Possible Edge Cases

- CLI bold rendering: nested markdown like `**bold *and italic* text**` — keep it simple, handle the common cases
- Table overflow: very wide tables with many columns should still be readable via horizontal scroll
- Default server config: if the saved server is unreachable, the CLI should still show a clear error rather than silently falling back

## Acceptance Criteria

- `neo auth login` success message references the correct command
- A saved default server URL is used when `--server` is not provided
- Agent output in the CLI renders bold text instead of showing raw `**` markers
- Tables in the web UI are contained within the chat area with horizontal scroll when needed

## Open Questions

- Should the CLI config store use the existing `config-store.js` mechanism, or a new one? same one.
- Should italic rendering use underline (more visible in terminals) or actual italic (not supported in all terminals)? underline
- Should the web UI table fix also apply a max-width or min-width to table cells for readability? yes.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- Bold markdown `**text**` is converted to terminal bold markers
- Nested or adjacent bold markers are handled correctly
- Login success message contains the correct command reference
