# Copy Message Button

## Context

Add a copy button below every completed assistant message in the web chat. Clicking copies the message's raw markdown-source content to the clipboard with a ~2-second "Copied!" feedback state. The spec at `_specs/copy-message-button.md` calls for the button to sit in an action row that can later hold thumbs-up/thumbs-down/regenerate; Phase 1 ships the copy affordance only but the structure is future-proofed. The codebase already has a small `CopyButton` local to `MarkdownRenderer.tsx` (used for fenced code blocks) — this plan extracts it into a reusable component, improves its failure handling, and uses it in both places.

---

## Key Design Decisions

- **Extract the existing `CopyButton`** from `web/components/MarkdownRenderer/MarkdownRenderer.tsx` (lines 19–42) into a new shared component at `web/components/CopyButton/`. One implementation, two call sites (code blocks + message actions). Also an opportunity to add the failure-state handling the current version silently swallows.
- **New `MessageActions` container component** at `web/components/MessageActions/`. Renders a `role="toolbar"` row with an `aria-label` so screen-reader users hear it as a grouped action list. In Phase 1 the toolbar contains one button; future thumbs-up/thumbs-down/regenerate siblings slot in without a rewrite.
- **Placement outside the bubble, inside `msgContent`**: the action row sits below the bubble (not inside it), left-aligned with the bubble's bottom edge. Matches the reference screenshot. This keeps the bubble's visual boundary clean and mirrors the pattern seen in Claude.ai / ChatGPT.
- **Streaming gate via "not the last message while loading"**: `ChatInterface` already tracks `isLoading`. The action row renders only for messages that are NOT the last message in the list while `isLoading === true`. No new `isStreaming` flag needed on `ChatMessage` — the derived state is sufficient.
- **Render predicate: assistant + non-empty content + no skill-badge + finished streaming.** These four conditions together cover all the spec's edge cases (skip user messages, skip empty skill-badge placeholders, skip in-flight messages).
- **Icon-only button with swap states**: `Copy` (default) → `Check` (success) → `AlertCircle` or `X` (failure). Uses lucide-react icons already imported elsewhere in the project. Visible icon is decorative (`aria-hidden="true"`); the button's accessible name lives on `aria-label` and changes with state so screen readers announce the transition.
- **Copy source is `ChatMessage.content` verbatim** — raw markdown, no sanitization, no attachment-badge text appended. Pasting into a markdown surface renders; pasting into plain text is readable.
- **Graceful failure for missing Clipboard API**: detect via `typeof navigator.clipboard.writeText !== 'function'`. If unavailable, try the `document.execCommand('copy')` hidden-textarea fallback. If both fail, show the "Copy failed" state for 2s. Never fail silently.
- **Design tokens only** per CLAUDE.md: hover/focus use brand/accent scale; no raw hex in any new file. CSS module starts with `@reference "../../app/globals.css"`.
- **ui-review skill mandatory** per the user's explicit request. Run it on the final diff before committing.

---

## Files to Change

