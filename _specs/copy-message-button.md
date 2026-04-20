# Spec for copy-message-button

branch: claude/feature/copy-message-button

## Summary

Add a copy button to the end of Neo's assistant responses in the web chat, matching the pattern the user shared in a reference screenshot (a small row of action icons below the message content — copy, thumbs-up, thumbs-down, regenerate — where Phase 1 ships only the copy affordance). Clicking the button copies the raw markdown-source content of that assistant message to the clipboard so the user can paste it into a ticket, Teams message, email, or investigation notes without manually selecting text. Phase 1 is copy-only; thumbs-up/thumbs-down and regenerate buttons are out of scope but the component should be designed so those can be added later without a rewrite.

## Functional requirements

### Placement and visibility

- The button appears below each assistant message bubble — after the message content, after the `toolSummary` block if one exists, and after the `interrupted` badge if one exists. It does NOT appear on user messages or on synthetic skill-badge messages (those have no meaningful content to copy).
- The button is part of the same action row that will eventually hold thumbs-up / thumbs-down / regenerate. In Phase 1 the row contains only the copy button, but the container is a single row element (`role="toolbar"` or equivalent) so future additions sit in a consistent spot.
- The button row is visible on messages that have finished streaming only. During an in-flight stream (before the final `response` event arrives), the button does NOT render — there's nothing stable to copy yet.
- The row is visible by default on desktop (below each completed assistant message, left-aligned with the bubble). Hover/focus emphasis is a subtle color or opacity change to indicate interactivity — no jarring transform or layout shift.
- On mobile (< 768px), the row remains visible by default. We do NOT hide it behind a hover-only reveal since touch devices have no hover state.

### Copy behavior

- Clicking the copy button copies the raw markdown-source content of that assistant message to the system clipboard via `navigator.clipboard.writeText`.
- The copied text is the `ChatMessage.content` string exactly as stored — the original markdown, not the rendered HTML. A user pasting into another markdown-aware surface (Teams, a markdown note) gets proper rendering; pasting into a plain-text surface gets readable text.
- If the assistant message has attachments (e.g., a text-file badge row), the attachment badges are NOT included in the copied output — only the message content. A future enhancement could include an `[Attached: foo.txt]` suffix, but Phase 1 keeps it simple.
- The `interrupted` suffix (if present) is also not copied — we strip it server-side before persisting, so the persisted `content` is already clean.

### Feedback after copy

- On successful copy, the button's label / icon briefly swaps to a "Copied!" affordance for ~2 seconds, then reverts. This mirrors the existing `CopyButton` pattern in `MarkdownRenderer.tsx` (which already ships for fenced code blocks).
- If `navigator.clipboard.writeText` is unavailable or throws (e.g., insecure context, browser blocks), fall back to a `textarea + execCommand('copy')` approach OR surface a subtle error state ("Copy failed") for ~2 seconds. Modern Chromium / Firefox / Safari on HTTPS all support the Clipboard API, so this is a graceful-degradation path rather than an expected path.
- The feedback state is per-button: each message's copy button has its own "Copied!" state; clicking one doesn't affect another.

### Accessibility

- The button is a real `<button>` element (not a styled `<div>`), so it receives keyboard focus in document order and activates on Enter/Space natively.
- It has a descriptive `aria-label` (e.g., `"Copy message to clipboard"`) — short enough to read without being disruptive.
- On successful copy, announce the state change to assistive tech. The existing `MarkdownRenderer` copy button uses a visible text swap ("Copied!") — that's sufficient because the button's accessible name updates and screen readers announce button-text changes. Do NOT add a separate `aria-live` region for this — it would double-announce.
- Visible `:focus-visible` outline using the design-system focus color (consistent with other buttons in `ChatInterface.module.css` — `brand-700` in light mode, `accent-400` in dark mode).
- Button has a hit target of at least 32×32 px at desktop zoom for touch friendliness.

### Design system compliance

- Per CLAUDE.md: the button is a reusable component, lives in its own folder under `web/components/` (e.g., `components/MessageActions/`), exports via the `components/index.ts` barrel, and uses CSS modules with `@reference "../../app/globals.css"` at the top of the module file.
- Uses design tokens only: `brand-*`, `accent-*`, `surface-*`, `border-*`. No raw hex values.
- Uses named font tokens (`font-body`), standard shade-based hover transitions (no `hover:opacity-*`).
- Maximum 3 inline Tailwind classes; anything more goes into the module CSS via `@apply`.

### Future-proofing for thumbs-up/thumbs-down/regenerate

- The container is named generically (`MessageActions` or `MessageActionRow`) and accepts an array of action children or a specific prop set so the copy button is one of N. In Phase 1, `N = 1`.
- The copy button itself is a stand-alone component (`CopyMessageButton` or `CopyButton` in the same folder) that takes `text: string` as a prop and does not assume anything about its container. This matches the existing `MarkdownRenderer` `CopyButton` pattern — in fact, if that component can be pulled out of `MarkdownRenderer` and reused here without regression, that's the cleanest path (one copy-button implementation, two call sites).

## Possible Edge Cases

