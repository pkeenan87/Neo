// ─────────────────────────────────────────────────────────────
//  Streamable HTTP MCP client (Neo-side)
//
//  Used when Neo needs to act as the MCP client itself instead of
//  registering the server with Anthropic's API-side `mcp_servers`
//  connector. Today's caller is the Information Security Incident
//  Response Logic App integration — every tool is destructive and
//  must hit Neo's confirmation gate, which only fires for local
//  tool dispatch. Future caller is the Wiz re-enable (path #3 from
//  PR #59) where service-account auth requires three custom HTTP
//  headers Anthropic's connector can't forward.
//
//  Wire contract (verified against the live Infosec Logic App via
//  Postman on 2026-05-15 — see _specs/infosec-incident-response-mcp.md):
//
//    POST <url>
//    Authorization: Bearer <token>   OR custom headers per strategy
//    Content-Type: application/json
//    Accept: application/json, text/event-stream
//    Mcp-Session-Id: <if any>
//
//    body: JSON-RPC 2.0 { jsonrpc, id, method, params }
//
//  Handshake order (REQUIRED — Logic App rejects tools/call without
//  a prior initialize + notifications/initialized):
//
//    1. initialize → 200 with `Mcp-Session-Id` response header
//    2. notifications/initialized → 202 Accepted, no body
//    3. tools/call → 200 with the tool result, OR streaming SSE
//
//  Session caching: one promise per URL serialises concurrent
//  first-turn calls so only one handshake fires. On 401 mid-session
//  (token expired or server-side session evicted), the cache is
//  invalidated and one retry fires automatically.
// ─────────────────────────────────────────────────────────────

import { logger } from "./logger";

// SECURITY: literal-Set allowlist for outbound MCP URLs. CodeQL's
// `js/request-forgery` rule rejects regex `.test()` as a sanitiser
// but accepts Set-membership against literal strings — same
// learning from PRs #57 / #58. The probe and runtime paths share
// this allowlist. Adding a new environment is a deliberate code
// change.
export const INFOSEC_LOGIC_APP_URL_ALLOWLIST = new Set<string>([
  "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp",
]);

const FETCH_TIMEOUT_MS = 10_000;

// Auth strategy. Discriminated union so a future Wiz re-enable can
// add `{ type: "customHeaders"; ... }` without a refactor.
export type AuthStrategy =
  | { type: "bearer"; tokenFactory: () => Promise<string> }
  | { type: "customHeaders"; headerFactory: () => Promise<Record<string, string>> };

export interface McpClientOptions {
  url: string;
  authStrategy: AuthStrategy;
  clientInfo: { name: string; version: string };
  protocolVersion?: string;
}

/**
 * Tool-result envelope returned by `McpClient.callTool`. The
 * `content` field carries the JSON-RPC `result.content` array
 * verbatim (each entry typed by MCP as `text | image | ...`). The
 * `correlationHeaders` field captures Azure API Management +
 * Logic App workflow run identifiers so the executor can plumb
 * them into the `tool_execution` audit event.
 */
export interface McpToolResult {
  content: unknown[];
  isError: boolean;
  correlationHeaders: {
    apiManagementRequestId?: string;
    apiManagementMiddlewareRequestId?: string;
    workflowRunId?: string;
    mcpSessionId?: string;
  };
}

interface McpSession {
  sessionId: string;
  // resolved auth: either bearer (Authorization header) or a map of
  // pre-built headers. The session caches the *resolved* values so
  // retries don't re-call the factory unless the cache is cleared.
  resolvedAuth:
    | { type: "bearer"; token: string }
    | { type: "customHeaders"; headers: Record<string, string> };
}

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// Module-scope rolling JSON-RPC `id` so successive requests don't
// collide on the same value (some MCP servers care, some don't —
// being defensive).
let nextRpcId = 1;

export class McpClient {
  private readonly url: string;
  private readonly authStrategy: AuthStrategy;
  private readonly clientInfo: { name: string; version: string };
  private readonly protocolVersion: string;
  private session: Promise<McpSession> | null = null;

