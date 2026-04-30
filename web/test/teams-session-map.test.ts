import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/", MOCK_MODE: false },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

const { mockGetMapping, mockCreateMapping, mockUpdateActivity, mockUpdateSession } = vi.hoisted(() => ({
  mockGetMapping: vi.fn(),
  mockCreateMapping: vi.fn(async () => undefined),
  mockUpdateActivity: vi.fn(async () => undefined),
  mockUpdateSession: vi.fn(async () => undefined),
}));
vi.mock("../lib/teams-mapping-store", () => ({
  getTeamsMapping: mockGetMapping,
  createTeamsMapping: mockCreateMapping,
  updateTeamsMappingActivity: mockUpdateActivity,
  updateTeamsMappingSessionId: mockUpdateSession,
}));

import { getSessionId, setSessionId, deleteSessionId } from "../lib/teams-session-map";

describe("teams-session-map — Cosmos read-through cache", () => {
  beforeEach(() => {
    mockGetMapping.mockReset();
    mockCreateMapping.mockClear();
  });

  it("first lookup falls through to Cosmos and warms the cache", async () => {
    mockGetMapping.mockResolvedValueOnce({ sessionId: "sess_abc", id: "conv_1" });
    const got = await getSessionId("conv_1");
    expect(got).toBe("sess_abc");
    expect(mockGetMapping).toHaveBeenCalledTimes(1);

    // Second lookup hits the warm cache — no second Cosmos call.
    const again = await getSessionId("conv_1");
    expect(again).toBe("sess_abc");
    expect(mockGetMapping).toHaveBeenCalledTimes(1);
  });

  it("Cosmos miss returns undefined and does not poison the cache", async () => {
    mockGetMapping.mockResolvedValueOnce(null);
    const got = await getSessionId("conv_unknown");
    expect(got).toBeUndefined();

    // Subsequent lookup re-queries Cosmos rather than caching the miss.
    mockGetMapping.mockResolvedValueOnce({ sessionId: "sess_late", id: "conv_unknown" });
    const got2 = await getSessionId("conv_unknown");
    expect(got2).toBe("sess_late");
  });

  it("setSessionId writes to Cosmos AND populates the in-memory cache", async () => {
    await setSessionId("conv_2", "sess_2", "thread", "team_1");
    expect(mockCreateMapping).toHaveBeenCalledWith({
      id: "conv_2",
      sessionId: "sess_2",
      channelType: "thread",
      teamId: "team_1",
    });

    // Subsequent getSessionId hits the cache — no Cosmos query.
    const got = await getSessionId("conv_2");
    expect(got).toBe("sess_2");
    expect(mockGetMapping).not.toHaveBeenCalled();
  });

  it("deleteSessionId removes the in-memory cache entry only", async () => {
    await setSessionId("conv_3", "sess_3", "dm", null);
    deleteSessionId("conv_3");
    // Local cache cleared — next get falls through to Cosmos.
    mockGetMapping.mockResolvedValueOnce({ sessionId: "sess_3", id: "conv_3" });
    const got = await getSessionId("conv_3");
    expect(got).toBe("sess_3");
    expect(mockGetMapping).toHaveBeenCalledTimes(1);
  });

  // Multi-instance round-trip:
  // - "Instance A" calls setSessionId → writes to Cosmos.
  // - "Instance B" doesn't have the in-memory entry — its
  //   getSessionId falls through to Cosmos and finds it.
  it("a write on instance A is visible to instance B via Cosmos fallback", async () => {
    // "Instance A": setSessionId writes to Cosmos.
    await setSessionId("conv_multi", "sess_multi", "thread", null);

    // Simulate "instance B" by clearing its in-memory cache for this id.
    deleteSessionId("conv_multi");

    // B's first lookup falls through to Cosmos.
    mockGetMapping.mockResolvedValueOnce({ sessionId: "sess_multi", id: "conv_multi" });
    const got = await getSessionId("conv_multi");
    expect(got).toBe("sess_multi");
    expect(mockGetMapping).toHaveBeenCalledTimes(1);
  });
});
