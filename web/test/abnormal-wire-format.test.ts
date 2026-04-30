import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────
//  Wire-format tests for the Abnormal Security tools.
//
//  The Xsoar reference integration
//  (Packs/AbnormalSecurity/Integrations/AbnormalSecurity/AbnormalSecurity.py)
//  is the canonical authority for what shape the API expects:
//
//    POST /v1/search
//      URL:  ?pageNumber=N&pageSize=N      ← MUST be query params
//      BODY: { source, filters }            ← time bounds nest in filters
//
//    POST /v1/search/remediate
//      BODY: { action, source, remediation_reason,
//              [messages | (remediate_all + search_filters)] }
//                                           ← time bounds nest in search_filters
//
//  These tests pin both shapes so the next regression doesn't silently
//  return page-1 results for every page (the original symptom that
//  motivated this fix), and so a future "lift time bounds to top
//  level" attempt fails loudly instead of silently breaking the API
//  contract.
// ──────────────────────────────────────────────────────────────

vi.mock("../lib/config", () => ({
  env: { MOCK_MODE: false },
  REMEDIATE_MAX_EXPLICIT_MESSAGES: 20,
}));

vi.mock("../lib/secrets", () => ({
  getToolSecret: vi.fn(async (name: string) => {
    if (name === "ABNORMAL_API_TOKEN") return "test-token";
    return undefined;
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let captured: CapturedRequest[] = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      captured.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import { executeTool } from "../lib/executors";

describe("abnormal wire format — POST /v1/search", () => {
  it("sends pageNumber + pageSize as URL query params, NOT body fields", async () => {
    await executeTool("search_abnormal_messages", {
      page_number: 2,
      page_size: 100,
      sender_email: "test@example.com",
    });

    expect(captured).toHaveLength(1);
    const [req] = captured;

    // Pagination MUST appear in the URL — putting them in the body
    // is what made page 2 silently return page 1.
    expect(req.url).toContain("?pageNumber=2&pageSize=100");
    expect(req.url).toContain("/v1/search?");

    // And MUST NOT be in the body.
    expect(req.body).not.toHaveProperty("page_number");
    expect(req.body).not.toHaveProperty("page_size");
    expect(req.body).not.toHaveProperty("pageNumber");
    expect(req.body).not.toHaveProperty("pageSize");
  });

  it("nests start_time / end_time inside `filters`, not at body top level", async () => {
    await executeTool("search_abnormal_messages", {
      start_time: "2026-04-01T00:00:00Z",
      end_time: "2026-04-30T00:00:00Z",
      sender_email: "test@example.com",
    });

    const [req] = captured;
    const body = req.body as { filters?: Record<string, unknown> };

    // Per Xsoar reference: time bounds belong inside `filters`.
    expect(body.filters?.start_time).toBe("2026-04-01T00:00:00Z");
    expect(body.filters?.end_time).toBe("2026-04-30T00:00:00Z");

    // Top-level body MUST NOT have these — Abnormal's /search ignores
    // them at top level, and a stale value there would silently widen
    // (or invalidate) the search scope.
    expect(req.body).not.toHaveProperty("start_time");
    expect(req.body).not.toHaveProperty("end_time");
  });

  it("clamps page_size to [1, 1000] and floors page_number at 1", async () => {
    await executeTool("search_abnormal_messages", { page_size: 99999, page_number: 0 });
    expect(captured[0].url).toContain("pageSize=1000");
    expect(captured[0].url).toContain("pageNumber=1");

    captured = [];
    await executeTool("search_abnormal_messages", { page_size: -5, page_number: -10 });
    expect(captured[0].url).toContain("pageSize=1");
    expect(captured[0].url).toContain("pageNumber=1");
  });

  it("defaults missing time bounds to a 48h fallback inside filters", async () => {
    await executeTool("search_abnormal_messages", {});
    const [req] = captured;
    const body = req.body as { filters?: { start_time?: string; end_time?: string } };

    expect(body.filters?.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.filters?.end_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const start = new Date(body.filters!.start_time!).getTime();
    const end = new Date(body.filters!.end_time!).getTime();
    // 48h window ±5 min for clock skew
    expect(end - start).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(end - start).toBeLessThan(49 * 60 * 60 * 1000);
  });
});

describe("abnormal wire format — POST /v1/search/remediate", () => {
  it("passes search_filters intact (time bounds stay nested) when remediate_all is true", async () => {
    await executeTool("remediate_abnormal_messages", {
      action: "delete",
      remediation_reason: "false_negative",
      justification: "test",
      remediate_all: true,
      search_filters: {
        start_time: "2026-04-01T00:00:00Z",
        end_time: "2026-04-30T00:00:00Z",
        sender_email: "bad@example.com",
      },
    });

    const [req] = captured;
    expect(req.url).toContain("/v1/search/remediate");

    const body = req.body as { search_filters?: Record<string, unknown>; remediate_all?: boolean };

    // Time bounds MUST stay inside search_filters per Xsoar.
    expect(body.search_filters?.start_time).toBe("2026-04-01T00:00:00Z");
    expect(body.search_filters?.end_time).toBe("2026-04-30T00:00:00Z");
    expect(body.search_filters?.sender_email).toBe("bad@example.com");

    // Top-level body MUST NOT have these.
    expect(req.body).not.toHaveProperty("start_time");
    expect(req.body).not.toHaveProperty("end_time");
    expect(body.remediate_all).toBe(true);
  });

  it("passes explicit `messages` array unchanged when not using remediate_all", async () => {
    await executeTool("remediate_abnormal_messages", {
      action: "delete",
      remediation_reason: "false_negative",
      justification: "test",
      messages: [{ message_id: "m1", recipient_email: "a@x.com" }],
    });

    const [req] = captured;
    const body = req.body as { messages?: { message_id: string }[] };
    expect(body.messages).toEqual([{ message_id: "m1", recipient_email: "a@x.com" }]);
    expect(req.body).not.toHaveProperty("remediate_all");
    expect(req.body).not.toHaveProperty("search_filters");
  });
});
