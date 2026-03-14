# Settings Page

## Context

Add a `/settings` route with two tabs (General and Usage) accessible via the gear icon in the chat sidebar. The General tab shows Profile (avatar, name, editable display name) and Appearance (Light/Auto/Dark color mode cards). The Usage tab shows token budget progress bars backed by the existing `/api/usage` endpoint. The ThemeContext must be extended to support an "Auto" (system preference) mode alongside Light and Dark. Display name is stored in localStorage only for v1.

---

## Key Design Decisions

- **Client component with URL-based tab selection**: Use `searchParams` (`?tab=general` / `?tab=usage`) for tab state so tabs are deep-linkable. Default to `general`.
- **Extend ThemeContext with "auto" mode**: Change the `Theme` type from `'light' | 'dark'` to `'light' | 'dark' | 'auto'`. When set to `auto`, resolve the actual class from `window.matchMedia('(prefers-color-scheme: dark)')` and listen for changes. Store `'auto'` in localStorage; derive the applied class at runtime.
- **Settings layout is a standalone page, not nested under `/chat`**: Settings gets its own `app/settings/page.tsx` with its own auth gate using the same `getAuthContext()` pattern. No shared layout with `/chat` since the sidebar and header are completely different.
- **Component-per-section pattern**: Each settings section (ProfileSection, AppearanceSection, UsageSection) is its own component in a `SettingsPage` component folder to keep the page file manageable.
- **Display name stored via a custom hook**: Create a `useDisplayName` hook that reads/writes `localStorage` key `neo-display-name` and provides the value with a setter. The Profile section uses this hook.
- **Usage tab fetches client-side**: The Usage tab calls `GET /api/usage` on mount and on refresh click. No SSR for usage data — it's user-specific and changes frequently.
- **Estimated cost shown on Usage tab**: The `/api/usage` response already returns `projectedMonthlyCostUsd`. Display it under the progress bars as "Estimated monthly cost: $X.XX".

---

## Files to Change

| File | Change |
|------|--------|
| `web/context/ThemeContext.tsx` | Extend `Theme` type to include `'auto'`. Add `setTheme(theme: Theme)` to context value. Resolve auto mode via `matchMedia` listener. |
| `web/components/ChatInterface/ChatInterface.tsx` | Wrap the gear icon (line 643) in a `<Link href="/settings">` so it navigates to the settings page. |
| `web/components/ChatInterface/ChatInterface.module.css` | Add a `.settingsLink` class for the gear icon link with hover state. |
| `web/app/settings/page.tsx` | **New file.** Server component that auth-gates with `getAuthContext()` and renders `SettingsPageClient`. |
| `web/components/SettingsPage/SettingsPage.tsx` | **New file.** Client component with two-column layout: sidebar nav (General, Usage tabs) and content area. Manages active tab from URL searchParams. |
| `web/components/SettingsPage/SettingsPage.module.css` | **New file.** Styles for the settings layout, sidebar nav, tab items, content area, and responsive breakpoints. |
| `web/components/SettingsPage/ProfileSection.tsx` | **New file.** Profile section: avatar, full name (read-only), display name (editable, localStorage). |
| `web/components/SettingsPage/AppearanceSection.tsx` | **New file.** Three color mode cards (Light/Auto/Dark) with visual thumbnails and selected state. |
| `web/components/SettingsPage/UsageSection.tsx` | **New file.** Fetches `/api/usage`, renders progress bars for 2-hour and weekly windows, shows estimated cost, refresh button, last-updated timestamp. |
| `web/components/SettingsPage/ProgressBar.tsx` | **New file.** Reusable progress bar with label, subtitle, percentage, and color thresholds (blue/amber/red). |
| `web/components/SettingsPage/index.ts` | **New file.** Barrel export for SettingsPage. |
| `web/components/index.ts` | Add `SettingsPage` to barrel exports. |
| `web/app/layout.tsx` | Update the inline theme script to handle the `'auto'` value from localStorage by checking `matchMedia` when the stored value is `'auto'`. |
| `web/test/settings-page.test.tsx` | **New file.** Tests for rendering, tab switching, theme selection, usage data display, and progress bar calculations. |

---

## Implementation Steps

### 1. Extend ThemeContext to support "auto" mode