| File | Change |
|------|--------|
| `web/components/CopyButton/CopyButton.tsx` | **New.** Extracted from `MarkdownRenderer.tsx`. Accepts `text: string`, optional `label?: string` (default `"Copy to clipboard"`) for the `aria-label`, optional `size?: 'sm' \| 'md'`, optional `variant?: 'text' \| 'icon'` (default `'icon'`). Handles the full clipboard success/failure state machine with 2-second timeouts. |
| `web/components/CopyButton/CopyButton.module.css` | **New.** Styles for the button (default / hover / focus-visible / copied / failed states), using design tokens. Starts with `@reference "../../app/globals.css"`. Both light and dark mode variants. |
| `web/components/CopyButton/index.ts` | **New.** Barrel export. |
| `web/components/MessageActions/MessageActions.tsx` | **New.** Container `<div role="toolbar" aria-label="Message actions">` that renders a row of action children. Phase 1 takes a single `content: string` prop and renders one `CopyButton`. Future thumbs-up/thumbs-down/regenerate slot in as siblings via additional props. |
| `web/components/MessageActions/MessageActions.module.css` | **New.** Row layout (flex, small gap, top margin), toolbar-specific spacing. `@reference` header. |
| `web/components/MessageActions/index.ts` | **New.** Barrel export. |
| `web/components/index.ts` | Add exports for `CopyButton` and `MessageActions`. |
| `web/components/MarkdownRenderer/MarkdownRenderer.tsx` | Replace the inline `CopyButton` with an import of the shared component. Remove the local copy (lines 19–42) and the associated `useState`/`useCallback` wiring. The rendered markup at line 88 now uses `<CopyButton text={codeText} variant="text" size="sm" />` (or equivalent). |
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | Remove the `.copyButton` block (lines 105–131) now that the shared component owns its styling. |
| `web/components/ChatInterface/ChatInterface.tsx` | Insert `<MessageActions>` inside the `msgContent` div, AFTER the `msgBubbleAssistant` close (line ~1045), guarded by the render predicate (assistant + non-empty content + no skillBadge + finished streaming). |
| `web/components/ChatInterface/ChatInterface.module.css` | Add a small `.messageActionsRow` selector for spacing between bubble and toolbar if needed (likely minor; most styling lives on `MessageActions` itself). |
| `web/test/copy-button.test.tsx` | **New.** Unit tests for the shared `CopyButton`: renders as `<button>`, invokes `navigator.clipboard.writeText` with exact `text` prop, flips to "copied" state for 2 seconds, flips to "failed" state when the clipboard API rejects, handles missing API via fallback path. |
| `web/test/chat-message-copy-affordance.test.tsx` | **New.** Integration-shape tests on `ChatInterface`-level rendering: given a completed assistant message the toolbar renders; given a user message it doesn't; given a skill-badge placeholder it doesn't; given a streaming-in-progress last assistant message it doesn't; given an interrupted assistant with non-empty content it does. |

---

## Implementation Steps

### 1. Create the shared `CopyButton` component

- Create `web/components/CopyButton/` with `CopyButton.tsx`, `CopyButton.module.css`, `index.ts`.
- The component is a client component (`'use client'` at the top because it uses state and clipboard APIs).
- Props: `text: string` (required), `label?: string` (defaults to `"Copy to clipboard"`), `size?: 'sm' | 'md'` (default `'sm'`), `variant?: 'text' | 'icon'` (default `'icon'`), `className?: string` forwarded to the outermost element last.
- Internal state: a single `status` string that is one of `'idle' | 'copied' | 'failed'`. `useState('idle')`.
- On click:
  1. Prevent default form submission if inside a form (defensive).
  2. Try `navigator.clipboard.writeText(text)` if it's a function.
  3. If it throws, try a textarea+`document.execCommand('copy')` fallback. (This handles old Safari and insecure contexts.)
  4. On success: `setStatus('copied')`, then `setTimeout(() => setStatus('idle'), 2000)`. Store the timeout ID in a ref so repeated clicks don't produce overlapping timers.
  5. On both paths failing: `setStatus('failed')`, same 2-second revert.
- Rendered markup: a `<button type="button">` with class from the module and optional `className` merged. `aria-label` is the `label` prop. `aria-live="polite"` on the button is NOT set (would double-announce with the label change); instead we rely on the screen-reader announcement of the button's new accessible name when it re-renders.
- In `variant="icon"` mode, the button renders a lucide icon: `Copy` for idle, `Check` for copied, `AlertCircle` for failed. Icons are `aria-hidden="true"` since the button's `aria-label` carries the meaning. The icon dimensions are 16×16 (sm) or 20×20 (md).
- In `variant="text"` mode (used by the existing code-block copy button for backward compat), the button renders the word `"Copy"` / `"Copied!"` / `"Copy failed"` instead of an icon.
- Clean up the timeout in a `useEffect` cleanup so the button unmounting mid-flight doesn't produce a setState warning.

### 2. Write the `CopyButton.module.css`

