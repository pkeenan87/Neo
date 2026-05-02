import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  executeTool defense-in-depth role re-check.
//
//  The agent loop's tool-visibility filter (getToolsForRole) is the
//  primary gate; this is the second layer. Closes audit Top-10 #6.
// ─────────────────────────────────────────────────────────────

vi.mock("../lib/config", () => ({
  env: {
    MOCK_MODE: true,
    AI_SEARCH_INDEX_DEFAULT: "sharepoint-docx",
    AI_SEARCH_API_VERSION: "2024-07-01",
    AI_SEARCH_RERANKER_THRESHOLD: 1.5,
    AI_SEARCH_ALLOW_DISABLE_THRESHOLD: false,
  },
  REMEDIATE_MAX_EXPLICIT_MESSAGES: 20,
}));

vi.mock("../lib/logger", async () => {
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
    hashPii: actual.hashPii,
  };
});

import { executeTool } from "../lib/executors";
import { ToolPermissionError } from "../lib/permissions";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeTool — role re-check", () => {
  it("throws ToolPermissionError for a destructive tool when role='reader'", async () => {
    await expect(
      executeTool(
        "reset_user_password",
        { upn: "alice@example.com", justification: "test" },
        { role: "reader" },
      ),
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  it("throws ToolPermissionError for a destructive tool when role='triage'", async () => {
    await expect(
      executeTool(
        "isolate_machine",
        { hostname: "host-1", platform: "defender", justification: "test" },
        { role: "triage" },
      ),
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  it("dispatches normally for a destructive tool when role='admin'", async () => {
    // MOCK_MODE returns synthetic data; the dispatch should not throw.
    const result = await executeTool(
      "reset_user_password",
      { upn: "alice@example.com", justification: "test" },
      { role: "admin" },
    );
    expect(result).toBeDefined();
  });

  it("dispatches normally for a read-only tool when role='reader'", async () => {
    // run_sentinel_kql is read-only — reader is allowed.
    const result = await executeTool(
      "run_sentinel_kql",
      { query: "SigninLogs | take 5", description: "test" },
      { role: "reader" },
    );
    expect(result).toBeDefined();
  });

  it("rejects an unknown tool name for any role", async () => {
    await expect(
      executeTool("not_a_real_tool_name", {}, { role: "admin" }),
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  it("preserves backwards compatibility — no role in context means no re-check", async () => {
    // Older callers that don't pass `role` still work. The destructive
    // tool dispatches without a permission error.
    const result = await executeTool(
      "reset_user_password",
      { upn: "alice@example.com", justification: "test" },
      {},
    );
    expect(result).toBeDefined();
  });
});