In `web/context/ThemeContext.tsx`:
- Change the `Theme` type to `'light' | 'dark' | 'auto'`.
- Add a `setTheme` function to the context value alongside `toggleTheme` (keep `toggleTheme` for backward compat with the header icon).
- `setTheme` accepts a `Theme` value, stores it in localStorage, and applies the resolved class:
  - If `'light'` — remove `dark` class.
  - If `'dark'` — add `dark` class.
  - If `'auto'` — check `window.matchMedia('(prefers-color-scheme: dark)')` and apply accordingly.
- When theme is `'auto'`, add a `matchMedia` change listener in `useEffect` that updates the DOM class when the system preference changes. Clean up the listener on unmount or when theme changes away from `'auto'`.
- Update `isTheme` guard to accept `'auto'`.
- Export the new `Theme` type for use by the Appearance section.

In `web/app/layout.tsx`:
- Update the inline theme script (lines 23-31) to handle `'auto'`: if the stored value is `'auto'`, resolve via `matchMedia`. If stored value is missing, also resolve via `matchMedia` (current behavior, no change needed).

### 2. Create the SettingsPage component folder

Create `web/components/SettingsPage/` with the following files:

**SettingsPage.tsx** (client component):
- Accept props: `userName`, `userRole`, `userImage` (same props as ChatInterface).
- Render a two-column layout: left sidebar nav + right content area.
- Sidebar nav contains: a back link (arrow icon + "Back to chat" or just the Neo logo linking to `/chat`), a "Settings" heading, and two nav items ("General" and "Usage") with active state.
- Active tab determined by a `tab` state, defaulting to `'general'`. Use `useSearchParams` from `next/navigation` to read `?tab=` from the URL, and `useRouter` to update it on click.
- Conditionally render the content area: when tab is `'general'`, render `ProfileSection` and `AppearanceSection`. When tab is `'usage'`, render `UsageSection`.
- On mobile (below `md` breakpoint), the sidebar nav should render as horizontal tabs at the top instead of a side column.

**SettingsPage.module.css**:
- `.container`: Full viewport height, two-column grid (`240px 1fr`), background `bg-surface-default`.
- `.sidebar`: Left column with padding, border-right, flex column.
- `.backLink`: Flex row with arrow icon, styled as subtle link.
- `.heading`: "Settings" title, `text-2xl font-bold`.
- `.navList`: Flex column, gap `4px`.
- `.navItem`: Padding `8px 16px`, rounded corners, cursor pointer, `transition-colors duration-150`.
- `.navItemActive`: Background highlight (brand-100 light / accent surface dark), font-weight bold.
- `.content`: Right column with padding `32px`, max-width for readability.
- `.section`: Margin-bottom `32px`, with divider between sections.
- `.sectionTitle`: `text-xl font-bold`, margin-bottom `16px`.
- Responsive: At `max-width: 768px`, switch to single-column layout with horizontal tab row at top.
- Dark mode via `:global(html.dark)` — use existing dark surface/border tokens.

### 3. Create the ProfileSection component

**ProfileSection.tsx**:
- Accept props: `userName`, `userImage`.
- Render a "Profile" heading.
- Row layout: `UserAvatar` (size 48) on the left, "Full name" read-only input showing `userName` on the right.
- Below that: "What should Neo call you?" label with an editable text input. This input reads/writes from `localStorage` key `neo-display-name`. Use a local state initialized from localStorage on mount.
- On change, debounce the localStorage write (or write on blur).
- No save button needed — changes auto-persist.

### 4. Create the AppearanceSection component

**AppearanceSection.tsx**:
- Import `useTheme` and `Theme` type from ThemeContext.
- Render an "Appearance" heading, then a "Color mode" subheading.
- Three cards in a horizontal row (flex, gap 16px):
  - **Light card**: A small styled div mimicking a light UI (white background, dark header bar, placeholder lines). Label "Light" below.
  - **Dark card**: Same but with dark background, green accent header bar. Label "Dark" below.
  - **Auto card**: Split or gradient representation. Label "Auto" below.
- Each card is a clickable button. The currently active theme has a selected state: brand-colored border (2px), slight shadow, or a checkmark overlay.
- On click, call `setTheme('light' | 'auto' | 'dark')` from the theme context.
- Cards should be ~120px wide, ~80px tall, with rounded corners and a subtle border.

### 5. Create the UsageSection component

