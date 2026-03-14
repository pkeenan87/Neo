# CLI Auto-Update

## Context

The Neo CLI currently has no way to check for or install updates. Users must manually download new versions from the web portal. This plan adds a `GET /api/cli/version` server endpoint that returns the latest version info, an automatic update check after CLI authentication, and a `neo update` command that downloads and installs the latest release from Azure Blob Storage. The version source of truth is `package.json` on the CLI side and `download-config.ts` on the server side.

---

## Key Design Decisions

- **Version source of truth (server):** The `PLATFORMS` array in `web/lib/download-config.ts` already stores the version string per platform. The new API route will read from this rather than introducing a separate version store.
- **Version source of truth (CLI):** Read from `cli/package.json` at runtime using an `import` or `createRequire`. This is already how the build system reads the version.
- **Update mechanism (Windows):** Download the installer (`neo-setup.exe`) to a temp directory, then launch it and exit the CLI. The Inno Setup installer handles replacing the binary in Program Files.
- **Update mechanism (macOS/Linux):** Not yet available (platforms are "coming-soon" in `download-config.ts`). The update command should detect the platform and print a "not yet supported" message for non-Windows systems.
- **No rate limiting on update checks:** Per the spec, every session checks once after auth. This is acceptable given the lightweight JSON endpoint.
- **Non-blocking check:** The update check fires as an async call that resolves before the REPL starts. If it fails (network error, timeout), it logs nothing and continues.
- **New CLI module `updater.js`:** Keeps update logic isolated from the main entry point and server-client module.

---

## Files to Change

| File | Change |
|------|--------|
| `web/app/api/cli/version/route.ts` | **New file.** GET endpoint returning `{ version, downloadUrl }` for the caller's platform. |
| `web/lib/download-config.ts` | No changes needed — already has version and download info per platform. |
| `cli/src/updater.js` | **New file.** Contains `checkForUpdate(serverUrl, getAuthHeader)` and `runUpdate(serverUrl, getAuthHeader)` functions. |
| `cli/src/index.js` | Add `update` subcommand handler (like `auth`). Call `checkForUpdate()` after `resolveServerConfig()` succeeds, before the REPL starts. |
| `cli/src/server-client.js` | Add `fetchLatestVersion(serverUrl, getAuthHeader)` that calls `GET /api/cli/version` and returns the JSON response. |
| `test/cli-update.test.js` | **New file.** Unit tests for version comparison, update check display logic, and `neo update` command behavior. |

---

## Implementation Steps

### 1. Create the server version endpoint

- Create directory `web/app/api/cli/version/` with a `route.ts` file.
- Export an async `GET` handler.
- Read the `User-Agent` header from the request and use the existing `detectOS()` function from `web/lib/detect-os` to determine the caller's platform.
- Look up the matching platform entry from the `PLATFORMS` array in `download-config.ts`.
- If the platform is found and its status is `"available"`, return a JSON response: `{ version: platform.version, downloadUrl: platform.downloadPath }`.
- If the platform is not found or is `"coming-soon"`, still return the Windows version as a fallback (since the CLI is currently Windows-only), with a `platform` field indicating which platform was detected.
- No authentication required on this endpoint — version info is not sensitive.

### 2. Add `fetchLatestVersion` to the server client

- In `cli/src/server-client.js`, add and export an async function `fetchLatestVersion(serverUrl, getAuthHeader)`.
- It should `GET ${serverUrl}/api/cli/version` with the auth header.
- On success, parse and return the JSON body (`{ version, downloadUrl }`).
- On any error (network failure, non-200 status), return `null` rather than throwing — this keeps the check non-blocking.

### 3. Create the CLI updater module

- Create `cli/src/updater.js` as an ES module.
- Import `chalk` for colored output, `fs` and `os` and `path` from Node built-ins, and `fetchLatestVersion` from `server-client.js`.
- Read the CLI's current version by importing `cli/package.json` using `createRequire` (since JSON imports need special handling in ESM) or by reading and parsing the file.
- Implement a `compareSemver(current, latest)` helper that splits on `.`, parses each segment as an integer, and returns `-1`, `0`, or `1`. Ignore pre-release tags — treat only the `major.minor.patch` portion.
- Implement `checkForUpdate(serverUrl, getAuthHeader)`:
  - Call `fetchLatestVersion()`. If it returns `null`, return silently.
  - Compare the returned version against the current CLI version using `compareSemver`.
  - If a newer version is available, print a colored notice: current version, latest version, and a prompt to run `neo update`.
  - If versions are equal or current is newer, do nothing.
