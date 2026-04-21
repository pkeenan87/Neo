import { env } from "./config";
import { InMemorySessionStore, type SessionStore } from "./session-store";
import { CosmosSessionStore } from "./conversation-store";
import { mockStore } from "./mock-conversation-store";

function createStore(): SessionStore {
  if (env.COSMOS_ENDPOINT && !env.MOCK_MODE) {
    return new CosmosSessionStore();
  }

  // MOCK_MODE or no Cosmos configured → file-backed mock store. Persists
  // conversations across dev-server restarts so the sidebar, reload
  // hydration, and tool-trace reconstruction all work without a Cosmos
  // DB. See lib/mock-conversation-store.ts. InMemorySessionStore stays
  // importable for any future test that needs an ephemeral store.
  void InMemorySessionStore;
  console.warn(
    "Cosmos DB disabled (MOCK_MODE or unconfigured) — using file-backed mock conversation store at .neo-mock-store/",
  );
  return mockStore;
}

export const sessionStore: SessionStore = createStore();
