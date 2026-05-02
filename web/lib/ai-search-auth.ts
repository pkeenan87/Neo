import { ManagedIdentityCredential } from "@azure/identity";
import { getToolSecret } from "./secrets";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────
//  Azure AI Search authentication
//
//  Production path: ManagedIdentityCredential → bearer token for
//  https://search.azure.com/.default. Required role on the search
//  service: `Search Index Data Reader`.
//
//  Local-dev fallback: when the managed-identity call fails AND
//  NODE_ENV !== "production", fall through to AI_SEARCH_ADMIN_KEY
//  resolved via Key Vault → env var. The admin key carries
//  read+write access to the search service; we never let it activate
//  silently in production where a transient IMDS failure would
//  otherwise downgrade auth for the lifetime of the module.
// ─────────────────────────────────────────────────────────────

// AI_SEARCH_ADMIN_KEY is intentionally NOT in EnvConfig — it is read
// only via getToolSecret() so it never lands in the typed config dump
// or any /api/config-style endpoint that serializes `env`.

export type AiSearchAuth =
  | { kind: "bearer"; token: string }
  | { kind: "apiKey"; key: string };

const AI_SEARCH_SCOPE = "https://search.azure.com/.default";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

let _credential: ManagedIdentityCredential | null = null;
let _cached: CachedToken | null = null;

function getCredential(): ManagedIdentityCredential {
  if (!_credential) {
    _credential = new ManagedIdentityCredential();
  }
  return _credential;
}

/** Drop the cached bearer token. Used after a 401 retry. */
export function clearAiSearchTokenCache(): void {
  _cached = null;
}

export async function getAiSearchAuth(): Promise<AiSearchAuth> {
  if (_cached && _cached.expiresAt > Date.now()) {
    return { kind: "bearer", token: _cached.token };
  }

  let bearerError: Error | undefined;
  try {
    const accessToken = await getCredential().getToken(AI_SEARCH_SCOPE);
    if (accessToken && accessToken.token) {
      // ManagedIdentityCredential populates expiresOnTimestamp in
      // every supported runtime; the 60-min fallback exists only as
      // a safety net for malformed responses, not as a hot path.
      _cached = {
        token: accessToken.token,
        expiresAt: (accessToken.expiresOnTimestamp ?? Date.now() + 3_600_000) - EXPIRY_BUFFER_MS,
      };
      return { kind: "bearer", token: accessToken.token };
    }
  } catch (err) {
    bearerError = err instanceof Error ? err : new Error(String(err));
  }

  if (process.env.NODE_ENV === "production") {
    const detail = bearerError ? ` (managed identity error: ${bearerError.message})` : "";
    throw new Error(
      "AI Search managed identity authentication failed in production. " +
        "Grant the app's managed identity `Search Index Data Reader` on " +
        "the AI Search service. The admin-key fallback is disabled in " +
        "production to prevent silent downgrade to a long-lived key." +
        detail,
    );
  }

  const adminKey = await getToolSecret("AI_SEARCH_ADMIN_KEY");
  if (adminKey) {
    logger.warn(
      "AI Search managed-identity unavailable — falling back to admin key (non-production only)",
      "ai-search-auth",
      { errorMessage: bearerError?.message ?? "no token returned" },
    );
    return { kind: "apiKey", key: adminKey };
  }

  const detail = bearerError ? ` (managed identity error: ${bearerError.message})` : "";
  throw new Error(
    "AI Search auth unavailable: grant the app's managed identity " +
      "`Search Index Data Reader` on the AI Search service, or set " +
      "AI_SEARCH_ADMIN_KEY in Key Vault / .env for local development." +
      detail,
  );
}