- Empty assistant messages (e.g., a skill-invocation badge placeholder with `content: ''`): do NOT render the copy button. The presence check should be on non-empty `content`, not just "role is assistant".
- Assistant messages that were interrupted mid-stream and persist with the `interrupted` flag but non-empty partial content: the copy button DOES render; copying gives whatever content got through before the interruption.
- Very long assistant messages (e.g., a multi-thousand-token investigation report): Clipboard API has no practical size limit for text content. No truncation needed.
- Messages containing markdown with embedded HTML (the renderer uses `rehypeSanitize`, but the source markdown may still contain HTML tags as text): copy the raw markdown source, not sanitized HTML. This is the natural behavior of copying `ChatMessage.content`.
- Dark mode: all visual states (default, hover, focus-visible, copied) respect dark mode tokens.
- Browser without Clipboard API (insecure HTTP, old Safari): gracefully degrade — either fall back to `execCommand('copy')` via a hidden textarea, or surface a "Copy not available" state. Do NOT silently fail with no feedback.
- Permissions policy blocking clipboard (iframe contexts, enterprise policy): same as above — surface a clear failure state.
- User selects a specific portion of the message and hits Cmd/Ctrl+C as usual: the copy button is additive — normal text selection still works and is unaffected.
- Streaming completes and a copy button appears, but then the user scrolls back to an older message and clicks its copy button: each button is independent and always copies its own message's current content. The `messages` state is the source of truth.
- If a conversation is reloaded from Cosmos and the message content has been trimmed (`context-manager.ts` truncation in tool results — NOT in assistant text, but just to be safe): the copy button still renders and copies whatever content is stored, even if that content is a summary rather than the original response. We don't try to "un-trim" — what you see is what you copy.

## Acceptance Criteria

- [ ] Every completed assistant message in the web chat has a copy button rendered below the bubble, below the tool-summary and interrupted-badge rows if present.
- [ ] User messages and skill-badge messages do NOT render the copy button.
- [ ] Messages that are currently streaming (not yet finalized) do NOT render the copy button.
- [ ] Clicking the button copies the assistant message's raw markdown-source `content` to the system clipboard.
- [ ] After a successful copy, the button shows a "Copied!" state for ~2 seconds, then reverts.
- [ ] The button has `<button>` semantics, receives keyboard focus, activates on Enter/Space, has an `aria-label`, and shows a visible `:focus-visible` outline using the design-system focus color.
- [ ] The button is visible (not hover-gated) on both desktop and mobile.
- [ ] The button uses design tokens and CSS modules per CLAUDE.md conventions.
- [ ] Clipboard API failure (e.g., insecure context) surfaces a visible "Copy failed" state for ~2 seconds rather than silently succeeding or silently failing.
- [ ] Copying a 10K-character assistant message works without truncation.
- [ ] Dark mode renders all button states (default, hover, focus, copied, failed) using dark-mode tokens.
- [ ] Existing vitest suite passes; new tests added (see Testing Guidelines).

## Open Questions

1. **Reuse the existing `CopyButton` from `MarkdownRenderer.tsx`, or write a new one?** The existing one is scoped to code blocks and hardcodes size/position assumptions. Recommendation: extract it to a shared `components/CopyButton/` and use it in both places. That way the "copied!" timing and failure handling live in one place. agreed.
2. **Copy icon vs. text?** The reference screenshot shows icon-only action buttons. Recommendation: icon-only with an `aria-label`. A minimal copy icon (lucide-react's `Copy` / `Check` pair) fits the action row's compact footprint and matches the thumbs-up/thumbs-down siblings that will arrive later. agreed.
3. **Action row placement — left-aligned under the message, or right-aligned?** The reference screenshot shows left-aligned below the bubble. Recommendation: follow the reference — left-aligned, below the bubble's bottom edge. left aligned
4. **Copy format — markdown source or rendered text?** Recommendation: raw markdown source. Users pasting into Teams/markdown surfaces get rich rendering; users pasting into plain text get readable text. Converting to plain text (stripping markdown syntax) loses formatting with no clear benefit. markdown 
5. **Include the "Neo Agent" label or just the content?** Recommendation: just the content. The author attribution is obvious in context; including it clutters pasted output. Content only

## Testing Guidelines
Create test file(s) under `web/test/` for the new feature, and create meaningful tests for the following cases, without going too heavy:

- `web/test/copy-message-button.test.tsx`
  - Renders a `<button>` element with an accessible label.
  - On click, calls `navigator.clipboard.writeText` with the expected content.
  - Shows a "Copied!" state for ~2 seconds after a successful copy.
  - Shows a "Copy failed" state when `navigator.clipboard.writeText` rejects.
  - Has a visible focus outline class on `:focus-visible` (assertion on class name presence since jsdom doesn't compute computed styles).
  - Does NOT mutate or escape the content — the exact `text` prop is what lands on the clipboard.

- `web/test/chat-message-copy-affordance.test.tsx`
  - Given a completed assistant message (`role: 'assistant'`, non-empty content), the copy button is rendered below the bubble.
  - Given a user message, NO copy button is rendered.
  - Given an assistant skill-badge placeholder (`content: ''`, `skillBadge` set), NO copy button is rendered.
  - Given an assistant message with `interrupted: true` and non-empty content, the copy button IS rendered and copies the stored content.
