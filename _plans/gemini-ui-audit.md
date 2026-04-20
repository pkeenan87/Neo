# Gemini UI Audit

## Context

Implement the six UI/UX improvements flagged in the Notion "Gemini UI Audit" feature request (High Impact / Web): dual-font typography for readability, expandable raw tool traces, a global toast system, a Chain-of-Thought visual hierarchy, a more prominent Send button when input is ready, and polished empty states. Work is staged in phases so each lands independently — typography and small-scope polish first, then toasts, then the larger tool-trace change, with CoT deferred as forward-looking since no reasoning stream exists today. Must respect `prefers-reduced-motion`, design tokens in `web/tailwind.config.ts`, the 3-class inline rule, and barrel-import patterns from CLAUDE.md.

---

## Key Design Decisions

- **Phased rollout, five commits**: Phase 1 (send button + empty states), Phase 2 (typography), Phase 3 (toasts), Phase 4 (tool traces), Phase 5 (optional CoT). Each phase is independently shippable so regressions are scoped.
- **Typography**: Load Inter (via `next/font/google`) as the sans-serif. Keep JetBrains Mono for code / IPs / hashes / tool names. Split the Tailwind font tokens so `font-display` + `font-body` both map to Inter and `font-mono` stays JetBrains. Update `globals.css` to switch the document body default from mono to sans. Surgical `font-mono` application on code-path elements (IP/hash badges, tool-name spans, KQL blocks, inline `<code>`).
- **Toast system — roll our own, don't add a dependency**: A small `ToastContext` provider + `<Toaster>` portal rendered from `app/layout.tsx`. Four intents (`success` / `error` / `info` / `warning`), auto-dismiss after 4s with a pause-on-hover, Escape dismisses focused toast, aria-live `polite` region. No runtime dep added — this is ~200 LOC and we already have `framer-motion`. Migrate `CopyButton`, `IntegrationDetailPage`, `ApiKeysSection` inline feedback to toasts in Phase 3.
- **Tool traces — extend the stream protocol, do NOT retrofit history**: Add a new `tool_result` stream event from the backend carrying `{ tool, input, output, durationMs }`. Extend `ChatMessage.toolsUsed` from `string[]` to `ToolTrace[]` where each trace has `{ name, input, output, durationMs }`. Render the existing `.toolSummaryList` as `<details>`/`<summary>` accordions; collapsed by default to keep the conversation view calm. Persist in `Conversation` so reload matches live. Old messages with only names continue to render (graceful-degrade: expand shows "raw trace unavailable" note).
- **CoT hierarchy — planned, not built**: The stream has a `thinking` event but it's a pre-response spinner, not an actual reasoning display. Enabling extended thinking in the Anthropic API is a separate product decision with cost and latency implications. Document the UI shape we'd use (a collapsed `<details>` block above the final answer bubble) and gate on a feature flag so we can wire it up later without re-planning.
- **Send button affordance**: Add a second visual state `.sendBtn.ready` that applies when `inputValue.trim() || fileUpload.hasFiles`. Ready state uses an accent glow (box-shadow) + slightly brighter background in both modes. Keeps the 3-class inline rule — all visual state lives in the CSS module.
- **Empty states — polish in place, don't extract yet**: Two call sites (`.emptyState` in `ChatInterface` sidebar and `IntegrationsPage`) — not enough to justify a shared component. Add a muted icon (`MessageSquareDashed` and `SearchX` from `lucide-react`) and center alignment per call site. Revisit extraction if a 3rd empty state appears.

---

## Files to Change

### Phase 1 — Send button + empty states

