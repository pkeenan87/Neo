# Spec for chat-ui-ux-fixes

branch: claude/feature/chat-ui-ux-fixes
Source: Notion issue — "UI/UX Issues" (2026-04-15, High urgency)

## Summary

Fix a cluster of chat UI/UX defects in the web interface where data posted to and returned from Claude doesn't handle its edge cases gracefully. The symptoms are visible in production screenshots from Notion: section headings render poorly, wide tables and code blocks overflow horizontally instead of scrolling inside the message, long unbroken user-pasted text bleeds outside the user bubble, uploaded `.txt` files show their full body inline after a conversation reload (skills show a clean badge by comparison), and mobile users get an expanded sidebar + oversized prompt input by default. In addition, the overall chat+input container is a touch narrow — the desired outcome calls for giving it a little more headroom.

The scope is strictly presentation: no changes to message persistence, tool results, skills, or the agent loop. This is a UI polish pass across the `ChatInterface` and Markdown-rendering components, plus a mobile-first pass on the layout.

## Functional requirements

### Markdown rendering in assistant messages

- **Headings (H1–H6)** must render with a consistent, hierarchical scale that matches the rest of the Neo design system (using `font-display`, `tracking-tight` for 2xl+, and proper vertical spacing above and below). No raw-looking `##` or uneven spacing; no oversized H1s that dominate the bubble.
- **Tables** that exceed the bubble width must scroll horizontally inside the bubble — the table itself should sit inside a scroll container with a visible-on-focus horizontal scrollbar, matching the behavior the user highlighted as "good" in the Teams screenshot. The rest of the message (surrounding text, other tables) must not reflow when the table grows.
- **Fenced code blocks** must also scroll horizontally when their longest line exceeds the bubble width. Today they appear to wrap or push the bubble wider than the container. Preserve the existing monospace font and syntax color (no change), only fix the overflow.
- **Inline code** (backtick-delimited within a paragraph) keeps its current styling.

### User message overflow

- A long single paste (e.g., a wall of JSON or a log line hundreds of chars wide) must stay contained inside the user bubble. Today it breaks out the left edge, overlapping the sidebar/margin. Force `overflow-wrap: anywhere` (or equivalent) on the user message text body so tokens with no whitespace are broken at arbitrary character boundaries rather than overflowing.
- Whitespace-preserving content (code snippets in the user message) may still require horizontal scroll within the bubble — same treatment as assistant code blocks.
- The user bubble's max-width stays the same percentage of the container, but the inner content must never exceed that max-width visually.

### Attachments on reload (txt + other text files)

- Today, uploaded `.txt` files render as inline text blocks when the conversation is reloaded from Cosmos — the full body of the file appears in the middle of the conversation rather than as an attachment pill.
- After the fix, reloaded `.txt` attachments render as an attachment badge similar to the skill-invocation badge (icon + filename + file-size hint). Clicking the badge is out of scope for Phase 1 (no preview modal yet) — it's purely a display fix.
- The badge rendering applies to reloaded conversations (from Cosmos history). The in-flight send path already renders fine during the active turn.
- Images and PDFs keep their existing rendering treatment (thumbnails / doc chips) — only text-file attachments are affected.

### Mobile responsive layout

- **Sidebar**: on screen widths below the Tailwind `md` breakpoint (768px), the sidebar must be collapsed by default. Users can toggle it open via the existing hamburger/menu button. Persistence of the collapsed state is not required — each mobile visit starts collapsed.
- **Prompt input**: on mobile, the composer input is currently visually oversized (taking ~40% of the viewport before any content is typed). Shrink its default height to a single row (with expand-on-type behavior preserved) and its horizontal padding to match standard mobile chat UIs.
- **Message bubbles**: on mobile, bubbles should have tighter horizontal padding so more content fits. No change to desktop bubble padding.
- The existing breakpoint structure in Tailwind should drive this — no new custom breakpoints needed.

### Overall container sizing

- Expand the chat+input container's max-width slightly on desktop to give more room for tables and long content. Current max-width is `max-w-3xl` (or equivalent) per existing layout — bump to `max-w-4xl`. The sidebar gutter stays the same; the expansion comes from the content area itself.
- No change on mobile (which is always full-width).

## Possible Edge Cases

