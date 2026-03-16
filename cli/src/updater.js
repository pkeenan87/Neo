// ─────────────────────────────────────────────────────────────
//  Updater — version check + self-update
// ─────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import { createWriteStream } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import chalk from "chalk";
import { fetchLatestVersion } from "./server-client.js";

/* global __CLI_VERSION__ */
// __CLI_VERSION__ is injected at build time by esbuild --define.
// In dev mode (node src/index.js), it won't exist — fall back to "0.0.0-dev"
// which intentionally fails SEMVER_RE so update checks no-op silently.
const CLI_VERSION = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0-dev";

const SEMVER_RE = /^\d{1,6}\.\d{1,6}(\.\d{1,6})?$/;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const DOWNLOAD_PATH_RE = /^\/[a-zA-Z0-9][a-zA-Z0-9/_\-.]*\.exe$/;

/**
 * Compare two semver strings (major.minor.patch only).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Throws on invalid input.
 */
export function compareSemver(a, b) {
  if (!SEMVER_RE.test(a) || !SEMVER_RE.test(b)) {
    throw new Error(`Invalid semver: "${a}" vs "${b}"`);
  }

  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check for a newer CLI version and print a notice if one exists.
 * Fails silently — never throws.
 */
export async function checkForUpdate(serverUrl, getAuthHeader, log = console.log) {
  const latest = await fetchLatestVersion(serverUrl, getAuthHeader);
  if (!latest || !latest.version || !SEMVER_RE.test(latest.version)) return;

  if (compareSemver(CLI_VERSION, latest.version) < 0) {
    log(chalk.yellow(`\n    [UPDATE] v${CLI_VERSION} -> v${latest.version}`));
    log(chalk.yellow(`    Run ${chalk.bold("neo update")} to install the latest version.\n`));
  }
}

/**
 * Download and install the latest CLI version.
 */
export async function runUpdate(serverUrl, getAuthHeader, log = console.log) {
  log(chalk.gray(`\n  Current version: v${CLI_VERSION}`));
  log(chalk.gray("  Checking for updates...\n"));

  const latest = await fetchLatestVersion(serverUrl, getAuthHeader);
  if (!latest) {
    log(chalk.red("  [ERROR] Could not reach the update server. Check your connection and try again."));
    return;
  }

  if (!latest.version || !SEMVER_RE.test(latest.version)) {
    log(chalk.red("  [ERROR] Server returned an invalid version string."));
    return;
  }

  if (compareSemver(CLI_VERSION, latest.version) >= 0) {
    log(chalk.green(`  [OK] You're up to date (v${CLI_VERSION}).`));
    return;
  }

  if (process.platform !== "win32") {
    log(chalk.yellow(`  [UPDATE] v${latest.version} is available, but auto-update is only supported on Windows.`));
    log(chalk.yellow(`  Download the latest version from: ${serverUrl}/downloads\n`));
    return;
  }

  // Validate downloadUrl is a safe relative path on the expected origin
  if (!latest.downloadUrl || !DOWNLOAD_PATH_RE.test(latest.downloadUrl) || latest.downloadUrl.includes("..")) {
    log(chalk.red("  [ERROR] Server returned an invalid download path."));
    return;
  }

  const parsedDownload = new URL(latest.downloadUrl, serverUrl);
  const parsedServer = new URL(serverUrl);
  if (parsedDownload.origin !== parsedServer.origin) {
    log(chalk.red("  [ERROR] Download URL origin does not match the configured server."));
    return;
  }

  const downloadUrl = parsedDownload.href;
  log(chalk.gray(`  Downloading v${latest.version}...`));

  let tempDir = null;
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Download failed (HTTP ${res.status})`);
    }

    // Validate Content-Type
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/octet-stream") &&
        !contentType.includes("application/x-msdownload")) {
      throw new Error(`Unexpected content type: ${contentType}`);
    }

    if (!res.body) {
      throw new Error("Download response had no body.");
    }

    tempDir = await mkdtemp(join(tmpdir(), "neo-update-"));
    const installerPath = join(tempDir, "neo-setup.exe");
    const fileStream = createWriteStream(installerPath);

    // Size-limiting transform to prevent disk exhaustion
    let bytesReceived = 0;
    const sizeGuard = new Transform({
      transform(chunk, _enc, cb) {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_DOWNLOAD_BYTES) {
          cb(new Error("Download exceeded maximum allowed size (200 MB)."));
        } else {
          cb(null, chunk);
        }
      },
    });

    await pipeline(res.body, sizeGuard, fileStream);

    // Verify SHA-256 integrity if the server provided a hash
    if (latest.sha256) {
      const fileBuffer = await readFile(installerPath);
      const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
      if (actualHash !== latest.sha256) {
        throw new Error("Installer integrity check failed — file hash mismatch.");
      }
    }

    log(chalk.green("  [OK] Download complete. Launching installer...\n"));

    const child = execFile(installerPath, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    process.stdout.write(
      chalk.gray("  The installer is running. This terminal will now close.\n"),
      () => process.exit(0)
    );
  } catch (err) {
    // Clean up temp directory on failure
    if (tempDir) {
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    const msg = err instanceof Error ? err.message : String(err);
    log(chalk.red(`  [ERROR] Update failed: ${msg}`));
    if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("access")) {
      log(chalk.yellow("  [NOTE] Try running with elevated privileges (Run as Administrator)."));
    }
  }
}
