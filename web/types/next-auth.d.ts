import type { Role } from "@/lib/permissions";

declare module "next-auth" {
  interface User {
    role?: Role;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: Role;
    authProvider?: string;
  }
}
