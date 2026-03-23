import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Role } from "@/lib/permissions";
import { findApiKey } from "@/lib/api-key-store";
import { logger } from "@/lib/logger";

// ─────────────────────────────────────────────────────────────
//  Auth.js Config
// ─────────────────────────────────────────────────────────────

// On Azure App Service behind a reverse proxy, the default SameSite=Lax
// cookies are dropped during the cross-origin OAuth redirect from Entra ID.
// Force SameSite=None + Secure on OAuth flow cookies for HTTPS deployments
// so they survive the redirect cycle. The session token stays Lax to prevent CSRF.
const useSecureCookies = (() => {
  try {
    return new URL(process.env.AUTH_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
})();

const crossOriginCookie = { httpOnly: true, sameSite: "none" as const, path: "/", secure: true, maxAge: 900 };

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  ...(useSecureCookies && {
    cookies: {
      pkceCodeVerifier: {
        name: "__Secure-authjs.pkce.code_verifier",
        options: crossOriginCookie,
      },
      state: {
        name: "__Secure-authjs.state",
        options: crossOriginCookie,
      },
      nonce: {
        name: "__Secure-authjs.nonce",
        options: crossOriginCookie,
      },
      callbackUrl: {
        name: "__Secure-authjs.callback-url",
        options: crossOriginCookie,
      },
      // SECURITY: Session token stays SameSite=Lax to prevent CSRF.
      // Only the OAuth flow cookies above need None for the cross-origin redirect.
      sessionToken: {
        name: "__Secure-authjs.session-token",
        options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: true },
      },
    },
  }),
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: {
        params: {
          scope: "openid profile email User.Read",
          prompt: "select_account",
          redirect_uri: `${process.env.AUTH_URL}/api/auth/callback/microsoft-entra-id`,
        },
      },
    }),
    Credentials({
      id: "api-key",
      name: "API Key",
      credentials: {
        apiKey: { label: "API Key", type: "text" },
      },
      async authorize(credentials) {
        const apiKey = credentials?.apiKey;
        if (typeof apiKey !== "string" || !apiKey) return null;

        const entry = await findApiKey(apiKey);
        if (!entry) return null;

        return {
          id: entry.label,
          name: entry.label,
          role: entry.role,
        };
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    authorized({ auth: session, request }) {
      // In dev with DEV_AUTH_BYPASS, allow all requests
      if (
        process.env.NODE_ENV === "development" &&
        process.env.DEV_AUTH_BYPASS === "true"
      ) {
        return true;
      }
      const isLoggedIn = !!session?.user;
      const isOnChat = request.nextUrl.pathname.startsWith("/chat");
      if (isOnChat) return isLoggedIn;
      return true;
    },
    async jwt({ token, user, account, profile }) {
      // On initial sign-in, persist role, provider, and AAD object ID into the JWT
      if (account && user) {
        if (account.provider === "microsoft-entra-id") {
          // Entra ID app roles come as a "roles" array in the decoded ID token (profile)
          const rawRoles = (profile as Record<string, unknown> | undefined)?.roles;
          if (!profile) {
            logger.warn("Entra ID profile absent — defaulting to reader", "auth", { provider: "entra-id" });
          }
          const idTokenRoles = Array.isArray(rawRoles)
            ? rawRoles.filter((r): r is string => typeof r === "string")
            : [];
          if (idTokenRoles.includes("Admin")) {
            token.role = "admin";
          } else {
            token.role = "reader";
          }
          logger.debug("Entra ID role resolved", "auth", { provider: "entra-id", role: token.role });
          token.authProvider = "entra-id";
          // Persist immutable AAD object ID for use as Cosmos partition key
          const entraProfile = profile as Record<string, unknown> | undefined;
          token.oid =
            (entraProfile?.oid as string) ??
            (entraProfile?.sub as string) ??
            user.id;

          // Fetch profile photo from Microsoft Graph (fire-and-forget on failure)
          if (account.access_token) {
            try {
              const photoRes = await fetch(
                "https://graph.microsoft.com/v1.0/me/photos/48x48/$value",
                { headers: { Authorization: `Bearer ${account.access_token}` } },
              );
              if (photoRes.ok) {
                const buf = await photoRes.arrayBuffer();
                const base64 = Buffer.from(buf).toString("base64");
                const contentType = photoRes.headers.get("content-type") ?? "image/jpeg";
                token.picture = `data:${contentType};base64,${base64}`;
              }
            } catch (err) {
              logger.warn("Failed to fetch Entra ID profile photo", "auth", {
                errorMessage: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else if (account.provider === "api-key") {
          token.role = (user as Record<string, unknown>).role as Role;
          token.authProvider = "api-key";
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const user = session.user as unknown as Record<string, unknown>;
        user.role = token.role;
        user.authProvider = token.authProvider;
        user.oid = token.oid;
        user.image = token.picture;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});
