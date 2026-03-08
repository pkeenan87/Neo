# Multi-Channel Markdown Rendering

> Render Claude's markdown output as properly formatted content across all three Neo channels: the web UI, Microsoft Teams, and the CLI terminal.

## Problem

Claude's responses use standard markdown syntax — bold text (`**bold**`), headers (`##`), bullet lists (`-`), code blocks (`` ``` ``), and inline code (`` ` ``). All three Neo channels currently display this raw markdown as literal plain text. Users see `**Investigation & Triage**` instead of **Investigation & Triage**, and bulleted lists render as a wall of text with dash characters. This makes agent responses difficult to scan and undermines the product's credibility as a professional SOC tool.

The screenshot in the web UI shows a typical example: an assistant greeting with bold markers, list dashes, and headers all rendered inline as unformatted monospace text inside a single message bubble.

## Goals

- Render Claude's markdown as rich formatted output in the **web UI** (HTML with appropriate styling)
- Render Claude's markdown as properly formatted messages in **Microsoft Teams** (Teams supports a subset of markdown natively, plus Adaptive Cards for richer layouts)
- Render Claude's markdown as styled terminal output in the **CLI** (ANSI colors, bold, indentation for lists)
- Preserve code blocks and KQL queries with monospace formatting across all channels
- Handle long responses gracefully (Teams has a 28 KB message limit; CLI has terminal width constraints)
- Handle carriage returns

## Non-Goals

- Changing what Claude outputs (the system prompt already asks for "structured text" — the issue is rendering, not generation)
- Adding image or media rendering support
- Supporting LaTeX or math notation
- Building a custom markdown parser — use established libraries
- Changing the NDJSON streaming protocol between server and client

## User Stories

1. **As a SOC analyst using the web UI**, I see agent responses with bold headings, bulleted lists, and syntax-highlighted code blocks, so I can quickly scan investigation results and recommended actions.
2. **As a SOC analyst using Teams**, I see agent responses with proper bold text, lists, and code formatting in the Teams chat, so the output is readable without switching to the web UI.
3. **As a SOC analyst using the CLI**, I see agent responses with bold/colored headings, indented bullet lists, and distinct code blocks in my terminal, so the output is scannable in a command-line workflow.
4. **As a SOC analyst**, I can copy KQL queries from code blocks in any channel and paste them into Sentinel without extra formatting characters contaminating the query.

## Scope

### Web UI

- Add a markdown rendering library (e.g., `react-markdown` with `remark-gfm`) to the web project
- Replace the plain-text `{msg.content}` rendering in the assistant message bubble with a markdown component
- Style markdown elements (headings, lists, code blocks, inline code, tables, blockquotes) to match the existing dark/light theme and monospace design system
- Ensure code blocks have a copy-to-clipboard button for KQL queries
- Sanitize rendered HTML to prevent XSS from any unexpected content in Claude's output

### Teams

- Teams message activities support a subset of markdown natively (bold, italic, lists, code blocks). Determine which Claude markdown features Teams handles correctly out of the box.
- For features Teams markdown does not support well (tables, complex nested lists), consider converting to Adaptive Cards or simplifying the formatting.
- Ensure long responses are chunked correctly — current chunking splits on a character limit which may break mid-markdown-element. Chunk on paragraph or block boundaries instead.
- Tool call results and confirmation cards already use Adaptive Cards and should remain unchanged.

### CLI

- Add a markdown-to-ANSI library (e.g., `marked-terminal` or a custom lightweight renderer) to the CLI project
- Render bold text as terminal bold, headers as colored/bold lines, bullet lists with proper indentation, and code blocks with a distinct background or border character
- Respect terminal width for line wrapping
- Keep the existing chalk color scheme (green for agent, white for content)

## Open Questions

1. **Teams markdown fidelity** — Teams supports basic markdown in `sendActivity()` text, but fidelity varies between desktop, mobile, and web clients. Should we test with plain Teams markdown first and only fall back to Adaptive Cards if rendering is poor, or go straight to Adaptive Cards for all agent responses? test with plan teams markdown
2. **Streaming and partial markdown** — The web UI streams responses via NDJSON. Should markdown be rendered incrementally as chunks arrive (may cause layout jumps), or should rendering wait until the full response is received (current behavior, since `response` event only fires once)? wait until full response
3. **Tables** — Claude sometimes outputs markdown tables for structured data (alert summaries, user info). Tables render poorly in Teams and terminals. Should we convert tables to a different format per channel, or instruct Claude via the system prompt to avoid tables? convert into a different format per channel.

## Success Criteria

- Agent responses in the web UI render bold, headers, lists, inline code, and fenced code blocks with proper HTML formatting and theme-appropriate styling
- Agent responses in Teams render bold, lists, and code blocks correctly in the Teams desktop client
- Agent responses in the CLI render bold, headers, lists, and code blocks with ANSI formatting in a standard 80-column terminal
- Code blocks include a copy button in the web UI and render as distinct monospace blocks in Teams and CLI
- No XSS vectors introduced through markdown rendering
- No regressions in the NDJSON streaming protocol, confirmation gate UX, or tool call display
