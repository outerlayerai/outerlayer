/**
 * useSavedViews Hook
 *
 * CRUD hook for saved filters/views, scoped by app + page. Saved-filters
 * mutations run through Server Actions (`@/lib/analytics/saved-filters/
 * actions`), never a REST fetch — a caller seeds the initial page of views
 * via `initialViews` (a React Server Component (RSC) read through `@/lib/analytics/saved-filters/
 * read`), and every mutation updates the SWR cache from the action's own
 * response instead of triggering a refetch. The hook keeps its
 * `{page, appId}` shape so any page on this surface (traces/requests/
 * sessions) can consume it the same way once it seeds its own initial views.
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import { useSnackbar } from 'notistack';
import { saveFilter, updateFilter, removeFilter } from '@/lib/analytics/saved-filters/actions';
import type { SavedFilter, SavedFilterPage } from '@/lib/analytics/saved-filters/read';

// ─── Hook ───────────────────────────────────────────────────────────

export function useSavedViews({
  page,
  appId,
  initialViews,
}: {
  page: SavedFilterPage;
  appId: string | undefined;
  initialViews?: SavedFilter[];
}) {
  const { enqueueSnackbar } = useSnackbar();

  const key = appId ? (['saved-filters', appId, page] as const) : null;
  // No fetcher: mutations are the only writer to this cache, so revalidation
  // is disabled outright and the cache is only ever written by the mutation
  // callbacks below.
  const seeded = initialViews ? { filters: initialViews } : undefined;
  const { data, error, isLoading, mutate } = useSWR<{ filters: SavedFilter[] }, Error, typeof key>(
    key,
    null,
    {
      fallbackData: seeded,
      revalidateOnMount: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  const views = data?.filters ?? [];

  const save = useCallback(
    async (name: string, filterConfig: Record<string, unknown>) => {
      if (!appId) return null;

      const result = await saveFilter({ appId, name, filter_config: filterConfig, page });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: 'error' });
        return null;
      }
      const outcome = result.data;
      if (!outcome.ok) {
        // Known per-code UX branches — the action's own conflict/limit
        // outcomes. `not_found` never fires here (saveFilter has no id to
        // miss) — the branch exists only because the type is shared with
        // updateFilter's outcome.
        if (outcome.reason === 'name_conflict') {
          enqueueSnackbar('A view with this name already exists', { variant: 'error' });
        } else if (outcome.reason === 'not_found') {
          enqueueSnackbar('Failed to save view', { variant: 'error' });
        } else {
          enqueueSnackbar(outcome.message, { variant: 'error' });
        }
        return null;
      }

      const saved = outcome.filter;
      // `prev` reads the SWR CACHE, not `fallbackData` — an RSC-seeded
      // `initialViews` never gets written into the cache on its own, so the
      // very first mutation after a fresh seed would otherwise see `prev`
      // as empty and silently drop every seeded row. Fall back to the seed
      // explicitly; once any mutate call writes a real value, later calls
      // read that value back through `prev` as normal.
      await mutate(
        (prev) => {
          const base = prev ?? seeded;
          return {
            filters: [...(base?.filters ?? []), saved].sort((a, b) => a.name.localeCompare(b.name)),
          };
        },
        { revalidate: false },
      );
      enqueueSnackbar('View saved', { variant: 'success' });
      return saved;
    },
    [page, appId, mutate, enqueueSnackbar, seeded]
  );

  const update = useCallback(
    async (
      id: string,
      updates: { name?: string; filter_config?: Record<string, unknown> },
    ) => {
      if (!appId) return null;

      const result = await updateFilter({ appId, filterId: id, ...updates });
      if (!result.ok) {
        enqueueSnackbar(result.error.message, { variant: 'error' });
        return null;
      }
      const outcome = result.data;
      if (!outcome.ok) {
        if (outcome.reason === 'name_conflict') {
          enqueueSnackbar('A view with this name already exists', { variant: 'error' });
        } else if (outcome.reason === 'not_found') {
          enqueueSnackbar('This view no longer exists', { variant: 'error' });
        } else {
          enqueueSnackbar(outcome.message, { variant: 'error' });
        }
        return null;
      }

      const updated = outcome.filter;
      await mutate(
        (prev) => {
          const base = prev ?? seeded;
          return base ? { filters: base.filters.map((f) => (f.id === id ? updated : f)) } : base;
        },
        { revalidate: false },
      );
      return updated;
    },
    [appId, mutate, enqueueSnackbar, seeded]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!appId) return false;

      const result = await removeFilter({ appId, filterId: id });
      if (!result.ok || !result.data.ok) {
        enqueueSnackbar('Failed to delete view', { variant: 'error' });
        return false;
      }

      await mutate(
        (prev) => {
          const base = prev ?? seeded;
          return base ? { filters: base.filters.filter((f) => f.id !== id) } : base;
        },
        { revalidate: false }
      );
      enqueueSnackbar('View deleted', { variant: 'success' });
      return true;
    },
    [appId, mutate, enqueueSnackbar, seeded]
  );

  return {
    views,
    isLoading,
    error: error || null,
    save,
    update,
    remove,
    // No fetcher to revalidate against; mutations already keep the cache
    // current, so this is a deliberate no-op kept for interface parity.
    refresh: () => mutate(undefined, { revalidate: false }),
  };
}
