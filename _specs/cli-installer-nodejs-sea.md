# Spec for CLI Installer via Node.js SEA

branch: claude/feature/cli-installer-nodejs-sea

## Summary

Package the Neo CLI as a standalone Windows executable using Node.js Single Executable Applications (SEA), then wrap it in a signed MSI installer. This eliminates the need for users to install Node.js or run `npm install` — they just install the MSI and get a `neo` command on their PATH.

## Functional requirements

- Use the Node.js SEA (Single Executable Application) workflow to produce a standalone `neo.exe` that bundles the CLI source and all dependencies into a single binary
- Create a build script that:
  1. Bundles the ES module source into a single CommonJS file (SEA requires a single entry point)
  2. Generates the SEA blob from the bundle
  3. Injects the blob into a copy of the Node.js binary
  4. Removes the experimental SEA warning signature if applicable
- Create an MSI installer using WiX Toolset (or similar) that:
  - Installs `neo.exe` to `Program Files`
  - Adds the install directory to the system PATH
  - Registers an uninstaller
  - Includes version metadata and branding
- Sign the MSI (and optionally the exe) using the project's existing code signing script
- Add npm scripts to `cli/package.json` for the full build pipeline (e.g. `npm run build:sea`, `npm run build:msi`, `npm run build:sign`)
- The build should be runnable from a Windows machine or CI environment
- Change the default URL for the app to be the value of the AUTH_URL in .env instead of localhost

## Possible Edge Cases

- ES module compatibility: Node.js SEA currently requires a CommonJS entry point — the CLI uses `"type": "module"`, so a bundler (esbuild) is needed to transpile to CJS before SEA injection
- Native modules: If any dependency uses native addons, SEA cannot bundle them — current deps (chalk, marked, marked-terminal, open) are pure JS, so this should not be an issue today but should be validated
- Node.js version pinning: The SEA binary embeds a specific Node.js version — the build process should document which version is used and ensure compatibility
- The `open` package launches a browser — verify this still works from a SEA binary (it shells out to `start`, so it should be fine on Windows)
- `.env` file loading: The standalone binary will need to locate `.env` relative to the exe or from a known config directory, not `process.cwd()`
- Code signing certificate availability: The build will fail if the signing certificate is not available — the build script should provide a clear error message and allow unsigned builds for local development

## Acceptance Criteria

- Running the build script on Windows produces a working `neo.exe` that does not require Node.js to be installed
- `neo.exe` behaves identically to `node src/index.js` for all CLI functionality
- An MSI installer is generated that installs `neo.exe` and adds it to PATH
- The MSI is signed with the project's code signing certificate
- The full pipeline can be triggered from a single npm script (e.g. `npm run release`)
- Build instructions are documented in the CLI README or a dedicated BUILD.md

## Open Questions

- Which bundler to use for the CJS conversion — esbuild is fast and zero-config, but is there a preference? esbuild.
- What WiX version / MSI tooling is preferred? WiX v4+ or an alternative like `electron-wix-msi`? Lets use Inno Setup, Wix wants money now.
- Where does the code signing script live and what are its arguments? (Need to integrate it into the build pipeline) it would be on the build machine. I sign my scripts like this # Paste your code here
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object -First 1

$ScriptPath = "<path_to_script>"

Set-AuthenticodeSignature `
    -FilePath $ScriptPath `
    -Certificate $cert `
    -TimestampServer "http://timestamp.digicert.com"

- Should the exe also be signed, or only the MSI? both
- What version numbering scheme should the installer use — pull from package.json? yes package.json
- Should the build produce an MSI only, or also a standalone zip with just the exe? MSI
- Is there a CI environment (GitHub Actions, Azure DevOps) where this should run automatically? not yet.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Verify the esbuild bundle step produces a valid single-file CJS output
- Verify the SEA configuration JSON is generated correctly
- Verify the build script exits with a clear error if Node.js or required tools are missing
- Smoke test: the built `neo.exe` starts and responds to `--help` or `--version`
- Verify the MSI includes the correct files and PATH registration (can be validated by inspecting the WiX XML output)
