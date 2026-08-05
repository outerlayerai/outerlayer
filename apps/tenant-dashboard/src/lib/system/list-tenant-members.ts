import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY } from "@/config-global.server";

/** Mirrors `UserRole` (`@/auth/types`) — re-derived from the generated DB
 *  enum directly rather than importing the legacy auth module (banned in
 *  this tier); the two types are structurally identical. */
type MemberRole = Database["public"]["Enums"]["app_role"];

export interface TenantMember {
  id: string;
  name: string | null;
  email: string;
  role: MemberRole;
  membershipId: string;
  membershipStatus: "active" | "pending";
  customRoleId?: string;
  customRoleName?: string;
  isConfirmed: boolean;
}

/**
 * The members list read: memberships + profiles + per-member auth confirmation
 * state for one tenant, active and pending only. A member cannot read a peer's
 * `profile` row (or any auth state) under RLS, so this is a genuine, narrow
 * admin need — confined here as the sole call site, replacing the inline admin
 * client the legacy `users.tsx` React Server Component (RSC) constructed itself.
 *
 * The per-member `auth.admin.getUserById` call (for `email_confirmed_at`) stays
 * one call per member: GoTrue's admin `listUsers` supports only page/perPage
 * pagination, not filtering by an arbitrary id list, so there is no batch
 * equivalent that preserves this exact semantic without over-fetching every
 * user in the project. Confirmation state is not tracked anywhere in
 * `public.profile`.
 */
export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  const admin = createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: memberships } = await admin
    .from("membership")
    .select("id, user_id, role, status, custom_role_id, custom_role(name)")
    .eq("tenant_id", tenantId)
    .in("status", ["active", "pending"]);

  if (!memberships || memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.user_id);
  const membershipByUser = new Map(
    memberships.map((m) => [
      m.user_id,
      {
        membershipId: m.id,
        role: m.role,
        status: m.status as "active" | "pending",
        customRoleName: (m.custom_role as { name: string } | null)?.name ?? undefined,
        customRoleId: m.custom_role_id ?? undefined,
      },
    ]),
  );

  const { data: profiles } = await admin
    .from("profile")
    .select("id, name, email")
    .in("id", userIds);

  const rows = profiles ?? [];

  return Promise.all(
    rows.map(async (profile) => {
      const membership = membershipByUser.get(profile.id);
      const { data: authUser } = await admin.auth.admin.getUserById(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: membership?.role ?? "read",
        membershipId: membership?.membershipId ?? "",
        membershipStatus: membership?.status ?? "pending",
        customRoleId: membership?.customRoleId,
        customRoleName: membership?.customRoleName,
        isConfirmed: !!authUser.user?.email_confirmed_at,
      };
    }),
  );
}
