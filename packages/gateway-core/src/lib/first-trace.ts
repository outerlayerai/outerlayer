import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Atomically marks the tenant's first trace by setting first_trace_at.
 * Returns true when the column transitions null → timestamp (genuine first
 * trace ever). Returns false if already set (billing-period reset case).
 */
export async function claimFirstTrace(
  adminClient: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data } = await adminClient
    .from('tenant')
    .update({ first_trace_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .is('first_trace_at', null)
    .select('first_trace_at');
  return (data?.length ?? 0) > 0;
}