- Implement `runUpdate(serverUrl, getAuthHeader)`:
  - Call `fetchLatestVersion()`. If it returns `null`, print an error that the server is unreachable and return.
  - Compare versions. If already up to date, print a green "You're up to date" message with the current version and return.
  - Check `process.platform`. If not `"win32"`, print a message that auto-update is only supported on Windows currently and suggest downloading manually from the server URL, then return.
  - For Windows: construct the full download URL by joining `serverUrl` with the `downloadUrl` path from the version response.
  - Download the installer to a temp file using Node's `fs.mkdtemp` in `os.tmpdir()` and `fetch()` with stream piping to `fs.createWriteStream`. Show a progress indicator (simple dots or a percentage if Content-Length is available).
  - After download completes, launch the installer using `child_process.execFile` (detached, unref'd) so it runs independently.
  - Print a message that the installer has been launched and exit the CLI process with code 0.
  - Wrap the entire download/launch sequence in a try-catch. On failure, print a clear error message. If it's a permissions error, suggest running with elevated privileges.

### 4. Wire up the `update` subcommand in `cli/src/index.js`

- In the `main()` function, after the existing `auth` subcommand check (line 272), add a similar check: if `process.argv[2] === "update"`, call the update handler and return.
- The update handler should:
  - Call `resolveServerConfig()` to get `serverUrl` and `getAuthHeader` (authentication is needed to reach the server).
  - Call `runUpdate(serverUrl, getAuthHeader)` from the updater module.
  - Exit after completion.

### 5. Wire up the automatic update check after auth

- In the `main()` function, after the `printBanner()` and server connection message (around line 281), call `checkForUpdate(serverUrl, getAuthHeader)` with `await`.
- Wrap it in a try-catch that silently swallows any error, so a failed check never blocks the REPL.
- The check should complete before the REPL prompt appears, so the update notice is visible to the user before they start typing.

### 6. Write tests

- Create `test/cli-update.test.js` using Node's built-in test runner (`node:test`) to stay consistent with the project's zero-test-framework approach.
- Test `compareSemver`: verify `1.0.0` vs `1.0.1` returns `-1`, `1.0.0` vs `1.0.0` returns `0`, `2.0.0` vs `1.9.9` returns `1`, and `1.2.3` vs `1.3.0` returns `-1`.
- Test `checkForUpdate` with a mock `fetchLatestVersion` that returns a newer version — verify it outputs the update notice (capture stdout or verify return value).
- Test `checkForUpdate` with same version — verify no output.
- Test `checkForUpdate` when `fetchLatestVersion` returns `null` (server unreachable) — verify no output and no thrown error.
- Test `runUpdate` when already up to date — verify "up to date" message.
- To enable testability, `checkForUpdate` and `runUpdate` should accept an optional `log` callback (defaulting to `console.log`) so tests can capture output without monkey-patching.

---

## Verification

1. **Version endpoint:** Run `cd web && npm run dev`, then `curl http://localhost:3000/api/cli/version` — should return `{ "version": "1.0.0", "downloadUrl": "/api/downloads/neo-setup.exe" }`.
2. **Update check on startup:** Run `cd cli && npm start` — after authentication, the banner area should show "up to date" silence (same version) or an update notice (if server has a newer version in `download-config.ts`).
3. **`neo update` when current:** Run `node src/index.js update` — should print "You're up to date (v1.0.0)".
4. **`neo update` when behind:** Temporarily bump the version in `download-config.ts` to `2.0.0`, run `node src/index.js update` — should attempt to download the installer (will fail in dev if no blob storage configured, which is expected).
5. **Tests:** Run `node --test test/cli-update.test.js` — all tests should pass.
6. **Failure resilience:** Stop the web server, run `cd cli && npm start` — the CLI should start normally with no error output from the update check.
