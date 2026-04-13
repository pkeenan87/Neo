import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── CSRF origin/host validation ──────────────────────────────
// The admin routes compare the Origin header's host against the request Host
// header. This is inherently domain-agnostic: it passes when the browser is
// on *any* domain, as long as Origin matches Host.

/**
 * Simulates the CSRF check used in admin API routes
 * (web/app/api/admin/org-context/route.ts, usage/reset/route.ts).
 */
function csrfOriginMatchesHost(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

describe("dual-domain CSRF validation", () => {
  it("passes when origin and host are both the custom domain", () => {
    assert.equal(
      csrfOriginMatchesHost("https://neo.companyname.com", "neo.companyname.com"),
      true,
    );
  });

  it("passes when origin and host are both the azurewebsites.net domain", () => {
    assert.equal(
      csrfOriginMatchesHost("https://app-neo-prod-001.azurewebsites.net", "app-neo-prod-001.azurewebsites.net"),
      true,
    );
  });

  it("rejects when origin is custom domain but host is azurewebsites.net", () => {
    assert.equal(
      csrfOriginMatchesHost("https://neo.companyname.com", "app-neo-prod-001.azurewebsites.net"),
      false,
    );
  });

  it("rejects when origin is azurewebsites.net but host is custom domain", () => {
    assert.equal(
      csrfOriginMatchesHost("https://app-neo-prod-001.azurewebsites.net", "neo.companyname.com"),
      false,
    );
  });

  it("rejects when origin is missing", () => {
    assert.equal(csrfOriginMatchesHost(null, "neo.companyname.com"), false);
  });

  it("rejects when host is missing", () => {
    assert.equal(csrfOriginMatchesHost("https://neo.companyname.com", null), false);
  });
});

// ── OAuth redirect URI derivation ────────────────────────────
// With the explicit redirect_uri removed from auth.ts, Auth.js derives it
// from the incoming request host. Verify the callback path is well-known.

describe("OAuth callback path", () => {
  const CALLBACK_PATH = "/api/auth/callback/microsoft-entra-id";

  it("custom domain callback URI is well-formed", () => {
    const uri = `https://neo.companyname.com${CALLBACK_PATH}`;
    const parsed = new URL(uri);
    assert.equal(parsed.hostname, "neo.companyname.com");
    assert.equal(parsed.pathname, CALLBACK_PATH);
    assert.equal(parsed.protocol, "https:");
  });

  it("azurewebsites.net callback URI is well-formed", () => {
    const uri = `https://app-neo-prod-001.azurewebsites.net${CALLBACK_PATH}`;
    const parsed = new URL(uri);
    assert.equal(parsed.hostname, "app-neo-prod-001.azurewebsites.net");
    assert.equal(parsed.pathname, CALLBACK_PATH);
    assert.equal(parsed.protocol, "https:");
  });
});
