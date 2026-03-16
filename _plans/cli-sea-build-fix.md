# CLI SEA Build Fix

## Context

The CLI SEA binary (`neo.exe`) crashes on startup with `ERR_INVALID_ARG_VALUE` because `createRequire(import.meta.url)` resolves to `undefined` when esbuild bundles ES modules to CJS format. Inside a SEA there is no real file URL for `import.meta.url`. The fix injects the CLI version at build time via esbuild's `--define` flag, eliminating the only use of `createRequire` and `import.meta.url` in the CLI source.

---

## Key Design Decisions

- **Build-time injection via esbuild `--define`** — The version is the only value read from `package.json` at runtime. Injecting it as a compile-time constant avoids all `import.meta.url` / `createRequire` issues and works identically in both dev (`node src/index.js`) and SEA contexts.
- **`globalThis.__CLI_VERSION__` pattern** — Use a global placeholder that esbuild replaces. In dev mode, the placeholder is defined by a small preamble, or the raw `import` still works since dev runs as ES modules.
- **Build script reads version from package.json** — A small Node.js one-liner in the `build:bundle` script reads the version and passes it to esbuild, keeping it DRY.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/src/updater.js` | Remove `createRequire` and `import.meta.url`. Replace `CLI_VERSION` with a declared constant that uses `globalThis.__CLI_VERSION__` with a fallback to a dynamic import for dev mode. |
| `cli/package.json` | Update `build:bundle` script to include `--define:__CLI_VERSION__='"X.Y.Z"'` where the version is read from package.json. |
| `test/cli-update.test.js` | No changes needed — tests import `compareSemver` directly and don't depend on `CLI_VERSION`. |

---

## Implementation Steps

### 1. Update `cli/src/updater.js`

- Remove the `import { createRequire } from "module"` import.
- Remove `const require = createRequire(import.meta.url)` and `const { version: CLI_VERSION } = require("../package.json")`.
- Replace with a declaration that reads from a global constant: `const CLI_VERSION = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0-dev"`.
- The `__CLI_VERSION__` global is replaced at build time by esbuild's `--define`. In dev mode (running `node src/index.js` directly), the global won't exist, so the fallback `"0.0.0-dev"` is used — but this is fine because dev mode doesn't use the update checker in practice. Alternatively, for dev parity, use a dynamic import fallback.

### 2. Update `cli/package.json` build script

- Change the `build:bundle` script from a simple esbuild call to a small Node.js invocation that reads the version and passes it to esbuild.
- The new command: `node -e "const v=require('./package.json').version; const {execSync}=require('child_process'); execSync('npx esbuild src/index.js --bundle --platform=node --format=cjs --outfile=dist/neo-bundle.cjs --minify --define:__CLI_VERSION__=\\'\"'+v+'\"\\''  , {stdio:'inherit'})"`.
- Alternatively, create a small `build/bundle.js` script that reads the version and spawns esbuild, keeping `package.json` clean.

### 3. Verify no other `import.meta.url` uses exist

- Search the entire `cli/src/` directory for `import.meta`, `createRequire`, `__dirname`, `__filename`, and `fileURLToPath`. Confirm the updater.js change was the only occurrence.

### 4. Run tests

- Run `node --test test/cli-update.test.js` to confirm `compareSemver` and other updater exports still work.
- Run all tests: `node --test test/` to confirm nothing is broken.

---

## Verification

1. **Dev mode**: Run `cd cli && npm start` — the CLI should start normally. The update check may show `0.0.0-dev` as the current version, which is acceptable for dev.
2. **Build**: Run `cd cli && npm run build:bundle` — should succeed without errors or warnings about `import.meta`.
3. **Bundle inspection**: Grep the output `dist/neo-bundle.cjs` for the version string — it should appear as a literal, not as a `createRequire` call.
4. **SEA build (Windows)**: Run `npm run release` on a Windows machine — should produce a working `neo.exe`.
5. **Smoke test**: Run `neo auth status`, `neo update`, and `neo` on the installed binary — all should work without `ERR_INVALID_ARG_VALUE`.
6. **Tests**: Run `node --test test/cli-update.test.js` — all pass.
