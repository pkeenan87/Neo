# Multi-Channel Markdown Rendering

## Context

Claude's responses contain standard markdown (bold, headers, bullet lists, code blocks, tables) but all three Neo channels — web UI, Teams, and CLI — render this as literal plain text. This plan adds per-channel markdown rendering: `react-markdown` for the web, Teams-native markdown for the bot, and `marked-terminal` for the CLI. All open questions from the spec are resolved: test with plain Teams markdown first, render after full response, convert tables per channel.

---

## Key Design Decisions

- **Web: `react-markdown` + `remark-gfm` + `rehype-sanitize`** — React-native rendering, GFM support (tables, strikethrough, task lists), built-in XSS sanitization. No `dangerouslySetInnerHTML`.
- **Web: New `MarkdownRenderer` component** — Encapsulates all markdown rendering logic, custom component overrides for styling, and the copy-to-clipboard button for code blocks. Keeps ChatInterface clean.
- **Teams: Pass markdown through directly** — Teams `sendActivity()` supports a subset of markdown natively (bold, italic, lists, code). Claude's output largely aligns with this subset. No conversion library needed — just pass the text as-is and let Teams render it.
- **Teams: Smart chunking on paragraph boundaries** — Replace the current fixed-offset `slice()` with splitting on double-newline boundaries so chunks don't break mid-markdown-element.
- **CLI: `marked` + `marked-terminal`** — Battle-tested library that renders markdown as ANSI-styled terminal output. Integrates with the existing chalk color scheme.
- **Carriage returns** — Normalize `\r\n` to `\n` and strip stray `\r` before rendering in all channels.
- **Tables** — Web renders as HTML tables. Teams converts tables to bold-header + list format (since Teams table rendering is inconsistent). CLI renders tables as aligned text via `marked-terminal`.
- **No shared library** — Each channel has different rendering needs. A shared markdown utility would add coupling for no benefit.

---

## Files to Change

| File | Change |
|------|--------|
| `web/package.json` | Add `react-markdown`, `remark-gfm`, `rehype-sanitize` dependencies |
| `web/components/MarkdownRenderer/MarkdownRenderer.tsx` | **New** — React component wrapping `react-markdown` with custom component overrides and copy button |
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | **New** — Styles for rendered markdown elements (headings, lists, code blocks, tables, blockquotes) with dark mode support |
| `web/components/MarkdownRenderer/index.ts` | **New** — Barrel export |
| `web/components/index.ts` | Add `MarkdownRenderer` to barrel if it exists, or note for manual export |
| `web/components/ChatInterface/ChatInterface.tsx` | Replace `{msg.content}` with `<MarkdownRenderer content={msg.content} />` for assistant messages only |
| `web/app/api/teams/messages/route.ts` | Normalize carriage returns in `sendAgentResult`, replace fixed-offset chunking with paragraph-boundary chunking, set `textFormat: 'markdown'` on activities |
| `cli/package.json` | Add `marked` and `marked-terminal` dependencies |
| `cli/src/index.js` | Replace `printResponse` with a markdown-to-ANSI renderer using `marked` + `marked-terminal` |

---

## Implementation Steps

### 1. Install web dependencies

