"use client";

/**
 * The client-tier identity crossing — the mirror of `lib/adapters` for
 * components that need "who is the current user" rather than a data read.
 * Exposes a narrow, purpose-named surface (not the whole auth context) so
 * later client-component moves copy this shape instead of reaching for
 * `useAuthContext`/`@/auth/types` directly, which `NEW_WORLD`'s
 * `no-restricted-imports` rail forbids outside `lib/adapters`.
 */

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the sanctioned client-tier crossing to the legacy auth context; lib/adapters is the server-tier equivalent.
import { useAuthContext } from "@/auth/hooks";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- type/enum crossing only, narrowed to what client components need.
import { UserRoleEnum, type UserRole } from "@/auth/types";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the sanctioned client-tier crossing to the legacy auth context; lib/adapters is the server-tier equivalent.
import { useOptionalCurrentUserRole } from "@/auth/context/app-permissions-context";

export { UserRoleEnum };
export type { UserRole };

interface CurrentUser {
  userId: string | undefined;
  email: string | undefined;
  /** The actor's org-level role for the REQUEST tenant. */
  role: UserRole | undefined;
  isOwner: boolean;
}

/**
 * The current user's identity + org role, narrowed for client components.
 *
 * `role` comes from the snapshot seeded by a React Server Component (RSC)
 * (`AppPermissionsProvider`,
 * mounted at the org/app layout, resolved server-side against the REQUEST
 * tenant) — undefined when no provider is mounted, or one is mounted but
 * can't resolve a role (e.g. no active membership row for the request
 * tenant).
 */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuthContext();
  const role = useOptionalCurrentUserRole();
  return {
    userId: user?.id,
    email: user?.email,
    role,
    isOwner: role === UserRoleEnum.OWNER,
  };
}
