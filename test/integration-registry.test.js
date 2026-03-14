import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTEGRATIONS, getIntegration } from "../web/lib/integration-registry.ts";
import { TOOLS } from "../web/lib/tools.ts";

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

describe("INTEGRATIONS registry", () => {
  it("has 3 integrations", () => {
    assert.equal(INTEGRATIONS.length, 3);
  });

  it("contains expected slugs", () => {
    const slugs = INTEGRATIONS.map((i) => i.slug);
    assert.ok(slugs.includes("microsoft-sentinel"));
    assert.ok(slugs.includes("microsoft-defender-xdr"));
    assert.ok(slugs.includes("microsoft-entra-id"));
  });

  it("each integration has at least one capability", () => {
    for (const integration of INTEGRATIONS) {
      assert.ok(
        integration.capabilities.length > 0,
        `${integration.slug} has no capabilities`
      );
    }
  });

  it("each integration has at least one secret", () => {
    for (const integration of INTEGRATIONS) {
      assert.ok(
        integration.secrets.length > 0,
        `${integration.slug} has no secrets`
      );
    }
  });

  it("all capabilities reference valid tool names", () => {
    for (const integration of INTEGRATIONS) {
      for (const cap of integration.capabilities) {
        assert.ok(
          TOOL_NAMES.has(cap),
          `${integration.slug} references unknown tool: ${cap}`
        );
      }
    }
  });

  it("all secrets have key, label, and description", () => {
    for (const integration of INTEGRATIONS) {
      for (const secret of integration.secrets) {
        assert.ok(secret.key, `missing key in ${integration.slug}`);
        assert.ok(secret.label, `missing label for ${secret.key}`);
        assert.ok(secret.description, `missing description for ${secret.key}`);
      }
    }
  });
});

describe("getIntegration", () => {
  it("returns correct integration by slug", () => {
    const sentinel = getIntegration("microsoft-sentinel");
    assert.ok(sentinel);
    assert.equal(sentinel.name, "Microsoft Sentinel");
    assert.equal(sentinel.capabilities.length, 2);
  });

  it("returns undefined for unknown slug", () => {
    assert.equal(getIntegration("nonexistent"), undefined);
  });
});

describe("integration secrets structure", () => {
  it("shared Azure AD secrets are consistent across integrations", () => {
    const sharedKeys = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
    for (const integration of INTEGRATIONS) {
      for (const sharedKey of sharedKeys) {
        const secret = integration.secrets.find((s) => s.key === sharedKey);
        assert.ok(secret, `${integration.slug} missing shared secret ${sharedKey}`);
        assert.equal(secret.required, true, `${sharedKey} should be required`);
      }
    }
  });

  it("sentinel has all 7 required secrets", () => {
    const sentinel = getIntegration("microsoft-sentinel");
    assert.ok(sentinel);
    assert.equal(sentinel.secrets.length, 7);
    const keys = sentinel.secrets.map((s) => s.key);
    assert.ok(keys.includes("SENTINEL_WORKSPACE_ID"));
    assert.ok(keys.includes("SENTINEL_WORKSPACE_NAME"));
    assert.ok(keys.includes("SENTINEL_RESOURCE_GROUP"));
    assert.ok(keys.includes("AZURE_SUBSCRIPTION_ID"));
  });
});