- Run `cd web && npm install react-markdown remark-gfm rehype-sanitize`
- Add `"react-markdown"` to `serverExternalPackages` in `next.config.js` if needed (test build first — it may not be necessary since it's a client component dependency)

### 2. Create the `MarkdownRenderer` component

- Create folder `web/components/MarkdownRenderer/` with three files: `MarkdownRenderer.tsx`, `MarkdownRenderer.module.css`, `index.ts`
- **`MarkdownRenderer.tsx`**:
  - Accept props: `content: string` and `className?: string`
  - Mark as `'use client'` since `react-markdown` uses React rendering
  - Normalize carriage returns: replace `\r\n` with `\n`, strip remaining `\r`
  - Render `<ReactMarkdown>` with `remarkPlugins={[remarkGfm]}` and `rehypePlugins={[rehypeSanitize]}`
  - Provide custom component overrides via the `components` prop for: `h1`, `h2`, `h3`, `p`, `ul`, `ol`, `li`, `code`, `pre`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `blockquote`, `a`, `strong`, `em`
  - For the `code` override: detect fenced code blocks (when `node` parent is `pre`) vs inline code. Fenced code blocks get a wrapper div with a copy-to-clipboard button. Inline code gets monospace styling only.
  - The copy button should use `navigator.clipboard.writeText()` with a brief "Copied!" state managed by `useState` + `setTimeout`
  - Forward `className` to the outermost wrapper div
- **`index.ts`**: Export `MarkdownRenderer` and `MarkdownRendererProps`

### 3. Style the `MarkdownRenderer`

- **`MarkdownRenderer.module.css`**:
  - `.wrapper` — base container, inherits font from parent
  - `.heading` — headings (`h1`–`h3`): bold, slightly larger font, bottom margin, `letter-spacing: 0.05em` to match the monospace design. No `font-display` — keep the monospace font family from the parent
  - `.paragraph` — `margin-bottom: 0.75rem`, `line-height: 1.625` (matches existing `.msgBubbleAssistant`)
  - `.list` — `padding-left: 1.5rem`, `margin-bottom: 0.75rem`, standard list styling
  - `.listItem` — `margin-bottom: 0.25rem`
  - `.codeBlock` — fenced code: `background: #f1f5f9`, `border: 1px solid #e2e8f0`, `border-radius: 0.375rem`, `padding: 1rem`, `overflow-x: auto`, `font-family: inherit` (already monospace), `font-size: 0.8125rem`
  - `.codeBlockHeader` — flex container for the language label and copy button, positioned above the code
  - `.copyButton` — small button top-right of code block: `font-size: 0.75rem`, `padding: 0.25rem 0.5rem`, `border-radius: 0.25rem`, transitions
  - `.inlineCode` — `background: #f1f5f9`, `padding: 0.125rem 0.375rem`, `border-radius: 0.25rem`, `font-size: 0.85em`
  - `.table` — `width: 100%`, `border-collapse: collapse`, `margin-bottom: 0.75rem`, `font-size: 0.8125rem`
  - `.tableHeader` — `background: #f8fafc`, `font-weight: 600`, `text-align: left`, `padding: 0.5rem`, `border-bottom: 2px solid #e2e8f0`
  - `.tableCell` — `padding: 0.5rem`, `border-bottom: 1px solid #e2e8f0`
  - `.blockquote` — `border-left: 3px solid #e2e8f0`, `padding-left: 1rem`, `color: #64748b`, `margin-bottom: 0.75rem`
  - `.link` — `color: #2563eb`, `text-decoration: underline`
  - Add `:global(html.dark)` variants for every class above using the existing pattern: green-on-dark theme (`#4ade80` text, `rgba(34, 197, 94, ...)` backgrounds/borders)

### 4. Integrate `MarkdownRenderer` into ChatInterface

- In `web/components/ChatInterface/ChatInterface.tsx`, import `MarkdownRenderer` from `@/components/MarkdownRenderer`
- Find the assistant message bubble rendering (around line 608-616) where `{msg.content}` is rendered
- Replace `{msg.content}` with `<MarkdownRenderer content={msg.content} />` only when `msg.role === 'assistant'`
- Keep user messages as plain text (users type plain text, not markdown)
- The existing `.msgBubbleAssistant` CSS remains unchanged — `MarkdownRenderer` adds its own internal styles for markdown elements

### 5. Update Teams bot response sending

- In `web/app/api/teams/messages/route.ts`, in the `sendAgentResult` function (line 121-142):
- Add a `normalizeText` helper at the top of the file: replace `\r\n` with `\n`, strip remaining `\r`
- Apply `normalizeText` to `result.text` before sending
- Replace the current chunking logic (lines 132-139) with paragraph-boundary chunking:
  - Split text on `\n\n` (double newline = paragraph boundary)
  - Accumulate paragraphs into a chunk until adding the next paragraph would exceed `MAX_LEN`
  - Send each accumulated chunk as a separate activity
  - If a single paragraph exceeds `MAX_LEN`, fall back to character-level splitting for that paragraph only
- When calling `context.sendActivity()`, pass an activity object with `textFormat: 'markdown'` instead of passing bare text string. This tells Teams to render the text as markdown:
  - Change `await context.sendActivity(text)` to `await context.sendActivity({ type: 'message', text, textFormat: 'markdown' })`

### 6. Install CLI dependencies

- Run `cd cli && npm install marked marked-terminal`

### 7. Update CLI response printing

- In `cli/src/index.js`:
- Import `marked` and `TerminalRenderer` from `marked-terminal` at the top of the file (using ES module syntax since the CLI uses `"type": "module"`)
- Configure `marked` to use `TerminalRenderer` with options that integrate with the existing chalk theme: set heading color to green, code block styling to match terminal conventions, table support enabled
- Replace the `printResponse` function body (line 86-88): instead of `console.log("\n" + chalk.white(text))`, normalize carriage returns, then pass the text through `marked.parse()` and print the result
- Respect terminal width: pass `process.stdout.columns || 80` as the `width` option to `TerminalRenderer`

### 8. Handle carriage returns

- This is covered in steps 2 (web), 5 (Teams), and 7 (CLI). All three channels normalize `\r\n` → `\n` and strip stray `\r` before rendering.

---

## Verification

1. `cd web && npm run build` — zero TypeScript errors, no build failures
2. **Web manual test**: Start dev server, send a message to the agent. Verify:
   - Bold text renders as bold (not `**bold**`)
   - Bullet lists render as actual HTML lists with indentation
   - Code blocks render with background color and copy button
   - Copy button copies code text to clipboard
   - Dark mode renders all markdown elements with green theme
   - User messages still render as plain text
   - Confirmation bar and tool call display are unaffected
3. **Teams manual test**: Send a message to the bot in Teams. Verify:
   - Bold text, lists, and code blocks render correctly in Teams desktop
   - Long responses are split on paragraph boundaries (not mid-word or mid-formatting)
   - Confirmation Adaptive Cards still render correctly
4. **CLI manual test**: Start the CLI REPL, send a query. Verify:
   - Headers render as bold/colored lines
   - Bullet lists render with indentation
   - Code blocks render as distinct terminal blocks
   - Output respects terminal width
5. **Security**: Inspect the web rendering to confirm `rehype-sanitize` strips any `<script>`, `onclick`, or other XSS vectors. Test by pasting a message containing `<script>alert(1)</script>` and verifying it renders as escaped text.
