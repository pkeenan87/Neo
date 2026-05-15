/**
 * Map an Entra OIDC profile to the Auth.js User shape used by this
 * project. Falls through `email → preferred_username → upn` because
 * the default Auth.js Entra provider reads only `email`, which Entra
 * doesn't populate for guests, federated accounts, and managed users
 * without a verified primary SMTP. Used by the `profile()` override
 * on the MicrosoftEntraID provider in `web/auth.ts` — split into its
 * own module so it can be unit-tested without pulling in NextAuth
 * (whose import has heavy `next/server` side effects).
 *
 * Note on shape: returns `image: null` rather than fetching the
 * profile photo. Photo fetching is handled in the `jwt()` callback
 * in `web/auth.ts` using `account.access_token` against Microsoft
 * Graph; whatever we put in `image` here gets overwritten by
 * `token.picture` anyway.
 */
export function mapEntraProfile(p: Record<string, unknown>): {
  id: string;
  name: string | undefined;
  email: string | undefined;
  image: null;
} {
  const email =
    (p.email as string | undefined) ??
    (p.preferred_username as string | undefined) ??
    (p.upn as string | undefined);
  return {
    id: (p.sub as string) ?? (p.oid as string),
    name: (p.name as string) ?? undefined,
    email,
    image: null,
  };
}
