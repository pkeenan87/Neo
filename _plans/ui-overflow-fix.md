# UI Overflow Fix

## Context

Wide content in agent responses — text-formatted tables inside code blocks, long markdown tables, and verbose tool output — overflows the chat bubble and pushes the UI beyond its container boundaries. The root cause is that `.codeBlockWrapper` in the MarkdownRenderer has `overflow: hidden` which clips rounded corners but prevents the inner `.codeBlock` (which has `overflow-x: auto`) from scrolling, and the wrapper has no `max-width` constraint so it expands to fit content width. The `.wrapper` class also lacks `min-width: 0` which is needed to prevent flex children from overflowing their parent.

---

## Key Design Decisions

- **Constrain at the wrapper level** — Add `min-width: 0` and `overflow-wrap: break-word` to `.wrapper` so the MarkdownRenderer respects its parent's width constraints in flex layouts
- **Constrain code block wrapper** — Add `max-width: 100%` to `.codeBlockWrapper` so it's bounded by its parent, letting the inner `.codeBlock`'s `overflow-x: auto` create a horizontal scrollbar for wide code content
- **No changes to table rendering** — The `.tableWrapper` already has `overflow-x: auto; max-width: 100%` which is correct. Tables overflow because the MarkdownRenderer wrapper itself doesn't constrain its children.

---

## Files to Change

| File | Change |
|------|--------|
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | Add `min-width: 0; overflow-wrap: break-word` to `.wrapper`; add `max-width: 100%` to `.codeBlockWrapper` |

---

## Implementation Steps

### 1. Update `.wrapper` class in MarkdownRenderer.module.css

- Add `min-width: 0` to prevent flex child overflow (the MarkdownRenderer sits inside a flex container — the assistant message bubble)
- Add `overflow-wrap: break-word` as a belt-and-suspenders alongside the existing `word-break: break-word`

### 2. Update `.codeBlockWrapper` class in MarkdownRenderer.module.css

- Add `max-width: 100%` so the code block wrapper is constrained by its parent width
- This allows the inner `.codeBlock` element (which already has `overflow-x: auto`) to create a horizontal scrollbar for wide content instead of expanding the wrapper

---

## Verification

1. Build: `cd /Users/pkeenan/Documents/Neo/web && export PATH="/Users/pkeenan/.nvm/versions/node/v24.14.0/bin:$PATH" && npm run build 2>&1 | tail -10`
2. Manual: Visit the two conversations linked in the Notion issue and verify tables no longer overflow
3. Manual: Send a query that produces a wide code block (e.g., KQL results table) and verify horizontal scroll within the code block
