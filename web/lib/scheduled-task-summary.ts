// ─────────────────────────────────────────────────────────────
//  Scheduled-task output summarisation
//
//  Shared between the runner (run-history entry's outputSummary)
//  and the routing layer (notification body for destination
//  "tool"). Hoisted out of scheduled-task-runner.ts so the
//  routing layer can import it without a circular dependency
//  (the runner imports routeOutput from scheduled-task-routing).
// ─────────────────────────────────────────────────────────────

export const OUTPUT_SUMMARY_MAX = 2000;

export function summarize(text: string): string {
  if (text.length <= OUTPUT_SUMMARY_MAX) return text;
  return text.slice(0, OUTPUT_SUMMARY_MAX) + "\n…[truncated]";
}
