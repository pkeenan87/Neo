#!/usr/bin/env tsx
/**
 * Seed the `triage-mappings` Cosmos container with the single mapping
 * that previously lived as a hardcoded constant in
 * triage-dispatch.ts. Run this once per environment after
 * provision-cosmos-db.ps1 has created the container, or any time
 * you want to re-assert the legacy default is in place.
 *
 * Idempotent — if the document already exists it is left untouched.
 *
 * Usage:
 *   cd web
 *   node dist/seed-triage-mappings.mjs            # real run
 *   node dist/seed-triage-mappings.mjs --dry-run  # report what would change
 *
 * Requires COSMOS_ENDPOINT set and the App Service's managed identity
 * (or a developer's az-login identity) to have Cosmos DB Built-in
 * Data Contributor on the target account.
 */

import { CosmosClient } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { legacyDefaultMapping } from "../lib/triage-mapping-store";
import type { TriageMapping } from "../lib/types";

const DATABASE_NAME = "neo-db";
const CONTAINER_NAME = "triage-mappings";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");

  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) {
    console.error("COSMOS_ENDPOINT is not set. Cannot seed.");
    return 2;
  }

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  const container = client.database(DATABASE_NAME).container(CONTAINER_NAME);

  const seed = legacyDefaultMapping();

  // Read first — if the seed mapping already exists we leave it alone
  // so a re-run never clobbers a deliberate admin edit.
  let existing: TriageMapping | undefined;
  try {
    const { resource } = await container.item(seed.id, seed.id).read<TriageMapping>();
    existing = resource ?? undefined;
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : 0;
    if (code !== 404) {
      console.error(`Seed read failed: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    existing = undefined;
  }

  if (existing) {
    console.log(`Seed mapping already present: ${seed.id} → ${existing.skillId}`);
    return 0;
  }

  if (dryRun) {
    console.log(`(dry-run) would seed: ${seed.id} → ${seed.skillId}`);
    return 0;
  }

  // Stamp the timestamp at write time so the audit trail is honest
  // about when the seed actually landed in this environment.
  const doc: TriageMapping = {
    ...seed,
    updatedAt: new Date().toISOString(),
  };
  await container.items.create(doc);
  console.log(`Seeded mapping: ${doc.id} → ${doc.skillId}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
