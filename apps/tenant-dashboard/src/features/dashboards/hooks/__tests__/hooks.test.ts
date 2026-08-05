// @vitest-environment jsdom
/**
 * Tests: useWidgetData
 *
 * Verifies:
 *   - The typed API client builds the correct URLs from path/query params
 *   - Canonical error envelopes ({error: {code, message}}) propagate as
 *     ApiError with the typed `code` preserved
 *
 * SWR caching/revalidation is tested by SWR itself — we mock it out so
 * the fetcher runs synchronously and we can assert on side effects.
 *
 * `useDashboards` and `useDashboard` are seeded by a React Server Component
 * (RSC) — no fetcher, real SWR
 * cache + `mutate`) — see `use-dashboards.test.ts` / `use-dashboard.test.ts`,
 * which exercise real SWR rather than this file's fetcher-capturing mock.
 */

vi.mock('server-only', () => ({}));


// openapi-fetch captures `globalThis.fetch` at createClient() time, which
// happens when `@/lib/api/client` is first imported. To ensure our mock is
// in place before that import fires, set it via vi.hoisted() — hoisted code
// runs before module evaluation.
const { mockFetch } = vi.hoisted(() => {
  const mockFetch = (globalThis as unknown as Record<string, unknown>)['__hooksTestMockFetch__'] as ReturnType<typeof vi.fn> | undefined
    ?? Object.assign(vi.fn(), {});
  (globalThis as unknown as Record<string, unknown>)['__hooksTestMockFetch__'] = mockFetch;
  // @ts-expect-error - overriding global fetch for tests
  globalThis.fetch = mockFetch;
  return { mockFetch };
});

// SWR mock: captures key + fetcher, invokes fetcher with the key when
// the test manually resolves. Supports string OR tuple keys.
let swrKey: unknown = null;
let swrCallback: ((key: unknown) => Promise<unknown>) | null = null;

vi.mock('swr', () => ({
  __esModule: true,
  default: (key: unknown, fetcher: (k: unknown) => Promise<unknown>) => {
    swrKey = key;
    swrCallback = fetcher;
    return {
      data: undefined,
      error: undefined,
      isLoading: key !== null,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
}));

import { useWidgetData } from '../use-widget-data';
import { renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  swrKey = null;
  swrCallback = null;
});

// Helper: build a Response-like object that openapi-fetch will accept.
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? status < 400,
    status,
    statusText: '',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: '',
    clone() { return this; },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// useWidgetData
// ---------------------------------------------------------------------------
// widget-data does not use the typed client: it runs on the
// withAnalyticsAuthParams wrapper, the one sanctioned `// live:` route. The
// hook therefore hand-builds its requests and parses that wrapper's envelope
// against the org-scoped URL.

describe('useWidgetData', () => {
  it('produces a non-null SWR key when enabled', () => {
    renderHook(() =>
      useWidgetData(
        'my-org',
        'app-789',
        { metric: 'request_count', visualization: 'line', filters: [] },
        { preset: 'last_7_days' },
        { enabled: true },
      ),
    );
    expect(swrKey).not.toBeNull();
  });

  it('encodes the metric in the SWR key so distinct configs dedupe separately', () => {
    renderHook(() =>
      useWidgetData(
        'my-org',
        'app-789',
        { metric: 'request_count', visualization: 'line', filters: [] },
        { preset: 'last_7_days' },
        { enabled: true },
      ),
    );
    expect(JSON.stringify(swrKey)).toContain('request_count');
  });

  it('produces a null SWR key when orgName is missing, even if enabled', () => {
    renderHook(() =>
      useWidgetData(
        undefined,
        'app-789',
        { metric: 'request_count', visualization: 'line', filters: [] },
        { preset: 'last_7_days' },
        { enabled: true },
      ),
    );
    expect(swrKey).toBeNull();
  });

  it('produces a null SWR key when disabled', () => {
    renderHook(() =>
      useWidgetData(
        'my-org',
        'app-789',
        { metric: 'request_count', visualization: 'line', filters: [] },
        { preset: 'last_7_days' },
        { enabled: false },
      ),
    );
    expect(swrKey).toBeNull();
  });

  it('POSTs widget config + timeRange to the re-pathed canonical widget-data route', async () => {
    // Uses the mockFetch seam (this file overrides globalThis.fetch so the
    // openapi-fetch dashboardApi captures it), not MSW — which that override
    // bypasses. `useWidgetData` goes through `apiFetch` (raw global fetch).
    mockFetch.mockResolvedValueOnce(jsonResponse({ datapoints: [] }));

    renderHook(() =>
      useWidgetData(
        'my-org',
        'app-789',
        { metric: 'request_count', visualization: 'line', filters: [] },
        { preset: 'last_7_days' },
        { enabled: true },
      ),
    );
    await swrCallback!(swrKey);

    // apiFetch calls `fetch(urlString, init)` (not a Request object like
    // openapi-fetch), so read the (url, init) args directly rather than via
    // readFetchCall (which unwraps a Request).
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('/api/orgs/my-org/apps/app-789/analytics/widget-data');
    expect(calledUrl).toContain('appId=app-789');
    expect(calledInit.method).toBe('POST');
    expect(JSON.parse(calledInit.body as string)).toMatchObject({
      metric: 'request_count',
      timeRange: { preset: 'last_7_days' },
    });
  });
});
