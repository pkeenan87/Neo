// ─────────────────────────────────────────────────────────────
//  Scheduled-task output summarisation
//
//  TWO caps live here because the consumers want different things:
//
//  1. summarize() — for the Cosmos run-history entry's
//     `outputSummary` field. Stays tight (2000 chars) because that
//     record is a per-run digest the UI shows in a small badge; it
//     is NOT what reaches Teams / email.
//
//  2. truncateForRouting() — for the routing-layer notification
//     body (destination "tool" → send_teams_message / send_email
//     summary). Tens of KB headroom so a real SOC analysis report
//     reaches the channel intact. Capped only because Teams
//     adaptive cards have ~28 KB total payload limit; we leave
//     ~3 KB room for the card scaffolding.
//
//  Hoisted out of scheduled-task-runner.ts so the routing layer
//  can import without a circular dependency (the runner imports
//  routeOutput from scheduled-task-routing).
// ─────────────────────────────────────────────────────────────

export const OUTPUT_SUMMARY_MAX = 2000;
// Teams adaptive cards cap at ~28 KB total payload. Leave headroom
// for the card scaffolding the Logic App wraps around the body.
// Email destinations comfortably tolerate this; we pick the smaller
// of the two limits so the same cap works for both routing tools.
export const ROUTING_BODY_MAX = 25_000;

export function summarize(text: string): string {
  if (text.length <= OUTPUT_SUMMARY_MAX) return text;
  return text.slice(0, OUTPUT_SUMMARY_MAX) + "\n…[truncated]";
}

// Body for the routing-layer notification — kept full unless it
// exceeds the Teams card payload ceiling. Distinct from summarize()
// so the Cosmos run-history record stays small while the actual
// notification carries the full analysis.
export function truncateForRouting(text: string): string {
  if (text.length <= ROUTING_BODY_MAX) return text;
  return text.slice(0, ROUTING_BODY_MAX) + "\n…[truncated]";
}
