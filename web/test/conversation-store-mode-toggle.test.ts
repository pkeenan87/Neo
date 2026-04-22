import { describe, it, expect, vi } from "vitest";

// The resolver reads NEO_CONVERSATION_STORE_MODE from config at module load.
// We mock config so tests don't depend on real env vars.
vi.mock("../lib/config", () => ({
  NEO_CONVERSATION_STORE_MODE: "v1",
}));

// Mock the logger so emitEvent / warn calls don't pollute test output and
// so we can assert on them. vi.hoisted avoids the "can't access before
// initialization" ReferenceError that hits plain const refs inside a
// hoisted vi.mock factory.
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
}));

import {
  getActiveStoreMode,
  parseModeHeader,
  withStoreModeFromRequest,
  __forceStoreModeForTest,
} from "../lib/conversation-store-mode";

describe("getActiveStoreMode", () => {
  it("returns the env-var default when no context is active", () => {
    expect(getActiveStoreMode()).toBe("v1");
  });

  it("returns the AsyncLocalStorage context mode when set", async () => {
    const seen: string[] = [];
    await __forceStoreModeForTest("v2", async () => {
      seen.push(getActiveStoreMode());
    });
    expect(seen).toEqual(["v2"]);
  });

  it("context is scoped to the callback — reverts when it exits", async () => {
    await __forceStoreModeForTest("dual-write", async () => {
      expect(getActiveStoreMode()).toBe("dual-write");
    });
    // Back to env default after the callback returns.
    expect(getActiveStoreMode()).toBe("v1");
  });
});

describe("parseModeHeader", () => {
  it("returns the mode for each valid value", () => {
    expect(parseModeHeader("v1")).toBe("v1");
    expect(parseModeHeader("v2")).toBe("v2");
    expect(parseModeHeader("dual-read")).toBe("dual-read");
    expect(parseModeHeader("dual-write")).toBe("dual-write");
  });

  it("lowercases + trims input before matching", () => {
    expect(parseModeHeader("  V2  ")).toBe("v2");
  });

  it("returns null for invalid, missing, or empty values", () => {
    expect(parseModeHeader(null)).toBeNull();
    expect(parseModeHeader("")).toBeNull();
    expect(parseModeHeader("bogus")).toBeNull();
  });
});

describe("withStoreModeFromRequest", () => {
  function makeRequest(headers: Record<string, string> = {}) {
    return {
      headers: new Headers(headers),
    };
  }

  it("no-ops (passes through) when the header is absent", async () => {
    mockEmitEvent.mockReset();
    let observed: string = "";
    await withStoreModeFromRequest(makeRequest(), { role: "admin" }, () => {
      observed = getActiveStoreMode();
    });
    expect(observed).toBe("v1");
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });

  it("applies the override when an admin supplies a valid header", async () => {
    mockEmitEvent.mockReset();
    let observed: string = "";
    await withStoreModeFromRequest(
      makeRequest({ "x-neo-store-mode": "v2" }),
      { role: "admin", name: "alice" },
      () => {
        observed = getActiveStoreMode();
      },
    );
    expect(observed).toBe("v2");
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "conversation_store_mode_override",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: "v2", callerName: "alice" }),
    );
  });

  it("ignores the header when the caller is not admin (logs warn)", async () => {
    mockEmitEvent.mockReset();
    mockWarn.mockReset();
    let observed: string = "";
    await withStoreModeFromRequest(
      makeRequest({ "x-neo-store-mode": "v2" }),
      { role: "reader", name: "bob" },
      () => {
        observed = getActiveStoreMode();
      },
    );
    expect(observed).toBe("v1"); // falls back to env default
    expect(mockEmitEvent).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("non-admin"),
      expect.any(String),
      expect.objectContaining({ requestedMode: "v2" }),
    );
  });

  it("ignores an invalid header value (logs warn, falls through)", async () => {
    mockEmitEvent.mockReset();
    mockWarn.mockReset();
    let observed: string = "";
    await withStoreModeFromRequest(
      makeRequest({ "x-neo-store-mode": "bogus" }),
      { role: "admin" },
      () => {
        observed = getActiveStoreMode();
      },
    );
    expect(observed).toBe("v1");
    expect(mockEmitEvent).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid"),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("ignores the header when identity is null (unauthenticated path)", async () => {
    mockEmitEvent.mockReset();
    let observed: string = "";
    await withStoreModeFromRequest(
      makeRequest({ "x-neo-store-mode": "v2" }),
      null,
      () => {
        observed = getActiveStoreMode();
      },
    );
    expect(observed).toBe("v1");
    expect(mockEmitEvent).not.toHaveBeenCalled();
  });
});
