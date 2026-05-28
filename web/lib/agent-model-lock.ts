// ─────────────────────────────────────────────────────────────
//  Agent model-lock resolution
//
//  Centralises the "which model do we use for this turn?" decision
//  shared by the api/agent (new turn), api/agent/confirm (post-
//  destructive-confirmation resume), and api/teams/messages routes.
//  Keeps the three-branch lock logic in one testable place so the
//  routes can't accidentally diverge.
//
//  The lock fires whenever ONE of two conditions holds:
//    (a) sessionModel is set — the user explicitly picked a tier
//        at create time. Honour it on every subsequent turn,
//        independent of messageCount (so a Cosmos failure on the
//        first saveMessages doesn't silently un-lock the session).
//    (b) messageCount > 0 but sessionModel is undefined — a legacy
//        or orphan session. Lock to DEFAULT_MODEL (the implicit
//        tier those conversations were using before the selector
//        existed). Without this branch an attacker could upgrade
//        any pre-existing 200K conversation to the 1M tier
//        ($30/Mtok input) by hand-crafting body.model.
//
//  Brand-new sessions with no messages AND no persisted model
//  honour bodyModel on this first turn (it gets persisted on the
//  first saveMessages).
// ─────────────────────────────────────────────────────────────

export interface ModelLockResult {
  /** The model id to use for this turn. */
  model: string;
  /** When non-null, the caller should emit a warn-level audit
   *  event with these fields so SIEM rules can detect tier-switch
   *  attempts. The shape mirrors the metadata the api/agent route
   *  has been emitting since PR #93. */
  divergence: {
    requestedModel: string;
    lockedModel: string;
    reason: "session_locked" | "legacy_locked";
  } | null;
}

export interface ResolveAgentModelInput {
  sessionModel: string | undefined;
  messageCount: number;
  bodyModel: string | undefined;
  supportedModelIds: ReadonlySet<string>;
  defaultModel: string;
}

export function resolveAgentModel(input: ResolveAgentModelInput): ModelLockResult {
  const { sessionModel, messageCount, bodyModel, supportedModelIds, defaultModel } = input;

  // Branch (a): session has a persisted model — always lock to it.
  if (sessionModel) {
    const divergence =
      bodyModel && bodyModel !== sessionModel
        ? {
            requestedModel: bodyModel,
            lockedModel: sessionModel,
            reason: "session_locked" as const,
          }
        : null;
    return { model: sessionModel, divergence };
  }

  // Branch (b): legacy / orphan session with messages but no model.
  if (messageCount > 0) {
    const divergence =
      bodyModel && bodyModel !== defaultModel
        ? {
            requestedModel: bodyModel,
            lockedModel: defaultModel,
            reason: "legacy_locked" as const,
          }
        : null;
    return { model: defaultModel, divergence };
  }

  // Brand-new session — honour bodyModel if valid, else default.
  const model =
    bodyModel && supportedModelIds.has(bodyModel) ? bodyModel : defaultModel;
  return { model, divergence: null };
}
