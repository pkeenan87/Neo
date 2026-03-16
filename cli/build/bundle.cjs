#!/usr/bin/env node
// Build helper — reads the version from package.json and invokes esbuild
// with --define:__CLI_VERSION__ so the SEA binary knows its version at runtime.

const { execSync } = require("child_process");
const { version } = require("../package.json");

const cmd = [
  "npx esbuild src/index.js",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--outfile=dist/neo-bundle.cjs",
  "--minify",
  `--define:__CLI_VERSION__='"${version}"'`,
].join(" ");

console.log(`Building CLI v${version}...`);
execSync(cmd, { stdio: "inherit", cwd: __dirname + "/.." });
console.log("Bundle complete: dist/neo-bundle.cjs");
