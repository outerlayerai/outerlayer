/**
 * The saved-filters list read, shared by any React Server Component (RSC) page that seeds
 * `useSavedViews` initial data instead of a client-side fetch. RLS on
 * `saved_trace_filters` (`tenant_shared_filters`) scopes to the caller's
 * tenant, so this needs only the app + page filter on top.
 */
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { FilterPageSchema, SavedFilterSchema } from './zod-schemas';
import type { z } from 'zod';

export type SavedFilterPage = z.infer<typeof FilterPageSchema>;
export type SavedFilter = z.infer<typeof SavedFilterSchema>;

export async function listSavedFilters(
  db: SupabaseClient,
  { appId, page }: { appId: string; page: SavedFilterPage },
): Promise<SavedFilter[]> {
  const { data, error } = await db
    .from('saved_trace_filters')
    .select('id, name, filter_config, created_at, updated_at')
    .eq('app_id', appId)
    .eq('page', page)
    .order('name', { ascending: true });

  if (error) throw new Error('Failed to fetch saved filters');
  return (data ?? []) as SavedFilter[];
}
