"use client";

/**
 * Data hook for the Context › History panel. Reads the `context_sync_event`
 * ledger for one app, newest-first, through the context read action (an
 * RLS-scoped server client) — no PostgREST call from the browser.
 *
 * Paginated (`page`/`pageSize`) with an exact total so the pager can label
 * "x–y of N". A realtime INSERT revalidates the current page via `mutate()`,
 * so a new sync attempt shows (and the total updates) without a manual
 * refresh.
 */
import { useCallback, useEffect, useId, useState } from "react";
import useSWR from "swr";
import type { ActionResult } from "../../../../lib/action-kit/result";
import { getContextSyncHistory } from "../../read-actions";
import type { ContextSyncHistoryResponse } from "../../types";
import { subscribeContextSyncEvents } from "./context-sync-realtime";
import { toSyncHistoryRows, type SyncHistoryRow } from "./sync-history-model";

export const HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const HISTORY_DEFAULT_PAGE_SIZE = 20;

interface UseContextSyncHistoryResult {
  rows: SyncHistoryRow[];
  /** Exact ledger size for this app (pager total); 0 until the first load. */
  total: number;
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  /** Changing the page size returns to the first page. */
  setPageSize: (size: number) => void;
  isLoading: boolean;
  error: boolean;
}

/**
 * The action gates on `context.read` and so returns the action-kit result
 * envelope (`ActionResult` — dependency-free, safe for this client module).
 * Unwrap it to the plain payload SWR expects, turning a denial or read error
 * into a rejection so the hook surfaces its error state.
 */
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export function useContextSyncHistory(appId: string): UseContextSyncHistoryResult {
  const [page, setPageState] = useState(0);
  const [pageSize, setPageSizeState] = useState<number>(HISTORY_DEFAULT_PAGE_SIZE);
  // The channel is one per mount — a fixed name would collide under
  // realtime-js's topic dedup (see context-sync-realtime.ts).
  const topic = `context-sync-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // live: a new sync attempt (link/push/resync) lands on the server without
  // user action here — the realtime subscription below revalidates this page
  // on every INSERT so the ledger and its total stay current.
  const {
    data,
    error: swrError,
    isLoading,
    mutate,
  } = useSWR<ContextSyncHistoryResponse>(
    appId ? (["context-sync-history", appId, page, pageSize] as const) : null,
    () => getContextSyncHistory({ appId, page, pageSize }).then(unwrap),
    { revalidateOnFocus: false },
  );

  const setPage = useCallback((next: number) => {
    setPageState(next);
  }, []);
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPageState(0);
  }, []);

  // Reset to the first page when switching apps.
  useEffect(() => {
    setPageState(0);
  }, [appId]);

  useEffect(() => {
    if (!appId) return;
    const unsubscribe = subscribeContextSyncEvents({
      appId,
      topic,
      onChange: () => void mutate(),
    });
    return unsubscribe;
  }, [appId, topic, mutate]);

  return {
    rows: data ? toSyncHistoryRows(data.rows) : [],
    total: data?.total ?? 0,
    page,
    pageSize,
    setPage,
    setPageSize,
    isLoading,
    error: Boolean(swrError),
  };
}
