/**
 * Integration test asserting the deployment-history schema invariant.
 *
 * Deployment history is unified into `public.deployment`
 * (`env_version IS NOT NULL`); `public.promotion_history` is never created —
 * there is no data migration to verify.
 *
 * Rather than leave a body-less skipped stub, this file asserts the
 * invariant directly: `public.promotion_history` does not exist in
 * the schema. If a future migration ever re-introduces that table, this test
 * fails and forces a deliberate decision.
 *
 * Runs against a real local Supabase and asserts the specific "relation absent"
 * error, not the mere absence of an error.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';

describe('deployment-history schema invariant — promotion_history is never created', () => {
  it('should report public.promotion_history as a non-existent relation', async () => {
    // Arrange — a service-role client (RLS does not mask a missing table).
    const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

    // Act — attempt a trivial SELECT against the dropped/never-created table.
    const { data, error } = await admin
      .from('promotion_history')
      .select('id')
      .limit(1);

    // Assert — the query did not return rows, and the error names the missing
    // relation. PostgreSQL reports a missing table with SQLSTATE `42P01`
    // ("undefined_table"); the message also names the relation.
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42P01');
    expect(error!.message).toMatch(/promotion_history/i);
  });
});
