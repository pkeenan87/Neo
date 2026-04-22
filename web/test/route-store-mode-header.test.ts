import { describe, it, expect, vi, beforeEach } from "vitest";

// End-to-end-ish test: the X-Neo-Store-Mode admin header, sent on a
// web API request, flips NEO_CONVERSATION_STORE_MODE for the
// duration of that request AND non-admin callers can't do it.
//
// We pick the smallest / cleanest route (GET /api/conversations)
// because it's one function call deep, and mock listConversations
// to assert which mode was active when it was invoked.

// Mock config so dispatch default is v1.
vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "x", MOCK_MODE: false },
  NEO_CONVERSATION_STORE_MODE: "v1",
}));

const { mockEmitEvent, mockWarn } = vi.hoisted(() => ({
  mockEmitEvent: vi.fn(),
  mockWarn: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    emitEvent: mockEmitEvent,
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

// Mock resolveAuth so the test controls identity directly.
const { mockIdentity } = vi.hoisted(() => ({
  mockIdentity: { current: null as { role: "admin" | "reader"; name: string; ownerId: string } | null },
}));
vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: vi.fn(async () => mockIdentity.current),
}));

// Mock listConversations to capture the active mode at call time.
// The handler wraps the call in withStoreModeFromRequest, so the
// mode observable inside listConversations' first `await`-boundary
// should reflect the header override when applicable.
const { observedModes, listSpy } = vi.hoisted(() => ({
  observedModes: [] as string[],
  listSpy: vi.fn(),
}));
vi.mock("../lib/conversation-store", async () => {
  // Need to defer the import of getActiveStoreMode so it reads the
  // SAME ALS instance the route wrapper writes into.
  const mode = await import("../lib/conversation-store-mode");
  return {
    listConversations: vi.fn(async (_ownerId: string) => {
      observedModes.push(mode.getActiveStoreMode());
      listSpy();
      return [];
    }),
  };
});

import { GET } from "../app/api/conversations/route";

// Build a minimal object matching the NextRequest surface the handler
// actually uses: `.headers.get()` and `.nextUrl.searchParams.get()`.
function makeReq(url: string, headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
    nextUrl: new URL(url),
  };
}

describe("route-layer admin-header mode override", () => {
  beforeEach(() => {
    observedModes.length = 0;
    listSpy.mockReset();
    mockEmitEvent.mockReset();
    mockWarn.mockReset();
    mockIdentity.current = null;
  });

  it("admin caller with X-Neo-Store-Mode=v2 → listConversations runs under v2 mode", async () => {
    mockIdentity.current = { role: "admin", name: "alice", ownerId: "admin_1" };
    const res = await GET(
      makeReq("http://localhost/api/conversations", {
        "x-neo-store-mode": "v2",
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(observedModes).toEqual(["v2"]);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "conversation_store_mode_override",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: "v2", callerName: "alice" }),
    );
  });

  it("non-admin caller with same header → override ignored, mode stays v1, warn logged", async () => {
    mockIdentity.current = { role: "reader", name: "bob", ownerId: "reader_1" };
    const res = await GET(
      makeReq("http://localhost/api/conversations", {
        "x-neo-store-mode": "v2",
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(observedModes).toEqual(["v1"]);
    expect(mockEmitEvent).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("non-admin"),
      expect.any(String),
      expect.objectContaining({ requestedMode: "v2" }),
    );
  });

  it("admin caller without header → no override, mode stays env default (v1)", async () => {
    mockIdentity.current = { role: "admin", name: "alice", ownerId: "admin_1" };
    const res = await GET(makeReq("http://localhost/api/conversations") as never);
    expect(res.status).toBe(200);
    expect(observedModes).toEqual(["v1"]);
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });

  it("invalid mode header → ignored with a warn, mode stays env default", async () => {
    mockIdentity.current = { role: "admin", name: "alice", ownerId: "admin_1" };
    const res = await GET(
      makeReq("http://localhost/api/conversations", {
        "x-neo-store-mode": "bogus",
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(observedModes).toEqual(["v1"]);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid"),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("unauthenticated caller → 401 before the wrap; store-mode-override never evaluated", async () => {
    mockIdentity.current = null;
    const res = await GET(
      makeReq("http://localhost/api/conversations", {
        "x-neo-store-mode": "v2",
      }) as never,
    );
    expect(res.status).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });
});
