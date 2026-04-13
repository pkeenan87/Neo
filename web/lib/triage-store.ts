import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { logger } from "./logger";
import type { TriageRun } from "./types";

// ── Lazy-singleton Cosmos container ──────────────────────────

let _container: Container | null = null;

function getTriageContainer(): Container | null {
  if (_container) return _container;

  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint) return null;

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database("neo-db").container("triageRuns");
  return _container;
}

// ── CRUD ─────────────────────────────────────────────────────

export async function createTriageRun(run: TriageRun): Promise<void> {
  const container = getTriageContainer();
  if (!container) {
    logger.warn("Triage store not configured — run will not be persisted", "triage-store");
    return;
  }
  await container.items.create(run);
}

/**
 * Look up a completed triage run by alertId + callerId for dedup.
 * Returns the run if found AND within the dedup window AND from the
 * same caller AND has a response. Returns null otherwise.
 *
 * Uses a cross-partition query because alertId is not the partition key.
 */
export async function getTriageRunByAlertId(
  alertId: string,
  callerId: string,
): Promise<TriageRun | null> {
  const container = getTriageContainer();
  if (!container) return null;

  const since = new Date(Date.now() - env.TRIAGE_DEDUP_WINDOW_MS).toISOString();

  try {
    const { resources } = await container.items
      .query<TriageRun>({
        query: `
          SELECT TOP 1 *
          FROM c
          WHERE c.alertId = @alertId
            AND c.callerId = @callerId
            AND c.createdAt >= @since
            AND IS_DEFINED(c.response)
          ORDER BY c.createdAt DESC
        `,
        parameters: [
          { name: "@alertId", value: alertId },
          { name: "@callerId", value: callerId },
          { name: "@since", value: since },
        ],
      })
      .fetchAll();

    return resources[0] ?? null;
  } catch (e: unknown) {
    logger.warn("Dedup query failed", "triage-store", {
      alertId,
      errorMessage: (e as Error).message,
    });
    return null;
  }
}

export async function updateTriageRun(run: TriageRun): Promise<void> {
  const container = getTriageContainer();
  if (!container) return;

  try {
    await container.item(run.id, run.id).replace(run);
  } catch (err) {
    logger.warn("Failed to update triage run", "triage-store", {
      alertId: run.alertId,
      errorMessage: (err as Error).message,
    });
  }
}
