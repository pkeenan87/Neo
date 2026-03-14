# Spec for CLI Update

branch: claude/feature/cli-update

## Summary

Add an automatic update-check mechanism to the Neo CLI and a `neo update` command. After authenticating, the CLI queries the web server for the latest available version. If a newer version exists, it notifies the user and prompts them to run `neo update`, which downloads and installs the latest release.

## Functional requirements

- The CLI stores its current version (e.g. in `package.json` or a dedicated constant).
- After successful authentication, the CLI calls a new server endpoint to check if a newer version is available.
- If an update is available, the CLI displays a notice with the current and latest version numbers and suggests running `neo update`.
- The `neo update` command downloads the latest installer/bundle from the server and replaces the current CLI binary or triggers the platform-appropriate update flow.
- The update check should be non-blocking — a failed check (network error, server down) must not prevent normal CLI usage.
- The server endpoint returns the latest version string and a download URL for the CLI artifact.

## Possible Edge Cases

- User is offline or server is unreachable during update check — fail silently and continue normal operation.
- User runs `neo update` when already on the latest version — display a "you're up to date" message.
- Download is interrupted mid-update — ensure the existing binary is not corrupted (download to temp file, then swap).
- Version comparison edge cases (pre-release tags, non-semver strings) — use strict semver comparison.
- Permissions issues when replacing the binary on disk — surface a clear error message with remediation steps (e.g. "run with elevated privileges").
- Windows vs macOS update flow differences — the Windows path uses the SEA/Inno Setup installer; macOS may need a different approach.

## Acceptance Criteria

- A new API route on the web server (e.g. `GET /api/cli/version`) returns `{ version, downloadUrl }`.
- The CLI checks for updates automatically after authentication completes.
- When an update is available, the CLI prints a visible notification with current and latest versions.
- Running `neo update` downloads and installs the latest CLI version.
- Running `neo update` when already current prints a friendly "up to date" message.
- A failed update check does not block or crash the CLI.
- The update flow works on both Windows (SEA binary) and macOS.

## Open Questions

- Where should CLI release artifacts be hosted — GitHub Releases, Azure Blob Storage, or served directly from the Next.js server? Read my code, we are already doing this in Azure Blob.
- Should update checks be rate-limited (e.g. once per session, once per hour) to avoid unnecessary network calls? no.
- Should `neo update` support a `--force` flag to re-download even when on the latest version? no.
- How should the version be bumped — manually in `package.json`, or via a CI/CD release pipeline? Manually in package.json for now.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Server endpoint returns a newer version — CLI displays update notice.
- Server endpoint returns the same version — CLI does not display a notice.
- Server endpoint is unreachable — CLI continues without error.
- `neo update` with a newer version available — downloads and reports success.
- `neo update` when already up to date — prints "up to date" message.
- Version comparison logic handles semver correctly (e.g. `1.2.3` < `1.3.0`).
