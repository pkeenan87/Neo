import { app, type InvocationContext, type Timer } from "@azure/functions";
import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";

// ── Configuration ────────────────────────────────────────────
// All values are read from Function App settings (environment variables).
// The function uses Managed Identity for both Cosmos DB and Blob Storage —
// no connection strings or secrets are needed.

interface Config {
  cosmosEndpoint: string;
  cosmosDatabase: string;
  cosmosContainer: string;
  storageAccountName: string;
  csvContainerName: string;
}

function loadConfig(): Config {
  const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
  const storageAccountName = process.env.STORAGE_ACCOUNT_NAME;

  if (!cosmosEndpoint) throw new Error("COSMOS_ENDPOINT is not configured");
  if (!storageAccountName) throw new Error("STORAGE_ACCOUNT_NAME is not configured");

  return {
    cosmosEndpoint,
    cosmosDatabase: process.env.COSMOS_DATABASE ?? "neo-db",
    cosmosContainer: process.env.COSMOS_CONTAINER ?? "conversations",
    storageAccountName,
    csvContainerName: process.env.CSV_CONTAINER_NAME ?? "neo-csv-uploads",
  };
}

// ── Cosmos DB helpers ────────────────────────────────────────

/**
 * Check whether a conversation still exists in Cosmos DB by its ID.
 * This is a cross-partition query since we don't know the ownerId
 * (partition key) from the blob prefix alone. The query returns at
 * most one result and only projects the ID.
 */
async function conversationExists(
  client: CosmosClient,
  config: Config,
  conversationId: string,
): Promise<boolean> {
  const container = client
    .database(config.cosmosDatabase)
    .container(config.cosmosContainer);

  const { resources } = await container.items
    .query<{ id: string }>({
      query: "SELECT TOP 1 c.id FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: conversationId }],
    })
    .fetchAll();

  return resources.length > 0;
}

// ── Blob Storage helpers ─────────────────────────────────────

/**
 * Discover all unique conversation ID prefixes in the CSV container.
 *
 * Blob key format: {conversationId}/{csvId}/{filename}
 *
 * We list with a "/" delimiter to get virtual directory prefixes,
 * which correspond to conversation IDs.
 */
/**
 * Expected format of conversation ID prefixes in the blob container.
 * Anything that doesn't match is likely a manually-created blob or
 * garbage — skip it rather than querying Cosmos for it.
 */
const CONV_PREFIX_RE = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listConversationPrefixes(
  container: ContainerClient,
  context: InvocationContext,
): Promise<string[]> {
  const prefixes: string[] = [];
  for await (const item of container.listBlobsByHierarchy("/")) {
    if (item.kind === "prefix" && item.name) {
      // item.name is "conv_<uuid>/" — strip the trailing slash.
      const conversationId = item.name.replace(/\/$/, "");
      if (!conversationId) continue;
      if (!CONV_PREFIX_RE.test(conversationId)) {
        context.warn(`Unexpected blob prefix format: ${conversationId} — skipping.`);
        continue;
      }
      prefixes.push(conversationId);
    }
  }
  return prefixes;
}

interface DeleteResult {
  deleted: number;
  failed: number;
}

/**
 * Delete all blobs under a conversation prefix (all csvId subfolders
 * and their files). Uses a flat listing to avoid recursive hierarchy
 * traversal. Returns both the success and failure counts so the caller
 * can surface a meaningful summary.
 */
async function deleteConversationBlobs(
  container: ContainerClient,
  conversationId: string,
  context: InvocationContext,
): Promise<DeleteResult> {
  let deleted = 0;
  let failed = 0;
  for await (const blob of container.listBlobsFlat({ prefix: `${conversationId}/` })) {
    try {
      await container.getBlobClient(blob.name).deleteIfExists();
      deleted++;
    } catch (err) {
      failed++;
      context.warn(
        `Failed to delete blob ${blob.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { deleted, failed };
}

// ── Timer function ───────────────────────────────────────────

/**
 * Daily timer-triggered function that sweeps the neo-csv-uploads
 * container for orphaned blobs whose parent conversation has been
 * deleted from or TTL-expired out of Cosmos DB. Runs at 03:00 UTC.
 *
 * Algorithm:
 *   1. List all top-level conversation ID prefixes in the container.
 *   2. For each prefix, check if the conversation still exists.
 *   3. If not, delete all blobs under that prefix.
 *
 * Performance: O(P) Cosmos queries where P is the number of distinct
 * conversation prefixes. Each query is a cross-partition fan-out on the
 * `id` field (partition key is `ownerId`), costing ~2–5 RU per lookup.
 * For a typical deployment with ~100 active conversations, this finishes
 * in seconds. At 10K+ prefixes, consider batching with Promise.all.
 */
async function csvCleanupHandler(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("CSV cleanup function started.");

  const config = loadConfig();
  const credential = new ManagedIdentityCredential();

  const cosmosClient = new CosmosClient({
    endpoint: config.cosmosEndpoint,
    aadCredentials: credential,
  });

  const blobService = new BlobServiceClient(
    `https://${config.storageAccountName}.blob.core.windows.net`,
    credential,
  );
  const csvContainer = blobService.getContainerClient(config.csvContainerName);

  // 1. Discover all conversation prefixes.
  const prefixes = await listConversationPrefixes(csvContainer, context);
  context.log(`Found ${prefixes.length} conversation prefix(es) in ${config.csvContainerName}.`);

  if (prefixes.length === 0) {
    context.log("No blobs to sweep. Done.");
    return;
  }

  // 2. Check each prefix against Cosmos DB and collect orphans.
  let orphanCount = 0;
  let totalBlobsDeleted = 0;
  let totalBlobsFailed = 0;

  for (const conversationId of prefixes) {
    // Fail closed: if the Cosmos lookup throws (throttle, transient 503),
    // skip this prefix rather than treating "query failed" as "not found."
    // Never delete blobs when existence is uncertain.
    let exists: boolean;
    try {
      exists = await conversationExists(cosmosClient, config, conversationId);
    } catch (err) {
      context.warn(
        `Skipping ${conversationId} — Cosmos lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (exists) continue;

    // 3. Conversation is gone — delete all its blobs.
    context.log(`Conversation ${conversationId} not found in Cosmos — deleting blobs.`);
    const result = await deleteConversationBlobs(csvContainer, conversationId, context);
    orphanCount++;
    totalBlobsDeleted += result.deleted;
    totalBlobsFailed += result.failed;
    context.log(`  Deleted ${result.deleted} blob(s) for ${conversationId}${result.failed > 0 ? `, ${result.failed} failed` : ""}.`);
  }

  if (totalBlobsFailed > 0) {
    context.warn(`CSV cleanup: ${totalBlobsFailed} blob(s) could not be deleted across ${orphanCount} orphan(s).`);
  }

  context.log(
    `CSV cleanup complete. Checked ${prefixes.length} prefix(es), ` +
    `found ${orphanCount} orphan(s), deleted ${totalBlobsDeleted} blob(s), ` +
    `${totalBlobsFailed} failed.`,
  );
}

// ── Registration ─────────────────────────────────────────────

app.timer("csvCleanup", {
  // Every day at 03:00 UTC. The cron expression uses the NCrontab
  // 6-field format required by Azure Functions (second granularity).
  schedule: "0 0 3 * * *",
  handler: csvCleanupHandler,
});
