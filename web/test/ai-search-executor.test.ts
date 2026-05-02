import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Tests for the AI Search executor (searchKnowledgeBase).
//
//  Covers input validation, request shape, threshold filtering
//  (including the operator env-gate AI_SEARCH_ALLOW_DISABLE_THRESHOLD),
//  chunk truncation, NaN-score coercion, structured "no results"
//  responses, error surfacing, the 401-retry-once path, audit
//  logging, the bearer vs. apiKey auth-header branching, and the
//  MOCK_MODE happy path.
// ─────────────────────────────────────────────────────────────

const { loggerMocks, authMock, clearCacheMock, mockEnv } = vi.hoisted(() => {
  type AuthShape =
    | { kind: "bearer"; token: string }
    | { kind: "apiKey"; key: string };
  const authFn: () => Promise<AuthShape> = async () => ({
    kind: "bearer",
    token: "tkn-1",
  });
  return {
    loggerMocks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      emitEvent: vi.fn(),
    },
    authMock: vi.fn(authFn),
    clearCacheMock: vi.fn(),
    mockEnv: {
      MOCK_MODE: false,
      AI_SEARCH_ENDPOINT: "https://srch-test.search.windows.net",
      AI_SEARCH_INDEX_DEFAULT: "sharepoint-docx",
      AI_SEARCH_API_VERSION: "2024-07-01",
      AI_SEARCH_RERANKER_THRESHOLD: 1.5,
      AI_SEARCH_ALLOW_DISABLE_THRESHOLD: false,
    },
  };
});

vi.mock("../lib/config", () => ({
  env: mockEnv,
  REMEDIATE_MAX_EXPLICIT_MESSAGES: 20,
}));

vi.mock("../lib/logger", () => ({
  logger: loggerMocks,
  hashPii: (s: string) => `hash(${s})`,
}));

vi.mock("../lib/ai-search-auth", () => ({
  getAiSearchAuth: () => authMock(),
  clearAiSearchTokenCache: () => clearCacheMock(),
}));

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let fetchResponses: Response[] = [];

function makeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function azureHit(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    chunk: "Outside Counsel Guidelines apply to all engaged law firms…",
    header_1: "Outside Counsel Guidelines",
    header_2: "Overview",
    header_3: null,
    title: "Outside-Counsel-Guidelines.docx",
    url: "https://example.sharepoint.com/sites/InformationSecurity/Outside-Counsel-Guidelines.docx",
    lastModified: "2026-02-14T09:30:00Z",
    "@search.rerankerScore": 2.7,
    "@search.captions": [{ text: "Outside Counsel Guidelines apply…" }],
    ...overrides,
  };
}

beforeEach(() => {
  captured = [];
  fetchResponses = [];
  authMock.mockReset();
  authMock.mockResolvedValue({ kind: "bearer", token: "tkn-1" });
  clearCacheMock.mockReset();
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
  loggerMocks.debug.mockReset();
  mockEnv.MOCK_MODE = false;
  mockEnv.AI_SEARCH_ALLOW_DISABLE_THRESHOLD = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) headers[k] = h[k];
      }
      captured.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
        headers,
      });
      const next = fetchResponses.shift();
      return next ?? makeResponse(200, { value: [azureHit()] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import { executeTool } from "../lib/executors";

describe("searchKnowledgeBase — happy path", () => {
  it("returns ranked, captioned results with topRerankerScore set", async () => {
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({ "@search.rerankerScore": 2.7, url: "https://example.sharepoint.com/a" }),
          azureHit({ "@search.rerankerScore": 1.95, url: "https://example.sharepoint.com/b" }),
        ],
      }),
    );

    const result = (await executeTool("searchKnowledgeBase", {
      query: "outside counsel guidelines",
    })) as { status: string; results: unknown[]; topRerankerScore: number };

    expect(result.status).toBe("ok");
    expect(result.results).toHaveLength(2);
    expect(result.topRerankerScore).toBe(2.7);
    const first = result.results[0] as { rerankerScore: number; url: string };
    expect(first.rerankerScore).toBeGreaterThan(1.5);
    expect(first.url).toMatch(/^https:\/\/example\.sharepoint\.com\//);
  });

  it("posts the documented hybrid + semantic body to the right endpoint", async () => {
    await executeTool("searchKnowledgeBase", { query: "policy on outside counsel" });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain(
      "https://srch-test.search.windows.net/indexes/sharepoint-docx/docs/search?api-version=2024-07-01",
    );
    const body = captured[0].body as Record<string, unknown>;
    expect(body.search).toBe("policy on outside counsel");
    expect(body.queryType).toBe("semantic");
    expect(body.semanticConfiguration).toBe("default-semantic");
    expect(body.captions).toBe("extractive");
    expect(body.answers).toBe("extractive|count-3");
    const vq = body.vectorQueries as Array<Record<string, unknown>>;
    expect(vq[0]).toMatchObject({ kind: "text", fields: "vector", k: 50 });
  });

  it("does not include a `filter` field in the request body (filter dropped from v1)", async () => {
    await executeTool("searchKnowledgeBase", { query: "q" });
    expect(captured[0].body).not.toHaveProperty("filter");
  });
});