- A table with a single very long cell (e.g., a URL): the scroll container must handle it; the cell itself should NOT overflow-wrap mid-URL.
- A code block with extremely long lines (e.g., a one-line JSON) followed by a short paragraph: scroll must apply only to the code block, not the paragraph below.
- Mixed content in one assistant message (heading + table + code block + list): each must render with its own correct overflow treatment. A wide table below a heading must not push the heading off-screen.
- User pastes a block with both long unbroken text AND meaningful line breaks (e.g., a stack trace). Line breaks should be preserved; only unbroken tokens get word-broken.
- Reloading a conversation whose history contains `.txt` attachments from BEFORE this fix shipped: the previously-inline text should still read correctly. If the persisted conversation structure can't be retroactively re-classified, the fix can target only *new* messages going forward — but the ideal is to detect the `[Attached: foo.txt]` marker (or equivalent persisted representation) and render a badge regardless of when the conversation was created.
- User on mobile rotates from portrait to landscape while the sidebar is in its default state: the sidebar should react to the breakpoint change (collapsed below 768px, open or last-user-state above).
- Extremely narrow mobile viewports (<360px — older Android devices): layout should still not overflow. Test at 320px minimum.
- Dark mode: all the fixes above must respect dark mode tokens — headings, scroll containers, attachment badges.
- A11y: horizontal scroll containers must be keyboard-reachable. Tables must still be navigable with arrow keys via the browser default; the wrapper div should have `tabIndex={0}` and a visible `:focus-visible` outline.

## Acceptance Criteria

- [ ] Section headings (H1–H3) in assistant messages render at sensible sizes with consistent spacing, matching the design system's typography tokens.
- [ ] A wide markdown table rendered in an assistant message has its own horizontal scrollbar inside the bubble; the bubble itself does not overflow the message container.
- [ ] A fenced code block with lines wider than the bubble scrolls horizontally inside the bubble.
- [ ] A user message containing a single unbroken string of 500+ characters stays inside its bubble; no horizontal overflow into the sidebar or page margin.
- [ ] Reloading a conversation whose history contains a `.txt` attachment renders the attachment as a badge (icon + filename), not as inline text.
- [ ] On a viewport narrower than 768px, the sidebar is collapsed on first render.
- [ ] On a viewport narrower than 768px, the composer/prompt input is a single-row input by default (expanding vertically as the user types) and uses tighter horizontal padding than the desktop version.
- [ ] On a viewport wider than 1024px, the chat+input container is visibly wider than before by one Tailwind size step (`max-w-3xl` → `max-w-4xl` or equivalent).
- [ ] All horizontal-scroll containers (tables, code blocks) are keyboard-focusable with visible `:focus-visible` outlines and scroll via arrow keys.
- [ ] Dark mode renders all the above correctly — no token regressions.
- [ ] Existing vitest tests still pass; no agent loop / message persistence behavior changes.

## Open Questions

- Should `.json`, `.log`, `.md`, and other text-family uploads (currently treated similarly to `.txt`) also render as badges on reload? Or keep the badge treatment scoped to `.txt` only for Phase 1? Recommendation: apply to all text-family uploads at once since the fix is the same component. apply to all text.
- Should the attachment badge on reload be clickable (open a preview modal) in this PR, or pure display? Recommendation: pure display for Phase 1; preview modal is a separate follow-up because it touches message persistence and a new route. pure display.
- Desired desktop container max-width: `max-w-4xl` (896px) or `max-w-5xl` (1024px)? The user said "a little more room." `max-w-4xl` is the conservative choice. Recommendation: `max-w-4xl`, revisit if users want more. max-w-4xl
- Mobile sidebar persistence: should the collapsed/open state persist across navigations within the same session? The spec says "each mobile visit starts collapsed." Confirm this is the preferred behavior, or if `localStorage`-backed persistence is desired. I confirm, I want it to start collapsed.
- Should this fix include any explicit "copy message" or "copy code block" affordances, or leave those for a separate UX-enhancement pass? Recommendation: out of scope for this spec. out of scope.

## Testing Guidelines

Create test files under `web/test/` for the new feature, and create meaningful tests for the following cases, without going too heavy:

- `web/test/chat-message-rendering.test.tsx`
  - Rendering a markdown H1/H2/H3 inside an assistant message produces the expected design-system typography tokens (check class names or computed styles).
  - A markdown table wider than its container is wrapped in a scroll container with `overflow-x: auto` (or the equivalent token class).
  - A fenced code block gets the same scroll wrapper.
  - A user message with a 1000-character unbroken token has its content node's computed `overflow-wrap` or equivalent set to a value that prevents horizontal overflow.

- `web/test/attachment-badge-reload.test.tsx`
  - Given a message whose persisted content includes an `[Attached: foo.txt]` marker (or the equivalent representation), the rendered output shows an attachment badge component, not inline text.
  - Badge shows the filename; the inline text of the file body is NOT rendered.
  - Non-text attachments (image/PDF) continue to render with their existing treatment.

- `web/test/mobile-layout.test.tsx`
  - At viewport width 375px, the sidebar component renders in its collapsed variant (or has the collapsed class).
  - At viewport width 375px, the composer input renders with its mobile-tightened padding class.
  - At viewport width 1280px, the chat container has the new max-width class.

Keep these focused on class/token assertions and rendered-structure checks — don't try to snapshot-test every markdown element. The visual validation happens in a manual pass.
