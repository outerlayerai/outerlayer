/**
 * loadApiKeys() — resolves its context through `loadRequestServiceContext()`,
 * which attaches the request's `X-Tenant-Id` header (the middleware-derived,
 * validated URL tenant) to every outgoing Supabase call, rather than relying
 * on the JWT claim tenant a stale session could name a different org for.
 *
 * proves AC-3. Asserting on the outgoing `X-Tenant-Id` header, rather than on
 * which tenant's rows come back, is the point: a client built with no tenant
 * argument sends no header at all and falls back to the JWT claim, so this
 * assertion catches that regression even when the claim happens to name the
 * same tenant as the header would have.
 */

import { http, HttpResponse } from 'msw';
import { server } from '@/test-helpers/msw-server';
import { seedApiKeysMswState, seedSupabaseAuth, seedSupabaseMswState } from '@/test-helpers/msw-handlers';

const SUPABASE_URL = 'http://localhost:54321';

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  app_metadata: { tenant_id: 'tenant-1' },
};

vi.mock('next/headers', async () => {
  const { getSupabaseTestCookieStore } = await import('@/test-helpers/supabase-session');
  return {
    cookies: () => getSupabaseTestCookieStore(),
    headers: () => ({
      get: (name: string) => (name === 'x-tenant-id' ? 'tenant-1' : undefined),
    }),
  };
});

describe('loadApiKeys — sends the request X-Tenant-Id header', () => {
  it('carries X-Tenant-Id on the app lookup', async () => {
    seedSupabaseAuth({ user: mockUser as never });
    seedSupabaseMswState({ apps: [{ id: 'app-1', tenant_id: 'tenant-1', name: 'my-app' }] });
    seedApiKeysMswState({
      environments: [{ id: 'env-1', app_id: 'app-1', is_default: true, name: 'dev' }],
      apiKeys: [],
    });

    let capturedHeader: string | null = null;
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
        capturedHeader = request.headers.get('x-tenant-id');
        return HttpResponse.json([{ id: 'app-1' }]);
      }),
    );

    const { loadApiKeys } = await import('./read');
    await loadApiKeys('my-app', undefined);

    expect(capturedHeader).toBe('tenant-1');
  });
});
