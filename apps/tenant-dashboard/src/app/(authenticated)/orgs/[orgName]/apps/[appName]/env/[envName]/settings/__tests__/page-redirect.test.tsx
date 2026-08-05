// @vitest-environment jsdom
/**
 * Tests for the bare /env/<env>/settings → /env/<env>/settings/general
 * server-side redirect.
 *
 * Why a real test instead of trusting the typecheck: a client-side
 * `useEffect` redirect would let the right pane paint blank for one frame
 * before the redirect fires. The server-side redirect avoids that, so this
 * test pins:
 *  1. `redirect()` is called (the page never renders children),
 *  2. it targets the General sub-route UNDER the env path segment (the env
 *     must not be dropped from the redirect target), and
 *  3. any remaining query string survives the hop, including the array-valued
 *     repeat-key form Next.js hands us and skipping `undefined` values.
 */

import { redirect } from 'next/navigation';

import SettingsPage from '../page';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

describe('SettingsPage — bare /settings server-side redirect', () => {
  beforeEach(() => {
    vi.mocked(redirect).mockClear();
  });

  it('redirects to General under the env segment when no query string is present', async () => {
    await SettingsPage({
      params: Promise.resolve({ orgName: 'acme', appName: 'myapp', envName: 'prod' }),
      searchParams: Promise.resolve({}),
    });

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(
      '/orgs/acme/apps/myapp/env/prod/settings/general',
    );
  });

  it('keeps the env segment AND preserves a single-value query string', async () => {
    await SettingsPage({
      params: Promise.resolve({ orgName: 'acme', appName: 'myapp', envName: 'staging' }),
      searchParams: Promise.resolve({ tab: 'config' }),
    });

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(
      '/orgs/acme/apps/myapp/env/staging/settings/general?tab=config',
    );
  });

  it('re-emits array-valued params as repeats, not a stringified array', async () => {
    // Next.js `searchParams` surfaces `?tag=a&tag=b` as `{ tag: ['a', 'b'] }`.
    await SettingsPage({
      params: Promise.resolve({ orgName: 'acme', appName: 'myapp', envName: 'dev' }),
      searchParams: Promise.resolve({ tag: ['a', 'b'] }),
    });

    expect(redirect).toHaveBeenCalledTimes(1);
    const target = vi.mocked(redirect).mock.calls[0]![0] as string;
    const [base, qs] = target.split('?');
    expect(base).toBe('/orgs/acme/apps/myapp/env/dev/settings/general');
    const params = new URLSearchParams(qs);
    expect(params.getAll('tag')).toEqual(['a', 'b']);
  });

  it('skips undefined query values without producing empty params', async () => {
    await SettingsPage({
      params: Promise.resolve({ orgName: 'acme', appName: 'myapp', envName: 'dev' }),
      searchParams: Promise.resolve({ note: undefined, tab: 'config' }),
    });

    expect(redirect).toHaveBeenCalledTimes(1);
    const target = vi.mocked(redirect).mock.calls[0]![0] as string;
    expect(target).toBe(
      '/orgs/acme/apps/myapp/env/dev/settings/general?tab=config',
    );
  });
});
