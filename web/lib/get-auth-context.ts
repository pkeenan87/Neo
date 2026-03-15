import { cache } from "react";
import { auth } from "@/auth";

interface AuthContext {
  userName: string;
  userRole: string;
  ownerId: string;
  userImage?: string;
}

/**
 * Deduplicated auth call — React.cache() ensures a single auth() round-trip
 * per server render, even when called from both layout.tsx and [id]/page.tsx.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const devBypass =
    process.env.NODE_ENV === "development" &&
    process.env.DEV_AUTH_BYPASS === "true";

  if (devBypass) {
    return { userName: "Operator", userRole: "admin", ownerId: "" };
  }

  const session = await auth();
  if (!session?.user) return null;

  const user = session.user as Record<string, unknown>;
  return {
    userName: (user.name as string) ?? "Operator",
    userRole: (user.role as string) ?? "reader",
    ownerId:
      (user.oid as string) ?? (user.id as string) ?? (user.name as string) ?? "",
    userImage: (user.image as string) ?? undefined,
  };
});
