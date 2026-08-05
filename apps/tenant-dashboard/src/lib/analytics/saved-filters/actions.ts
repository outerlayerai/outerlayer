'use server';

/**
 * Saved-filters mutations, gated through `authorizedAction`. `trace.read`
 * gates every mutation, appId-narrowed: the filters exist only on
 * trace-analytics surfaces (traces/requests/sessions) that are themselves
 * gated by `trace.read` in the UI, so a member who can't reach those pages
 * can't reach these actions either. RLS (`tenant_shared_filters`) keeps
 * saved filters tenant+app shared by design (any app member may edit or
 * delete a teammate's saved view — `user_id` is provenance only, never an
 * access-control column); the appId narrowing here is additive on top of
 * that tenant-level RLS scope, never a per-user restriction.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { authorizedAction } from '@/lib/action-kit';

import { CreateSavedFilterBodySchema, FilterConfigSchema } from './zod-schemas';
import { z } from 'zod';
import type { SavedFilter } from './read';

const MAX_FILTERS_PER_APP = 10;

/** A business-rule rejection the caller can render a specific message for,
 * distinct from validation/permission/internal failures — those still throw
 * and map to the wrapper's generic `fail`. */
type MutationOutcome =
  | { ok: true; filter: SavedFilter }
  | { ok: false; reason: 'name_conflict' }
  | { ok: false; reason: 'limit_exceeded'; message: string }
  | { ok: false; reason: 'not_found' };

type DeleteOutcome = { ok: true } | { ok: false; reason: 'not_found' };

const UpdateSavedFilterInput = z
  .object({
    appId: z.string().min(1),
    filterId: z.string().uuid(),
    name: z.string().trim().min(1).max(100).optional(),
    filter_config: FilterConfigSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.filter_config !== undefined, {
    message: 'At least one of name or filter_config must be provided',
  });

const RemoveSavedFilterInput = z.object({
  appId: z.string().min(1),
  filterId: z.string().uuid(),
});

export const saveFilter = authorizedAction({
  input: CreateSavedFilterBodySchema,
  permission: 'trace.read',
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<MutationOutcome> => {
    const db = ctx.db as SupabaseClient;
    const { appId, name, filter_config, page } = input;

    const { count, error: countError } = await db
      .from('saved_trace_filters')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId);
    if (countError) throw new Error('Failed to check filter count');
    if ((count ?? 0) >= MAX_FILTERS_PER_APP) {
      return {
        ok: false,
        reason: 'limit_exceeded',
        message: `Maximum of ${MAX_FILTERS_PER_APP} saved filters per app reached`,
      };
    }

    const { data, error } = await db
      .from('saved_trace_filters')
      .insert({
        user_id: ctx.actor.userId,
        tenant_id: ctx.tenantId,
        app_id: appId,
        name,
        filter_config,
        page,
      })
      .select('id, name, filter_config, created_at, updated_at')
      .single();

    if (error) {
      if (error.code === '23505') return { ok: false, reason: 'name_conflict' };
      throw new Error('Failed to create saved filter');
    }
    return { ok: true, filter: data as SavedFilter };
  },
});

export const updateFilter = authorizedAction({
  input: UpdateSavedFilterInput,
  permission: 'trace.read',
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<MutationOutcome> => {
    const db = ctx.db as SupabaseClient;
    const updates: { name?: string; filter_config?: z.infer<typeof FilterConfigSchema> } = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.filter_config !== undefined) updates.filter_config = input.filter_config;

    const { data, error } = await db
      .from('saved_trace_filters')
      .update(updates)
      // app_id narrows to the caller's authorized app on top of RLS's
      // tenant scope — the permission check above already commits to this
      // app, so a filterId from a different app in the same tenant 404s
      // here instead of silently updating it.
      .eq('id', input.filterId)
      .eq('app_id', input.appId)
      .select('id, name, filter_config, created_at, updated_at')
      .single();

    if (error) {
      if (error.code === '23505') return { ok: false, reason: 'name_conflict' };
      // PGRST116 is PostgREST's "the result contains 0 rows" for `.single()`
      // — the (id, app_id) pair matched no row (an unknown filterId or one
      // from a different app in the same tenant). A typed outcome, not a
      // thrown error: mirrors removeFilter's not_found so the hook branches
      // on the same shape for both mutations. Any OTHER error is a genuine
      // failure (a transient DB error, a bug) and must not read as "this
      // view no longer exists" — it throws and maps to the wrapper's
      // generic internal_error.
      if (error.code === 'PGRST116') return { ok: false, reason: 'not_found' };
      throw new Error('Failed to update saved filter');
    }
    return { ok: true, filter: data as SavedFilter };
  },
});

export const removeFilter = authorizedAction({
  input: RemoveSavedFilterInput,
  permission: 'trace.read',
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<DeleteOutcome> => {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from('saved_trace_filters')
      .delete()
      .eq('id', input.filterId)
      .eq('app_id', input.appId)
      .select('id')
      .single();

    if (error || !data) return { ok: false, reason: 'not_found' };
    return { ok: true };
  },
});
