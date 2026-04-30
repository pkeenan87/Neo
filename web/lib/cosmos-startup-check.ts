// ─────────────────────────────────────────────────────────────
//  Cosmos startup connectivity check
//
//  Runs once at server boot (via instrumentation.ts) when
//  COSMOS_ENDPOINT is configured. Verifies that every required
//  container exists, so a misprovisioned environment fails-fast
//  with a clear "missing container X" message instead of silently
//  degrading at runtime — particularly dangerous for the rate
//  limiter (fails open → no rate limiting) and circuit breaker
//  (won't trip without its container). See
//  _plans/multi-instance-deployment.md.
// ─────────────────────────────────────────────────────────────

import { CosmosClient, type Database } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { logger } from "./logger";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DATABASE_NAME = "neo-db";

// All containers the app requires. Update this list when adding a new
// Cosmos-backed store. Sourced from the `_container = ... .container(...)`
// sites across lib/ — keep in sync with scripts/provision-cosmos-db.ps1.
const REQUIRED_CONTAINERS: readonly string[] = [
  "conversations",
  "usage-logs",
  "triageRuns",
  "teams-mappings",
  "api-keys",
  "skills",
  "instance-shared",
];

export type DatabaseFactory = (endpoint: string) => Database;

const defaultDatabaseFactory: DatabaseFactory = (endpoint) => {
  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  return client.database(DATABASE_NAME);
};

/**
 * Verify every required Cosmos container exists. Throws with the
 * missing container name on first miss so operators get a clear
 * remediation hint. No-op when COSMOS_ENDPOINT is unset (dev/mock).
 *
 * Container existence is checked via `read()` of the container
 * resource — a single metadata round-trip per container, ~50ms
 * total in practice. Cheap relative to the cost of a silent
 * misconfig.
 */
export async function assertCosmosContainers(
  endpoint: string | undefined,
  factory: DatabaseFactory = defaultDatabaseFactory,
): Promise<void> {
  if (!endpoint) return;

  const database = factory(endpoint);
  const missing: string[] = [];

  for (const name of REQUIRED_CONTAINERS) {
    try {
      await database.container(name).read();
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: number }).code
          : 0;
      if (code === 404) {
        missing.push(name);
      } else {
        // Non-404: connectivity / auth problem. Surface immediately
        // — no point checking the rest if we can't reach Cosmos.
        logger.error(
          "Cosmos startup check: connectivity failure",
          "cosmos-startup-check",
          { container: name, errorMessage: toMessage(err) },
        );
        throw new Error(
          `Cosmos startup check failed for container '${name}': ${toMessage(err)}. ` +
            `Verify COSMOS_ENDPOINT, managed identity role assignments, and network access.`,
        );
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Cosmos containers missing in database '${DATABASE_NAME}': ${missing.join(", ")}. ` +
        `Run scripts/provision-cosmos-db.ps1 against the Cosmos account before starting the app. ` +
        `See _plans/multi-instance-deployment.md.`,
    );
  }

  logger.info("Cosmos startup check passed", "cosmos-startup-check", {
    containers: REQUIRED_CONTAINERS.length,
  });
}
