// Next.js instrumentation hook — runs once per server process at
// boot, before any route handler. Used here as the single point
// where startup invariants are enforced. Without this, validateConfig
// is a dead export and nothing fails-fast in a misconfigured prod
// deploy. See _plans/multi-instance-deployment.md.

export async function register(): Promise<void> {
  // Skip on the Edge runtime — Cosmos SDK + ManagedIdentityCredential
  // need Node APIs and are loaded lazily by Node-runtime routes anyway.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateConfig, env } = await import("./lib/config");
  const { assertCosmosContainers } = await import("./lib/cosmos-startup-check");

  validateConfig();
  await assertCosmosContainers(env.COSMOS_ENDPOINT);
}