describe("searchKnowledgeBase — input validation", () => {
  it("clamps top to [1, 20]", async () => {
    await executeTool("searchKnowledgeBase", { query: "q", top: 0 });
    await executeTool("searchKnowledgeBase", { query: "q", top: 9999 });

    expect((captured[0].body as { top: number }).top).toBe(1);
    expect((captured[1].body as { top: number }).top).toBe(20);
  });

  it("rejects unsupported index values with a helpful error", async () => {
    await expect(
      executeTool("searchKnowledgeBase", { query: "q", index: "runbooks" }),
    ).rejects.toThrow(/unsupported index "runbooks"/);
    expect(captured).toHaveLength(0);
  });

  it("rejects oversized query strings", async () => {
    await expect(
      executeTool("searchKnowledgeBase", { query: "x".repeat(2_001) }),
    ).rejects.toThrow(/exceeds 2000 characters/);
    expect(captured).toHaveLength(0);
  });

  it("rejects empty / whitespace queries", async () => {
    await expect(
      executeTool("searchKnowledgeBase", { query: "   " }),
    ).rejects.toThrow(/non-empty/);
  });

  it("ignores any model-supplied disableRerankerThreshold input", async () => {
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({ "@search.rerankerScore": 0.4 }),
        ],
      }),
    );

    // The schema does NOT expose disableRerankerThreshold, but a
    // prompt-injected tool_use could still pass it. The executor must
    // respect only env.AI_SEARCH_ALLOW_DISABLE_THRESHOLD.
    const result = (await executeTool("searchKnowledgeBase", {
      query: "q",
      disableRerankerThreshold: true,
    })) as { status: string };

    expect(result.status).toBe("no_results");
  });
});

describe("searchKnowledgeBase — threshold filtering", () => {
  it("drops results with rerankerScore below the threshold by default", async () => {
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({ "@search.rerankerScore": 2.1, url: "https://example.sharepoint.com/a" }),
          azureHit({ "@search.rerankerScore": 1.9, url: "https://example.sharepoint.com/b" }),
          azureHit({ "@search.rerankerScore": 1.0, url: "https://example.sharepoint.com/c" }),
        ],
      }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
      results: { rerankerScore: number }[];
    };

    expect(result.status).toBe("ok");
    expect(result.results.map((r) => r.rerankerScore)).toEqual([2.1, 1.9]);
  });

  it("returns all results when AI_SEARCH_ALLOW_DISABLE_THRESHOLD is set by ops", async () => {
    mockEnv.AI_SEARCH_ALLOW_DISABLE_THRESHOLD = true;
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({ "@search.rerankerScore": 2.1 }),
          azureHit({ "@search.rerankerScore": 1.9 }),
          azureHit({ "@search.rerankerScore": 1.0 }),
        ],
      }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
      results: unknown[];
    };

    expect(result.status).toBe("ok");
    expect(result.results).toHaveLength(3);
  });

  it("returns reason='below_threshold' when hits exist but none clear the bar", async () => {
    fetchResponses.push(
      makeResponse(200, { value: [azureHit({ "@search.rerankerScore": 0.4 })] }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
      reason: string;
      suggestion: string;
    };

    expect(result.status).toBe("no_results");
    expect(result.reason).toBe("below_threshold");
    expect(result.suggestion).toMatch(/threshold/);
  });

  it("returns reason='empty_index' when value=[]", async () => {
    fetchResponses.push(makeResponse(200, { value: [] }));

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
      reason: string;
    };

    expect(result.status).toBe("no_results");
    expect(result.reason).toBe("empty_index");
  });

  it("coerces NaN reranker scores to 0 (which is below threshold)", async () => {
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({ "@search.rerankerScore": Number.NaN }),
          azureHit({ "@search.rerankerScore": 2.0 }),
        ],
      }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
      results: { rerankerScore: number }[];
    };

    expect(result.status).toBe("ok");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].rerankerScore).toBe(2.0);
  });
});

