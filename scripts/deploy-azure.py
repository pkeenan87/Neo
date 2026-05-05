#!/usr/bin/env python3
"""
Builds and deploys the Neo web application to Azure App Service.

This is the Python equivalent of deploy-azure.ps1 with three speedups
baked in:

1. Lower zip compression (level 1 vs the .NET default of level 6).
   Produces a zip 2-3x faster with ~10% larger output; net win on
   upload because the file is smaller than uncompressed and the
   local CPU is freed sooner.
2. Parallel copies of the small staging dirs (public, static,
   skills) via a thread pool. The standalone server tree is the
   only large dir and is copied serially.
3. `npm ci --prefer-offline --no-audit --no-fund` — skips the
   registry roundtrip when the lockfile cache is warm and avoids
   audit + funding work that doesn't affect the deploy.

USAGE
    python3 scripts/deploy-azure.py
    python3 scripts/deploy-azure.py --web-app-name neo-prod --skip-build
    python3 scripts/deploy-azure.py --no-wait     # don't poll for Kudu confirmation

PREREQUISITES
    * Python 3.8+
    * Azure CLI (`az`) signed in — `az login`
    * npm (Node 20+ recommended to match CI)
    * provision-azure.ps1 must have already created the resource
      group, web app, and supporting resources.

NOT IMPLEMENTED (call out for future)
    * WEBSITE_RUN_FROM_PACKAGE=1 — would skip the unzip step on
      App Service entirely (biggest single deploy speedup), but
      makes wwwroot read-only at runtime. Wait until all skill
      storage is on Cosmos.
    * Slot-swap zero-downtime deploys.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

# ── Output helpers ────────────────────────────────────────────


class C:
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    GRAY = "\033[90m"
    RESET = "\033[0m"


def info(msg: str) -> None:
    print(f"  {C.CYAN}{msg}{C.RESET}")


def detail(msg: str) -> None:
    print(f"  {C.GRAY}{msg}{C.RESET}")


def ok(msg: str) -> None:
    print(f"  {C.GREEN}{msg}{C.RESET}")


def warn(msg: str) -> None:
    print(f"  {C.YELLOW}{msg}{C.RESET}")


def fail(msg: str, suggestion: Optional[str] = None) -> None:
    print(f"\n  {C.RED}ERROR: {msg}{C.RESET}", file=sys.stderr)
    if suggestion:
        print(f"  {C.RED}{suggestion}{C.RESET}\n", file=sys.stderr)
    sys.exit(1)


def run(
    cmd: list[str],
    *,
    cwd: Optional[Path] = None,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=capture,
        text=capture,
        check=check,
    )


# ── Stages ────────────────────────────────────────────────────


def check_prerequisites(args: argparse.Namespace, web_dir: Path) -> dict:
    info("Checking prerequisites...")

    if not shutil.which("az"):
        fail(
            "Azure CLI (az) is not installed.",
            "Install it from: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli",
        )

    try:
        result = run(["az", "account", "show", "--output", "json"], capture=True)
        account = json.loads(result.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        fail("Not logged in to Azure CLI.", "Run: az login")

    detail(f"Subscription: {account['name']} ({account['id']})")

    try:
        run(
            [
                "az", "webapp", "show",
                "--name", args.web_app_name,
                "--resource-group", args.resource_group,
                "--output", "json",
            ],
            capture=True,
        )
    except subprocess.CalledProcessError:
        fail(
            f"Web App '{args.web_app_name}' not found in resource group '{args.resource_group}'.",
            "Run provision-azure.ps1 first to create the Azure resources.",
        )

    detail(f"Web App '{args.web_app_name}' found.")

    if not (web_dir / "package.json").is_file():
        fail(
            "web/package.json not found.",
            "Make sure this script is in the scripts/ directory of the Neo repo.",
        )

    if not shutil.which("npm"):
        fail("npm is not installed.")

    return account


def build(web_dir: Path, standalone_dir: Path, skip_build: bool) -> None:
    if skip_build:
        warn("Skipping build (--skip-build flag set).")

        if not standalone_dir.is_dir():
            fail(".next/standalone/ not found. Cannot skip build — run without --skip-build first.")

        if next(standalone_dir.rglob("server.js"), None) is None:
            fail("server.js not found in .next/standalone/. Previous build appears incomplete.")

        age_hours = (time.time() - standalone_dir.stat().st_mtime) / 3600
        if age_hours > 24:
            warn(f"Build artifact is {age_hours:.0f} hours old. Consider rebuilding.")
        return

    print()
    info("Installing dependencies (npm ci --prefer-offline --no-audit --no-fund)...")
    try:
        run(
            ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"],
            cwd=web_dir,
        )
    except subprocess.CalledProcessError as e:
        fail(
            f"npm ci failed with exit code {e.returncode}",
            "Lockfile may be out of sync — run 'npm install' locally and commit the updated lockfile.",
        )
    ok("Dependencies installed.")

    print()
    info("Building Next.js application...")
    try:
        run(["npm", "run", "build"], cwd=web_dir)
    except subprocess.CalledProcessError as e:
        fail(f"npm run build failed with exit code {e.returncode}")
    ok("Build complete.")

    # Bundle the conversation-storage migration script into a single
    # self-contained dist/migrate.mjs. Next's standalone dep tracing
    # doesn't pull in web/scripts/, so without this step the App
    # Service filesystem won't have the migration runtime.
    print()
    info("Bundling migration script...")
    try:
        run(["npm", "run", "build:migrate"], cwd=web_dir)
    except subprocess.CalledProcessError as e:
        fail(f"npm run build:migrate failed with exit code {e.returncode}")
    ok("Migration script bundled.")

    if not standalone_dir.is_dir():
        fail(
            ".next/standalone/ not found after build.",
            "Ensure output: 'standalone' is set in web/next.config.js",
        )


def resolve_server_root(standalone_dir: Path) -> Path:
    """Next's standalone build can nest server.js under a subdirectory
    matching the package folder name (e.g. standalone/web/server.js
    instead of standalone/server.js). Return the actual directory
    containing server.js so the zip root has it directly."""
    if (standalone_dir / "server.js").is_file():
        return standalone_dir

    nested = next(standalone_dir.rglob("server.js"), None)
    if nested is None:
        fail("server.js not found anywhere in standalone output.")
    warn(f"Detected monorepo layout — server.js found at: {nested}")
    return nested.parent


def stage(
    web_dir: Path,
    server_root: Path,
    standalone_dir: Path,
    staging_dir: Path,
) -> None:
    """Copy the standalone server tree, then in parallel: public/,
    .next/static/, skills/. The server tree dwarfs the others, so
    parallelizing the small copies is the meaningful win."""
    info("Copying standalone server tree...")
    shutil.copytree(server_root, staging_dir)

    public_src = web_dir / "public"
    static_src = web_dir / ".next" / "static"
    skills_src = web_dir / "skills"
    migrate_src = web_dir / "dist" / "migrate.mjs"

    def copy_dir(src: Path, dst: Path) -> Optional[Path]:
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
            return src
        return None

    info("Copying public/, .next/static/, skills/ in parallel...")
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = [
            ex.submit(copy_dir, public_src, staging_dir / "public"),
            ex.submit(copy_dir, static_src, staging_dir / ".next" / "static"),
            ex.submit(copy_dir, skills_src, staging_dir / "skills"),
        ]
        for f in as_completed(futures):
            f.result()  # surface exceptions

    if skills_src.is_dir():
        skill_count = sum(1 for _ in skills_src.glob("*.md"))
        ok(f"Copied {skill_count} skill file(s).")

    # The bundled conversation-storage migration script. Operators run
    # this from SSH on the App Service via `node dist/migrate.mjs
    # --dry-run` to execute the v1→v2 migration under the App Service's
    # managed identity.
    if migrate_src.is_file():
        dist_dst = staging_dir / "dist"
        dist_dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(migrate_src, dist_dst / "migrate.mjs")
        ok("Copied migration bundle.")
    else:
        warn("dist/migrate.mjs not found — migration bundle missing from deploy.")

    # If the standalone output is nested, Next.js hoists shared
    # dependencies to the top-level standalone/node_modules. Mirror
    # them into the zip root so the runtime's import graph stays
    # consistent with what was built.
    if server_root != standalone_dir:
        root_node_modules = standalone_dir / "node_modules"
        staging_node_modules = staging_dir / "node_modules"
        if root_node_modules.is_dir() and not staging_node_modules.is_dir():
            shutil.copytree(root_node_modules, staging_node_modules)


def make_zip(staging_dir: Path, zip_path: Path, compress_level: int) -> None:
    info(f"Creating zip (compression level {compress_level})...")
    with zipfile.ZipFile(
        zip_path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=compress_level,
    ) as zf:
        for root, _, files in os.walk(staging_dir):
            root_path = Path(root)
            for fname in files:
                full = root_path / fname
                arcname = full.relative_to(staging_dir)
                zf.write(full, arcname)

    zip_mb = zip_path.stat().st_size / (1024 * 1024)
    ok(f"Package created: {zip_mb:.1f} MB")


def deploy(args: argparse.Namespace, zip_path: Path) -> None:
    print()
    info(f"Deploying to {args.web_app_name}...")
    deploy_cmd = [
        "az", "webapp", "deploy",
        "--resource-group", args.resource_group,
        "--name", args.web_app_name,
        "--src-path", str(zip_path),
        "--type", "zip",
        "--output", "none",
    ]
    if args.no_wait:
        # Skips the Kudu deployment-status poll. Returns as soon as
        # the upload completes (saves 30-120s on a typical run) but
        # the operator no longer gets runtime confirmation that the
        # app actually started.
        deploy_cmd += ["--track-status", "false"]

    try:
        run(deploy_cmd)
    except subprocess.CalledProcessError:
        fail("Deployment failed.")
    ok("Deployment complete.")


def configure_startup(args: argparse.Namespace) -> None:
    print()
    info("Configuring startup command...")
    try:
        run(
            [
                "az", "webapp", "config", "set",
                "--resource-group", args.resource_group,
                "--name", args.web_app_name,
                "--startup-file", "node server.js",
                "--output", "none",
            ]
        )
        ok("Startup command set to: node server.js")
    except subprocess.CalledProcessError:
        warn("Failed to set startup command. Set it manually in Azure Portal:")
        warn("  Startup Command → node server.js")


def cleanup(staging_dir: Path, zip_path: Path) -> None:
    try:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        if zip_path.exists():
            zip_path.unlink()
    except OSError:
        warn(f"Failed to clean up temp files at '{staging_dir}'.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build and deploy the Neo web app to Azure App Service.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--resource-group",
        default="neo-rg",
        help="Azure resource group name (default: neo-rg).",
    )
    parser.add_argument(
        "--web-app-name",
        default="neo-web",
        help="Azure App Service web app name (default: neo-web).",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip npm ci + npm run build; reuse the existing .next/standalone/ output.",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help=(
            "Pass --track-status false to az webapp deploy. Returns as soon as the "
            "upload completes (saves 30-120s) but skips runtime confirmation."
        ),
    )
    parser.add_argument(
        "--compression-level",
        type=int,
        default=1,
        choices=range(0, 10),
        metavar="0-9",
        help="Zip compression level (default: 1 — fastest with reasonable size).",
    )
    args = parser.parse_args()

    # Mirror the PS1 ValidatePattern on web app name.
    if not re.match(r"^[a-z0-9][a-z0-9\-]{0,58}[a-z0-9]$", args.web_app_name):
        fail(
            f"Invalid web app name: '{args.web_app_name}'.",
            "Must be 2-60 chars, lowercase alphanumeric or hyphen, no leading/trailing hyphen.",
        )

    return args


def main() -> None:
    args = parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    web_dir = repo_root / "web"

    if not web_dir.is_dir():
        fail(
            f"Could not locate 'web/' directory at '{web_dir}'.",
            "Ensure deploy-azure.py lives in the scripts/ subdirectory of the repo.",
        )

    check_prerequisites(args, web_dir)

    standalone_dir = web_dir / ".next" / "standalone"
    build(web_dir, standalone_dir, args.skip_build)
    server_root = resolve_server_root(standalone_dir)

    print()
    info("Packaging deployment artifact...")

    # Use a fresh path under the system temp dir; copytree wants the
    # destination to not exist yet.
    staging_dir = Path(tempfile.gettempdir()) / f"neo-deploy-{os.urandom(4).hex()}"
    zip_path = staging_dir.with_suffix(".zip")

    try:
        stage(web_dir, server_root, standalone_dir, staging_dir)
        make_zip(staging_dir, zip_path, args.compression_level)
        deploy(args, zip_path)
        configure_startup(args)
    finally:
        cleanup(staging_dir, zip_path)

    # Summary
    print()
    print(f"  {C.GREEN}============================================{C.RESET}")
    print(f"  {C.GREEN}Deployment complete!{C.RESET}")
    print(f"  {C.GREEN}============================================{C.RESET}")
    print()
    print(f"  Web App: {args.web_app_name}")
    print(f"  URL:     https://{args.web_app_name}.azurewebsites.net")
    print()
    print(f"  {C.YELLOW}It may take a minute for the app to start.{C.RESET}")
    print()


if __name__ == "__main__":
    main()
