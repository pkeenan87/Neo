// ─────────────────────────────────────────────────────────────
//  Triage circuit breaker — Cosmos-backed shared state.
//
//  Shared across all App Service instances via the
//  `instance-shared-counter` primitive: a trip on instance A is
//  immediately visible to instance B's check on the next request.
//  See _plans/multi-instance-deployment.md.
//
//  Failure modes:
//    - Cosmos read fails → assume `open: false` (do NOT trip on a
//      transient storage error; the cooldown timer would just hide
//      the recovery from the operator).
//    - Cosmos write fails (recordOutcome / tripBreaker) → outcome
//      drops silently; the breaker can't measure what it can't
//      record, but a one-shot drop won't change the trip decision.
// ─────────────────────────────────────────────────────────────

import { env } from "./config";
import {
  recordOutcome,
  readOutcomeState,
  tripBreaker,
  resetOutcomeWindow,
} from "./instance-shared-counter";

const KEY = "triage:global";

export async function checkCircuitBreaker(): Promise<{ open: boolean; reason?: string }> {
  const windowMs = env.TRIAGE_CIRCUIT_BREAKER_WINDOW_MS;
  const state = await readOutcomeState(KEY, windowMs);

  // Auto-reset after cooldown. Swallow Cosmos errors here — the next
  // check will re-attempt the reset. We don't want a transient storage
  // hiccup to pin the breaker open past its cooldown.
  if (state.trippedAt && Date.now() - state.trippedAt >= env.TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS) {
    await resetOutcomeWindow(KEY).catch(() => {});
    return { open: false };
  }

  if (state.trippedAt) {
    return { open: true, reason: "circuit_breaker_open" };
  }

  if (state.outcomes.length === 0) return { open: false };

  const failCount = state.outcomes.filter((o) => !o.success).length;
  const failRate = failCount / state.outcomes.length;

  if (failRate >= env.TRIAGE_CIRCUIT_BREAKER_THRESHOLD) {
    await tripBreaker(KEY);
    return { open: true, reason: "circuit_breaker_open" };
  }

  return { open: false };
}

export async function recordTriageOutcome(success: boolean): Promise<void> {
  await recordOutcome(KEY, success);
}

export async function resetCircuitBreaker(): Promise<void> {
  await resetOutcomeWindow(KEY);
}
