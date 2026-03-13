# CLI Response Formatting

## Context

Agent responses in the CLI render bulleted lists, headings, and other markdown elements poorly. Lists collapse into single lines with raw `<br>` tags visible, and bullets run together instead of appearing as separate indented lines. The root cause is that Claude's responses sometimes contain HTML tags and markdown that the `marked` + `marked-terminal` pipeline doesn't handle gracefully without pre-processing. The fix is to add a pre-processing step (similar to the Teams `formatForTeams` function) that normalizes the markdown before passing it to `marked-terminal`, and to tune the `markedTerminal` configuration for better list and heading rendering.

---

## Key Design Decisions

- **Pre-process markdown before rendering, don't replace the renderer.** The user confirmed `marked` + `marked-terminal` is sufficient. The issue is input quality, not renderer capability.
- **Strip HTML tags in the pre-processor.** Claude sometimes emits `<br>`, `<em>`, `<strong>`, and other HTML in its responses. These should be converted to their markdown equivalents or stripped before `marked` parses them.
- **Ensure blank lines before list blocks.** `marked` requires a blank line before a list to parse it as a list (per CommonMark spec). Without this, list items get treated as inline text. The Teams formatter already solves this exact problem.
- **Normalize bullet markers to `- `.** Claude uses `•`, `*`, `+`, and `-` inconsistently. Normalizing to `- ` ensures `marked` recognizes them as list items.
- **Keep the pre-processor as a standalone function** in `index.js` (not a separate module) since it's small and CLI-specific.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/src/index.js` | Add a `formatForTerminal(text)` pre-processing function; update `printResponse` to call it before `marked.parse()` |
| `test/cli-response-formatting.test.js` | New test file validating the pre-processing function |

---

## Implementation Steps

### 1. Add the `formatForTerminal` function in `cli/src/index.js`

- Add a new function `formatForTerminal(text)` above the existing `printResponse` function
- The function takes a raw markdown string and returns a cleaned markdown string
- It should perform the following transformations in order:
  1. **Strip `<br>` and `<br/>` tags** — replace with `\n`
  2. **Convert HTML inline formatting to markdown** — replace `<em>...</em>` with `*...*`, `<strong>...</strong>` with `**...**`, `<code>...</code>` with backtick-wrapped equivalents
  3. **Strip remaining HTML tags** — remove any other `<tag>` or `</tag>` patterns (but preserve content between them)
  4. **Convert Unicode bullets to markdown bullets** — replace lines starting with `•` (optionally preceded by whitespace) with `- `
  5. **Ensure blank lines before list blocks** — if a line is a list item (starts with `- `, `* `, `+ `, or `1. ` etc.) and the previous line is neither blank nor a list item, insert a blank line before it. This is the same logic as `formatForTeams` in the Teams route.
  6. **Normalize bullet markers** — replace `* ` and `+ ` bullet prefixes with `- ` for consistency
  7. **Collapse runs of 3+ blank lines** into exactly 2 blank lines (preserves paragraph separation without excessive whitespace)

### 2. Update `printResponse` to use the pre-processor

- In the `printResponse` function, after the existing `normalized` line-ending normalization, call `formatForTerminal(normalized)` and pass the result to `terminalMarkdown.parse()`
- The flow becomes: raw text → normalize line endings → `formatForTerminal` → `marked.parse()` → `console.log`

### 3. Update `markedTerminal` configuration

- Review the current `markedTerminal` options (lines 101-108) and consider adding:
  - `emoji: false` — prevents emoji shortcode expansion that can interfere with output
  - Verify that `reflowText: true` and `width` are working correctly with the pre-processed input
- The `width` is set once at module load from `process.stdout.columns`. Consider reading it at render time inside `printResponse` so it adapts if the terminal is resized (wrap the `Marked` construction or read columns dynamically)

### 4. Create test file `test/cli-response-formatting.test.js`

- Create a `test/` directory at the project root
- Create `test/cli-response-formatting.test.js` using Node's built-in `node:test` runner (no extra dependencies)
- Import the `formatForTerminal` function (this requires exporting it from `index.js` — add a named export)
- Write the following test cases:
  - **Bullet list normalization**: Input with `- item1\n- item2` after a paragraph (no blank line) produces output with a blank line inserted before the first bullet
  - **HTML `<br>` stripping**: Input containing `line one<br>line two` produces `line one\nline two` with no raw HTML
  - **Unicode bullet conversion**: Input with `• First item\n• Second item` produces `- First item\n- Second item`
  - **HTML inline tag conversion**: Input with `<strong>bold</strong>` produces `**bold**`
  - **Remaining HTML tag stripping**: Input with `<div>content</div>` produces `content`
  - **Plain text passthrough**: Input with no markdown or HTML passes through unchanged
  - **Excessive blank lines collapsed**: Input with 4+ consecutive blank lines collapses to 2

### 5. Export `formatForTerminal` for testability

- At the bottom of `cli/src/index.js`, add `formatForTerminal` to an export (or use a named export) so the test file can import it
- Since `index.js` is the CLI entry point and calls `main()` at the bottom, the export should be guarded or the function extracted. The simplest approach: export the function as a named export alongside the default behavior. Since the file uses ES modules, add `export { formatForTerminal }` after the function definition. The `main()` call at the bottom will still execute when run directly.

---

## Verification

1. Run the CLI with `cd cli && npm start`, send a message that triggers a bulleted response (e.g., "what can you do?"), and visually confirm bullets render as separate indented lines with no raw HTML tags
2. Run tests with `node --test test/cli-response-formatting.test.js` from the project root
3. Verify that plain text responses (no markdown) still render correctly without corruption
4. Verify that code blocks in responses still render with visible boundaries
5. Test with a narrow terminal width (resize to ~60 columns) to confirm reflow works
