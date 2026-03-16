import { CryptographyClient, KeyClient } from "@azure/keyvault-keys";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";

// ─────────────────────────────────────────────────────────────
//  Key Vault encryption for API keys (RSA-OAEP)
// ─────────────────────────────────────────────────────────────

let _cryptoClient: CryptographyClient | null = null;

async function getCryptoClient(): Promise<CryptographyClient> {
  if (_cryptoClient) return _cryptoClient;

  if (!env.KEY_VAULT_URL) {
    throw new Error(
      "KEY_VAULT_URL is not configured. API key encryption requires Key Vault."
    );
  }

  const credential = new ManagedIdentityCredential();
  const keyClient = new KeyClient(env.KEY_VAULT_URL, credential);
  const key = await keyClient.getKey(env.KEY_VAULT_KEY_NAME);

  if (!key.id) {
    throw new Error(
      `Key Vault key "${env.KEY_VAULT_KEY_NAME}" has no resolvable ID. Check that the key exists and is enabled.`
    );
  }

  _cryptoClient = new CryptographyClient(key.id, credential);
  return _cryptoClient;
}

export async function encryptApiKey(raw: string): Promise<string> {
  const client = await getCryptoClient();
  const result = await client.encrypt("RSA-OAEP", Buffer.from(raw, "utf-8"));
  return Buffer.from(result.result).toString("base64");
}

export async function decryptApiKey(encrypted: string): Promise<string> {
  const client = await getCryptoClient();
  const result = await client.decrypt(
    "RSA-OAEP",
    Buffer.from(encrypted, "base64")
  );
  return Buffer.from(result.result).toString("utf-8");
}