| File | Change |
|------|--------|
| `web/components/ChatInterface/ChatInterface.tsx` | Compute `ready = inputValue.trim().length > 0 \|\| fileUpload.hasFiles`, apply `.sendBtn.ready` class. Add `MessageSquareDashed` icon to the `.emptyState` node in the sidebar; restructure from single `<div>` to icon + text in a flex column. |
| `web/components/ChatInterface/ChatInterface.module.css` | New `.sendBtn.ready` rule (accent glow via box-shadow + brighter background). Update `.emptyState` to a flex-column layout with icon sizing + muted color. |
| `web/components/IntegrationsPage/IntegrationsPage.tsx` | Wrap empty-state paragraph in a flex column, add `SearchX` icon, keep `role="status" aria-live="polite"` on the text. |
| `web/components/IntegrationsPage/IntegrationsPage.module.css` | Update `.emptyState` to match the new layout. |

### Phase 2 — Typography

| File | Change |
|------|--------|
| `web/app/layout.tsx` | Add `next/font/google` import for Inter with weights 400/500/600/700; expose as `--font-sans` CSS variable. Apply both `--font-sans` and the existing `--font-mono` class on `<html>`. |
| `web/tailwind.config.ts` | Change `fontFamily.display` and `fontFamily.body` to Inter stack: `['var(--font-sans)', 'ui-sans-serif', 'system-ui', ...]`. Keep `fontFamily.mono` as JetBrains. |
| `web/app/globals.css` | Change the body `@apply font-mono` rule to `@apply font-body`. Add a utility note at the top explaining the dual-font token split. |
| `web/components/ChatInterface/ChatInterface.module.css` | Replace hardcoded `font-family: var(--font-mono), monospace` in `.container` with `@apply font-body`. Keep `.toolSummaryItemName` explicitly on `font-mono` (tool names are code-family). |
| `web/components/ChatInterface/ChatInterface.tsx` | No structural change; verify no inline `font-*` Tailwind classes override the new default. |
| `web/components/MarkdownRenderer/MarkdownRenderer.module.css` | Verify `.codeBlock`, `.codeContent`, `.inlineCode` use `@apply font-mono`; update if they currently inherit or use `font-body`. |
| `web/components/CopyButton/CopyButton.module.css` | Already uses `font-body` — no change needed; confirm the token now resolves to Inter. |
| All other CSS modules under `web/components/**/*.module.css` | Audit and confirm: headings and labels should inherit `font-body` implicitly; only code/ID/hash/tool-name elements should use explicit `font-mono`. |

### Phase 3 — Global toast system

| File | Change |
|------|--------|
| `web/context/ToastContext.tsx` (new) | Provider exposing `toast({ intent, title, description?, durationMs? })` via context. Internal state = `Toast[]` queue + `toast.id → timeoutId` map. Auto-dismiss, pause-on-hover, Escape dismisses focused. `'use client'` directive. |
| `web/components/Toaster/Toaster.tsx` (new) | Portal-rendered list of toasts with framer-motion enter/exit animations (gated on `prefers-reduced-motion`). Toast variants styled via design tokens (success → accent, error → error-500, warning → warning-500, info → brand-600). Each toast: icon + title + optional description + dismiss button. `role="status"` for success/info, `role="alert"` for error/warning. |
| `web/components/Toaster/Toaster.module.css` (new) | Per-intent styles, fixed positioning (bottom-right desktop, bottom-center mobile via `@media`), entry/exit transforms, `aria-live` container wiring. |
| `web/components/Toaster/index.ts` (new) | Barrel export. |
| `web/components/index.ts` | Add `Toaster` export. |
| `web/app/layout.tsx` | Wrap `<body>` children in `ToastProvider`; render `<Toaster />` as a sibling. |
| `web/components/CopyButton/CopyButton.tsx` | Replace the sr-only `<span role="status" aria-live="polite">` status with `toast({ intent: 'success', title: 'Copied to clipboard' })` on success and `{ intent: 'error', title: 'Copy failed' }` on failure. Remove the `.srOnly` span. Static aria-label on icon variant remains. |
| `web/components/CopyButton/CopyButton.module.css` | Remove `.srOnly` rule. |
| `web/test/copy-button.test.tsx` | Update the "announces via aria-live" tests to assert the `toast()` mock is called with the expected payload instead of probing the `role="status"` span. Wrap render in a `ToastProvider` so `useToast()` resolves. |
| `web/components/IntegrationDetailPage/IntegrationDetailPage.tsx` | Replace the local `FeedbackState` + inline feedback div with `toast()` calls for save/test success/error. |
| `web/components/SettingsPage/ApiKeysSection.tsx` | Same — replace `FeedbackState` + inline feedback div with `toast()`. |

