// @vitest-environment jsdom
/**
 * `useSavedViews` — real SWR cache (a fresh in-memory provider per test, via
 * `SWRConfig`), with only the Server Actions and the snackbar mocked. Pins
 * the cache-merge/replace branches on save/update/remove, the per-outcome
 * snackbar messages, and the no-appId early-outs — the logic this hook's
 * only OTHER exerciser (`agent-sessions.test.tsx`) can't reach, since that
 * test mocks the whole hook away.
 */
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { saveFilterMock, updateFilterMock, removeFilterMock, enqueueSnackbarMock } = vi.hoisted(() => ({
  saveFilterMock: vi.fn(),
  updateFilterMock: vi.fn(),
  removeFilterMock: vi.fn(),
  enqueueSnackbarMock: vi.fn(),
}));

vi.mock('@/lib/analytics/saved-filters/actions', () => ({
  saveFilter: saveFilterMock,
  updateFilter: updateFilterMock,
  removeFilter: removeFilterMock,
}));
vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }),
}));

import { useSavedViews } from './use-saved-views';
import type { SavedFilter } from '@/lib/analytics/saved-filters/read';

function view(id: string, overrides: Partial<SavedFilter> = {}): SavedFilter {
  return {
    id,
    name: 'View',
    filter_config: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

// A fresh Map-backed cache per test — SWR's default module-level cache would
// otherwise leak state across tests keyed on the same (appId, page).
function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSavedViews — seeding and no-appId early-outs', () => {
  it('seeds views from initialViews with no fetch (fallbackData, not a network call)', () => {
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1', { name: 'Alpha' })] }),
      { wrapper },
    );
    expect(result.current.views).toEqual([view('v1', { name: 'Alpha' })]);
    expect(result.current.isLoading).toBe(false);
  });

  it('defaults to an empty view list when no initialViews is seeded', () => {
    const { result } = renderHook(() => useSavedViews({ page: 'sessions', appId: 'app-1' }), { wrapper });
    expect(result.current.views).toEqual([]);
  });

  it('save/update/remove all no-op (never call the action) when appId is undefined', async () => {
    const { result } = renderHook(() => useSavedViews({ page: 'sessions', appId: undefined }), { wrapper });

    await act(async () => {
      expect(await result.current.save('X', {})).toBeNull();
      expect(await result.current.update('v1', { name: 'Y' })).toBeNull();
      expect(await result.current.remove('v1')).toBe(false);
    });

    expect(saveFilterMock).not.toHaveBeenCalled();
    expect(updateFilterMock).not.toHaveBeenCalled();
    expect(removeFilterMock).not.toHaveBeenCalled();
  });
});

