import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the MCP client and infosec-auth — same harness shape as
// infosec-executors.test.ts so the new notification tools don't hit
// the network and don't try to mint a real Entra token.
const { mcpClientMock } = vi.hoisted(() => ({
  mcpClientMock: {
    callTool: vi.fn(),
    ensureSession: vi.fn(),
    reset: vi.fn(),
  },
}));
vi.mock("../lib/mcp-client", () => ({
  getMcpClient: vi.fn(() => mcpClientMock),
  INFOSEC_LOGIC_APP_URL_ALLOWLIST: new Set<string>([
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp",
  ]),
}));
vi.mock("../lib/infosec-auth", () => ({
  getInfosecAccessToken: vi.fn(async () => "stub-token"),
}));
vi.mock("../lib/secrets", () => ({
  getToolSecret: vi.fn(async () => undefined),
}));

const envState = {
  MOCK_MODE: false as boolean,
  INFOSEC_LOGIC_APP_MCP_URL:
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp" as string | undefined,
};
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "MOCK_MODE") return envState.MOCK_MODE;
      if (prop === "INFOSEC_LOGIC_APP_MCP_URL") return envState.INFOSEC_LOGIC_APP_MCP_URL;
      return undefined;
    },
  }),
  REMEDIATE_MAX_EXPLICIT_MESSAGES: 20,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hashed-${s}`,
  // Notification tools do NOT call resolveResponder, so the log
  // context is irrelevant for their happy path. We still stub it.
  getLogContext: () => ({ userName: "admin", userEmail: "admin@example.com" }),
}));

import { executeTool } from "../lib/executors";

beforeEach(() => {
  mcpClientMock.callTool.mockReset();
  envState.MOCK_MODE = false;
  envState.INFOSEC_LOGIC_APP_MCP_URL =
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp";
  mcpClientMock.callTool.mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
    isError: false,
    correlationHeaders: {
      apiManagementRequestId: "ar-1",
      workflowRunId: "wf-1",
      mcpSessionId: "sess-1",
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("send_teams_message / send_email — mock mode", () => {
  it("send_teams_message returns a synthetic fixture without hitting the MCP client", async () => {
    envState.MOCK_MODE = true;
    const result = (await executeTool("send_teams_message", {
      title: "Hunt complete",
      status: "success",
      body: "Found 0 indicators of compromise.",
    })) as Record<string, unknown>;
    expect(result.mocked).toBe(true);
    expect(result.tool).toBe("send-teams-message");
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("send_email returns a synthetic fixture without hitting the MCP client", async () => {
    envState.MOCK_MODE = true;
    const result = (await executeTool("send_email", {
      title: "Hunt complete",
      status: "success",
      body: "Body text.",
    })) as Record<string, unknown>;
    expect(result.mocked).toBe(true);
    expect(result.tool).toBe("send-email");
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });
});

describe("send_teams_message / send_email — live dispatch", () => {
  it("send_teams_message maps title/status/body → taskName/status/summary", async () => {
    await executeTool("send_teams_message", {
      title: "Weekly hunt",
      status: "success",
      body: "Found 0 indicators.",
    });
    expect(mcpClientMock.callTool).toHaveBeenCalledTimes(1);
    const [kebabName, payload] = mcpClientMock.callTool.mock.calls[0];
    expect(kebabName).toBe("send-teams-message");
    expect(payload).toEqual({
      taskName: "Weekly hunt",
      status: "success",
      summary: "Found 0 indicators.",
    });
  });

  it("send_email maps title/status/body → taskName/status/summary with kebab name send-email", async () => {
    await executeTool("send_email", {
      title: "Posture digest",
      status: "warning",
      body: "12 endpoints flagged.",
    });
    const [kebabName, payload] = mcpClientMock.callTool.mock.calls[0];
    expect(kebabName).toBe("send-email");
    expect(payload).toEqual({
      taskName: "Posture digest",
      status: "warning",
      summary: "12 endpoints flagged.",
    });
  });

  it("does NOT include a responder field — the Logic App notification schema has no responder", async () => {
    await executeTool("send_teams_message", {
      title: "X",
      status: "success",
      body: "Y",
    });
    const payload = mcpClientMock.callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("responder");
  });
});

describe("send_teams_message / send_email — input validation", () => {
  it("rejects an empty title", async () => {
    await expect(
      executeTool("send_teams_message", { title: "", status: "success", body: "x" }),
    ).rejects.toThrow(/missing required 'title' field/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("rejects an empty status", async () => {
    await expect(
      executeTool("send_email", { title: "X", status: "", body: "x" }),
    ).rejects.toThrow(/missing required 'status' field/);
  });

  it("rejects an empty body", async () => {
    await expect(
      executeTool("send_teams_message", { title: "X", status: "success", body: "" }),
    ).rejects.toThrow(/missing required 'body' field/);
  });

  it("rejects a title that exceeds 200 characters", async () => {
    await expect(
      executeTool("send_teams_message", {
        title: "x".repeat(201),
        status: "success",
        body: "y",
      }),
    ).rejects.toThrow(/'title' exceeds 200 characters/);
  });

  it("rejects a status that exceeds 64 characters", async () => {
    await expect(
      executeTool("send_email", {
        title: "X",
        status: "x".repeat(65),
        body: "y",
      }),
    ).rejects.toThrow(/'status' exceeds 64 characters/);
  });

  it("rejects ASCII control characters in the title", async () => {
    await expect(
      executeTool("send_teams_message", {
        title: "badtitle",
        status: "success",
        body: "y",
      }),
    ).rejects.toThrow(/'title' contains control or formatting characters/);
  });

  it("rejects ASCII control characters in the status", async () => {
    await expect(
      executeTool("send_email", {
        title: "X",
        status: "success",
        body: "y",
      }),
    ).rejects.toThrow(/'status' contains control or formatting characters/);
  });

  it("rejects Unicode BiDi override in title (F8)", async () => {
    await expect(
      executeTool("send_teams_message", {
        title: "Status‮sseccus",
        status: "success",
        body: "y",
      }),
    ).rejects.toThrow(/'title' contains control or formatting characters/);
  });

  it("rejects zero-width characters in status (F8)", async () => {
    await expect(
      executeTool("send_email", {
        title: "X",
        status: "succ​ess",
        body: "y",
      }),
    ).rejects.toThrow(/'status' contains control or formatting characters/);
  });

  it("allows newlines in body (legitimate rich-text content)", async () => {
    await expect(
      executeTool("send_teams_message", {
        title: "X",
        status: "success",
        body: "line1\nline2\nline3",
      }),
    ).resolves.toBeDefined();
  });
});
