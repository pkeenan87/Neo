import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  validateConfig() must throw when NODE_ENV=production AND
//  MOCK_MODE=true. Mock mode silently swallows tool calls and
//  re-activates the API-key file fallback (api-key-store.ts), so
//  shipping it to prod is a posture failure.
// ─────────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Required so validateConfig doesn't trip on its other guards.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.AUTH_SECRET = "test-secret";
  process.env.COSMOS_ENDPOINT = "https://test.documents.azure.com:443/";
  // Set explicitly to "false" rather than delete — dotenv.config()
  // runs at module load and would otherwise repopulate from the
  // checked-in .env (which has DEV_AUTH_BYPASS=true for local dev).
  process.env.DEV_AUTH_BYPASS = "false";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("validateConfig — MOCK_MODE production guard", () => {
  it("throws when NODE_ENV='production' and MOCK_MODE=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.MOCK_MODE = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/MOCK_MODE must not be enabled in production/);
  });

  it("does not throw when NODE_ENV='development' even if MOCK_MODE=true", async () => {
    process.env.NODE_ENV = "development";
    process.env.MOCK_MODE = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("does not throw when MOCK_MODE=false in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.MOCK_MODE = "false";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("treats unset MOCK_MODE as the project default (true) — and therefore throws in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MOCK_MODE;

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/MOCK_MODE must not be enabled in production/);
  });

  it("still enforces the existing DEV_AUTH_BYPASS guard alongside the new one", async () => {
    process.env.NODE_ENV = "production";
    process.env.MOCK_MODE = "false";
    // Override the beforeEach setting for this case.
    process.env.DEV_AUTH_BYPASS = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/DEV_AUTH_BYPASS must not be enabled outside of development/);
  });
});
