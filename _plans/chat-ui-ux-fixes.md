# Chat UI/UX Fixes

## Context

Address a cluster of presentation defects in the web chat interface reported in Notion: section headings render with poor scale, wide markdown tables and fenced code blocks overflow the message container instead of scrolling inside the bubble, long unbroken pasted text bleeds out of the user bubble, uploaded text-family files (`.txt`, `.json`, `.log`, `.md`) display their full body inline after a conversation reload (skills show a clean badge by comparison), and on mobile the sidebar is expanded and the composer input is oversized by default. The desktop chat container is also slightly too narrow. This plan keeps changes strictly presentation-layer — no agent loop, persistence, or executor changes.

---

## Key Design Decisions

- **Markdown rendering stays in `MarkdownRenderer`**. Don't fork into multiple renderers — instead, audit and tighten its custom component map (headings, tables, code blocks) so each respects the design system.
- **Heading scale via design tokens**, not arbitrary sizes. H1–H3 use the `font-display` token + `tracking-tight` for ≥2xl with consistent vertical rhythm matching other Neo surfaces.
- **Horizontal overflow handled at the WRAPPER level** of tables and code blocks (a div with `overflow-x: auto`), not on the bubble itself. The bubble's own `overflow-x: auto` is removed so the bubble's `max-width` can be a hard ceiling and only the misbehaving children scroll.
- **User-message overflow**: apply `overflow-wrap: anywhere` to the text container of the user bubble. This breaks long unbroken tokens at arbitrary character boundaries while preserving normal word-wrap behavior. Combined with a hard `max-width`, the bubble can never escape its column.
- **Attachment badges via pre-render extraction**, not a custom react-markdown component. The `<text_attachment>` blocks are extracted from `message.content` at the conversation-load layer (`conversationToChatMessages` in `ChatInterface.tsx`) into a structured `attachments[]` array on the chat message object. The remaining markdown content (without the blob) is passed to `MarkdownRenderer`. Badges render above the markdown body, mirroring the existing `skillBadge` pattern. This keeps `MarkdownRenderer` simple and avoids fighting `rehype-sanitize`.
- **Apply badge to all text-family attachments** (`.txt`, `.json`, `.log`, `.md`) by detecting the `<text_attachment ...>` tag — the wrapper is the same for every text upload, so the same extraction logic catches them all per the resolved spec decision.
- **Mobile responsiveness via CSS Module breakpoints**, not new JS state. Use `@media (max-width: 767px)` blocks in `ChatInterface.module.css` to override sidebar default-open, composer default-height/padding, and bubble padding. The existing `isSidebarOpen` JS state stays — but its initial value is `false` for mobile (computed from `window.matchMedia` once on mount, SSR-safe via a hydration-safe pattern).
- **Container width bump** from `48rem` (max-w-3xl) to `56rem` (max-w-4xl) on `.messagesInner` AND `.inputInner` (composer must stay aligned with messages). Mobile is full-width regardless.
- **No new components for this PR**. All changes happen in existing files. The attachment badge is a small inline span with `.attachmentBadge` class added to the existing module CSS.
- **Backward compat for old conversations**: messages persisted before this fix already contain `<text_attachment>` blocks in their content. The pre-render extraction parses those tags from any message regardless of when it was persisted, so older conversations get the new badge treatment for free.

---

## Files to Change