- Start with `@reference "../../app/globals.css";`.
- Base `.button` class: `inline-flex items-center justify-center`, padding `px-2 py-1`, border-radius `rounded-md`, transition `transition-colors duration-150`, font `font-body`, plus a min-size so the hit target is at least 32×32 px.
- Use design tokens for colors: surface-raised background, brand-600 text in light mode, `:global(html.dark)` variant flipping to dark-surface-raised background + brand-300 text.
- Hover: brand-50 background in light, brand-700 background in dark. NO `hover:opacity-*` per CLAUDE.md.
- `:focus-visible`: 2px outline with brand-700 (light) / accent-400 (dark), same pattern as the scroll-wrapper outlines in `MarkdownRenderer.module.css`.
- State modifiers via a CSS class toggle (`.button.copied`, `.button.failed`) — `.copied` uses a success tint (accent-400 at low alpha), `.failed` uses a warning/error tint from the token scale. Both preserve readable contrast.
- Size variants via `.sm` / `.md` modifier classes.

### 3. Create the `MessageActions` container

- Create `web/components/MessageActions/MessageActions.tsx` with props `{ content: string; className?: string }` in Phase 1. Document in a JSDoc block that future phases will add `onThumbsUp`, `onThumbsDown`, `onRegenerate` props.
- Renders: `<div role="toolbar" aria-label="Message actions" className={styles.toolbar}>` with a single `<CopyButton text={content} label="Copy message to clipboard" />` child.
- `CopyButton` is imported from the barrel: `import { CopyButton } from '@/components'`.

### 4. Write `MessageActions.module.css`

- `@reference "../../app/globals.css";` header.
- `.toolbar` class: `flex items-center gap-2 mt-2`, no background, no border — the toolbar is visually quiet and reads as a footer to the message bubble.
- Mobile (<768px) `@media` block: tighter `mt-1`, smaller `gap-1` if needed.

### 5. Wire both new components through the barrel

- In `web/components/index.ts`, add:
  - `export { CopyButton } from './CopyButton'`
  - `export { MessageActions } from './MessageActions'`
- Keep alphabetical or grouped-by-category order consistent with existing entries.

### 6. Extract the existing `MarkdownRenderer` `CopyButton`

- In `web/components/MarkdownRenderer/MarkdownRenderer.tsx`:
  - Remove the local `CopyButton` function (lines 19–42).
  - Import the shared component from the barrel (`import { CopyButton } from '@/components'`).
  - In the `pre` renderer (around line 88), replace `<CopyButton text={codeText} />` with `<CopyButton text={codeText} variant="text" size="sm" label="Copy code to clipboard" />`. The `variant="text"` preserves the current "Copy" / "Copied!" visual for code blocks.
- In `web/components/MarkdownRenderer/MarkdownRenderer.module.css`:
  - Remove the `.copyButton`, `.copyButton:hover`, and `:global(html.dark) .copyButton` blocks (lines 105–131). These move into the shared component's styles.
- Sanity: `npm run build` should not complain about unused imports.

### 7. Integrate `MessageActions` into `ChatInterface`

