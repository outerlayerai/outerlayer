// @vitest-environment jsdom
/**
 * Unit tests for the usePlatformAdmin hook.
 *
 * The hook drives a nav affordance, not access — every platform-admin route and
 * server action re-checks both conditions server-side. But it had no tests at
 * all, and the consequences of each direction being wrong are asymmetric:
 *
 *   - false negative → the admin surface is invisible to a real admin
 *   - false positive → a non-admin sees a nav entry into pages that will deny
 *     them, which reads as a broken app and leaks that the surface exists
 *
 * The domain check also short-circuits BEFORE the `platform_user_role` query, so
 * it saves a round trip for every non-admin on every page load. A test that only
 * asserted the returned flag would let that short-circuit be deleted silently,
 * so the query itself is asserted on too.
 *
 * `useAuthContext` and the browser Supabase client are the two seams.
 */

import { renderHook, waitFor } from '@testing-library/react';

const mockUser = vi.fn();
vi.mock('../use-auth-context', () => ({
  useAuthContext: () => ({ user: mockUser() }),
}));

const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));
vi.mock('../../../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: () => ({ from }),
}));

import { usePlatformAdmin } from '../use-platform-admin';

const ADMIN = { id: 'user-1', email: 'admin@outerlayer.ai' };

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: { role: 'platform_admin' } });
});

describe('usePlatformAdmin', () => {
  it('resolves true for an allowed domain WITH a platform role', async () => {
    mockUser.mockReturnValue(ADMIN);

    const { result } = renderHook(() => usePlatformAdmin());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(true);
    expect(from).toHaveBeenCalledWith('platform_user_role');
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  // Kills the `if (false)` / `if (true)` / negation-dropped mutants on the domain
  // check: this user WOULD get a platform_user_role row back, so only the domain
  // check can deny them — and the short-circuit means the query never runs.
  it('resolves false for a disallowed domain, without querying platform_user_role', async () => {
    mockUser.mockReturnValue({ id: 'user-2', email: 'attacker@example.com' });

    const { result } = renderHook(() => usePlatformAdmin());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(false);
    // The short-circuit is the point: no round trip for a non-admin.
    expect(from).not.toHaveBeenCalled();
  });

  it('resolves false for an allowed domain WITHOUT a platform role', async () => {
    mockUser.mockReturnValue(ADMIN);
    maybeSingle.mockResolvedValue({ data: null });

    const { result } = renderHook(() => usePlatformAdmin());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(false);
    // Domain alone grants nothing — but the query DID run, unlike the case above.
    expect(from).toHaveBeenCalledWith('platform_user_role');
  });

  it('matches the domain case-insensitively', async () => {
    mockUser.mockReturnValue({ id: 'user-3', email: 'Admin@OuterLayer.AI' });

    const { result } = renderHook(() => usePlatformAdmin());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(true);
  });

  it.each([
    ['no session', undefined],
    ['a session with no id', { email: 'admin@outerlayer.ai' }],
    ['a session with no email', { id: 'user-4' }],
  ])('resolves false and stops loading for %s', async (_label, user) => {
    mockUser.mockReturnValue(user);

    const { result } = renderHook(() => usePlatformAdmin());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('resolves false rather than hanging when the role query throws', async () => {
    mockUser.mockReturnValue(ADMIN);
    maybeSingle.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePlatformAdmin());

    // `loading` must still settle — a stuck spinner would hide the nav forever.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isPlatformAdmin).toBe(false);
  });
});