describe('useSavedViews — save', () => {
  it('appends the created filter, keeping the list sorted by name, and shows a success snackbar', async () => {
    saveFilterMock.mockResolvedValue({ ok: true, data: { ok: true, filter: view('v2', { name: 'Zebra' }) } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1', { name: 'Alpha' })] }),
      { wrapper },
    );

    await act(async () => {
      await result.current.save('Zebra', { v: 1 });
    });

    expect(result.current.views.map((v) => v.name)).toEqual(['Alpha', 'Zebra']);
    expect(saveFilterMock).toHaveBeenCalledWith({ appId: 'app-1', name: 'Zebra', filter_config: { v: 1 }, page: 'sessions' });
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('View saved', { variant: 'success' });
  });

  it('an outer action failure (e.g. forbidden) shows the wrapper error message and leaves the cache untouched', async () => {
    saveFilterMock.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'Permission denied: trace.read' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.save('New', {}));

    expect(returned).toBeNull();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('Permission denied: trace.read', { variant: 'error' });
    expect(result.current.views).toEqual([view('v1')]);
  });

  it('name_conflict shows the specific message and does not mutate the cache', async () => {
    saveFilterMock.mockResolvedValue({ ok: true, data: { ok: false, reason: 'name_conflict' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.save('My view', {}));

    expect(returned).toBeNull();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('A view with this name already exists', { variant: 'error' });
    expect(result.current.views).toEqual([view('v1')]);
  });

  it('limit_exceeded surfaces the outcome\'s own message, not a generic one', async () => {
    saveFilterMock.mockResolvedValue({
      ok: true,
      data: { ok: false, reason: 'limit_exceeded', message: 'Maximum of 10 saved filters per app reached' },
    });
    const { result } = renderHook(() => useSavedViews({ page: 'sessions', appId: 'app-1' }), { wrapper });

    await act(async () => {
      await result.current.save('New', {});
    });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith('Maximum of 10 saved filters per app reached', { variant: 'error' });
  });

  it('a not_found business outcome (unreachable in practice, shared union) still resolves to null with a snackbar, never a crash', async () => {
    saveFilterMock.mockResolvedValue({ ok: true, data: { ok: false, reason: 'not_found' } });
    const { result } = renderHook(() => useSavedViews({ page: 'sessions', appId: 'app-1' }), { wrapper });

    const returned = await act(async () => result.current.save('New', {}));

    expect(returned).toBeNull();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('Failed to save view', { variant: 'error' });
  });
});

describe('useSavedViews — update', () => {
  it('replaces exactly the matching filter in place, preserving the others and their order', async () => {
    updateFilterMock.mockResolvedValue({ ok: true, data: { ok: true, filter: view('v1', { name: 'Renamed' }) } });
    const { result } = renderHook(
      () =>
        useSavedViews({
          page: 'sessions',
          appId: 'app-1',
          initialViews: [view('v1', { name: 'Old' }), view('v2', { name: 'Other' })],
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.update('v1', { name: 'Renamed' });
    });

    expect(result.current.views).toEqual([view('v1', { name: 'Renamed' }), view('v2', { name: 'Other' })]);
    expect(updateFilterMock).toHaveBeenCalledWith({ appId: 'app-1', filterId: 'v1', name: 'Renamed' });
  });

  it('not_found shows "no longer exists" and leaves the cache untouched', async () => {
    updateFilterMock.mockResolvedValue({ ok: true, data: { ok: false, reason: 'not_found' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.update('v1', { name: 'X' }));

    expect(returned).toBeNull();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('This view no longer exists', { variant: 'error' });
    expect(result.current.views).toEqual([view('v1')]);
  });

  it('name_conflict on update shows the same specific message as save', async () => {
    updateFilterMock.mockResolvedValue({ ok: true, data: { ok: false, reason: 'name_conflict' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    await act(async () => {
      await result.current.update('v1', { name: 'Dup' });
    });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith('A view with this name already exists', { variant: 'error' });
  });

  it('an outer action failure surfaces the wrapper error message', async () => {
    updateFilterMock.mockResolvedValue({ ok: false, error: { code: 'internal_error', message: 'Failed to update saved filter' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.update('v1', { name: 'X' }));

    expect(returned).toBeNull();
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('Failed to update saved filter', { variant: 'error' });
  });
});

describe('useSavedViews — remove', () => {
  it('removes exactly the matching filter and shows a success snackbar', async () => {
    removeFilterMock.mockResolvedValue({ ok: true, data: { ok: true } });
    const { result } = renderHook(
      () =>
        useSavedViews({
          page: 'sessions',
          appId: 'app-1',
          initialViews: [view('v1', { name: 'Keep' }), view('v2', { name: 'Gone' })],
        }),
      { wrapper },
    );

    const returned = await act(async () => result.current.remove('v2'));

    expect(returned).toBe(true);
    expect(result.current.views).toEqual([view('v1', { name: 'Keep' })]);
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('View deleted', { variant: 'success' });
  });

  it('a not_found outcome (data.ok: false) fails without mutating the cache', async () => {
    removeFilterMock.mockResolvedValue({ ok: true, data: { ok: false, reason: 'not_found' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.remove('v1'));

    expect(returned).toBe(false);
    expect(enqueueSnackbarMock).toHaveBeenCalledWith('Failed to delete view', { variant: 'error' });
    expect(result.current.views).toEqual([view('v1')]);
  });

  it('an outer action failure (result.ok: false) also fails without mutating the cache', async () => {
    removeFilterMock.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'denied' } });
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    const returned = await act(async () => result.current.remove('v1'));

    expect(returned).toBe(false);
    expect(result.current.views).toEqual([view('v1')]);
  });
});

describe('useSavedViews — refresh', () => {
  it('is a local-cache no-op: it never calls any Server Action', async () => {
    const { result } = renderHook(
      () => useSavedViews({ page: 'sessions', appId: 'app-1', initialViews: [view('v1')] }),
      { wrapper },
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(saveFilterMock).not.toHaveBeenCalled();
    expect(updateFilterMock).not.toHaveBeenCalled();
    expect(removeFilterMock).not.toHaveBeenCalled();
    expect(result.current.views).toEqual([view('v1')]);
  });
});