describe("searchKnowledgeBase — chunk and caption shaping", () => {
  it("truncates oversized chunks to ~1500 chars + ellipsis and sets truncated=true", async () => {
    const big = "x".repeat(5_000);
    fetchResponses.push(
      makeResponse(200, { value: [azureHit({ chunk: big })] }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      results: { chunk: string }[];
      truncated: boolean;
    };

    expect(result.results[0].chunk.length).toBeLessThanOrEqual(1_501);
    expect(result.results[0].chunk.endsWith("…")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("reports truncated=false when no returned chunk hit the cap", async () => {
    fetchResponses.push(makeResponse(200, { value: [azureHit({ chunk: "short chunk" })] }));

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
  });

  it("caps captions to 3 entries per hit, each ≤300 chars", async () => {
    const big = "y".repeat(800);
    fetchResponses.push(
      makeResponse(200, {
        value: [
          azureHit({
            "@search.captions": [
              { text: big },
              { text: "second" },
              { text: "third" },
              { text: "fourth — should be dropped" },
              { text: "fifth — should be dropped" },
            ],
          }),
        ],
      }),
    );

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      results: { captions: string[] }[];
    };

    expect(result.results[0].captions).toHaveLength(3);
    expect(result.results[0].captions[0].length).toBeLessThanOrEqual(301);
    expect(result.results[0].captions[0].endsWith("…")).toBe(true);
    expect(result.results[0].captions[3]).toBeUndefined();
  });
});

describe("searchKnowledgeBase — error paths", () => {
  it("surfaces 5xx errors with a structured message", async () => {
    fetchResponses.push(makeResponse(503, "Service Unavailable"));

    await expect(
      executeTool("searchKnowledgeBase", { query: "q" }),
    ).rejects.toThrow(/AI Search request failed \(503\)/);
  });

  it("retries exactly once on 401 with a fresh token", async () => {
    fetchResponses.push(makeResponse(401, "expired"));
    fetchResponses.push(makeResponse(200, { value: [azureHit()] }));

    authMock.mockResolvedValueOnce({ kind: "bearer", token: "tkn-1" });
    authMock.mockResolvedValueOnce({ kind: "bearer", token: "tkn-2" });

    const result = (await executeTool("searchKnowledgeBase", { query: "q" })) as {
      status: string;
    };

    expect(clearCacheMock).toHaveBeenCalledTimes(1);
    expect(authMock).toHaveBeenCalledTimes(2);
    expect(captured[0].headers.Authorization).toBe("Bearer tkn-1");
    expect(captured[1].headers.Authorization).toBe("Bearer tkn-2");
    expect(result.status).toBe("ok");
  });
});

describe("searchKnowledgeBase — audit logging", () => {
  it("emits exactly one logger.info on success with the documented metadata", async () => {
    fetchResponses.push(makeResponse(200, { value: [azureHit()] }));

    await executeTool("searchKnowledgeBase", { query: "outside counsel guidelines" });

    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    const [, , metadata] = loggerMocks.info.mock.calls[0];
    expect(metadata).toMatchObject({
      toolName: "searchKnowledgeBase",
      query: "outside counsel guidelines",
      resultCount: 1,
      searchIndex: "sharepoint-docx",
    });
    expect(typeof metadata.topRerankerScore).toBe("number");
    expect(Array.isArray(metadata.urls)).toBe(true);
    // Must not log raw chunk content.
    expect(JSON.stringify(metadata)).not.toContain("Outside Counsel Guidelines apply");
  });
});

describe("searchKnowledgeBase — auth header branching", () => {
  it("sends Bearer when auth resolves to kind=bearer", async () => {
    authMock.mockResolvedValue({ kind: "bearer", token: "abc" });
    await executeTool("searchKnowledgeBase", { query: "q" });
    expect(captured[0].headers.Authorization).toBe("Bearer abc");
    expect(captured[0].headers["api-key"]).toBeUndefined();
  });

  it("sends api-key header when auth resolves to kind=apiKey (local-dev fallback)", async () => {
    authMock.mockResolvedValue({ kind: "apiKey", key: "secret-key" });
    await executeTool("searchKnowledgeBase", { query: "q" });
    expect(captured[0].headers["api-key"]).toBe("secret-key");
    expect(captured[0].headers.Authorization).toBeUndefined();
  });
});

describe("searchKnowledgeBase — MOCK_MODE", () => {
  it("returns synthetic results without hitting the network", async () => {
    mockEnv.MOCK_MODE = true;

    const result = (await executeTool("searchKnowledgeBase", {
      query: "what's the outside counsel policy",
    })) as { status: string; results: { url: string; rerankerScore: number }[] };

    expect(result.status).toBe("ok");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].url).toMatch(/^https:\/\/example\.sharepoint\.com\//);
    expect(captured).toHaveLength(0);
  });
});