- In `web/components/ChatInterface/ChatInterface.tsx`, locate the assistant-message render block (lines 993–1045).
- Find the closing `</div>` of `msgBubbleAssistant` / `msgBubbleUser` (around line 1045) — the action row should sit AFTER this close but BEFORE the closing `</div>` of `msgContent` (so it's inside the content wrapper but outside the bubble).
- Import `MessageActions` from the barrel.
- Add the toolbar guarded by the render predicate: `role === 'assistant'` AND `content` truthy AND no `skillBadge` AND (`!isLoading` OR message is not the last one).
- Pass `content={msg.content}`.
- Confirm the new toolbar is NOT rendered on user messages (the conditional is above the user branch already because the condition includes `role === 'assistant'`).

### 8. Minor style tuning in `ChatInterface.module.css`

- Verify the action row sits cleanly below the bubble with the existing message-row gap. If the stock `mt-2` from `MessageActions.module.css` clashes with the existing 2-rem message row gap, add a small `.messageActionsRow` override or adjust the top margin. Keep this minimal.

### 9. Unit tests for `CopyButton`

- New file `web/test/copy-button.test.tsx`. Uses `@testing-library/react` + `vitest`.
- Mock `navigator.clipboard.writeText` with a `vi.fn()` resolving to undefined by default.
- Tests:
  1. Renders as a `<button>` with the expected `aria-label`.
  2. On click, calls `navigator.clipboard.writeText` with the exact `text` prop.
  3. After a successful copy, the button's accessible name switches to the "copied" variant for ~2 seconds.
  4. After a rejected copy (mock the function to reject), the accessible name switches to the "failed" variant.
  5. If `navigator.clipboard.writeText` is absent entirely, the fallback path is invoked (mock `document.execCommand` to return true, assert it was called).
  6. Unmounting mid-timeout does not produce a React warning (mount, click, unmount before 2s, assert no console.error).
- For assertions on the post-click label, use `screen.findByRole('button', { name: /copied/i })` with a short timeout — avoid fake timers unless necessary to keep the test predictable.

### 10. Integration tests for ChatInterface rendering

- New file `web/test/chat-message-copy-affordance.test.tsx`.
- Mock heavy dependencies if needed (framer-motion, next/image, context providers). Model the approach on the existing `web/test/chat-message-rendering.test.tsx`.
- Tests:
  1. Render a completed assistant message (assistant, non-empty content, no skillBadge). Assert the toolbar and copy button appear.
  2. Render a user message. Assert the toolbar does NOT appear.
  3. Render an assistant skill-badge placeholder (empty content, skillBadge set). Assert the toolbar does NOT appear.
  4. Render an in-flight assistant message (last message, isLoading=true, partial content). Assert the toolbar does NOT appear.
  5. Render an assistant message with `interrupted: true` and non-empty content. Assert the toolbar DOES appear.

### 11. Run typecheck + test suite

- `cd web && npx tsc --noEmit` — must be clean.
- `cd web && npx vitest run` — all existing + new tests must pass. Target count depends on how many the two new files add; note expected increase in the final report.

### 12. Run the `ui-review` skill

- Per the user's explicit request, invoke the `ui-review` skill on the final diff before committing.
- Skill location: `.claude/skills/ui-review/SKILL.md`. Invoke via the `Skill` tool with name `"ui-review"` and a short intent blurb describing the change ("Adding a copy button below assistant messages in the chat UI — extracted and reused the existing `CopyButton` from `MarkdownRenderer` into a shared component, added a `MessageActions` toolbar. Please check a11y, responsive, and design-token compliance").
- The skill invokes Gemini CLI. Parse the returned JSON (severity-grouped issues + positives).
- Address any high/medium findings. Defer low/nit findings with explicit reasoning in the chat. One-round cap — don't ping-pong.

### 13. Manual browser verification

- Start the dev server: `cd web && npm run dev`.
- Open the chat at desktop width. Send a prompt that produces a normal assistant response. Verify the copy button appears below the bubble after streaming completes.
- Click it; confirm the icon swap + revert; paste into a plain-text editor and confirm the content matches the rendered assistant response (minus markdown rendering, plus markdown source).
- Verify NO copy button appears during streaming (send a prompt, watch the in-flight indicator; confirm the toolbar shows up only after the response completes).
- Verify NO copy button appears on user messages or skill-badge messages (invoke a slash command to produce a skill badge).
- Toggle dark mode. Verify all states (default, hover, focus-visible, copied, failed) render correctly in dark mode.
- Narrow the viewport to <768px. Verify the toolbar is still visible (not hover-gated) and sits appropriately below the bubble.
- Press Tab to focus the button; verify the focus ring is visible.

### 14. Run code-review skill

### 15. Commit

- Commit message convention: `✨ feat: copy button below assistant messages (Phase 1)`. Include the spec link and a one-line mention of the `CopyButton` extraction.
- Do NOT commit transient ui-review output.

---

## Verification

1. `npx tsc --noEmit` — clean.
2. `npx vitest run` — all tests pass, including the two new files.
3. `ui-review` skill run, any high/medium findings addressed.
4. Manual: dev server at desktop width. Send a normal prompt, verify the copy button appears after streaming completes, click it, paste into a plain-text editor, confirm the content matches. Confirm the button does NOT appear during streaming, on user messages, or on skill-badge messages. Verify dark-mode and mobile (<768px) rendering.
5. Existing code-block copy button (in `MarkdownRenderer`) still works correctly after the extraction — verify by rendering an assistant response that contains a fenced code block, clicking the code-block's Copy button, pasting it somewhere.
