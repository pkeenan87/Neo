import { env } from "./config";

interface TriageOutcome {
  timestamp: number;
  success: boolean;
}

let outcomes: TriageOutcome[] = [];
let trippedAt: number | null = null;

function prune(): void {
  const cutoff = Date.now() - env.TRIAGE_CIRCUIT_BREAKER_WINDOW_MS;
  outcomes = outcomes.filter((o) => o.timestamp >= cutoff);
}

/**
 * Check whether the circuit breaker is currently open.
 * If it was tripped and the cooldown has elapsed, auto-resets.
 */
export function checkCircuitBreaker(): { open: boolean; reason?: string } {
  // Auto-reset after cooldown
  if (trippedAt && Date.now() - trippedAt >= env.TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS) {
    resetCircuitBreaker();
  }

  if (trippedAt) {
    return { open: true, reason: "circuit_breaker_open" };
  }

  prune();

  if (outcomes.length === 0) return { open: false };

  const failCount = outcomes.filter((o) => !o.success).length;
  const failRate = failCount / outcomes.length;

  if (failRate >= env.TRIAGE_CIRCUIT_BREAKER_THRESHOLD) {
    trippedAt = Date.now();
    return { open: true, reason: "circuit_breaker_open" };
  }

  return { open: false };
}

export function recordTriageOutcome(success: boolean): void {
  outcomes.push({ timestamp: Date.now(), success });
}

export function resetCircuitBreaker(): void {
  outcomes = [];
  trippedAt = null;
}
