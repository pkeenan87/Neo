import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      TRIAGE_CONFIDENCE_THRESHOLD: 0.80,
      TRIAGE_SEVERITY_ALLOWLIST: "Informational,Low,Medium,High",
    },
  };
});

import { applyGuardrails, parseTriageResult } from "../lib/triage-wrapper";
import type { TriageResponse, TriageSource, AgentLoopResult } from "../lib/types";

function makeResponse(overrides: Partial<TriageResponse> = {}): TriageResponse {
  return {
    verdict: "benign",
    confidence: 0.92,
    reasoning: "Test reasoning",
    evidence: [],
    recommendedActions: [],
    neoRunId: "run-001",
    skillUsed: "test-skill",
    durationMs: 1000,
    ...overrides,
  };
}

function makeSource(overrides: Partial<TriageSource> = {}): TriageSource {
  return {
    product: "DefenderXDR",
    alertType: "DefenderEndpoint.SuspiciousProcess",
    severity: "Low",
    tenantId: "test-tenant",
    alertId: "alert-001",
    detectionTime: "2026-04-12T00:00:00Z",
    ...overrides,
  };
}

describe("applyGuardrails", () => {
  it("passes through a benign verdict with high confidence", () => {
    const result = applyGuardrails(makeResponse(), makeSource());
    expect(result.verdict).toBe("benign");
    expect(result.originalVerdict).toBeUndefined();
  });

  it("coerces to escalate when confidence is below threshold", () => {
    const result = applyGuardrails(
      makeResponse({ confidence: 0.65 }),
      makeSource(),
    );
    expect(result.verdict).toBe("escalate");
    expect(result.originalVerdict).toBe("benign");
    expect(result.originalConfidence).toBe(0.65);
    expect(result.reason).toBe("confidence_below_threshold");
  });

  it("does not coerce an escalate verdict regardless of confidence", () => {
    const result = applyGuardrails(
      makeResponse({ verdict: "escalate", confidence: 0.50 }),
      makeSource(),
    );
    expect(result.verdict).toBe("escalate");
    expect(result.originalVerdict).toBeUndefined();
  });

  it("allows all severities when the default allowlist includes all levels", () => {
    for (const severity of ["Informational", "Low", "Medium", "High"] as const) {
      const result = applyGuardrails(makeResponse(), makeSource({ severity }));
      expect(result.verdict).toBe("benign");
    }
  });
});

describe("parseTriageResult — fail-safe", () => {
  it("returns escalate with neo_parse_failure when no verdict tool call is found", () => {
    const agentResult: AgentLoopResult = {
      type: "response",
      text: "I couldn't determine a verdict.",
      messages: [
        { role: "user", content: "investigate" },
        { role: "assistant", content: [{ type: "text", text: "No tool call" }] },
      ],
    };
    const result = parseTriageResult(agentResult, "run-001", "test-skill", 500, false);
    expect(result.verdict).toBe("escalate");
    expect(result.reason).toBe("neo_parse_failure");
  });

  it("returns escalate with destructive_tool_blocked when confirmation is required", () => {
    const agentResult: AgentLoopResult = {
      type: "confirmation_required",
      tool: { id: "tool-1", name: "isolate_machine", input: {} },
      messages: [],
    };
    const result = parseTriageResult(agentResult, "run-001", "test-skill", 500, false);
    expect(result.verdict).toBe("escalate");
    expect(result.reason).toBe("destructive_tool_blocked");
  });

  it("includes dryRun flag when set", () => {
    const agentResult: AgentLoopResult = {
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
              confidence: 0.95,
              reasoning: "All clear",
              evidence: [],
              recommendedActions: [],
            },
          }],
        },
      ],
    };
    const result = parseTriageResult(agentResult, "run-001", "test-skill", 500, true);
    expect(result.verdict).toBe("benign");
    expect(result.dryRun).toBe(true);
  });
});
