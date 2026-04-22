#!/usr/bin/env tsx
/**
 * CLI wrapper: drives runMigration against real Cosmos + blob clients.
 *
 * All migration logic lives in lib/migrate-conversations.ts for
 * testability; this file only handles:
 *   - Argv parsing → MigrateOptions.
 *   - Real Cosmos container wiring via managed identity.
 *   - File-backed checkpoint read/write.
 *   - Source-conversation iteration (paginated cross-partition query
 *     against the v1 container or v2 roots).
 *   - Process exit code + summary print.
 *
 * Example runs:
 *   npm run migrate:conversations -- --dry-run
 *   npm run migrate:conversations -- --direction v1-to-v2 --ru-budget 500
 *   npm run migrate:conversations -- --direction v2-to-v1 --conversation-id conv_…
 */

import { promises as fs } from "fs";
import path from "path";
import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import {
  parseMigrateArgs,
  runMigration,
  type MigrateOptions,
  type MigrationCheckpoint,
} from "../lib/migrate-conversations";
import {
  NEO_CONVERSATIONS_V2_CONTAINER,
} from "../lib/config";
import type { Conversation, ConversationV2Root } from "../lib/types";

const CHECKPOINT_FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  ".migration-checkpoint.json",
);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let opts: MigrateOptions;
  try {
    opts = parseMigrateArgs(argv);
  } catch (err) {
    console.error(`arg parse failed: ${(err as Error).message}`);
    printUsage();
    return 2;
  }

  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) {
    console.error("COSMOS_ENDPOINT env var is required");
    return 2;
  }
  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  const v1Container = client.database("neo-db").container("conversations");
  const v2Container = client
    .database("neo-db")
    .container(NEO_CONVERSATIONS_V2_CONTAINER);

  const sourceContainer = opts.direction === "v1-to-v2" ? v1Container : v2Container;

  const summary = await runMigration(
    opts,
    {
      v1Container,
      v2Container,
      listConversations: async function* (filter) {
        yield* iterateSource(sourceContainer, opts.direction, filter);
      },
    },
    {
      read: readCheckpoint,
      write: writeCheckpoint,
    },
  );

  // Print a compact summary — makes log scraping easy.
  console.log(JSON.stringify({ summary }, null, 2));

  if (summary.rejectedOversized.length > 0) {
    console.error(
      `rejected (would exceed 2 MB): ${summary.rejectedOversized.join(", ")}`,
    );
    return 3;
  }
  if (summary.failed > 0) return 1;
  return 0;
}

async function* iterateSource(
  container: Container,
  direction: MigrateOptions["direction"],
  filter: {
    since?: string;
    ownerId?: string;
    conversationId?: string;
    afterId?: string | null;
  },
): AsyncGenerator<Conversation & { migrated?: boolean }> {
  const conditions: string[] = [];
  const params: { name: string; value: string }[] = [];
  if (direction === "v2-to-v1") {
    conditions.push(`c.docType = "root"`);
  }
  if (filter.since) {
    conditions.push(`c.updatedAt >= @since`);
    params.push({ name: "@since", value: filter.since });
  }
  if (filter.ownerId) {
    conditions.push(`c.ownerId = @ownerId`);
    params.push({ name: "@ownerId", value: filter.ownerId });
  }
  if (filter.conversationId) {
    conditions.push(`c.id = @convId`);
    params.push({ name: "@convId", value: filter.conversationId });
  }
  if (filter.afterId) {
    conditions.push(`c.id > @afterId`);
    params.push({ name: "@afterId", value: filter.afterId });
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM c ${where} ORDER BY c.id ASC`;

  const iter = container.items.query<Conversation | ConversationV2Root>({
    query,
    parameters: params,
  });

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      if (direction === "v2-to-v1") {
        // The runner only needs the `id` + `ownerId` for v2→v1; pass
        // a minimal shape cast to Conversation.
        const root = r as ConversationV2Root;
        yield {
          id: root.id,
          ownerId: root.ownerId,
          title: root.title,
          createdAt: root.createdAt,
          updatedAt: root.updatedAt,
          messageCount: root.turnCount,
          role: root.role,
          channel: root.channel,
          messages: [],
          pendingConfirmation: null,
        };
      } else {
        yield r as Conversation & { migrated?: boolean };
      }
    }
  }
}

async function readCheckpoint(): Promise<MigrationCheckpoint | null> {
  try {
    const raw = await fs.readFile(CHECKPOINT_FILE, "utf8");
    return JSON.parse(raw) as MigrationCheckpoint;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function writeCheckpoint(cp: MigrationCheckpoint): Promise<void> {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function printUsage(): void {
  console.error(`
Usage:
  npm run migrate:conversations -- [flags]

Flags:
  --dry-run                 Report what would change; write nothing.
  --direction v1-to-v2 | v2-to-v1   (default: v1-to-v2)
  --since <ISO>             Only migrate conversations updated since this date.
  --conversation-id <id>    Restrict to a single conversation.
  --owner-id <id>           Restrict to a single owner.
  --ru-budget <n>           Sleep between batches when RU pressure exceeds n.
  --force-rerun             Re-migrate even if source doc is marked migrated.

Exit codes:
  0 success
  1 one or more conversations failed
  2 bad args / config
  3 one or more v2→v1 conversations exceeded the 2 MB v1 ceiling
`);
}

main().then((code) => process.exit(code), (err) => {
  console.error("migration crashed:", err);
  process.exit(1);
});
