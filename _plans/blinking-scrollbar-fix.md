# Blinking Scrollbar Fix

## Context

Fix the flickering vertical scrollbar that appears on the right edge of the chat area while Neo is in its "thinking" state, then stabilizes just before the assistant response renders. The root cause is that `.messagesArea` in `web/components/ChatInterface/ChatInterface.module.css` uses `overflow-y: auto` without `scrollbar-gutter: stable`, so when the thinking indicator is added and later removed via `AnimatePresence` the content height oscillates across the overflow threshold and the browser toggles the scrollbar in and out. The fix is a targeted CSS change plus a small audit of the adjacent animation so we don't trade one flicker for another.

---

## Key Design Decisions

- **Reserve scrollbar space via `scrollbar-gutter: stable`** on `.messagesArea` rather than forcing `overflow-y: scroll`. `stable` keeps a constant-width gutter whether the scrollbar is drawn or not, which eliminates the reflow that causes the blink — without leaving a permanently visible track when the content is short.
- **Scope the fix to `.messagesArea` only**. The other scroll containers in the file (`.sidebarBody`, `.slashPopover`, `.textarea`) have stable content sizes and don't exhibit this bug. Bolting `scrollbar-gutter: stable` onto all four would create unnecessary right-gutter padding in the sidebar where it would be visually obvious.
- **Don't touch the thinking indicator animation itself**. The `AnimatePresence` mount/unmount behavior and the 0.15s exit duration are intentional. The scrollbar fix works at the container level; changing the indicator animation would be a bigger change for no additional benefit.
- **Keep the `custom-scrollbar` class intact**. The webkit-scrollbar-only styles in `globals.css` coexist with `scrollbar-gutter` cleanly — the gutter reservation is a layout concern, the thumb/track colors are a paint concern.
- **Accept the ~4px gutter on mobile**. Touch devices use overlay scrollbars that normally don't affect layout, but `scrollbar-gutter: stable` still reserves width. The cost is ~4px of unused space on the right edge of mobile — trivial given the existing bubble padding, and it keeps layout behavior consistent across viewports.
- **Run the `ui-review` skill on every change** before committing, per the user's explicit request. The skill invokes Gemini CLI as a second-opinion reviewer for frontend edits and catches a11y / responsive / semantic issues that self-review tends to miss.

---

## Files to Change

| File | Change |
|------|--------|
| `web/components/ChatInterface/ChatInterface.module.css` | Add `scrollbar-gutter: stable` to the `.messagesArea` selector so the scrollbar track space is reserved whether the bar is drawn or not. |
| `web/test/chat-message-rendering.test.tsx` | New test case asserting that the messages area element carries the `.messagesArea` class and — where practical via jsdom — that the computed `scrollbar-gutter` style is `stable`. (jsdom doesn't fully compute styles, so the assertion may fall back to class-name presence.) |

No TypeScript, JSX, or animation changes. No changes to `ChatInterface.tsx`, `globals.css`, or any layout files.

---

## Implementation Steps

### 1. Add `scrollbar-gutter: stable` to `.messagesArea`

- Open `web/components/ChatInterface/ChatInterface.module.css` and locate the `.messagesArea` selector (around line 369–375).
- Alongside the existing `overflow-y: auto` / `overflow-x: hidden` declarations, add `scrollbar-gutter: stable`.
- Add a short inline comment explaining why the gutter is reserved (so a future refactor doesn't strip it assuming it's cosmetic) — point at this plan by slug and reference the flickering-thinking-indicator symptom.

### 2. Verify no regressions in sibling scroll containers

- Confirm the change is scoped — do a visual diff-style read of `ChatInterface.module.css` to ensure only `.messagesArea` was modified, not `.sidebarBody`, `.slashPopover`, or `.textarea`.
- Nothing to change here; this step is a sanity check.

### 3. Add a regression-guard test

- In `web/test/chat-message-rendering.test.tsx`, add a new `describe` block: `"messages area — scrollbar gutter"`.
- Approach: render a minimal harness that mounts the messages container (either via `ChatInterface` with heavy mocking — expensive — OR by importing the CSS module and asserting the `.messagesArea` rule set contains `scrollbar-gutter`). The latter is the lighter option.
- Given CSS-module class names are hashed at build time, a simpler regression guard is a pure string assertion: read `ChatInterface.module.css` as a text file in the test via `node:fs`, assert it contains both `.messagesArea` and `scrollbar-gutter: stable`. This catches the fix being accidentally reverted without needing a full component mount.
- Add one test case.

### 4. Manual browser verification

- Start the dev server: `cd web && npm run dev`.
- Open the chat at desktop width. Submit a prompt that triggers a long-ish thinking phase (e.g., "investigate user X"). Watch the right edge of the messages area for the entire "thinking → response" transition.
- Confirm the scrollbar track does not appear and disappear. It should either stay hidden (short content) or stay visible (long content), but not toggle.
- Repeat with a conversation that already has enough messages to require scroll — confirm the scrollbar stays visible throughout the thinking phase instead of briefly hiding.
- Repeat in dark mode.
- Repeat at a narrow viewport (<768px) to confirm the mobile layout still looks correct with the reserved gutter.

### 5. Run the `ui-review` skill

- Per the user's request, run the `ui-review` skill on the change before committing. The skill invokes Gemini CLI to do a second-opinion pass on the UI edit.
- The skill expects frontend changes staged or unstaged in the working tree. Stage the modified CSS file but do NOT commit yet.
- Invoke the skill and capture its output. Address any findings it raises (typically: a11y, responsive, semantic issues). If Gemini flags an issue that materially conflicts with this plan, surface it to the user before proceeding; otherwise apply the adjustments and re-run the skill.

### 6. Run typecheck + tests

- `cd web && npx tsc --noEmit` — must be clean.
- `cd web && npx vitest run` — all existing tests + the new regression-guard test must pass.

### 7. Commit

- Commit message format matches the project convention (`🐛 fix: ...` or similar). Include the Notion issue name and a one-line explanation of the root cause and fix.
- Do not commit the Gemini CLI review output — it's transient.

---

## Verification

1. `web/components/ChatInterface/ChatInterface.module.css` diff shows exactly one modification: `scrollbar-gutter: stable` added to `.messagesArea`. No other selectors touched.
2. `cd web && npx tsc --noEmit` — clean.
3. `cd web && npx vitest run` — all tests pass, including the new regression-guard test.
4. `ui-review` skill run complete, findings addressed or explicitly waived.
5. Manual: dev server at desktop width, submit a prompt, confirm the right-edge scrollbar does NOT flicker during the thinking-to-response transition. Repeat in dark mode and at <768px.
6. No visible layout shift in the sidebar, composer, or slash-popover regions (confirming the change is correctly scoped).