| File | Change |
|------|--------|
| `web/components/MarkdownRenderer/MarkdownRenderer.tsx` | Audit + tighten the custom component map: H1/H2/H3 use design tokens; table component wraps `<table>` in a `<div>` with `overflow-x: auto` and `tabIndex={0}` for keyboard scroll; code block wrapper (already exists) gets the same overflow treatment if not already in place. |
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | New/updated classes for `.headingH1`, `.headingH2`, `.headingH3`, `.tableScrollWrapper`, `.codeBlockScrollWrapper`. All use `@apply` against design tokens. Focus-visible outlines on the scroll wrappers. Dark mode variants. |
| `web/components/ChatInterface/ChatInterface.tsx` | (a) Extract `<text_attachment ...>...</text_attachment>` blocks from `message.content` in `conversationToChatMessages` into a new `attachments?: ChatAttachment[]` field on the `ChatMessage` shape; (b) Render an attachment-badge row above the markdown body for messages that have attachments; (c) Add an SSR-safe initial `isSidebarOpen` derived from `window.matchMedia("(max-width: 767px)")` + a resize listener that collapses on transition to mobile; (d) Add `overflow-wrap: anywhere` class to the user message text container. |
| `web/components/ChatInterface/ChatInterface.module.css` | (a) `.messagesInner` and `.inputInner` max-width 48rem → 56rem; (b) `.msgBubbleUser` text container gets `overflow-wrap: anywhere` (no horizontal-overflow); (c) `.msgBubbleUser` and `.msgBubbleAssistant` lose any `overflow-x: auto` (children handle their own scroll); (d) New `.attachmentBadge` and `.attachmentBadgeRow` classes mirroring `.skillBadge` style; (e) New `@media (max-width: 767px)` block: tighter bubble padding, single-row composer height (~2.5rem), tighter composer padding. |
| `web/lib/types.ts` (or a new `web/lib/chat-attachments.ts`) | New small parser `extractTextAttachments(content: string): { text: string; attachments: ChatAttachment[] }` and a `ChatAttachment` interface (`filename`, `sizeBytes`, `kind: "text"` for now). The parser scans for the `<text_attachment filename="..." size_bytes="...">...</text_attachment>` regex used by `txt-content-blocks.ts` and returns the cleaned content + the metadata. |
| `web/test/chat-message-rendering.test.tsx` | New vitest file. Asserts that a markdown H1/H2/H3 inside MarkdownRenderer applies the correct token class; a wide table is wrapped in a scroll container; a fenced code block is wrapped similarly; a user-message text container has the no-horizontal-overflow class. |
| `web/test/attachment-badge-reload.test.tsx` | New vitest file. Asserts that `extractTextAttachments` correctly parses a single `<text_attachment>` block, multiple blocks, and content with no blocks (passthrough). Asserts that a ChatInterface message containing such content renders the `.attachmentBadge` element with the filename and does NOT render the inline body text. |
| `web/test/mobile-layout.test.tsx` | New vitest file. Mocks `window.matchMedia` to simulate mobile viewport; asserts ChatInterface initial `isSidebarOpen` is false; asserts the responsive CSS class names attach correctly. (Note: full media-query CSS isn't applied by jsdom, so the test verifies state and class assignment only — not computed styles.) |

---

## Implementation Steps

### 1. Add the attachment parser

- Create `web/lib/chat-attachments.ts`. Define a `ChatAttachment` interface with fields `filename: string`, `sizeBytes: number`, `kind: "text"` (kind is a forward-looking enum so future attachment types can extend without breaking the interface).
- Implement `extractTextAttachments(content: string): { text: string; attachments: ChatAttachment[] }`. The regex should match `<text_attachment filename="..." size_bytes="...">[\s\S]*?</text_attachment>` (case-insensitive, non-greedy, multiline). For each match: extract the `filename` and `size_bytes` attribute values (HTML-decode `&quot;` / `&amp;` / `&lt;` / `&gt;` since `txt-content-blocks.ts` escapes attribute values), push to the attachments array, and remove the matched substring from the content. Return `{ text: trimmed remainder, attachments }`.
- Handle malformed cases conservatively: if a `<text_attachment>` tag has no closing tag, leave it in the text (don't strip half a block). If `size_bytes` is missing or non-numeric, default to 0 in the attachment but still create the badge.

### 2. Wire the parser into conversation loading

- In `web/components/ChatInterface/ChatInterface.tsx`, locate `conversationToChatMessages()` (around lines 140–204 per the explore). Find the `ChatMessage` interface (declared in the same file or a sibling type file).
- Add `attachments?: ChatAttachment[]` to the `ChatMessage` interface.
- For each user-role message and assistant-role message whose content is a string, call `extractTextAttachments` on the content. Replace the content with the cleaned `text` and set `attachments` on the message if any were extracted.
- Do the same for the in-flight send path so that newly sent text-file uploads also render as badges in real time (find the spot where the local `chatMessages` state is updated when the user sends a message with files attached).

### 3. Render the attachment badges

- In `ChatInterface.tsx`, locate the message rendering JSX (around line 938–991). Above the content body (whether `MarkdownRenderer` for assistant or plain text for user), conditionally render an `<div className={styles.attachmentBadgeRow}>` containing one `<span className={styles.attachmentBadge}>` per attachment. The badge text is `{attachment.filename}` plus a small file-size hint (e.g., `1.2 KB` formatted via a tiny inline helper).
- The badge appears for both user and assistant messages that have `attachments` (in practice it's user messages, but make the rendering symmetric so future bot-attached files work).
- No click handler — the badge is pure display per the resolved spec decision.

### 4. Add the badge CSS

- In `web/components/ChatInterface/ChatInterface.module.css`, add `.attachmentBadgeRow` (flex row, `gap-2`, `flex-wrap`, `mb-2`) and `.attachmentBadge`. The `.attachmentBadge` mirrors the existing `.skillBadge` styling — `inline-flex` with an icon-sized leading area, padded pill shape, surface-raised background with a border-default outline, body font, small text size. Add a paperclip-style emoji or text marker (e.g., `📎` prefix or a leading text label like `Attached:`) to distinguish from skill badges. Dark mode variant uses the standard surface tokens.

### 5. Heading scale audit in MarkdownRenderer

- Open `web/components/MarkdownRenderer/MarkdownRenderer.tsx`. Find the custom component map for `h1`, `h2`, `h3`. Each should map to a styled wrapper that uses a class from `MarkdownRenderer.module.css`.
- In `MarkdownRenderer.module.css`, define `.headingH1`, `.headingH2`, `.headingH3` using `@apply` with the design system tokens (see CLAUDE.md): H1 ~`text-3xl font-bold tracking-tight font-display`, H2 ~`text-2xl font-bold tracking-tight font-display`, H3 ~`text-xl font-semibold font-display`. Add consistent vertical spacing — `mt-8 mb-4` for H1, `mt-6 mb-3` for H2, `mt-4 mb-2` for H3.
- Ensure the file starts with `@reference "../../app/globals.css";` (per the project's CSS Module convention). If not, add it.

### 6. Table + code horizontal scroll

- In `MarkdownRenderer.tsx`, the `table` custom component should wrap the actual `<table>` element in a `<div className={styles.tableScrollWrapper}>` with `tabIndex={0}` and an `aria-label="Scrollable table"`.
- In `MarkdownRenderer.module.css`, `.tableScrollWrapper` uses `@apply overflow-x-auto max-w-full block` plus a `:focus-visible` outline using the brand-500 token. Dark-mode-friendly via design tokens.
- For the code block, the existing `.codeBlockWrapper` already wraps fenced code. Verify it has `overflow-x: auto` on the inner `<pre>` or wrapper. If not, add `.codeBlockScrollWrapper` with the same treatment (`overflow-x-auto`, `tabIndex={0}`, focus-visible outline). The copy button stays in the header.

### 7. User message overflow containment

- In `ChatInterface.module.css`, find the `.msgBubbleUser` and the inner text container styles. Add `overflow-wrap: anywhere` (or `overflow-wrap: break-word` if `anywhere` causes issues with email-like strings — `anywhere` is the spec choice). Also set `min-width: 0` on the flex child if needed to allow the browser to compute proper wrapping.
- Remove any `overflow-x: auto` from `.msgBubbleUser` and `.msgBubbleAssistant` — the children (table/code wrappers) now own that responsibility. The bubble's `max-width` becomes the hard ceiling.

### 8. Container max-width bump

- In `ChatInterface.module.css`, change the `max-width` of `.messagesInner` and `.inputInner` from `48rem` to `56rem` (Tailwind `max-w-4xl` equivalent). This is one Tailwind step up.
- Visually verify the input area still aligns with the message column (they share the same max-width, so they should).

### 9. Mobile sidebar default-collapsed

- In `ChatInterface.tsx`, the `isSidebarOpen` `useState` initializer currently defaults to a fixed boolean. Replace with a function initializer that, on first render, returns `false` if `window.matchMedia("(max-width: 767px)").matches` and `true` otherwise.
- Wrap the matchMedia access in a `typeof window !== "undefined"` check for SSR safety. If `window` is unavailable (SSR), default to `true` (desktop-default) so server-rendered HTML matches the desktop layout; on hydration the client computes the real value and corrects it on first effect.
- Add a `useEffect` that subscribes to the media query's `change` event. When the viewport becomes mobile, call `setIsSidebarOpen(false)`. When it becomes desktop, leave the current state alone (don't auto-open).

### 10. Mobile composer + bubble sizing

- In `ChatInterface.module.css`, add a single `@media (max-width: 767px)` block at the bottom (or wherever existing media queries live). Inside:
  - Override `.composerTextarea` (or whatever the textarea class is — find via the existing component): smaller default `min-height` (e.g., `2.5rem`), tighter `padding` (e.g., `0.75rem 1rem`).
  - Override `.msgBubbleUser` and `.msgBubbleAssistant`: tighter horizontal padding (e.g., `0.75rem` instead of `1.25rem`).
  - Override `.inputArea` padding to match the tighter composer.

### 11. Update tests for existing components if any rely on the changed structure

- Run the existing test suite first; if any tests assert on `max-width: 48rem` or the old composer padding, update them to match the new values.
- The added attachments field on `ChatMessage` shouldn't break any existing tests because it's optional, but verify.

### 12. Write the new test files

- `web/test/chat-attachments.test.ts` (rename from spec's `attachment-badge-reload.test.tsx` to a unit test of the parser, plus an integration test of the badge rendering):
  - Parser tests: single attachment block, multiple blocks, no blocks (passthrough), malformed (no closing tag) is left in content, HTML-encoded attribute values are decoded.
  - Component test (renders a message with attachments via testing-library): badge element present, filename text matches, inline body NOT present in DOM.
- `web/test/chat-message-rendering.test.tsx`:
  - Render a markdown string with `# Heading 1` → assistant message contains an `h1` with `.headingH1` class.
  - Render a wide table → the `<table>` is wrapped in an element with `.tableScrollWrapper` class.
  - Render a fenced code block → the `<pre>` is wrapped in an element with the code-scroll-wrapper class.
  - Render a user message with a 1000-character unbroken token → the text container has the `overflow-wrap: anywhere` class (assert by class name; jsdom doesn't compute styles).
- `web/test/mobile-layout.test.tsx`:
  - Mock `window.matchMedia` to return `matches: true` for `(max-width: 767px)`.
  - Render `ChatInterface`. Assert sidebar is rendered in its closed state (e.g., width `0` style or absence of expanded class).
  - Mock `window.matchMedia` to return `matches: false`. Render. Assert sidebar is open by default.

### 13. Manual verification checklist

- Start dev server (`cd web && npm run dev`), open chat at desktop width.
- Send a message that triggers an assistant response with: a wide table, a long code block, and headings. Verify the table scrolls inside the bubble; the bubble doesn't overflow; headings look right.
- Paste a 1000-character no-whitespace string and send. Verify the bubble stays inside the column.
- Upload a `.txt` file (and one `.json` file) with a body. Send. Reload the page. Verify the message renders with attachment badges instead of inline text.
- Resize the browser narrow (<768px) or use Chrome DevTools mobile emulation. Verify sidebar starts collapsed; composer is single-row; bubble padding is tighter.
- Toggle dark mode. Verify all the above renders correctly with dark tokens.

---

## Verification

1. `cd web && npx tsc --noEmit` — must be clean.
2. `cd web && npx vitest run` — all existing tests plus the three new files must pass.
3. Confirm the new tests are present in the run summary: `chat-attachments`, `chat-message-rendering`, `mobile-layout`.
4. Manual smoke checks per Step 13.
5. Reload an existing pre-fix conversation that contains a `.txt` upload from before this change ships. Verify the badge renders correctly (backward compat).
