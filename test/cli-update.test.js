import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, checkForUpdate, runUpdate } from "../cli/src/updater.js";

// ── compareSemver ────────────────────────────────────────────

describe("compareSemver", () => {
  it("returns -1 when current is older (patch)", () => {
    assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  });

  it("returns -1 when current is older (minor)", () => {
    assert.equal(compareSemver("1.2.3", "1.3.0"), -1);
  });

  it("returns -1 when current is older (major)", () => {
    assert.equal(compareSemver("1.9.9", "2.0.0"), -1);
  });

  it("returns 0 when versions are equal", () => {
    assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  });

  it("returns 1 when current is newer", () => {
    assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
  });

  it("handles missing patch segment", () => {
    assert.equal(compareSemver("1.0", "1.0.1"), -1);
  });

  it("throws on invalid semver (v prefix)", () => {
    assert.throws(() => compareSemver("v1.0.0", "1.0.0"), /Invalid semver/);
  });

  it("throws on empty string", () => {
    assert.throws(() => compareSemver("", "1.0.0"), /Invalid semver/);
  });

  it("throws on non-numeric segments", () => {
    assert.throws(() => compareSemver("1.abc.0", "1.0.0"), /Invalid semver/);
  });
});

// ── checkForUpdate ───────────────────────────────────────────

describe("checkForUpdate", () => {
  it("prints update notice when newer version is available", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "99.0.0", downloadUrl: "/api/downloads/neo-setup.exe", platform: "windows" }),
    });

    try {
      await checkForUpdate("http://localhost:3000", async () => "Bearer test", log);
      const output = lines.join("\n");
      assert.ok(output.includes("99.0.0"), "should mention the latest version");
      assert.ok(output.includes("neo update"), "should suggest neo update");
      assert.ok(output.includes("[UPDATE]"), "should include text prefix");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("prints nothing when already up to date", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "0.0.1", downloadUrl: "/api/downloads/neo-setup.exe", platform: "windows" }),
    });

    try {
      await checkForUpdate("http://localhost:3000", async () => "Bearer test", log);
      assert.equal(lines.length, 0, "should not print anything");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("prints nothing when server is unreachable", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network error"); };

    try {
      await checkForUpdate("http://localhost:3000", async () => "Bearer test", log);
      assert.equal(lines.length, 0, "should not print anything");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("prints nothing when server returns invalid version", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "bad", downloadUrl: "/api/downloads/neo-setup.exe" }),
    });

    try {
      await checkForUpdate("http://localhost:3000", async () => "Bearer test", log);
      assert.equal(lines.length, 0, "should not print anything for malformed version");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── runUpdate ────────────────────────────────────────────────

describe("runUpdate", () => {
  it("prints 'up to date' with [OK] prefix when on latest version", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "0.0.1", downloadUrl: "/api/downloads/neo-setup.exe", platform: "windows" }),
    });

    try {
      await runUpdate("http://localhost:3000", async () => "Bearer test", log);
      const output = lines.join("\n");
      assert.ok(output.includes("up to date"), "should say up to date");
      assert.ok(output.includes("[OK]"), "should include [OK] prefix");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("prints error with [ERROR] prefix when server is unreachable", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network error"); };

    try {
      await runUpdate("http://localhost:3000", async () => "Bearer test", log);
      const output = lines.join("\n");
      assert.ok(output.includes("Could not reach"), "should show unreachable message");
      assert.ok(output.includes("[ERROR]"), "should include [ERROR] prefix");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects invalid version from server", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "v1.0.0", downloadUrl: "/api/downloads/neo-setup.exe" }),
    });

    try {
      await runUpdate("http://localhost:3000", async () => "Bearer test", log);
      const output = lines.join("\n");
      assert.ok(output.includes("invalid version"), "should reject non-semver version");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("rejects unsafe download path from server", async () => {
    const lines = [];
    const log = (msg) => lines.push(msg);

    const origFetch = globalThis.fetch;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ version: "99.0.0", downloadUrl: "//evil.com/malware.exe" }),
    });

    try {
      await runUpdate("http://localhost:3000", async () => "Bearer test", log);
      const output = lines.join("\n");
      assert.ok(output.includes("invalid download path"), "should reject unsafe URL");
    } finally {
      globalThis.fetch = origFetch;
      if (origPlatform) {
        Object.defineProperty(process, "platform", origPlatform);
      }
    }
  });
});