### Phase 4 — Expandable tool traces

| File | Change |
|------|--------|
| `web/lib/types.ts` | Add `tool_result` event variant to `AgentEvent` union: `{ type: 'tool_result'; tool: string; input: Record<string, unknown>; output: unknown; durationMs: number }`. Add `ToolTrace` type: `{ name: string; input: Record<string, unknown>; output: unknown; durationMs: number }`. |
| `web/lib/agent.ts` | After each tool execution in the agent loop, emit a `tool_result` event with the tool name, the parsed input, the raw output (stringified JSON), and the elapsed duration. Keep the existing `tool_call` event untouched. Persist the trace alongside the message in the session so reload carries it. |
| `web/lib/types.ts` (Conversation / ChatMessage shape) | Extend the persisted assistant-message shape to carry `toolTraces?: ToolTrace[]`. Keep `toolsUsed?: string[]` as a legacy field for forward compat during the migration window; the renderer will prefer `toolTraces` when present and fall back to `toolsUsed`. |
| `web/components/ChatInterface/ChatInterface.tsx` | Extend `ChatMessage` local type with `toolTraces?: ToolTrace[]`. In `processNDJSONStream`, accumulate `toolTraces: ToolTrace[]` alongside `toolsUsed`; on `'tool_result'` event push the full trace; on `'response'` event attach both to the message. In `conversationToChatMessages`, hydrate `toolTraces` from the persisted message if present. |
| `web/components/ChatInterface/ChatInterface.tsx` | Render the tool-summary section: if `toolTraces` present → use `<details>` per trace (collapsed by default) containing a formatted header (tool name + duration) and a body with input and output in `<pre>` tags. If only `toolsUsed` (legacy) → render the existing bullet list unchanged. |
| `web/components/ChatInterface/ChatInterface.module.css` | New rules: `.toolTrace` (details wrapper), `.toolTraceSummary` (summary row with chevron), `.toolTraceBody` (input/output pre blocks), `.toolTraceKey` (sub-labels). Keep within design tokens, use `font-mono` for input/output bodies and tool names. |
| `web/test/chat-tool-traces.test.tsx` (new) | 4-5 tests: renders bullet-list for legacy `toolsUsed`, renders details for `toolTraces`, details are collapsed initially, expanded details show input + output, duration pill renders. |

### Phase 5 — Chain-of-Thought hierarchy (deferred / forward-looking)

| File | Change |
|------|--------|
| `_plans/cot-hierarchy.md` (new) | A companion plan describing: enabling `extended_thinking` in the Anthropic SDK call, streaming `thinking_delta` as a new `reasoning` event, UI change in `ChatInterface.tsx` to render a collapsed `<details>` labeled "Reasoning" above the final answer in the same bubble. NOT implemented in this work. |

---

## Implementation Steps

### 1. Phase 1 — Send button ready state

- In `ChatInterface.tsx`, compute `const sendReady = inputValue.trim().length > 0 || fileUpload.hasFiles` once per render (already inlined in the disabled check today — hoist it into a named const).
- Apply `styles.sendBtn` always; conditionally add `styles.ready` when `sendReady`.
- In `ChatInterface.module.css`, define `.sendBtn.ready` that: increases background saturation (light mode → `brand-950` equivalent, dark mode → `accent-400` brighter), adds a subtle box-shadow using the existing `glow-green` token in dark mode (or a neutral shadow in light), and bumps the icon color to higher contrast white. Gate the visual transition behind `@media (prefers-reduced-motion: no-preference)` for the `transition: all 150ms ease-out` rule.
- Verify: idle state (empty input) looks the same as today; typed state has the visible "go" affordance; disabled still wins visually.

