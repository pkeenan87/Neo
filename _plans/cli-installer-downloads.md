# CLI Installer Downloads Page

## Context

This plan implements a downloads page for the Neo CLI installer, accessible via a new `/downloads` route in the web app. A download icon button will be added to the sidebar user row (next to the user name, matching the claude.ai pattern). The downloads page detects the visitor's OS, highlights the matching platform, and includes install instructions plus a quick-start guide. Only Windows is available today, but the platform config is data-driven to support macOS and Linux without restructuring. Installer files are hosted in Azure Blob Storage, authenticated via the App Service's managed identity (matching the Cosmos DB pattern), so the CLI can be updated independently of web app deployments. Download events are logged via the existing logger.

---

## Key Design Decisions

- **Azure Blob Storage for installer hosting**: Installer files live in a dedicated Blob Storage container (`cli-releases`). This decouples CLI releases from web deployments — upload a new `.exe` to the container without redeploying the app.
- **Managed identity authentication**: Uses `DefaultAzureCredential` from `@azure/identity` (already a project dependency) to authenticate with Blob Storage — matching the same pattern used for Cosmos DB. In Azure, this resolves to the App Service's system-assigned managed identity. Locally, it falls back to Azure CLI login (`az login`). No client secrets or connection strings needed for storage access.
- **Proxy API route instead of direct blob URLs**: Downloads go through `/api/downloads/[filename]` which fetches from Blob Storage and streams to the client. This keeps the storage account URL private, allows download logging, and lets us add access control later without changing client URLs.
- **Data-driven platform config**: A single `PLATFORMS` array in a shared config file defines all platforms (name, icon, blob filename, version, file size, status). Adding a new platform means adding one entry — no new components needed.
- **Client-side OS detection**: The downloads page is a `'use client'` component that reads `navigator.userAgent` to detect the user's OS. A utility function (`detectOS`) is extracted into `web/lib/detect-os.ts` for testability.
- **Public route (no auth)**: The `/downloads` route lives outside the `/chat` layout and requires no authentication, so the download link can be shared freely.
- **Download analytics via existing logger**: The API download route logs each download event (platform, filename, user-agent) using the existing `logger.ts` module.
- **Icon consistency**: Uses the `Download` icon from `lucide-react` (already a project dependency) for the sidebar button.

---

## Files to Change

| File | Change |
|------|--------|
| `web/lib/detect-os.ts` | New file — `detectOS(ua: string)` utility returning `'windows' \| 'macos' \| 'linux' \| 'unknown'` |
| `web/lib/download-config.ts` | New file — `PLATFORMS` array and `PlatformInfo` type defining all downloadable platforms with blob filenames |
| `web/app/downloads/page.tsx` | New file — Downloads page component with OS detection, platform cards, install instructions, and quick-start guide |
| `web/app/downloads/Downloads.module.css` | New file — CSS module for the downloads page (platform cards, sections, badges) |
| `web/app/api/downloads/[filename]/route.ts` | New file — API route that proxies download from Azure Blob Storage via managed identity and logs the download event |
| `web/lib/types.ts` | Add `CLI_STORAGE_ACCOUNT` and `CLI_STORAGE_CONTAINER` to `EnvConfig` interface |
| `web/lib/config.ts` | Add `CLI_STORAGE_ACCOUNT` and `CLI_STORAGE_CONTAINER` to the `env` object |
| `.env.example` | Add `CLI_STORAGE_ACCOUNT` and `CLI_STORAGE_CONTAINER` entries |
| `web/components/ChatInterface/ChatInterface.tsx` | Add a `Download` icon button (as a Next.js `Link` to `/downloads`) in the sidebar `.userRow`, between user info and the Settings icon |
| `web/components/ChatInterface/ChatInterface.module.css` | Add `.downloadButton` style for the new icon button in the user row |
| `docs/user-guide.md` | Add "Downloading the CLI" section under Getting Started; add `/downloads` to the API Endpoints table |
| `docs/configuration.md` | Add CLI Downloads Storage section documenting `CLI_STORAGE_ACCOUNT` and `CLI_STORAGE_CONTAINER` env vars; add Blob Storage provisioning step to Azure Deployment section |
| `test/detect-os.test.js` | New file — Unit tests for `detectOS` utility |
| `test/download-config.test.js` | New file — Validates platform config structure |

---

## Implementation Steps

### 1. Add Azure Blob Storage env vars

