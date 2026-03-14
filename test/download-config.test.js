import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PLATFORMS } from "../web/lib/download-config.ts";

describe("PLATFORMS config", () => {
  it("every platform has all required fields", () => {
    for (const p of PLATFORMS) {
      assert.ok(p.id, `missing id`);
      assert.ok(p.name, `missing name for ${p.id}`);
      assert.ok(p.status, `missing status for ${p.id}`);
      assert.ok(p.version, `missing version for ${p.id}`);
    }
  });

  it("available platforms have blobFilename and downloadPath", () => {
    for (const p of PLATFORMS.filter((p) => p.status === "available")) {
      assert.ok(p.blobFilename, `missing blobFilename for available platform ${p.id}`);
      assert.ok(p.downloadPath, `missing downloadPath for available platform ${p.id}`);
    }
  });

  it("coming-soon platforms have null blobFilename and downloadPath", () => {
    for (const p of PLATFORMS.filter((p) => p.status === "coming-soon")) {
      assert.equal(p.blobFilename, null, `blobFilename should be null for ${p.id}`);
      assert.equal(p.downloadPath, null, `downloadPath should be null for ${p.id}`);
    }
  });

  it("has at least one platform with status 'available'", () => {
    const available = PLATFORMS.filter((p) => p.status === "available");
    assert.ok(available.length > 0, "no platforms are available");
  });

  it("platform IDs are unique", () => {
    const ids = PLATFORMS.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, "duplicate platform IDs found");
  });
});
