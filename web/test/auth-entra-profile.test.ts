import { describe, expect, it } from "vitest";
import { mapEntraProfile } from "../lib/entra-profile";

// `mapEntraProfile` is the project's Entra-provider `profile()`
// override. The default Auth.js Entra provider reads only `email`,
// which Entra doesn't populate for guests, federated accounts, and
// managed users without a verified primary SMTP. Those users still
// have `preferred_username` (UPN). The override falls through
// `email → preferred_username → upn` so `session.user.email` is
// populated for every legitimate Entra caller — which is what the
// Infosec Logic App audit `responder` field consumes.

describe("mapEntraProfile", () => {
  it("uses the `email` claim when present", () => {
    const out = mapEntraProfile({
      sub: "user-oid",
      name: "Alice Example",
      email: "alice@example.com",
      preferred_username: "alice@example.com",
      upn: "alice@example.com",
    });
    expect(out.email).toBe("alice@example.com");
  });

  it("falls back to `preferred_username` when `email` is absent", () => {
    const out = mapEntraProfile({
      sub: "guest-oid",
      name: "Guest User",
      preferred_username: "guest@homedomain.example",
      // No email claim — common for B2B guests and managed users
      // without a verified primary SMTP.
    });
    expect(out.email).toBe("guest@homedomain.example");
  });

  it("falls back to `upn` (legacy v1 claim) when both `email` and `preferred_username` are absent", () => {
    const out = mapEntraProfile({
      sub: "legacy-oid",
      name: "Legacy Account",
      upn: "svc@legacy.example",
    });
    expect(out.email).toBe("svc@legacy.example");
  });

  it("leaves email undefined when no email-shaped claim is present", () => {
    const out = mapEntraProfile({ sub: "no-email-oid", name: "Anon" });
    expect(out.email).toBeUndefined();
  });

  it("uses `sub` for id and falls back to `oid`", () => {
    expect(mapEntraProfile({ sub: "s", oid: "o" }).id).toBe("s");
    expect(mapEntraProfile({ oid: "o" }).id).toBe("o");
  });

  it("returns image: null — photo fetching is handled in the jwt() callback", () => {
    const out = mapEntraProfile({ sub: "x", email: "x@example.com" });
    expect(out.image).toBeNull();
  });
});
