import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

import { assertCosmosContainers } from "../lib/cosmos-startup-check";

function makeDatabaseFactory(present: Set<string>, throwCode: { container: string; code: number } | null = null) {
  return () =>
    ({
      container(name: string) {
        return {
          async read() {
            if (throwCode && throwCode.container === name) {
              throw Object.assign(new Error("boom"), { code: throwCode.code });
            }
            if (!present.has(name)) {
              throw Object.assign(new Error("not found"), { code: 404 });
            }
            return { resource: { id: name } };
          },
        };
      },
    }) as never;
}

const ALL_REQUIRED = [
  "conversations",
  "usage-logs",
  "triageRuns",
  "teams-mappings",
  "api-keys",
  "skills",
  "instance-shared",
];

describe("assertCosmosContainers", () => {
  it("no-op when endpoint is undefined (dev / mock mode)", async () => {
    const factory = vi.fn();
    await expect(assertCosmosContainers(undefined, factory as never)).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("succeeds when every required container exists", async () => {
    const factory = makeDatabaseFactory(new Set(ALL_REQUIRED));
    await expect(
      assertCosmosContainers("https://mock.documents.azure.com:443/", factory),
    ).resolves.toBeUndefined();
  });

  it("throws naming the missing container(s) on 404", async () => {
    const present = new Set(ALL_REQUIRED.filter((n) => n !== "skills" && n !== "instance-shared"));
    const factory = makeDatabaseFactory(present);
    await expect(
      assertCosmosContainers("https://mock.documents.azure.com:443/", factory),
    ).rejects.toThrow(/skills.*instance-shared|instance-shared.*skills/);
  });

  it("error message points operators at the provisioning script", async () => {
    const factory = makeDatabaseFactory(new Set(ALL_REQUIRED.filter((n) => n !== "skills")));
    try {
      await assertCosmosContainers("https://mock.documents.azure.com:443/", factory);
      expect.fail("expected to throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/provision-cosmos-db\.ps1/);
    }
  });

  it("re-throws on non-404 connectivity errors with a clear message", async () => {
    const factory = makeDatabaseFactory(new Set(ALL_REQUIRED), {
      container: "instance-shared",
      code: 401,
    });
    await expect(
      assertCosmosContainers("https://mock.documents.azure.com:443/", factory),
    ).rejects.toThrow(/connectivity|managed identity|network/i);
  });
});
