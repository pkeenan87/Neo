import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated bearer-token request shape check ──────────────
// Mirrors the early-exit logic in
// web/lib/scheduled-task-internal-auth.ts (missing/empty bearer
// detection). Full JWT verification is not testable here without
// minting a real signed token, so we cover the surface that the
// route actually relies on for its 401/403 branches.

function checkBearerShape(authorizationHeader) {
  if (!authorizationHeader) return { ok: false, status: 401, reason: "missing_bearer" };
  if (!authorizationHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, reason: "missing_bearer" };
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, reason: "empty_bearer" };
  return { ok: true };
}

describe("internal poll bearer shape check", () => {
  it("missing header → 401 missing_bearer", () => {
    assert.deepEqual(checkBearerShape(null), {
      ok: false,
      status: 401,
      reason: "missing_bearer",
    });
  });

  it("non-bearer scheme → 401 missing_bearer", () => {
    assert.deepEqual(checkBearerShape("Basic abc"), {
      ok: false,
      status: 401,
      reason: "missing_bearer",
    });
  });

  it("Bearer with empty token → 401 empty_bearer", () => {
    assert.deepEqual(checkBearerShape("Bearer   "), {
      ok: false,
      status: 401,
      reason: "empty_bearer",
    });
  });

  it("well-formed bearer passes the shape check", () => {
    assert.deepEqual(checkBearerShape("Bearer abc.def.ghi"), { ok: true });
  });
});
