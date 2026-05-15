import { describe, expect, it, vi } from "vitest";

// Importing logger.ts touches config/env so we provide a benign
// MOCK_MODE state to avoid the production-guard throw.
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "MOCK_MODE") return true;
      return undefined;
    },
  }),
}));

// Logger's metadata sanitiser is module-private — to verify the
// allowlist contains the new field names without exporting the Set,
// we exercise the public emit path and assert the resulting console
// line carries those fields verbatim.

import { logger } from "../lib/logger";

describe("logger SAFE_METADATA_FIELDS — Infosec audit fields", () => {
  it("preserves responder / apiManagementRequestId / apiManagementMiddlewareRequestId / workflowRunId / mcpSessionId in emitted metadata", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.emitEvent("tool_execution", "test", "test", {
      // These five are the Infosec additions from
      // _plans/infosec-incident-response-mcp.md step 8.
      responder: "admin@example.com",
      apiManagementRequestId: "ar-1",
      apiManagementMiddlewareRequestId: "mw-1",
      workflowRunId: "wf-1",
      mcpSessionId: "sess-1",
      // Sanity baseline — should survive (already in the allowlist).
      toolName: "block_ipaddress",
      // Sanity poison — should be dropped (not in allowlist).
      bearerToken: "should-be-stripped",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;

    // All five new fields survived sanitisation.
    expect(line).toContain('"responder":"admin@example.com"');
    expect(line).toContain('"apiManagementRequestId":"ar-1"');
    expect(line).toContain('"apiManagementMiddlewareRequestId":"mw-1"');
    expect(line).toContain('"workflowRunId":"wf-1"');
    expect(line).toContain('"mcpSessionId":"sess-1"');
    // Baseline survived.
    expect(line).toContain('"toolName":"block_ipaddress"');
    // Poison did NOT survive — defence-in-depth proof the allowlist
    // is actually filtering, not pass-through.
    expect(line).not.toContain("should-be-stripped");

    logSpy.mockRestore();
  });
});
