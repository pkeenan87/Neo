# Spec for CLI Response Formatting

branch: claude/feature/cli-response-formatting

## Summary

Agent responses in the CLI do not render markdown correctly — particularly bulleted lists, headings, and line breaks. Bullets appear inline separated by `<br>` tags or run together on a single line instead of rendering as properly indented, multi-line list items. The web UI and Teams channel both handle this formatting correctly. The CLI should produce an aesthetically pleasing, well-structured terminal output that matches the quality of those other channels.

## Functional requirements

- Bulleted and numbered lists must render as separate, properly indented lines in the terminal
- Nested list items must display with visible indentation hierarchy
- Headings (##, ###) must render with visual distinction (bold, color, or spacing)
- Code blocks (inline and fenced) must render with visible differentiation from prose
- Bold, italic, and other inline formatting must render using terminal escape codes
- Long paragraphs must reflow to fit the current terminal width without mid-word breaks
- The response should look clean and readable regardless of terminal width (minimum 60 columns)
- No raw HTML tags (e.g., `<br>`) should appear in the terminal output

## Possible Edge Cases

- Agent returns markdown with HTML tags mixed in (e.g., `<br>`, `<em>`) — these should be stripped or converted
- Very narrow terminal widths (< 60 columns) may cause awkward wrapping of list items
- Agent returns deeply nested lists (3+ levels) — terminal rendering should degrade gracefully
- Agent returns markdown tables — should render as aligned columns or fall back to readable plaintext
- Empty lines or excessive whitespace in agent response — should be normalized without collapsing meaningful paragraph breaks
- Agent returns a response with no markdown at all (plain text) — should pass through cleanly

## Acceptance Criteria

- Bulleted lists from the agent render as separate indented lines in the CLI, not run-together text
- No `<br>` or other raw HTML tags are visible in CLI output
- Headings are visually distinct from body text (bold and/or colored)
- Code blocks are visually distinct (background or border styling where the terminal supports it)
- Output is reflowed to the current terminal width
- CLI output is visually comparable in quality to the web UI's markdown rendering

## Open Questions

- Is the current `marked` + `marked-terminal` stack sufficient, or should it be replaced with a different terminal markdown renderer? it is sufficient
- Should the CLI pre-process the markdown (e.g., strip HTML, normalize lists) before passing to the renderer, or should the renderer handle it? yes pre process.
- Should colored output be configurable (e.g., for CI/piped output where ANSI codes are unwanted)? no

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- A response with bulleted list items renders each item on its own line with a bullet prefix
- A response with headings renders them as bold/colored text with spacing
- A response containing `<br>` tags does not show raw HTML in output
- A response with a fenced code block renders it with visible boundaries
- A plain text response (no markdown) passes through without corruption
