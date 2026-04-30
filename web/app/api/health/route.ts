import { NextResponse } from "next/server";
import { validateConfig } from "@/lib/config";

// App Service Health Check probe target. Re-runs the same boot
// invariants `instrumentation.ts` enforces — `validateConfig` throws
// on missing ANTHROPIC_API_KEY, on missing COSMOS_ENDPOINT in
// production (the multi-instance guard), and on the
// DEV_AUTH_BYPASS-outside-development guard. A failing instance
// returns 503 so App Service routes traffic away from it until it
// recovers; a passing instance returns 200.
//
// Cheap (no I/O, no Cosmos round-trip) so it's safe to probe at the
// default 30s interval. The startup-time `assertCosmosContainers`
// check fires once at boot from instrumentation.ts; we don't repeat
// it here to keep the probe latency-bounded.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    validateConfig();
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
