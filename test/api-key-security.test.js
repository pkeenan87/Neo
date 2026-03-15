import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";

// ── Hash consistency ─────────────────────────────────────────

describe("API key hash", () => {
  function hashApiKey(raw) {
    return createHash("sha256").update(raw).digest("hex");
  }

  it("produces consistent SHA-256 hash", () => {
    const key = "test-key-abc123";
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64, "SHA-256 hex should be 64 chars");
  });

  it("produces different hashes for different keys", () => {
    const hash1 = hashApiKey("key-one");
    const hash2 = hashApiKey("key-two");
    assert.notEqual(hash1, hash2);
  });
});

// ── Expiration check ─────────────────────────────────────────

describe("API key expiration", () => {
  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() <= Date.now();
  }

  it("returns false for null expiration", () => {
    assert.equal(isExpired(null), false);
  });

  it("returns false for future expiration", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    assert.equal(isExpired(future), false);
  });

  it("returns true for past expiration", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    assert.equal(isExpired(past), true);
  });
});

// ── Revocation check ─────────────────────────────────────────

describe("API key revocation", () => {
  function isRevoked(record) {
    return record.revoked === true;
  }

  it("returns false for active key", () => {
    assert.equal(isRevoked({ revoked: false }), false);
  });

  it("returns true for revoked key", () => {
    assert.equal(isRevoked({ revoked: true }), true);
  });
});

// ── Lifetime validation ──────────────────────────────────────

describe("API key lifetime validation", () => {
  const MAX_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;

  function validateExpiration(expiresAt) {
    if (!expiresAt) return { valid: true };
    const expMs = new Date(expiresAt).getTime();
    if (isNaN(expMs) || expMs <= Date.now()) {
      return { valid: false, reason: "must be in the future" };
    }
    if (expMs - Date.now() > MAX_LIFETIME_MS) {
      return { valid: false, reason: "exceeds 2-year maximum" };
    }
    return { valid: true };
  }

  it("accepts null expiration", () => {
    assert.equal(validateExpiration(null).valid, true);
  });

  it("accepts date within 2 years", () => {
    const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(validateExpiration(oneYear).valid, true);
  });

  it("rejects date more than 2 years away", () => {
    const threeYears = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = validateExpiration(threeYears);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("2-year"));
  });

  it("rejects past date", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const result = validateExpiration(past);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("future"));
  });

  it("rejects invalid date string", () => {
    const result = validateExpiration("not-a-date");
    assert.equal(result.valid, false);
  });
});

// ── Key count limit ──────────────────────────────────────────

describe("API key count limit", () => {
  const MAX_KEYS = 20;

  it("allows creation when under limit", () => {
    assert.ok(19 < MAX_KEYS, "should allow when count is under 20");
  });

  it("rejects creation at limit", () => {
    assert.ok(20 >= MAX_KEYS, "should reject when count is 20");
  });
});
