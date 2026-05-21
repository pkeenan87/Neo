// ─────────────────────────────────────────────────────────────
//  Cron helpers for scheduled tasks
//
//  Thin wrapper around cron-parser. All times computed against the
//  task's IANA timezone; results are always returned as UTC ISO
//  strings so Cosmos comparisons (nextRunTime <= now) are unambiguous.
// ─────────────────────────────────────────────────────────────

import parser from "cron-parser";

import { DEFAULT_POLL_INTERVAL_SECONDS } from "./scheduled-task-types";

export class CronValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronValidationError";
  }
}

/**
 * Validate a cron expression + timezone pair. Rejects:
 *   - syntax errors
 *   - unknown IANA timezones
 *   - expressions whose adjacent fires are closer than the poll
 *     interval (a `* * * * *` cron is incompatible with a 2-minute
 *     poller because we'd skip fires)
 *
 * The minSpacingSeconds default matches DEFAULT_POLL_INTERVAL_SECONDS.
 * Pass a custom value if the deployment configures a faster poller.
 */
export function validateCronExpression(
  expression: string,
  timezone: string,
  minSpacingSeconds: number = DEFAULT_POLL_INTERVAL_SECONDS,
): void {
  if (!expression || typeof expression !== "string") {
    throw new CronValidationError("Cron expression must be a non-empty string");
  }
  if (!timezone || typeof timezone !== "string") {
    throw new CronValidationError("Timezone must be a non-empty IANA name");
  }

  let interval: ReturnType<typeof parser.parseExpression>;
  try {
    interval = parser.parseExpression(expression, { tz: timezone });
  } catch (err) {
    throw new CronValidationError(
      `Invalid cron expression or timezone: ${(err as Error).message}`,
    );
  }

  // Compare next two fires. If they're closer than the poll interval,
  // the poller can't reliably catch every fire — reject at validation.
  const first = interval.next().toDate().getTime();
  const second = interval.next().toDate().getTime();
  const spacingSeconds = (second - first) / 1000;
  if (spacingSeconds < minSpacingSeconds) {
    throw new CronValidationError(
      `Cron fires every ${spacingSeconds}s, which is faster than the ${minSpacingSeconds}s poll interval. Pick a coarser schedule.`,
    );
  }
}

/**
 * Compute the next UTC ISO string a cron will fire, starting from
 * `fromIso`. Caller is expected to have validated the expression.
 */
export function computeNextRunTime(
  expression: string,
  timezone: string,
  fromIso: string,
): string {
  const interval = parser.parseExpression(expression, {
    tz: timezone,
    currentDate: new Date(fromIso),
  });
  return interval.next().toDate().toISOString();
}

/**
 * Preview the next `n` upcoming fires for UI display. Returns UTC
 * ISO strings sorted ascending.
 */
export function previewNextNFires(
  expression: string,
  timezone: string,
  n: number,
  fromIso: string = new Date().toISOString(),
): string[] {
  const interval = parser.parseExpression(expression, {
    tz: timezone,
    currentDate: new Date(fromIso),
  });
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(interval.next().toDate().toISOString());
  }
  return out;
}
