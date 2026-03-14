# Spec for CLI Installer Downloads Page

branch: claude/feature/cli-installer-downloads

## Summary

Add a download button to the sidebar user profile area (next to the user name, matching the claude.ai pattern shown in the reference screenshot) that navigates to a new `/downloads` route. The downloads page detects the user's operating system and prominently offers the correct installer, while also listing all available platforms. The page includes install instructions and a quick-start guide. Only Windows is available today, but the architecture must support adding macOS and Linux installers without restructuring.

## Functional Requirements

### Download Button in Sidebar
- Add an icon button (download arrow icon) to the `.userRow` area in the sidebar footer, positioned between the user info and the existing settings icon
- The button should match the visual style shown in the reference screenshot (compact icon button, consistent with the existing settings gear icon)
- Clicking the button navigates to `/downloads` using Next.js `Link`
- The button should have a tooltip or aria-label: "Download CLI"

### Downloads Route (`/downloads`)
- New route at `web/app/downloads/page.tsx`
- Accessible without authentication (public page) so users can share the link
- Includes a "Back to Chat" or home link for navigation

### OS Detection
- Detect the user's operating system via the browser `navigator.userAgent` on the client side
- Highlight the matching platform's download card as the recommended/primary option
- Supported platform definitions (data-driven, not hardcoded per-platform UI):
  - **Windows** — `.exe` installer (available now)
  - **macOS** — `.dmg` or `.pkg` installer (coming soon)
  - **Linux** — `.deb` / `.tar.gz` installer (coming soon)
- Platforms without an available download show a "Coming Soon" badge and a disabled download button

### Platform Download Cards
- Each platform is rendered from a shared config/array of platform objects containing: OS name, icon, file URL (or null if unavailable), file size, version string, and status (available / coming-soon)
- The detected OS card appears first or is visually promoted (e.g. "Recommended for your system" label)
- Available platforms show a prominent download button with file size
- The download URL and version info should be easy to update (single config object or environment variable for the download base URL)

### Install Instructions Section
- Below the download cards, show collapsible or tabbed install instructions per platform
- Windows instructions should cover:
  1. Download the installer
  2. Run the `.exe` and follow the setup wizard
  3. Verify installation by opening a terminal and running `neo --version`
- macOS and Linux sections show placeholder text: "Instructions will be available when this platform is supported"

### Quick-Start Guide Section
- After install instructions, include a quick-start section covering:
  1. Setting the `NEO_SERVER_URL` environment variable (or noting the default)
  2. Running `neo` to start the CLI
  3. A brief description of first-run authentication flow
  4. One example command or interaction to orient new users

## Possible Edge Cases
- User's OS cannot be detected (e.g. unusual user agent) — default to showing all platforms equally with no "recommended" badge
- Download URL is not yet configured — show a helpful message rather than a broken link
- User accesses `/downloads` on a mobile device — show a message that the CLI is for desktop operating systems, but still display the download cards for reference
- Very long version strings or file sizes — ensure the card layout handles variable-length text gracefully

## Acceptance Criteria
- Download icon button appears in the sidebar user row, visually consistent with existing icon buttons
- Clicking the button navigates to `/downloads`
- The downloads page correctly detects Windows, macOS, and Linux via user agent
- The detected OS platform card is visually promoted as "Recommended"
- Windows shows an active download button; macOS and Linux show "Coming Soon"
- Install instructions are present and accurate for Windows
- Quick-start guide is present with correct `NEO_SERVER_URL` and basic usage info
- The platform config is a single data structure that can be extended by adding an entry (no new components needed per platform)
- Page renders well on desktop viewports (responsive/mobile is not a priority but should not break)
- All components follow the project's styling conventions (3-class inline rule, CSS modules, design tokens, no `any` types)

## Open Questions
- Should the download files be served from the Neo web server itself (e.g. `/api/downloads/neo-setup.exe`) or from an external hosting service (Azure Blob Storage, GitHub Releases, etc.)? served from web server
- What is the initial download URL for the Windows installer? use the suggestion above.
- Should the page show a version number and/or release date for each installer? Yes
- Should we track download analytics (e.g. count downloads per platform)? Yes, we can add it to the logging.

## Testing Guidelines
Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:
- OS detection utility correctly identifies Windows, macOS, and Linux from sample user agent strings
- OS detection returns a sensible default ("unknown") for unrecognized user agents
- Platform config structure: all required fields are present for each platform entry
- Download button renders in the sidebar and links to `/downloads`
