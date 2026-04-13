import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth
const resolveAuthMock = vi.fn();
vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: (req: unknown) => resolveAuthMock(req),
}));

// Mock logger
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (x: string) => x,
  setLogContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
}));

// Mock agent loop
const runAgentLoopMock = vi.fn();
vi.mock("../lib/agent", () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
}));

// Mock config
vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    getSystemPrompt: async () => "base prompt",
    DEFAULT_MODEL: "claude-sonnet-4-6",
    env: {
      ...(actual.env as Record<string, unknown>),
      COSMOS_ENDPOINT: "https://mock.cosmos",
      TRIAGE_DEDUP_WINDOW_MS: 86400000,
      TRIAGE_CONFIDENCE_THRESHOLD: 0.80,
      TRIAGE_SEVERITY_ALLOWLIST: "Informational,Low,Medium,High",
      TRIAGE_CIRCUIT_BREAKER_THRESHOLD: 0.30,
      TRIAGE_CIRCUIT_BREAKER_WINDOW_MS: 900000,
      TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS: 1800000,
      TRIAGE_CALLER_ALLOWLIST: "",
      TRIAGE_RAW_PAYLOAD_MAX_BYTES: 500000,
    },
  };
});

// Mock triage store
vi.mock("../lib/triage-store", () => ({
  createTriageRun: vi.fn(),
  getTriageRunByAlertId: vi.fn().mockResolvedValue(null),
  updateTriageRun: vi.fn(),
}));

// Mock usage tracker
vi.mock("../lib/usage-tracker", () => ({
  recordUsage: vi.fn(),
}));

// Mock skill store (needed by triage-dispatch)
const getSkillMock = vi.fn().mockImplementation((id: string) => {
  const skills: Record<string, unknown> = {
    "defender-endpoint-triage": {
      id: "defender-endpoint-triage",
      name: "Defender Endpoint Triage",
      instructions: "investigate",
      requiredTools: ["get_xdr_alert"],
      requiredRole: "reader",
    },
    "generic-alert-triage": {
      id: "generic-alert-triage",
      name: "Generic Alert Triage",
      instructions: "investigate generically",
      requiredTools: ["run_sentinel_kql"],
      requiredRole: "reader",
    },
  };
  return skills[id] ?? undefined;
});
vi.mock("../lib/skill-store", () => ({
  getSkill: (id: string) => getSkillMock(id),
  getSkillsForRole: () => [],
}));

// Mock circuit breaker
vi.mock("../lib/triage-circuit-breaker", () => ({
  checkCircuitBreaker: vi.fn().mockReturnValue({ open: false }),
  recordTriageOutcome: vi.fn(),
}));

import { POST } from "../app/api/triage/route";
import type { TriageResponse } from "../lib/types";

function makeRequest(body: unknown, authValid = true): Request {
  resolveAuthMock.mockResolvedValue(
    authValid
      ? { role: "admin", name: "logic-app", ownerId: "sp-001", provider: "service-principal" }
      : null,
  );
  return new Request("http://localhost:3000/api/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    source: {
      product: "DefenderXDR",
      alertType: "DefenderEndpoint.SuspiciousProcess",
      severity: "Medium",
      tenantId: "test-tenant",
      alertId: `alert-${Date.now()}`,
      detectionTime: "2026-04-12T14:00:00Z",
    },
    payload: {
      essentials: {
        title: "Suspicious PowerShell",
        description: "powershell.exe ran with encoded command",
        entities: { users: ["user@test.com"], devices: ["LAPTOP-X1"] },
      },
    },
    context: {
      requesterId: "logic-app-sentinel",
      dryRun: false,
    },
  };
}

const defaultSkills: Record<string, unknown> = {
  "defender-endpoint-triage": {
    id: "defender-endpoint-triage",
    name: "Defender Endpoint Triage",
    instructions: "investigate",
    requiredTools: ["get_xdr_alert"],
    requiredRole: "reader",
  },
  "generic-alert-triage": {
    id: "generic-alert-triage",
    name: "Generic Alert Triage",
    instructions: "investigate generically",
    requiredTools: ["run_sentinel_kql"],
    requiredRole: "reader",
  },
};

describe("POST /api/triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default skill-store implementation after each test
    getSkillMock.mockImplementation((id: string) => defaultSkills[id] ?? undefined);
    // Default: agent loop returns a valid verdict tool call
    runAgentLoopMock.mockResolvedValue({
      type: "response",
      text: "",
      messages: [
        { role: "user", content: "investigate" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tu-1",
            name: "respond_with_triage_verdict",
            input: {
              verdict: "benign",
              confidence: 0.92,
              reasoning: "Process is legitimate admin tooling.",
              evidence: [{ source: "DefenderXDR", finding: "Known IT tool" }],
              recommendedActions: [{ action: "close", reason: "Benign activity" }],
            },
          }],
        },
      ],
    });
  });

  it("returns a well-formed verdict for a valid request", async () => {
    const res = await POST(makeRequest(validBody()) as never);
    expect(res.status).toBe(200);
    const json: TriageResponse = await res.json();
    expect(json.verdict).toBe("benign");
    expect(json.confidence).toBe(0.92);
    expect(json.neoRunId).toMatch(/^triage_/);
    expect(json.skillUsed).toBe("defender-endpoint-triage");
    expect(json.reasoning).toContain("legitimate");
  });

  it("returns 401 for unauthenticated requests", async () => {
    const res = await POST(makeRequest(validBody(), false) as never);
    expect(res.status).toBe(401);
  });

  it("returns 400 for a malformed request body (missing source)", async () => {
    const res = await POST(makeRequest({ payload: {}, context: {} }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("source");
  });

  it("returns 400 for a missing alertId", async () => {
    const body = validBody();
    (body.source as Record<string, unknown>).alertId = "";
    const res = await POST(makeRequest(body) as never);
    expect(res.status).toBe(400);
  });

  it("returns inconclusive with no_skill_registered when no skills match", async () => {
    // Override skill store to return nothing for any skill ID
    getSkillMock.mockReturnValue(undefined);

    const body = validBody();
    body.source.alertType = "Unknown.AlertType";
    const res = await POST(makeRequest(body) as never);
    const json: TriageResponse = await res.json();
    expect(json.verdict).toBe("inconclusive");
    expect(json.reason).toBe("no_skill_registered");
  });

  it("returns escalate with neo_parse_failure when agent loop has no verdict tool call", async () => {
    runAgentLoopMock.mockResolvedValue({
      type: "response",
      text: "I could not determine a verdict",
      messages: [
        { role: "user", content: "investigate" },
        { role: "assistant", content: [{ type: "text", text: "no tool call" }] },
      ],
    });
    const res = await POST(makeRequest(validBody()) as never);
    const json: TriageResponse = await res.json();
    expect(json.verdict).toBe("escalate");
    expect(json.reason).toBe("neo_parse_failure");
  });

  it("returns escalate with neo_internal_error on an unhandled exception", async () => {
    runAgentLoopMock.mockRejectedValue(new Error("Claude is down"));
    const res = await POST(makeRequest(validBody()) as never);
    expect(res.status).toBe(200); // Never 500
    const json: TriageResponse = await res.json();
    expect(json.verdict).toBe("escalate");
    expect(json.reason).toBe("neo_internal_error");
  });
});
