// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// SettingsProvider hands themeMode ownership to MUI's color scheme and only
// persists layout/stretch. Mock the color-scheme seam so we can assert the
// delegation.
const mocks = vi.hoisted(() => ({
  setMode: vi.fn(),
  scheme: { mode: 'light', systemMode: 'light', setMode: undefined as unknown },
}));
mocks.scheme.setMode = mocks.setMode;

vi.mock('@mui/material/styles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mui/material/styles')>()),
  useColorScheme: () => mocks.scheme,
}));

// The global setup stubs useLocalStorage to a stale array shape; this provider
// uses the object API, so exercise the real hook (backed by jsdom localStorage).
vi.mock('../../../hooks/use-local-storage', async (importOriginal) =>
  importOriginal<typeof import('../../../hooks/use-local-storage')>(),
);

import { SettingsProvider } from './settings-provider';
import { useSettingsContext } from './settings-context';
import { SettingsValueProps } from '../types';

const DEFAULTS: SettingsValueProps = {
  themeMode: 'light',
  themeLayout: 'vertical',
};

function wrapper({ children }: { children: ReactNode }) {
  return <SettingsProvider defaultSettings={DEFAULTS}>{children}</SettingsProvider>;
}

function renderProvider() {
  return renderHook(() => useSettingsContext(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
  mocks.setMode.mockClear();
  mocks.scheme.mode = 'light';
  mocks.scheme.systemMode = 'light';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsProvider', () => {
  it('exposes exactly the trimmed context shape and derives themeMode from the color scheme', () => {
    const { result } = renderProvider();
    // Pin the exact key set: a re-added `themeDirection` (or a dropped live key)
    // fails here.
    expect(Object.keys(result.current).sort()).toEqual([
      'onUpdate',
      'themeLayout',
      'themeMode',
    ]);
    expect(result.current.themeMode).toBe('light');
    expect(result.current.themeLayout).toBe('vertical');
    expect(typeof result.current.onUpdate).toBe('function');
  });

  it('reports dark when the resolved color scheme is dark', () => {
    mocks.scheme.mode = 'dark';
    const { result } = renderProvider();
    expect(result.current.themeMode).toBe('dark');
  });

  it('resolves a "system" mode through systemMode', () => {
    mocks.scheme.mode = 'system';
    mocks.scheme.systemMode = 'dark';
    const { result } = renderProvider();
    expect(result.current.themeMode).toBe('dark');
  });

  it('routes onUpdate("themeMode") to MUI setMode and does NOT persist it to settings', () => {
    const { result } = renderProvider();
    act(() => result.current.onUpdate('themeMode', 'dark'));
    expect(mocks.setMode).toHaveBeenCalledTimes(1);
    expect(mocks.setMode).toHaveBeenCalledWith('dark');
    // themeMode is MUI-owned — nothing about it lands in the settings blob.
    expect(localStorage.getItem('settings')).toBeNull();
  });

  it('persists non-mode settings via local storage without touching setMode', async () => {
    const { result } = renderProvider();
    act(() => result.current.onUpdate('themeLayout', 'mini'));
    await waitFor(() => expect(result.current.themeLayout).toBe('mini'));
    expect(mocks.setMode).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('settings') ?? '{}').themeLayout).toBe('mini');
  });

  it('normalizes a stale persisted "horizontal" layout to "vertical"', async () => {
    // The settings value space is vertical | mini. A user who last used
    // horizontal has it persisted in localStorage — it must fall back to
    // vertical or their nav matches no layout branch and renders blank.
    // `_restored` is an untyped marker key so we can wait for the
    // storage-restore effect to actually apply before asserting — the
    // normalized `themeLayout` value is 'vertical' both before and after
    // restore, so it can't signal completion on its own.
    localStorage.setItem(
      'settings',
      JSON.stringify({ themeLayout: 'horizontal', _restored: true }),
    );
    const { result } = renderProvider();
    await waitFor(() => expect((result.current as unknown as { _restored?: boolean })._restored).toBe(true));
    expect(result.current.themeLayout).toBe('vertical');
  });
});
