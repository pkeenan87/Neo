# Spec for CLI SEA Build Fix

branch: claude/feature/cli-sea-build-fix

## Summary

Fix the CLI Single Executable Application (SEA) build so the installed `neo.exe` runs without crashing. The current build fails at startup with `ERR_INVALID_ARG_VALUE` because `createRequire(import.meta.url)` in `cli/src/updater.js` resolves to `undefined` after esbuild bundles ES modules into CJS format. The fix eliminates all uses of `import.meta.url` and `createRequire` in the CLI source so the bundled CJS output works correctly inside a SEA.

## Functional requirements

- The CLI SEA binary (`neo.exe`) starts and runs identically to `node src/index.js` for all commands: `auth`, `update`, and the REPL.
- The `updater.js` module reads the CLI version without using `createRequire(import.meta.url)`. Instead, the version should be injected at build time via esbuild's `--define` flag, or read from a hardcoded constant that the build script updates before bundling.
- Any other uses of `import.meta.url`, `__dirname`, or `__filename` that would break in a CJS/SEA context are identified and replaced with SEA-compatible alternatives.
- The esbuild bundle command is updated if needed to handle the fix (e.g., adding `--define:CLI_VERSION='"1.0.0"'` sourced from `package.json`).
- The build pipeline (`npm run release`) produces a working `neo.exe` that passes basic smoke tests: `neo auth status`, `neo update`, and entering the REPL.

## Possible Edge Cases

- The version string contains characters that need escaping in esbuild `--define` (unlikely with semver but should be handled).
- Future code additions re-introduce `import.meta.url` usage — the build should fail explicitly if this happens (esbuild will naturally error on `import.meta` in CJS format).
- The `sea-config.json` `main` field points to the bundled output — ensure it stays in sync if the output filename changes.

## Acceptance Criteria

- `npm run build:bundle` succeeds without warnings about `import.meta`.
- `npm run release` produces a working `neo.exe`.
- Running `neo auth status` on a Windows machine prints status info without errors.
- Running `neo update` checks for updates without crashing.
- Running `neo` enters the REPL and connects to the server.
- The version displayed by the CLI matches `package.json`.

## Open Questions

- Should the version be injected at build time via esbuild `--define`, or should `updater.js` read it from a generated constants file? build.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- The CLI version constant is a valid semver string.
- The `compareSemver` function still works with the injected version.
- The esbuild bundle command includes the version define flag.
