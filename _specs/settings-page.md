# Spec for Settings Page

branch: claude/feature/settings-page

## Summary

Add a `/settings` route accessible to authenticated users via the gear icon in the `/chat` sidebar footer. The settings page has a sidebar navigation with two tabs: **General** and **Usage**. The General tab contains a Profile section (avatar, full name, display name) and an Appearance section (Light / Auto / Dark color mode selector with visual thumbnails). The Usage tab displays token usage limits as progress bars with rolling window breakdowns (2-hour session and weekly), similar to Claude's plan usage limits UI.

## Functional requirements

### Layout & Navigation
- Settings page uses a two-column layout: left sidebar nav + right content area
- Sidebar nav lists "General" and "Usage" as clickable items with active state highlighting
- Page title "Settings" displayed at the top
- Back navigation to `/chat` (e.g., a back arrow or the Neo logo)
- The gear icon in the `/chat` sidebar footer (currently decorative in `ChatInterface.tsx` line 643) becomes a `<Link>` to `/settings`
- Page is auth-gated — unauthenticated users are redirected to login

### General Tab — Profile Section
- User avatar (initials circle, matching existing `UserAvatar` component style)
- "Full name" field displaying the user's name from their Entra ID / auth session (read-only)
- "What should Neo call you?" field — editable display name (optional, stored client-side in localStorage)
- Profile fields are informational for v1 — no server-side profile editing

### General Tab — Appearance Section
- "Color mode" heading with three selectable cards: Light, Auto, Dark
- Each card shows a small thumbnail preview of the UI in that mode (styled divs, not screenshots)
- Cards have a selected state (border highlight or checkmark)
- Selection persists via the existing `ThemeContext` (`localStorage` key `neo-theme`)
- Replace the existing header toggle (moon/sun icon in `ChatInterface.tsx`) with this as the canonical place to change theme — keep the header toggle as a convenience shortcut

### Usage Tab — Plan Usage Limits
- "Plan usage limits" heading
- **2-hour session** progress bar: label "Current session", subtitle "Resets in X hr Y min", progress bar showing percentage used, "X% used" label on the right
- Divider line
- **Weekly limits** heading
- **All models** progress bar: label "All models", subtitle "Resets [day] [time]", progress bar, "X% used"
- "Last updated: less than a minute ago" timestamp with a refresh icon/button that re-fetches usage data
- Data sourced from `GET /api/usage` endpoint (already implemented)
- Progress bar color: brand blue for normal usage, shift to warning/amber at 80%+, red at 95%+
- All values derived from the `twoHourUsage`, `weeklyUsage`, `twoHourLimit`, `weeklyLimit` fields from the API response

## Possible Edge Cases
- User has no usage data yet (new account) — show 0% with empty progress bars
- API usage endpoint returns an error — show a "Could not load usage data" message with retry button
- Display name field is empty — fall back to full name from auth session
- Theme preference not set — default to "Auto" (system preference)
- User navigates directly to `/settings` without being on `/chat` first — should still work
- Mobile / narrow viewport — sidebar nav may need to collapse to horizontal tabs or a dropdown

## Acceptance Criteria
- Gear icon in `/chat` sidebar navigates to `/settings`
- Settings page renders with General and Usage tabs
- General tab shows Profile (avatar, name fields) and Appearance (Light/Auto/Dark cards)
- Selecting a color mode card updates the theme immediately and persists across page reloads
- Usage tab shows 2-hour and weekly progress bars with data from `/api/usage`
- Progress bars update percentage labels and fill correctly
- Refresh button on Usage tab re-fetches data from the API
- Page is only accessible when authenticated
- Responsive layout works on mobile viewports

## Open Questions
- Should the display name ("What should Neo call you?") be persisted server-side (Cosmos DB) or is localStorage sufficient for v1? local storage
- Should there be a "Notifications" section in General (similar to the Claude screenshot) or is that out of scope? out of scope
- Should the Usage tab show estimated cost in USD alongside token counts? Yes

## Testing Guidelines
Create test file(s) in the ./test folder for the new feature, and create meaningful tests for the following cases, without going too heavy:
- Verify settings page renders General tab by default with Profile and Appearance sections
- Verify clicking Usage tab switches content to show usage progress bars
- Verify color mode selection updates ThemeContext
- Verify usage data is fetched from /api/usage and displayed correctly
- Verify progress bar percentage calculation is accurate (e.g., 55000 used / 55000 limit = 100%)
