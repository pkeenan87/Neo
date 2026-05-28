import { describe, expect, it } from "vitest";
import { resolveAgentModel } from "../lib/agent-model-lock";

const SUPPORTED_IDS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
]);
const DEFAULT = "claude-sonnet-4-6";

describe("resolveAgentModel — session.model wins regardless of messageCount", () => {
  it("locks to session.model on a 0-message session (saveMessages-failure case)", () => {
    // Regression for F6: transient Cosmos failure on the first
    // saveMessages leaves persisted messageCount=0 even though
    // session.model was set at create time. The lock must still
    // fire — otherwise an attacker can flip tiers by hand-crafting
    // body.model on the next turn.
    const result = resolveAgentModel({
      sessionModel: "claude-opus-4-7[1m]",
      messageCount: 0,
      bodyModel: "claude-sonnet-4-6",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe("claude-opus-4-7[1m]");
    expect(result.divergence).toEqual({
      requestedModel: "claude-sonnet-4-6",
      lockedModel: "claude-opus-4-7[1m]",
      reason: "session_locked",
    });
  });

  it("locks to session.model on a many-message session", () => {
    const result = resolveAgentModel({
      sessionModel: "claude-opus-4-7[1m]",
      messageCount: 42,
      bodyModel: "claude-sonnet-4-6",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe("claude-opus-4-7[1m]");
    expect(result.divergence?.reason).toBe("session_locked");
  });

  it("emits no divergence when body.model matches session.model", () => {
    const result = resolveAgentModel({
      sessionModel: "claude-opus-4-7[1m]",
      messageCount: 5,
      bodyModel: "claude-opus-4-7[1m]",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe("claude-opus-4-7[1m]");
    expect(result.divergence).toBeNull();
  });

  it("emits no divergence when body.model is absent (CLI / Teams use case)", () => {
    const result = resolveAgentModel({
      sessionModel: "claude-opus-4-7[1m]",
      messageCount: 5,
      bodyModel: undefined,
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe("claude-opus-4-7[1m]");
    expect(result.divergence).toBeNull();
  });
});

describe("resolveAgentModel — legacy session lock (no model, messageCount > 0)", () => {
  it("locks legacy session to DEFAULT_MODEL — body.model ignored (F1 attack)", () => {
    // Regression for F1: legacy sessions (pre-PR-93) and sessions
    // created with invalid/missing body.model have session.model =
    // undefined but messageCount > 0. Without this branch, body.model
    // wins on every turn and an attacker can upgrade the conversation
    // to the 1M tier ($30/Mtok input) at will.
    const result = resolveAgentModel({
      sessionModel: undefined,
      messageCount: 30,
      bodyModel: "claude-opus-4-7[1m]",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe(DEFAULT);
    expect(result.divergence).toEqual({
      requestedModel: "claude-opus-4-7[1m]",
      lockedModel: DEFAULT,
      reason: "legacy_locked",
    });
  });

  it("emits no divergence when body.model matches DEFAULT_MODEL on a legacy session", () => {
    const result = resolveAgentModel({
      sessionModel: undefined,
      messageCount: 30,
      bodyModel: DEFAULT,
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe(DEFAULT);
    expect(result.divergence).toBeNull();
  });
});

describe("resolveAgentModel — new session honours body.model", () => {
  it("uses body.model when valid and session has no model + no messages", () => {
    const result = resolveAgentModel({
      sessionModel: undefined,
      messageCount: 0,
      bodyModel: "claude-opus-4-7[1m]",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe("claude-opus-4-7[1m]");
    expect(result.divergence).toBeNull();
  });

  it("falls back to DEFAULT_MODEL when body.model is absent on a new session", () => {
    const result = resolveAgentModel({
      sessionModel: undefined,
      messageCount: 0,
      bodyModel: undefined,
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe(DEFAULT);
    expect(result.divergence).toBeNull();
  });

  it("falls back to DEFAULT_MODEL when body.model is not in SUPPORTED_MODEL_IDS", () => {
    const result = resolveAgentModel({
      sessionModel: undefined,
      messageCount: 0,
      bodyModel: "claude-totally-fake-id",
      supportedModelIds: SUPPORTED_IDS,
      defaultModel: DEFAULT,
    });
    expect(result.model).toBe(DEFAULT);
    expect(result.divergence).toBeNull();
  });
});
