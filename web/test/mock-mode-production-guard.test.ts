import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  validateConfig() must throw when NODE_ENV=production AND
//  MOCK_MODE=true. Mock mode silently swallows tool calls and
//  re-activates the API-key file fallback (api-key-store.ts), so
//  shipping it to prod is a posture failure.
// ─────────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

// `process.env.NODE_ENV` is typed as a literal union by @types/node and
// can't be assigned freely. The cast lets us mutate it across tests.
const env = () => process.env as unknown as Record<string, string | undefined>;

beforeEach(() => {
  // Required so validateConfig doesn't trip on its other guards.
  env().ANTHROPIC_API_KEY = "sk-ant-test";
  env().AUTH_SECRET = "test-secret";
  env().COSMOS_ENDPOINT = "https://test.documents.azure.com:443/";
  // Set explicitly to "false" rather than delete — dotenv.config()
  // runs at module load and would otherwise repopulate from the
  // checked-in .env (which has DEV_AUTH_BYPASS=true for local dev).
  env().DEV_AUTH_BYPASS = "false";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("validateConfig — MOCK_MODE production guard", () => {
  it("throws when NODE_ENV='production' and MOCK_MODE=true", async () => {
    env().NODE_ENV = "production";
    env().MOCK_MODE = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/MOCK_MODE must not be enabled in production/);
  });

  it("does not throw when NODE_ENV='development' even if MOCK_MODE=true", async () => {
    env().NODE_ENV = "development";
    env().MOCK_MODE = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("does not throw when MOCK_MODE=false in production", async () => {
    env().NODE_ENV = "production";
    env().MOCK_MODE = "false";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("treats unset MOCK_MODE as the project default (true) — and therefore throws in production", async () => {
    env().NODE_ENV = "production";
    // Empty string (not delete) so dotenv.config() — which runs on every
    // config module re-import — can't repopulate MOCK_MODE from a
    // developer's local `.env`. The config.ts parser is
    // `process.env.MOCK_MODE !== "false"`, so "" round-trips to true
    // exactly like undefined would. This preserves the intent of the
    // test (project default is mock-mode) while staying robust to .env.
    env().MOCK_MODE = "";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/MOCK_MODE must not be enabled in production/);
  });

  it("still enforces the existing DEV_AUTH_BYPASS guard alongside the new one", async () => {
    env().NODE_ENV = "production";
    env().MOCK_MODE = "false";
    // Override the beforeEach setting for this case.
    env().DEV_AUTH_BYPASS = "true";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/DEV_AUTH_BYPASS must not be enabled outside of development/);
  });
});
