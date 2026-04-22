/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

// ─── Mocks required by conversation-store-v2 ────────────────
// We only call the pure rebuildConversationFromDocs helper, so the
// mocks just satisfy the module's import graph.

vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/" },
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
}));
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));
vi.mock("../lib/tool-result-blob-store", () => ({
  isBlobRefDescriptor: (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    return (v as { _neo_blob_ref?: unknown })._neo_blob_ref === true;
  },
  promoteStagingBlob: vi.fn(),
  resolveBlobRef: vi.fn(),
}));
vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) {
      return { container: () => ({}) };
    }
  },
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

import { rebuildConversationFromDocs } from "../lib/conversation-store-v2";
import type {
  ConversationV2Root,
  TurnDoc,
  BlobRefDescriptor,
  ToolTrace,
} from "../lib/types";

// ─── Mini harness mirroring ChatInterface's tool-trace render ──
//
// We don't pull in the full ChatInterface (too many side imports for
// a unit test). This mirrors the trace-accordion DOM structure so we
// can assert the descriptor renders compactly rather than as the full
// offloaded payload. Drift between this mirror and the real component
// is caught by the dedicated chat-tool-traces integration test.

function ToolTraceAccordion({ trace }: { trace: ToolTrace }) {
  const outputStr =
    typeof trace.output === "string"
      ? trace.output
      : JSON.stringify(trace.output, null, 2);
  return (
    <div>
      <details data-testid="trace">
        <summary data-testid="trace-summary">
          <span>{trace.name}</span>
        </summary>
        <div>
          <pre data-testid="trace-output">{outputStr}</pre>
        </div>
      </details>
    </div>
  );
}

// ─── Fixtures ───────────────────────────────────────────────

const BASE_ROOT: ConversationV2Root = {
  id: "conv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  docType: "root",
  conversationId: "conv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerId: "user_1",
  title: "Large KQL dump",
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
  role: "reader",
  channel: "web",
  schemaVersion: 2,
  retentionClass: "standard-7y",
  turnCount: 2,
  latestCheckpointId: null,
  rollingSummary: null,
  pendingConfirmation: null,
};

function makeDescriptorEnvelope(): string {
  const descriptor: BlobRefDescriptor = {
    _neo_blob_ref: true,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sizeBytes: 850_000,
    mediaType: "application/json",
    rawPrefix: "{ \"resultSet\": [ { \"account\": \"alice@corp.com\", \"count\": 12 }, …",
    uri: "https://neoblobs.blob.core.windows.net/tool-results/staging/e3b0c44298fc…",
    sourceTool: "run_sentinel_kql",
    conversationId: BASE_ROOT.conversationId,
  };
  return JSON.stringify(
    {
      _neo_trust_boundary: {
        source: "tool_offload",
        tool: "run_sentinel_kql",
        injection_detected: false,
      },
      data: descriptor,
    },
    null,
    2,
  );
}

// ─── Tests ──────────────────────────────────────────────────

describe("conversation hydration + render (v2 → ChatInterface)", () => {
  afterEach(() => cleanup());

  it("rebuildConversationFromDocs preserves the offloaded envelope in tool_result.content", () => {
    const envelope = makeDescriptorEnvelope();

    const assistantTurn: TurnDoc = {
      id: `turn_${BASE_ROOT.id}_1`,
      docType: "turn",
      conversationId: BASE_ROOT.id,
      turnNumber: 1,
      role: "assistant",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: BASE_ROOT.createdAt,
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "run_sentinel_kql",
          input: { query: "SigninLogs | take 1000" },
        },
      ],
    };

    const toolResultTurn: TurnDoc = {
      id: `turn_${BASE_ROOT.id}_2`,
      docType: "turn",
      conversationId: BASE_ROOT.id,
      turnNumber: 2,
      role: "user",
      parentTurnId: assistantTurn.id,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: BASE_ROOT.createdAt,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: envelope,
        },
      ],
    };

    const rebuilt = rebuildConversationFromDocs({
      root: BASE_ROOT,
      turns: [assistantTurn, toolResultTurn],
    });

    expect(rebuilt.messages).toHaveLength(2);
    const persistedResult = rebuilt.messages[1].content as unknown as Array<Record<string, unknown>>;
    expect(persistedResult[0].type).toBe("tool_result");
    // The raw envelope string round-trips unchanged — the client
    // renderer will surface the descriptor JSON without resolving
    // the blob payload inline.
    expect(persistedResult[0].content).toBe(envelope);
  });

  it("ToolTraceAccordion renders the descriptor envelope JSON, not the full payload", () => {
    const envelope = makeDescriptorEnvelope();
    const trace: ToolTrace = {
      name: "run_sentinel_kql",
      input: { query: "SigninLogs | take 1000" },
      output: envelope,
      durationMs: 42,
    };
    const { getByTestId } = render(<ToolTraceAccordion trace={trace} />);
    const summary = getByTestId("trace-summary");
    fireEvent.click(summary);
    const out = getByTestId("trace-output");
    // Output contains the descriptor's sha + uri so dashboards and
    // users see "this came from blob storage", but NOT the 850 KB
    // payload itself.
    expect(out.textContent).toContain("_neo_blob_ref");
    expect(out.textContent).toContain(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(out.textContent).toContain("sizeBytes");
    // And the compact envelope is small relative to the original.
    expect((out.textContent ?? "").length).toBeLessThan(4_000);
  });

  it("resolveBlobRef is never invoked from hydration — resolution stays server-side (get_full_tool_result)", async () => {
    const blobStore = await import("../lib/tool-result-blob-store");
    const resolveSpy = vi.mocked(blobStore.resolveBlobRef);
    resolveSpy.mockClear();

    const envelope = makeDescriptorEnvelope();
    const turn: TurnDoc = {
      id: `turn_${BASE_ROOT.id}_1`,
      docType: "turn",
      conversationId: BASE_ROOT.id,
      turnNumber: 1,
      role: "user",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: BASE_ROOT.createdAt,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: envelope,
        },
      ],
    };
    rebuildConversationFromDocs({ root: BASE_ROOT, turns: [turn] });
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