- Add `CLI_STORAGE_ACCOUNT` and `CLI_STORAGE_CONTAINER` to the `EnvConfig` interface in `web/lib/types.ts`
- Add both to the `env` object in `web/lib/config.ts`, reading from `process.env.CLI_STORAGE_ACCOUNT` and `process.env.CLI_STORAGE_CONTAINER` (defaulting container to `'cli-releases'`)
- Add both entries to `.env.example` with comments explaining their purpose

### 2. Create the OS detection utility

- Create `web/lib/detect-os.ts` exporting a pure function `detectOS(userAgent: string): DetectedOS`
- Type `DetectedOS` as `'windows' | 'macos' | 'linux' | 'unknown'`
- Check the user-agent string for platform indicators: `Win` → windows, `Mac` → macos, `Linux` (excluding Android) → linux, fallback → unknown
- Export the type and function

### 3. Create the platform config

- Create `web/lib/download-config.ts` exporting a `PlatformInfo` interface with fields: `id` (string), `name` (string), `iconName` (string — lucide icon name), `fileExtension` (string), `blobFilename` (string — the filename in the Blob Storage container, e.g. `neo-setup.exe`), `downloadPath` (string — the client-facing API route path, e.g. `/api/downloads/neo-setup.exe`), `version` (string), `releaseDate` (string), `fileSize` (string or null), `status` ('available' | 'coming-soon')
- Export a `PLATFORMS` constant array with three entries: Windows (status: available, blobFilename: `neo-setup.exe`), macOS (status: coming-soon), Linux (status: coming-soon)
- Include version and releaseDate fields populated with current values for Windows, placeholder values for others

### 4. Create the download API route (Azure Blob Storage proxy with managed identity)

- Add `@azure/storage-blob` to `web/package.json` dependencies
- Create `web/app/api/downloads/[filename]/route.ts` with a GET handler
- Validate the `filename` param against an allowlist derived from `PLATFORMS` config (only serve files whose `blobFilename` matches a known available platform entry) to prevent arbitrary blob access
- Use `DefaultAzureCredential` from `@azure/identity` to authenticate — this uses the App Service managed identity in Azure and Azure CLI credentials locally, matching the Cosmos DB pattern already used in the project
- Create a `BlobServiceClient` from `@azure/storage-blob` using the storage account URL (`https://<CLI_STORAGE_ACCOUNT>.blob.core.windows.net`) and the `DefaultAzureCredential`
- Get a `BlobClient` for the container and filename, then call `download()` to stream the blob
- If the blob does not exist (catches `BlobNotFound` error), return a 404 JSON response
- Stream the blob content to the client with headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<filename>"`, and `Content-Length` from the blob properties
- Log the download event using the existing logger: component `"downloads"`, level `"info"`, metadata including filename, detected platform from user-agent, and the request user-agent string

### 5. Create the downloads page

- Create `web/app/downloads/page.tsx` as a `'use client'` component
- Import `detectOS` from `@/lib/detect-os`, `PLATFORMS` from `@/lib/download-config`, and `Link` from `next/link`
- On mount, call `detectOS(navigator.userAgent)` and store the result in state
- Render a page with these sections:
  - **Header**: Page title ("Download Neo CLI"), subtitle, and a "Back to Chat" link using Next.js `Link`
  - **Platform Cards**: Map over `PLATFORMS`, sorting detected OS to first position. Each card shows: platform icon (lucide), platform name, version, release date, file size, and either a download button (linking to the API proxy route) or a "Coming Soon" badge. The detected OS card gets a "Recommended for your system" label.
  - **Mobile notice**: If OS is unknown or user-agent suggests mobile, show a note that the CLI is for desktop operating systems
  - **Install Instructions**: A section with per-platform expandable/collapsible content. Windows shows the three-step install process from the spec. macOS and Linux show placeholder text.
  - **Quick-Start Guide**: A section with numbered steps covering: setting `NEO_SERVER_URL`, running `neo`, authentication flow description, and an example interaction
- Create `web/app/downloads/Downloads.module.css` with styles for the page layout, platform cards (including recommended highlight, coming-soon state, download button), section headings, collapsible instruction panels, and quick-start steps. Follow the 3-class inline rule and use project design tokens.

### 6. Add download button to the sidebar

- In `web/components/ChatInterface/ChatInterface.tsx`, import the `Download` icon from `lucide-react` and `Link` from `next/link`
- In the `.userRow` div (around line 638, between the `.userInfo` div and the `Settings` icon), add a `Link` element wrapping a `Download` icon, with `href="/downloads"`, `aria-label="Download CLI"`, and the `.downloadButton` CSS class
- In `web/components/ChatInterface/ChatInterface.module.css`, add a `.downloadButton` class styled to match the existing Settings icon treatment (same size, opacity, hover behavior, cursor pointer)