### 2. Phase 1 — Empty-state polish

- In `ChatInterface.tsx`, rewrite the sidebar empty-state node from a single `<div className={styles.emptyState}>No conversations yet</div>` to a flex-column with an `MessageSquareDashed` icon (size 28, `aria-hidden="true"`) above the text.
- In `IntegrationsPage.tsx`, similarly rewrap the existing `<p className={styles.emptyState}>` in a flex-column with a `SearchX` icon. Keep `role="status" aria-live="polite"` on the outer wrapper (not the icon).
- Update each module's `.emptyState` CSS to a flex column, centered, with `gap: 0.5rem`, muted color, padding.
- Verify each empty state in DevTools — a11y tree should show only the text node as live-announced, icon must be `aria-hidden`.

### 3. Phase 1 — Commit & push

- Run `npx tsc --noEmit`, `npx vitest run`, `npm run build` from `web/`.
- Commit: `✨ feat: polish send button ready state + empty-state icons`.
- Push.

### 4. Phase 2 — Typography: load Inter + split tokens

- In `app/layout.tsx`, import `Inter` from `next/font/google` with the same weight set as JetBrains Mono. Pass the Inter CSS variable (`--font-sans`) onto `<html>` alongside the mono one.
- In `tailwind.config.ts`, update `fontFamily.display` and `fontFamily.body` to `['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif']`. Keep `fontFamily.mono` as JetBrains.
- In `app/globals.css`, change the body-level `@apply font-mono` to `@apply font-body`.
- Type check; run dev server briefly to confirm the body defaults to Inter.

### 5. Phase 2 — Surgical mono overrides

- Audit each CSS module referenced in the Files-to-Change table. For each, identify elements that should stay monospace (code blocks, tool names, IPs / hashes / hexadecimal content, timestamps in log context) and explicitly `@apply font-mono` on them.
- `ChatInterface.module.css`: confirm `.toolSummaryItemName` uses `font-mono` (for tool names like `run_sentinel_kql`).
- `MarkdownRenderer.module.css`: confirm `.codeBlock`, `.codeContent`, `.inlineCode` use `font-mono`.
- `IntegrationDetailPage` / `ApiKeysSection`: any fields showing tokens, API keys, secrets → `font-mono`.
- Non-code labels, buttons, descriptions, markdown body → should resolve to `font-body` automatically.

### 6. Phase 2 — Commit & push

- Manual check in both themes at `/chat`, `/settings`, `/integrations` pages. Headings and body readable in Inter; code blocks, tool names, IP addresses still mono.
- `npx tsc --noEmit` + `npx vitest run` + `npm run build`.
- Commit: `✨ feat: dual-font system — Inter for UI, JetBrains Mono for code`.
- Push.

### 7. Phase 3 — Toast context + provider

- Create `context/ToastContext.tsx` with: `Toast` interface, `ToastContextValue` with `toast()` and `dismiss(id)`, internal queue state managed by `useReducer`. Auto-dismiss via `setTimeout`, cleared on unmount or manual dismiss. Keyboard: Escape dismisses the focused toast.
- Export `useToast()` hook that throws if provider is missing.
- Ensure SSR-safety: provider is `'use client'`; `useToast` access in server components will be blocked at build time by the `'use client'` boundary.

### 8. Phase 3 — Toaster UI

