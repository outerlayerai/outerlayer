/**
 * `loadPreTenantDb` fails closed on an auth error even when Supabase's
 * `getUser()` still hands back a user object alongside it — a case the
 * cookie-driven MSW fixture in `request-service-context.test.ts` can't
 * produce (there, "unauthenticated" always means both `error` and `user`
 * are absent together). Isolated in its own file because it mocks
 * `@/supabaseServerClient` directly rather than going through MSW.
 */
const mockGetUser = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/supabaseServerClient', () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

import { loadPreTenantDb } from '../request-service-context';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadPreTenantDb — error precedence over a present user', () => {
  it('returns null when getUser reports an error, even though it also returned a user object', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: { message: 'token expired' } });

    await expect(loadPreTenantDb()).resolves.toBeNull();
  });

  it('returns the db when there is no error and a user is present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    await expect(loadPreTenantDb()).resolves.not.toBeNull();
  });
});