**UsageSection.tsx** (client component):
- On mount, fetch `GET /api/usage` using `fetch` with credentials.
- Store response data in state. Track loading, error, and last-updated timestamp.
- Render "Plan usage limits" heading.
- **2-hour session bar**: Use `ProgressBar` with:
  - Label: "Current session"
  - Subtitle: "Resets in X hr Y min" — calculate time remaining from the 2-hour window (the window started `windowMs` ago relative to the oldest record, or approximate as "Resets in ~2 hr" since exact start isn't in the response).
  - Value: `twoHourUsage.totalInputTokens`
  - Max: `twoHourLimit`
- Divider.
- **Weekly limits** heading.
- **Weekly bar**: Use `ProgressBar` with:
  - Label: "All models"
  - Subtitle: "Resets in X days" — approximate based on weekly window.
  - Value: `weeklyUsage.totalInputTokens`
  - Max: `weeklyLimit`
- Below the bars: "Estimated monthly cost: $X.XX" using `projectedMonthlyCostUsd` from the response.
- "Last updated: less than a minute ago" line with a refresh button (RefreshCw icon from lucide-react). On click, re-fetch the API.
- Error state: If fetch fails, show "Could not load usage data" with a retry button.
- Loading state: Show skeleton/placeholder bars while loading.

### 6. Create the ProgressBar component

**ProgressBar.tsx**:
- Accept props: `label: string`, `subtitle: string`, `value: number`, `max: number`, `className?: string`.
- Calculate percentage: `Math.min(100, Math.round((value / max) * 100))`. Handle `max === 0` gracefully (show 0%).
- Render: left column with label + subtitle, middle with the bar, right with "X% used".
- Bar: outer container with `bg-brand-200` (light) / dark equivalent, inner fill div with width set to percentage.
- Color thresholds: below 80% use `bg-blue-500`, 80-94% use `bg-warning-500` (amber), 95%+ use `bg-error-500` (red).
- Bar height: 8px, rounded corners.
- Transition on width changes (`transition-all duration-300`).

### 7. Create the settings page route

**web/app/settings/page.tsx** (server component):
- Import `getAuthContext` from `@/lib/get-auth-context`.
- Import `redirect` from `next/navigation`.
- Call `getAuthContext()`. If null, `redirect('/')`.
- Render `SettingsPageClient` passing `userName`, `userRole`, `userImage` from auth context.
- Add metadata export: `title: 'Settings | Neo'`.

### 8. Wire up the gear icon in ChatInterface

In `web/components/ChatInterface/ChatInterface.tsx`:
- Import `Link` from `next/link`.
- Wrap the `<Settings>` icon (line 643) in `<Link href="/settings">`. Remove `aria-hidden="true"` and add proper `aria-label="Settings"`.
- Add a `.settingsLink` class in `ChatInterface.module.css` with hover state (opacity or color change).

### 9. Update barrel exports

In `web/components/index.ts`:
- Add `export { SettingsPage } from './SettingsPage'`.

In `web/components/SettingsPage/index.ts`:
- Export the main `SettingsPage` component (default used by the page route).

### 10. Write tests

Create `web/test/settings-page.test.tsx`:
- Mock `useTheme` and the fetch API.
- Test that the General tab renders by default with "Profile" and "Appearance" headings.
- Test that clicking the "Usage" tab switches content to show "Plan usage limits".
- Test that clicking a color mode card calls `setTheme` with the correct value.
- Test that usage data from a mocked `/api/usage` response renders correct percentages in progress bars.
- Test the `ProgressBar` percentage calculation: `55000 / 55000 = 100%`, `0 / 55000 = 0%`, `27500 / 55000 = 50%`.
- Test that the progress bar color changes at the 80% and 95% thresholds.

---

## Verification

1. Run `cd web && npx vitest run` — all tests pass including new settings page tests.
2. Run `cd web && npx tsc --noEmit` — no TypeScript errors.
3. Manual check: Start dev server, log in, click gear icon in sidebar — navigates to `/settings`.
4. Manual check: General tab shows profile with avatar and name, appearance cards. Clicking Dark/Light/Auto changes theme immediately.
5. Manual check: Usage tab shows progress bars with data from the API (or 0% in mock mode).
6. Manual check: Selecting "Auto" in appearance and changing system preference (via OS settings or browser DevTools) updates the theme live.
7. Manual check: Resize browser to mobile width — sidebar nav becomes horizontal tabs.
8. Manual check: Navigate directly to `/settings` without visiting `/chat` first — page loads and auth gate works.