### 7. Update documentation

#### `docs/user-guide.md`

- In the **Table of Contents**, add a "Downloading the CLI" entry under Getting Started (between Prerequisites and First-Time Setup)
- Add a new **Downloading the CLI** subsection under Getting Started, before First-Time Setup (CLI). Content:
  - Explain that the CLI installer is available from the downloads page at `/downloads` on the Neo web server
  - Note that the page auto-detects the user's OS and recommends the correct installer
  - List the currently available platform (Windows) and note that macOS and Linux are coming soon
  - Mention that install instructions and a quick-start guide are included on the page
- In the **First-Time Setup (CLI)** section's "Option A — Windows Installer" step 1, update the text to direct users to the `/downloads` page instead of just saying "Download and run" — e.g. "Visit your Neo server's downloads page (`https://<your-server>/downloads`) and download the Windows installer, or run `NeoSetup-<version>.exe` if provided directly."
- In the **API Endpoints** table at the bottom, add a row for `GET /downloads` (public, no auth — CLI installer downloads page) and `GET /api/downloads/[filename]` (public, no auth — streams installer file from Azure Blob Storage)

#### `docs/configuration.md`

- In the **Table of Contents**, add a "CLI Downloads Storage" entry under Web Server Configuration
- Add a new **CLI Downloads Storage** subsection under Web Server Configuration (after Mock Mode). Content:
  - Explain the purpose: hosting CLI installer files in Azure Blob Storage for independent updates
  - Document the two env vars: `CLI_STORAGE_ACCOUNT` (required for downloads — the storage account name) and `CLI_STORAGE_CONTAINER` (optional, defaults to `cli-releases`)
  - Note that authentication uses `DefaultAzureCredential` (managed identity in Azure, `az login` locally) — same pattern as Cosmos DB
  - Note the required RBAC role: **Storage Blob Data Reader** on the container or account
- In the **Environment Variables** table, add rows for `CLI_STORAGE_ACCOUNT` (No, "Azure Storage account name for CLI installers") and `CLI_STORAGE_CONTAINER` (No, "Blob container name, default: `cli-releases`")
- In the **Azure Deployment** section, add a new step **"Provision Blob Storage for CLI Downloads (Optional)"** between the existing Event Hub and Log Analytics steps. Content:
  - Explain creating a storage account and container (can be done via portal or CLI commands)
  - Provide `az` CLI commands to: create a storage account, create a `cli-releases` container, assign **Storage Blob Data Reader** role to the App Service managed identity
  - Note to upload installer files to the container after building them
- In **Step 5 (Set Secret Environment Variables)**, add the `CLI_STORAGE_ACCOUNT` app setting (note: this is not a secret, but grouped here for convenience with other provisioned-resource settings)
- In the **Building the Windows Installer** section, add a note at the end about uploading the built installer to Blob Storage after building: provide an `az storage blob upload` command example targeting the `cli-releases` container

### 8. Write tests

- Create `test/detect-os.test.js` using `node:test` and `node:assert/strict` (matching existing test style):
  - Test that a Windows user-agent string returns `'windows'`
  - Test that a macOS user-agent string returns `'macos'`
  - Test that a Linux user-agent string returns `'linux'`
  - Test that an Android user-agent string does not return `'linux'`
  - Test that an empty or unrecognized string returns `'unknown'`
- Create `test/download-config.test.js`:
  - Import `PLATFORMS` and verify each entry has all required fields (`id`, `name`, `status`, `version`, `blobFilename`)
  - Verify at least one platform has `status: 'available'`
  - Verify platform IDs are unique

---

## Verification

1. Run `cd web && npm install && npm run build` to confirm the new dependency, route, and components compile without errors
2. Run `node --test test/detect-os.test.js test/download-config.test.js` to verify utility tests pass
3. Start the dev server (`cd web && npm run dev`) and confirm:
   - The download icon button appears in the sidebar next to the user name
   - Clicking it navigates to `/downloads`
   - The correct OS is detected and its card is highlighted as "Recommended"
   - Windows shows an active download button; macOS and Linux show "Coming Soon"
   - Install instructions and quick-start guide sections render correctly
   - With valid Azure credentials and a blob in the container, `/api/downloads/neo-setup.exe` streams the file successfully
   - Without the blob present, the route returns a clean 404
4. Review `docs/user-guide.md` and `docs/configuration.md` for accuracy and broken links
