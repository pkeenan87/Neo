import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Multi-instance deployment guard: production must have COSMOS_ENDPOINT
// configured. Without it, the in-memory session store + skill cache +
// API key file cache produce different state per instance. See
// _plans/multi-instance-deployment.md.

const ORIGINAL_ENV = { ...process.env };

// `process.env.NODE_ENV` is typed as a literal union by `@types/node` and
// can't be assigned freely. Cast `process.env` on each access (not once
// at module load — beforeEach reassigns process.env, so a captured alias
// would point at the stale object).
const env = () => process.env as unknown as Record<string, string | undefined>;

describe("startup assertion — multi-instance Cosmos guard", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.ANTHROPIC_API_KEY = "test-key";
    // dotenv re-reads .env on each module re-import. Empty-string
    // assignments suppress override (dotenv doesn't replace existing
    // env vars), avoiding spurious failures from unrelated guards.
    process.env.DEV_AUTH_BYPASS = "";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when NODE_ENV=production and COSMOS_ENDPOINT is unset", async () => {
    env().NODE_ENV = "production";
    delete env().COSMOS_ENDPOINT;

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).toThrow(/Multi-instance deployment requires COSMOS_ENDPOINT/);
  });

  it("does NOT throw when NODE_ENV=production and COSMOS_ENDPOINT is set", async () => {
    env().NODE_ENV = "production";
    env().COSMOS_ENDPOINT = "https://prod.documents.azure.com:443/";
    env().AUTH_SECRET = "test-auth-secret";

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=development and COSMOS_ENDPOINT is unset", async () => {
    env().NODE_ENV = "development";
    delete env().COSMOS_ENDPOINT;

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("does NOT throw when NODE_ENV is undefined (test/CI default)", async () => {
    delete env().NODE_ENV;
    delete env().COSMOS_ENDPOINT;

    const { validateConfig } = await import("../lib/config");
    expect(() => validateConfig()).not.toThrow();
  });

  it("error message points operators at the fix", async () => {
    env().NODE_ENV = "production";
    delete env().COSMOS_ENDPOINT;

    const { validateConfig } = await import("../lib/config");
    try {
      validateConfig();
      expect.fail("expected validateConfig to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/COSMOS_ENDPOINT/);
      expect(message).toMatch(/documents\.azure\.com/);
      expect(message).toMatch(/NODE_ENV=development/);
    }
  });
});
