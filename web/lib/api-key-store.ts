import { readFileSync, watch } from "fs";
import { timingSafeEqual } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Role } from "./permissions";

export interface ApiKeyEntry {
  key: string;
  role: Role;
  label: string;
}

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

// Initial load at module startup
loadKeys();

// Hot-reload whenever the file changes on disk
try {
  watch(KEY_FILE, () => {
    loadKeys();
  });
} catch {
  // File may not exist yet; will be loaded on the next watch trigger once created
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Look up an API key. Uses a timing-safe comparison to resist enumeration. */
export function findApiKey(key: string): ApiKeyEntry | undefined {
  return keyCache.find((entry) => safeCompare(entry.key, key));
}
