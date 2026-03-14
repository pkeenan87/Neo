import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { env } from "./config";

// ─────────────────────────────────────────────────────────────
//  Key Vault-backed secrets with env var fallback
// ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let _secretClient: SecretClient | null = null;

const KV_URL_RE = /^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/?$/;

function getSecretClient(): SecretClient | null {
  if (!env.KEY_VAULT_URL) return null;
  if (!KV_URL_RE.test(env.KEY_VAULT_URL)) {
    throw new Error(
      `KEY_VAULT_URL is not a valid Azure Key Vault URL: ${env.KEY_VAULT_URL}`
    );
  }
  if (!_secretClient) {
    _secretClient = new SecretClient(
      env.KEY_VAULT_URL,
      new DefaultAzureCredential()
    );
  }
  return _secretClient;
}

/**
 * Read a tool secret. Checks cache first, then Key Vault, then falls back to
 * the environment variable of the same name. Never throws — returns undefined
 * if the secret is not found anywhere.
 */
export async function getToolSecret(
  name: string
): Promise<string | undefined> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const client = getSecretClient();
  if (client) {
    try {
      const secret = await client.getSecret(name);
      if (secret.value) {
        cache.set(name, {
          value: secret.value,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return secret.value;
      }
    } catch {
      // Key Vault miss or network error — fall through to env var
    }
  }

  return process.env[name];
}

/**
 * Write a secret to Key Vault. Requires KEY_VAULT_URL to be configured.
 */
export async function setToolSecret(
  name: string,
  value: string
): Promise<void> {
  const client = getSecretClient();
  if (!client) {
    throw new Error(
      "KEY_VAULT_URL is not configured. Cannot save secrets without Key Vault."
    );
  }

  await client.setSecret(name, value);
  cache.set(name, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Delete a secret from Key Vault.
 */
export async function deleteToolSecret(name: string): Promise<void> {
  const client = getSecretClient();
  if (!client) {
    throw new Error(
      "KEY_VAULT_URL is not configured. Cannot delete secrets without Key Vault."
    );
  }

  await client.beginDeleteSecret(name);
  cache.delete(name);
}

/**
 * Check which secrets are configured. Returns a map of secret name to boolean.
 */
export async function getSecretStatuses(
  names: string[]
): Promise<Record<string, boolean>> {
  const results = await Promise.all(
    names.map(async (name) => [name, await getToolSecret(name)] as const)
  );
  return Object.fromEntries(
    results.map(([name, value]) => [name, value !== undefined && value !== ""])
  );
}