- Create `components/Toaster/Toaster.tsx` (`'use client'`). Consumes the toast queue via `useToast`, renders a portal to `document.body` (React 19 has built-in portal support via `createPortal` in `react-dom`). Wraps each toast in a `motion.div` with enter `{ opacity: 0, y: 20 }` → `{ opacity: 1, y: 0 }`, exit `{ opacity: 0, x: 20 }`. Wrap AnimatePresence around the list.
- Icon per intent via `lucide-react`: `CheckCircle` / `XCircle` / `Info` / `AlertTriangle`.
- `role="status"` for info/success, `role="alert"` for error/warning. Container is `aria-live="polite"` with `aria-atomic="false"`.
- CSS Module: fixed positioning (`bottom: 1.5rem; right: 1.5rem`), responsive mobile (`@media (max-width: 767px) { bottom: 1rem; left: 1rem; right: 1rem; }`), per-intent color via design tokens (`success.500`, `error.500`, `warning.500`, `brand.600`), `shadow-card-hover` elevation. Animation gated behind `prefers-reduced-motion: no-preference`.
- Add barrel export; add to `components/index.ts`.

### 9. Phase 3 — Wire provider into layout

- In `app/layout.tsx`, wrap the existing theme provider children with `<ToastProvider>` (nest inside `ThemeProvider` so toasts can read theme). Render `<Toaster />` as a sibling of the children so it portals above everything.

### 10. Phase 3 — Migrate CopyButton to toasts

- In `CopyButton.tsx`, replace the sr-only `<span role="status">` with a call to `toast({ intent: status === 'copied' ? 'success' : 'error', title: status === 'copied' ? 'Copied to clipboard' : 'Copy failed' })`. Call in the `schedule()` callback when transitioning to `copied` / `failed`.
- Remove the sr-only span and the `liveMessage` state logic.
- Delete the `.srOnly` CSS rule.
- Update `copy-button.test.tsx`: wrap `render()` in `<ToastProvider>` (export a test helper). Replace the `getByRole('status')` assertions with `vi.mock`-based assertions on the toast function. Keep the static aria-label assertions.

### 11. Phase 3 — Migrate IntegrationDetailPage + ApiKeysSection

- In `IntegrationDetailPage.tsx`, replace every `setFeedback({ ... })` with `toast({ ... })`. Remove the inline feedback render block at the bottom of the form. Remove the `feedback` state and `FeedbackState` type if no longer used.
- Same pattern in `SettingsPage/ApiKeysSection.tsx`.
- Verify: saving an integration now shows a floating toast; deleting an API key shows a floating confirmation; failed API calls show an error toast.

### 12. Phase 3 — Commit & push

- `npx tsc --noEmit` + `npx vitest run` + `npm run build` from `web/`.
- Commit: `✨ feat: global toast notification system`.
- Push.

### 13. Phase 4 — Backend: emit tool_result events

- In `lib/types.ts`, add the `tool_result` variant to the `AgentEvent` union.
- In `lib/agent.ts`, inside the tool-execution block: capture `startedAt = Date.now()` before the executor call; after, compute `durationMs = Date.now() - startedAt`; emit `{ type: 'tool_result', tool: toolName, input: toolInput, output: toolOutput, durationMs }` through the existing callback pipeline. If the output is a string longer than 50K tokens (already handled by the context manager), use the truncated form for the event payload so the UI doesn't pull more data than the agent itself saw.
- Persist the full trace in the saved conversation: extend the assistant-message write path in `lib/agent.ts` to include `toolTraces: ToolTrace[]` on the final persisted message. `toolsUsed: string[]` is left in place for the migration window.

### 14. Phase 4 — Frontend: consume tool_result events

- In `ChatInterface.tsx` `processNDJSONStream`, add a case for `'tool_result'` that finds the most recent entry in the current `toolsUsed` array matching the tool name and replaces it with a `ToolTrace` entry (or maintains a parallel `toolTraces: ToolTrace[]` accumulator). On `'response'` event, attach `toolTraces` (if any collected) to the assistant message alongside `toolsUsed`.
- In `conversationToChatMessages`, hydrate `toolTraces` from the persisted message payload if present. Fall back to `toolsUsed` when legacy-only.

