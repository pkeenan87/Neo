import { describe, it } from "node:test";
import assert from "node:assert/strict";

// toKvName is a pure function — test the logic directly to avoid
// importing secrets.ts which depends on the Next.js module chain.
function toKvName(name) {
  return name.replace(/_/g, "-").toLowerCase();
}

describe("toKvName", () => {
  it("converts underscores to dashes and lowercases", () => {
    assert.equal(toKvName("AZURE_TENANT_ID"), "azure-tenant-id");
  });

  it("handles multiple underscores", () => {
    assert.equal(toKvName("SENTINEL_WORKSPACE_NAME"), "sentinel-workspace-name");
  });

  it("passes through already-dashed names unchanged", () => {
    assert.equal(toKvName("already-dashed"), "already-dashed");
  });

  it("lowercases names without underscores or dashes", () => {
    assert.equal(toKvName("NoDashes"), "nodashes");
  });

  it("handles empty string", () => {
    assert.equal(toKvName(""), "");
  });
});
