import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Role } from "@/lib/permissions";
import { findApiKey } from "@/lib/api-key-store";

// ─────────────────────────────────────────────────────────────
//  Auth.js Config
// ─────────────────────────────────────────────────────────────

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: {
        params: {
          prompt: "select_account",
        },
      },
    }),
    Credentials({
      id: "api-key",
      name: "API Key",
      credentials: {
        apiKey: { label: "API Key", type: "text" },
      },
      authorize(credentials) {
        const apiKey = credentials?.apiKey;
        if (typeof apiKey !== "string" || !apiKey) return null;

        const entry = findApiKey(apiKey);
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
    jwt({ token, user, account, profile }) {
      // On initial sign-in, persist role, provider, and AAD object ID into the JWT
      if (account && user) {
        if (account.provider === "microsoft-entra-id") {
          // Entra ID app roles come as a "roles" array in the ID token
          const idTokenRoles = (account as Record<string, unknown>).roles as
            | string[]
            | undefined;
          if (idTokenRoles?.includes("Admin")) {
            token.role = "admin";
          } else {
            token.role = "reader";
          }
          token.authProvider = "entra-id";
          // Persist immutable AAD object ID for use as Cosmos partition key
          const entraProfile = profile as Record<string, unknown> | undefined;
          token.oid =
            (entraProfile?.oid as string) ??
            (entraProfile?.sub as string) ??
            user.id;
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
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});
