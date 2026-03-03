// ─────────────────────────────────────────────────────────────
//  Encrypted Config Store (~/.neo/config.json)
//
//  Sensitive fields (apiKey, accessToken, refreshToken) are
//  encrypted at rest with AES-256-GCM.  The key is derived from
//  the machine's username + hostname via scrypt — portable only
//  within the same machine.
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir, userInfo, hostname } from "os";
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

const CONFIG_DIR = join(homedir(), ".neo");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = "enc:v1:";

// Sensitive field paths that must be encrypted on disk
const SENSITIVE_FIELDS = ["apiKey", "entraId.accessToken", "entraId.refreshToken"];

function deriveKey(salt) {
  const material = userInfo().username + hostname();
  return scryptSync(material, Buffer.from(salt, "hex"), KEY_LENGTH);
}

function getOrCreateSalt(raw) {
  if (raw._salt) return raw._salt;
  return randomBytes(32).toString("hex");
}

function encrypt(plaintext, salt) {
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(packed, salt) {
  const payload = packed.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted value");
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

// ── Deep get/set helpers for dotted paths like "entraId.accessToken" ──

function deepGet(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function deepSet(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function deepDelete(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== "object") return;
    current = current[keys[i]];
  }
  delete current[keys[keys.length - 1]];
}

// ── Public API ────────────────────────────────────────────────

const DEFAULTS = {
  serverUrl: "http://localhost:3000",
  authMethod: null,
};

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULTS };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }

  const salt = raw._salt;

  // Decrypt sensitive fields in-place
  for (const field of SENSITIVE_FIELDS) {
    const value = deepGet(raw, field);
    if (typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX)) {
      if (!salt) {
        process.stderr.write(
          `  Warning: encrypted credential "${field}" found but no derivation salt in config.\n` +
          `  Run: node src/index.js auth login\n\n`
        );
        deepDelete(raw, field);
        continue;
      }
      try {
        deepSet(raw, field, decrypt(value, salt));
      } catch {
        process.stderr.write(
          `  Warning: could not decrypt "${field}" — config may be from a different machine.\n` +
          `  Run: node src/index.js auth login\n\n`
        );
        deepDelete(raw, field);
      }
    }
  }

  // Remove internal fields from returned config
  const result = { ...DEFAULTS, ...raw };
  delete result._salt;
  return result;
}

export function writeConfig(config) {
  // Deep-clone so we don't mutate the caller's object
  const toWrite = JSON.parse(JSON.stringify(config));

  // Ensure a per-install salt exists for key derivation
  let existingRaw = {};
  try {
    existingRaw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* first write or corrupt file */ }
  toWrite._salt = getOrCreateSalt(existingRaw);

  const salt = toWrite._salt;

  // Encrypt sensitive fields (skip already-encrypted values)
  for (const field of SENSITIVE_FIELDS) {
    const value = deepGet(toWrite, field);
    if (typeof value === "string" && value.length > 0 && !value.startsWith(ENCRYPTED_PREFIX)) {
      deepSet(toWrite, field, encrypt(value, salt));
    }
  }

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), { encoding: "utf8", mode: 0o600 });
}
