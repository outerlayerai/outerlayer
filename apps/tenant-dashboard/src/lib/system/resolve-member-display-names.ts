import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_API } from '@/config-global';
import { SUPABASE_SECRET_KEY } from '@/config-global.server';
import type { Database } from '@/types/db';

/**
 * Membership-UUID actors → developer display names, under the service-role
 * client. A member cannot read a peer's `profile` row under RLS, so turning
 * an agent session's ActorId into a name is a genuine, narrow RLS bypass —
 * scoped strictly to the caller-verified `tenantId`, never a raw param.
 *
 * Authorization rationale: callers pass only actor ids that came out of
 * ClickHouse rows the caller's resolved agent-session scope already let them
 * see (self-pinned or team.read), so this never widens visibility; it only
 * makes an already-visible column human-readable. Resolution failures
 * degrade to an empty map, never an error.
 */
export async function resolveMemberDisplayNames(
  tenantId: string,
  membershipIds: string[],
): Promise<Record<string, string>> {
  if (membershipIds.length === 0) return {};
  try {
    const db = createClient<Database>(
      `${SUPABASE_API.url}`,
      `${SUPABASE_SECRET_KEY}`,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: memberships } = await db
      .from('membership')
      .select('id, user_id')
      .eq('tenant_id', tenantId)
      .in('id', membershipIds);
    const userIds = (memberships ?? []).map((m) => m.user_id).filter(Boolean);
    if (userIds.length === 0) return {};
    const { data: profiles } = await db
      .from('profile')
      .select('id, name, email')
      .in('id', userIds as string[]);
    const nameByUser = new Map((profiles ?? []).map((p) => [p.id, p.name || p.email]));
    const out: Record<string, string> = {};
    for (const m of memberships ?? []) {
      const name = m.user_id ? nameByUser.get(m.user_id) : undefined;
      if (name) out[m.id] = name;
    }
    return out;
  } catch {
    return {};
  }
}
