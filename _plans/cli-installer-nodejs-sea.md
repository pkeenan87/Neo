# CLI Installer via Node.js SEA

## Context

The Neo CLI is currently run via `node src/index.js`, requiring Node.js and `npm install` on the target machine. This plan packages it as a standalone `neo.exe` using Node.js Single Executable Applications (SEA), wraps it in an Inno Setup installer, and signs both the exe and installer with a DigiCert-timestamped Authenticode certificate. A secondary change updates the default server URL fallback in the CLI to use the `AUTH_URL` environment variable instead of hardcoded `http://localhost:3000`.

---

## Key Design Decisions

- **esbuild for CJS bundling** — Node.js SEA requires a single CommonJS entry point. The CLI uses ES modules, so esbuild will transpile and bundle everything into one CJS file. esbuild is fast, zero-config, and already proven for this use case.
- **Inno Setup instead of WiX** — WiX now requires a paid license. Inno Setup is free, mature, and produces standard Windows installers with PATH modification and uninstaller support.
- **PowerShell signing script** — Uses `Set-AuthenticodeSignature` with the first code-signing cert from `Cert:\CurrentUser\My` and DigiCert timestamp server, matching the user's existing signing workflow.
- **Version from package.json** — The installer reads its version number from `cli/package.json` to keep a single source of truth.
- **AUTH_URL fallback** — The three places that hardcode `http://localhost:3000` as a default server URL will fall back to `process.env.AUTH_URL` first, so deployed installations connect to the right server without extra config.

---

## Files to Change

| File | Change |
|------|--------|
| `cli/package.json` | Add `esbuild` as devDependency; add `build:bundle`, `build:sea`, `build:sign`, `build:installer`, and `release` scripts |
| `cli/sea-config.json` | New file — SEA configuration blob descriptor |
| `cli/build/build-sea.ps1` | New file — PowerShell script that runs the full SEA build pipeline (esbuild → generate blob → inject into node.exe → remove signature) |
| `cli/build/sign.ps1` | New file — PowerShell script that signs a given file path with Authenticode using the machine's code-signing cert |
| `cli/build/installer.iss` | New file — Inno Setup script defining the installer (app name, version, exe path, PATH modification, uninstaller) |
| `cli/build/build-installer.ps1` | New file — PowerShell script that reads version from package.json, compiles the Inno Setup script, and signs the output |
| `cli/src/config.js` | Change default server URL fallback from `"http://localhost:3000"` to `process.env.AUTH_URL \|\| "http://localhost:3000"` |
| `cli/src/config-store.js` | Change `DEFAULTS.serverUrl` from `"http://localhost:3000"` to `process.env.AUTH_URL \|\| "http://localhost:3000"` |
| `cli/src/index.js` | Change the two hardcoded `"http://localhost:3000"` fallbacks in `handleAuthCommand()` to use `process.env.AUTH_URL \|\| "http://localhost:3000"` |
| `cli/.gitignore` | New file (or append) — ignore `dist/`, `build/output/`, and `*.exe` artifacts |

---

## Implementation Steps

### 1. Add esbuild and build scripts to package.json

- Add `esbuild` as a devDependency in `cli/package.json`
- Add the following npm scripts:
  - `build:bundle` — runs esbuild to produce `dist/neo-bundle.cjs` (single CJS file, platform node, bundle all dependencies, minify)
  - `build:sea` — runs `cli/build/build-sea.ps1`
  - `build:sign` — runs `cli/build/sign.ps1` on the built exe
  - `build:installer` — runs `cli/build/build-installer.ps1`
  - `release` — chains `build:bundle`, `build:sea`, `build:sign` (on exe), `build:installer`, `build:sign` (on installer)

### 2. Create the SEA configuration file

- Create `cli/sea-config.json` with:
  - `main` pointing to `dist/neo-bundle.cjs`
  - `output` pointing to `dist/sea-prep.blob`
  - `disableExperimentalSEAWarning` set to true

### 3. Create the SEA build script

- Create `cli/build/build-sea.ps1` that:
  1. Runs `npx esbuild src/index.js --bundle --platform=node --format=cjs --outfile=dist/neo-bundle.cjs` to bundle the ES module source
  2. Runs `node --experimental-sea-config sea-config.json` to generate the SEA blob
  3. Copies the current `node.exe` to `dist/neo.exe`
  4. Removes the existing Node.js signature from the copied exe using `signtool remove /s dist/neo.exe` (so the SEA blob can be injected)
  5. Injects the blob using `npx postject dist/neo.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`

### 4. Create the code signing script

- Create `cli/build/sign.ps1` that accepts a file path parameter
- Retrieves the first code-signing certificate from `Cert:\CurrentUser\My`
- Calls `Set-AuthenticodeSignature` with the file path, certificate, and DigiCert timestamp server (`http://timestamp.digicert.com`)
- Exits with a non-zero code and clear error message if no code-signing cert is found
- Accepts an optional `-SkipSign` flag that skips signing (for local dev builds without a cert)

### 5. Create the Inno Setup installer script

- Create `cli/build/installer.iss` that:
  - Sets the app name to "Neo Security Agent CLI"
  - Reads the version dynamically (the build script will substitute it from package.json)
  - Sets the publisher and URL metadata
  - Installs `dist/neo.exe` to `{pf}\Neo`
  - Modifies the system PATH to include the install directory (using Inno Setup's `ChangesEnvironment=yes` and a `[Registry]` entry or the `modpath.iss` include)
  - Creates an uninstaller entry
  - Sets the output filename to `dist/NeoSetup-{version}.exe`

### 6. Create the installer build script

- Create `cli/build/build-installer.ps1` that:
  1. Reads the version from `cli/package.json` using PowerShell JSON parsing
  2. Calls the Inno Setup compiler (`iscc`) with the version passed as a `/D` define
  3. After compilation, calls `sign.ps1` on the output installer exe

### 7. Update default server URL to use AUTH_URL

- In `cli/src/config.js` line 65: change `"http://localhost:3000"` to `process.env.AUTH_URL || "http://localhost:3000"`
- In `cli/src/config-store.js` line 96: change the `DEFAULTS.serverUrl` value from `"http://localhost:3000"` to `process.env.AUTH_URL || "http://localhost:3000"`
- In `cli/src/index.js` line 206 (inside `handleAuthCommand` login path): change `"http://localhost:3000"` to `process.env.AUTH_URL || "http://localhost:3000"`
- In `cli/src/index.js` line 235 (inside `handleAuthCommand` status path): change `"http://localhost:3000"` to `process.env.AUTH_URL || "http://localhost:3000"`

### 8. Add .gitignore for build artifacts

- Create or update `cli/.gitignore` to ignore:
  - `dist/`
  - `build/output/`
  - `*.exe`
  - `node_modules/`

---

## Verification

1. Run `npm run build:bundle` in `cli/` and confirm `dist/neo-bundle.cjs` is produced and is a valid CJS file
2. On a Windows machine with Node.js installed, run the full `npm run release` pipeline and verify `dist/neo.exe` and `dist/NeoSetup-*.exe` are produced
3. Run `dist/neo.exe --help` (or just launch it) on a machine without Node.js installed to confirm it works standalone
4. Install the MSI on a clean Windows machine, open a new terminal, and verify `neo` is available on PATH
5. Verify both `neo.exe` and the installer exe have valid Authenticode signatures using `Get-AuthenticodeSignature`
6. Set `AUTH_URL=https://example.com` in `.env`, run the CLI without `NEO_SERVER` set, and confirm it connects to `https://example.com` instead of `localhost:3000`
7. Run existing CLI tests to confirm no regressions