### 15. Phase 4 — Render expandable traces

- Replace the existing `.toolSummary` render block:
  - If `msg.toolTraces?.length > 0`: render a heading "Tools used" and a list of `<details>` elements. Each `<summary>` shows tool name (in `font-mono`), duration pill (e.g. `142ms`), and a chevron icon. The body contains two `<pre>` blocks: "Input" and "Output", each wrapped in the existing code-block styling.
  - Else if `msg.toolsUsed?.length > 0` (legacy): keep the current bullet-list render.
- Respect `prefers-reduced-motion` on the chevron-rotate transition.
- Keep the 3-class inline rule — all new classes live in `ChatInterface.module.css`.

### 16. Phase 4 — Tests

- New test file `test/chat-tool-traces.test.tsx`:
  1. Renders bullet list when `toolsUsed` is passed without `toolTraces` (legacy fallback).
  2. Renders `<details>` accordions when `toolTraces` is passed.
  3. Accordions are collapsed by default (`<details>` without `open`).
  4. Expanding an accordion (via `click` on `<summary>`) shows input + output text.
  5. Duration pill shows formatted `Nms` or `N.Ns`.

### 17. Phase 4 — Commit & push

- `npx tsc --noEmit` + `npx vitest run` + `npm run build` from `web/`.
- Commit: `✨ feat: expandable tool traces with raw input + output`.
- Push.

### 18. Phase 5 — Document CoT follow-up (no code)

- Write `_plans/cot-hierarchy.md` capturing: (a) Anthropic API change needed (`extended_thinking: { type: 'enabled' }`), (b) stream event shape for thinking deltas, (c) proposed UI (collapsed `<details>` labeled "Reasoning" rendered above the answer text in the same assistant bubble, styled with muted color + italic summary, monospace body), (d) cost implications estimated against typical session. No code. This plan is picked up separately when the product decision is made.

---

## Verification

1. **Phase 1**: Load `/chat` with an empty input. Send button is dimmed / idle. Type a character — button brightens (ready state). Clear input — back to idle. Load `/integrations` with a search query that matches nothing — see centered `SearchX` icon + muted text. Load `/chat` in a new account or after clearing all conversations — sidebar shows `MessageSquareDashed` icon + "No conversations yet".
2. **Phase 2**: Open DevTools Computed tab on `.messagesArea` — `font-family` should resolve to `Inter` first. Open on a code block in a markdown message — should resolve to `JetBrains Mono`. Open on the tool-name span at the bottom of an assistant message — JetBrains Mono. All buttons, labels, headings — Inter.
3. **Phase 3**: Click any `CopyButton` → floating toast appears bottom-right, dismisses after 4s. Hover the toast → dismiss timer pauses. Focus a toast and press Escape → it dismisses. Save an integration with a bad secret → red error toast with `role="alert"`. In System Prefs → Accessibility → Reduce Motion = ON, toast slides in without animation.
4. **Phase 4**: Run a prompt that triggers ≥2 tool calls. Stream completes → assistant message shows a "Tools used" section with 2 collapsed `<details>`. Click a summary → expands to show input JSON + output payload. Refresh the page → the same conversation reloads with the same expandable traces (persistence verified). Open an OLD conversation from before this change → sees the legacy bullet-list (no expansion), no errors in console.
5. **Test commands** (from `web/`, run at end of each phase):
   - `npx tsc --noEmit`
   - `npx vitest run`
   - `npm run build`
6. **a11y sanity per phase**: Keyboard-only nav reaches every new interactive element; `:focus-visible` rings visible; screen-reader output via VoiceOver reads toasts once (not repeated); `<details>`/`<summary>` expands with Enter/Space.
7. **ui-review skill after Phase 2 and Phase 3**: run the `ui-review` skill on the diff to catch typography or toast layout regressions Claude tends to miss on self-review.