  constructor(opts: McpClientOptions) {
    if (!INFOSEC_LOGIC_APP_URL_ALLOWLIST.has(opts.url)) {
      throw new Error(
        `MCP URL '${opts.url}' is not in INFOSEC_LOGIC_APP_URL_ALLOWLIST. Add it explicitly to enable.`,
      );
    }
    this.url = opts.url;
    this.authStrategy = opts.authStrategy;
    this.clientInfo = opts.clientInfo;
    this.protocolVersion = opts.protocolVersion ?? "2025-06-18";
  }

  /**
   * Force the initialize → notifications/initialized handshake to
   * complete. Used by the probe (which wants to validate
   * reachability without invoking a destructive tool) and called
   * implicitly by `callTool`.
   */
  async ensureSession(): Promise<McpSession> {
    if (this.session) return this.session;
    this.session = this.handshake();
    try {
      return await this.session;
    } catch (err) {
      // On failure invalidate the cached promise so the next caller
      // tries again instead of awaiting a permanently-rejected
      // promise.
      this.session = null;
      throw err;
    }
  }

  /**
   * Call an MCP tool. Handles handshake, session-header
   * propagation, 401-retry-with-reinit (max once), and correlation
   * header extraction.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.callToolWithRetry(toolName, args, /* allowRetry */ true);
  }

  /**
   * Public hook to reset the cached session — used by the probe
   * after credential rotation and exposed for test isolation.
   */
  reset(): void {
    this.session = null;
  }

  private async callToolWithRetry(
    toolName: string,
    args: Record<string, unknown>,
    allowRetry: boolean,
  ): Promise<McpToolResult> {
    const session = await this.ensureSession();

    const headers = this.buildHeaders(session, /* includeSessionId */ true);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

    const res = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      body,
    });

    // 401 only — NOT 403. 401 = "your bearer is stale/missing", which a
    // re-handshake can fix. 403 = "your bearer is valid but you don't
    // have permission for this tool" — re-handshaking will just produce
    // the same identity and the same 403, doubling the request volume
    // against the upstream. See ultra-review MEDIUM #6.
    if (res.status === 401) {
      if (!allowRetry) {
        const bodyText = (await res.text().catch(() => "")).slice(0, 500);
        throw new Error(
          `MCP tools/call rejected after retry (HTTP ${res.status}): ${bodyText}`,
        );
      }
      // Stale session or expired token. Drop the cached promise
      // and retry once with a fresh handshake.
      logger.warn(
        "mcp-client: 401 on tools/call — invalidating session and retrying once",
        "mcp-client",
        { statusCode: res.status, toolName },
      );
      this.session = null;
      return this.callToolWithRetry(toolName, args, /* allowRetry */ false);
    }

    if (!res.ok) {
      const bodyText = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `MCP tools/call failed (HTTP ${res.status}): ${bodyText}`,
      );
    }

    const correlationHeaders = this.extractCorrelationHeaders(res, session.sessionId);
    const payload = await this.readJsonRpcBody<{
      content: unknown[];
      isError?: boolean;
    }>(res);

    if ("error" in payload) {
      // JSON-RPC error envelope — tool dispatched but server-side
      // refused the call. Surface as a structured error so the
      // executor can wrap it in the tool_result envelope without
      // crashing the agent loop.
      throw new Error(
        `MCP tools/call returned JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
      );
    }

    return {
      content: payload.result.content ?? [],
      isError: Boolean(payload.result.isError),
      correlationHeaders,
    };
  }

  private async handshake(): Promise<McpSession> {
    const resolvedAuth = await this.resolveAuth();

    // 1. initialize
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    });

    const initHeaders = this.buildHeadersFromAuth(resolvedAuth);
    const initRes = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: initHeaders,
      body: initBody,
    });

    if (!initRes.ok) {
      const bodyText = (await initRes.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `MCP initialize failed (HTTP ${initRes.status}): ${bodyText}`,
      );
    }

    // The server's session id arrives as a response header (case-
    // insensitive). Required on every subsequent request.
    const sessionId = initRes.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      throw new Error(
        "MCP initialize succeeded but the server did not return an Mcp-Session-Id response header — refusing to proceed without one.",
      );
    }

    // Drain the body to release the connection.
    await initRes.text().catch(() => "");

    const session: McpSession = { sessionId, resolvedAuth };

    // 2. notifications/initialized — 202 Accepted with no body.
    const ackHeaders = this.buildHeaders(session, /* includeSessionId */ true);
    const ackRes = await fetch(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: ackHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    if (!ackRes.ok && ackRes.status !== 202) {
      const bodyText = (await ackRes.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `MCP notifications/initialized rejected (HTTP ${ackRes.status}): ${bodyText}`,
      );
    }
    // Drain body.
    await ackRes.text().catch(() => "");

    logger.info("mcp-client: handshake complete", "mcp-client", {
      mcpSessionId: sessionId,
    });

    return session;
  }

  private async resolveAuth(): Promise<McpSession["resolvedAuth"]> {
    if (this.authStrategy.type === "bearer") {
      const token = await this.authStrategy.tokenFactory();
      return { type: "bearer", token };
    }
    const headers = await this.authStrategy.headerFactory();
    return { type: "customHeaders", headers };
  }

  private buildHeaders(
    session: McpSession,
    includeSessionId: boolean,
  ): Record<string, string> {
    const headers = this.buildHeadersFromAuth(session.resolvedAuth);
    if (includeSessionId) headers["Mcp-Session-Id"] = session.sessionId;
    return headers;
  }

  private buildHeadersFromAuth(auth: McpSession["resolvedAuth"]): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${auth.token}`;
    } else {
      Object.assign(headers, auth.headers);
    }
    return headers;
  }

  private extractCorrelationHeaders(
    res: Response,
    sessionId: string,
  ): McpToolResult["correlationHeaders"] {
    const get = (name: string): string | undefined => {
      const v = res.headers.get(name);
      return v === null ? undefined : v;
    };
    return {
      apiManagementRequestId: get("x-ms-request-id"),
      apiManagementMiddlewareRequestId: get("x-ms-middleware-request-id"),
      workflowRunId: get("Workflow-Run-Id") ?? get("x-ms-workflow-run-id"),
      mcpSessionId: sessionId,
    };
  }

  private async readJsonRpcBody<T>(res: Response): Promise<JsonRpcResponse<T>> {
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // SSE response — consume events and use the LAST `data:` JSON
      // payload as the result. Logic App responses today are
      // synchronous JSON (verified 2026-05-15) so this branch is
      // defensive but tested.
      const text = await res.text();
      const lastDataLine = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .pop();
      if (!lastDataLine) {
        throw new Error("MCP SSE response contained no `data:` events");
      }
      const json = lastDataLine.slice("data:".length).trim();
      return JSON.parse(json) as JsonRpcResponse<T>;
    }
    return (await res.json()) as JsonRpcResponse<T>;
  }
}

// ─────────────────────────────────────────────────────────────
//  Per-URL singleton registry
//
//  Memoising one McpClient per URL means concurrent first-turn
//  callers serialise on the same handshake Promise. The auth
//  strategy is captured at construction time — if the underlying
//  credentials rotate, call `reset()` on the client to force a
//  fresh handshake on the next call (factories will re-resolve).
// ─────────────────────────────────────────────────────────────

const clientRegistry = new Map<string, McpClient>();

export function getMcpClient(
  url: string,
  authStrategy: AuthStrategy,
  clientInfo: { name: string; version: string } = { name: "neo", version: "1.0.0" },
): McpClient {
  const existing = clientRegistry.get(url);
  if (existing) return existing;
  const client = new McpClient({ url, authStrategy, clientInfo });
  clientRegistry.set(url, client);
  return client;
}

/** Test-only: wipe the per-URL singleton cache. Not part of the
 * runtime API — see web/test/mcp-client.test.ts for usage. */
export function __resetMcpClientCache(): void {
  clientRegistry.clear();
}
