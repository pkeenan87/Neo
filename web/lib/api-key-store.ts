import { readFileSync, watch } from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./config";
import { encryptApiKey, decryptApiKey } from "./api-key-crypto";
import type { Role } from "./permissions";

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

export interface ApiKeyEntry {
  key: string;
  role: Role;
  label: string;
}

export interface ApiKeyRecord {
  id: string;
  encryptedKey: string;
  role: Role;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  createdBy: string;
  revoked: boolean;
  lastUsedAt: string | null;
}

/** ApiKeyRecord with encryptedKey stripped (safe to return to client). */
export type ApiKeyRecordPublic = Omit<ApiKeyRecord, "encryptedKey">;

export class ApiKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyValidationError";
  }
}

export const MAX_KEYS_PER_ADMIN = 20;
export const MAX_API_KEY_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years
const CONTAINER_NAME = "api-keys";
const DATABASE_NAME = "neo-db";

// ─────────────────────────────────────────────────────────────
//  JSON file fallback (existing behavior)
// ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = resolve(__dirname, "../api-keys.json");

let keyCache: ApiKeyEntry[] = [];

function loadKeys(): void {
  try {
    const raw = readFileSync(KEY_FILE, "utf-8");
    keyCache = (JSON.parse(raw) as { keys: ApiKeyEntry[] }).keys ?? [];
  } catch {
    keyCache = [];
  }
}

loadKeys();

try {
  watch(KEY_FILE, () => {
    loadKeys();
  });
} catch {
  // File may not exist yet
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function findApiKeyFromFile(key: string): ApiKeyEntry | undefined {
  return keyCache.find((entry) => safeCompare(entry.key, key));
}

// ─────────────────────────────────────────────────────────────
//  Cosmos DB container
// ─────────────────────────────────────────────────────────────

let _container: Container | null = null;

function getApiKeysContainer(): Container | null {
  if (_container) return _container;

  const endpoint = env.COSMOS_ENDPOINT;
  if (!endpoint || env.MOCK_MODE) return null;

  const credential = new ManagedIdentityCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _container = client.database(DATABASE_NAME).container(CONTAINER_NAME);
  return _container;
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isExpired(record: ApiKeyRecord): boolean {
  if (!record.expiresAt) return false;
  return new Date(record.expiresAt).getTime() <= Date.now();
}

/**
 * Check if the given ownerId is a super-admin (can manage all keys).
 * Configured via SUPER_ADMIN_IDS env var (comma-separated list).
 */
function isSuperAdmin(ownerId: string): boolean {
  const ids = process.env.SUPER_ADMIN_IDS;
  if (!ids) return false;
  return ids.split(",").map((s) => s.trim()).includes(ownerId);
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Look up an API key. Tries Cosmos DB first, falls back to JSON file
 * only when Cosmos is not configured. Cosmos errors fail closed.
 */
export async function findApiKey(
  key: string
): Promise<ApiKeyEntry | undefined> {
  const container = getApiKeysContainer();

  if (container) {
    try {
      const hash = hashApiKey(key);
      const { resource } = await container.item(hash, hash).read<ApiKeyRecord>();

      // Key not in Cosmos — check JSON file for unmigrated keys
      if (!resource) return findApiKeyFromFile(key);

      // Known Cosmos key — enforce revocation and expiration (never fall through)
      if (resource.revoked) return undefined;
      if (isExpired(resource)) return undefined;

      const decrypted = await decryptApiKey(resource.encryptedKey);
      if (!safeCompare(decrypted, key)) return undefined;

      return { key, role: resource.role, label: resource.label };
    } catch {
      // Cosmos configured but erroring — fail closed to prevent
      // revoked keys from authenticating via JSON fallback
      return undefined;
    }
  }

  // Cosmos not configured — JSON file is the only source
  return findApiKeyFromFile(key);
}

/**
 * Create a new API key and store it encrypted in Cosmos DB.
 * Returns the raw key (for one-time display) and the public record.
 */
export async function createApiKey(
  label: string,
  role: Role,
  expiresAt: string | null,
  createdBy: string
): Promise<{ rawKey: string; record: ApiKeyRecordPublic }> {
  const container = getApiKeysContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured. Cannot create API keys.");
  }

  if (expiresAt) {
    const expMs = new Date(expiresAt).getTime();
    if (isNaN(expMs) || expMs <= Date.now()) {
      throw new ApiKeyValidationError("Expiration date must be in the future.");
    }
    if (expMs - Date.now() > MAX_API_KEY_LIFETIME_MS) {
      throw new ApiKeyValidationError(
        "API keys cannot expire more than 2 years from now."
      );
    }
  }

  const { resources } = await container.items
    .query<ApiKeyRecord>({
      query:
        "SELECT c.id FROM c WHERE c.createdBy = @createdBy AND c.revoked = false",
      parameters: [{ name: "@createdBy", value: createdBy }],
    })
    .fetchAll();

  if (resources.length >= MAX_KEYS_PER_ADMIN) {
    throw new ApiKeyValidationError(
      `Maximum of ${MAX_KEYS_PER_ADMIN} active API keys per admin. Revoke an existing key first.`
    );
  }

  const rawKey = randomBytes(32).toString("base64url");
  const hash = hashApiKey(rawKey);
  const encrypted = await encryptApiKey(rawKey);

  const record: ApiKeyRecord = {
    id: hash,
    encryptedKey: encrypted,
    role,
    label,
    createdAt: new Date().toISOString(),
    expiresAt,
    createdBy,
    revoked: false,
    lastUsedAt: null,
  };

  await container.items.create(record);

  const { encryptedKey: _omit, ...publicRecord } = record;
  return { rawKey, record: publicRecord };
}

/**
 * Revoke an API key (soft delete). Enforces ownership unless super-admin.
 */
export async function revokeApiKey(
  id: string,
  requestingOwnerId: string
): Promise<void> {
  const container = getApiKeysContainer();
  if (!container) {
    throw new Error("Cosmos DB is not configured.");
  }

  const { resource } = await container.item(id, id).read<ApiKeyRecord>();
  if (!resource) {
    throw new Error("API key not found.");
  }

  if (
    resource.createdBy !== requestingOwnerId &&
    !isSuperAdmin(requestingOwnerId)
  ) {
    throw new Error("Forbidden: cannot revoke a key you did not create.");
  }

  resource.revoked = true;
  await container.item(id, id).replace(resource);
}

/**
 * List API keys. Scoped to createdBy unless super-admin.
 * Returns records without encryptedKey.
 */
export async function listApiKeys(
  requestingOwnerId: string
): Promise<ApiKeyRecordPublic[]> {
  const container = getApiKeysContainer();
  if (!container) return [];

  const query = isSuperAdmin(requestingOwnerId)
    ? { query: "SELECT * FROM c ORDER BY c.createdAt DESC" }
    : {
        query:
          "SELECT * FROM c WHERE c.createdBy = @createdBy ORDER BY c.createdAt DESC",
        parameters: [{ name: "@createdBy", value: requestingOwnerId }],
      };

  const { resources } = await container.items
    .query<ApiKeyRecord>(query)
    .fetchAll();

  return resources.map(({ encryptedKey: _omit, ...rest }) => rest);
}

/**
 * Update the lastUsedAt timestamp. Fire-and-forget — never throws.
 */
export function updateLastUsed(id: string): void {
  const container = getApiKeysContainer();
  if (!container) return;

  container
    .item(id, id)
    .patch([{ op: "set", path: "/lastUsedAt", value: new Date().toISOString() }])
    .catch(() => {
      // Fire-and-forget — don't block the auth path
    });
}
