import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectOS } from "../web/lib/detect-os.ts";

describe("detectOS", () => {
  it("returns 'windows' for a Windows user-agent", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0";
    assert.equal(detectOS(ua), "windows");
  });

  it("returns 'macos' for a macOS user-agent", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0";
    assert.equal(detectOS(ua), "macos");
  });

  it("returns 'linux' for a Linux user-agent", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
    assert.equal(detectOS(ua), "linux");
  });

  it("does not return 'linux' for an Android user-agent", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0";
    assert.notEqual(detectOS(ua), "linux");
  });

  it("does not return 'windows' for an Android user-agent with 'win' substring", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0";
    assert.notEqual(detectOS(ua), "windows");
  });

  it("returns 'unknown' for an empty string", () => {
    assert.equal(detectOS(""), "unknown");
  });

  it("returns 'unknown' for an unrecognized user-agent", () => {
    assert.equal(detectOS("SomeBot/1.0"), "unknown");
  });
});
