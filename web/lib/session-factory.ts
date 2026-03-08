import { env } from "./config";
import { InMemorySessionStore, type SessionStore } from "./session-store";
import { CosmosSessionStore } from "./conversation-store";

function createStore(): SessionStore {
  if (env.COSMOS_ENDPOINT && !env.MOCK_MODE) {
    return new CosmosSessionStore();
  }

  if (!env.COSMOS_ENDPOINT) {
    console.warn("Cosmos DB not configured, using in-memory session store.");
  }
  return new InMemorySessionStore();
}

export const sessionStore: SessionStore = createStore();
