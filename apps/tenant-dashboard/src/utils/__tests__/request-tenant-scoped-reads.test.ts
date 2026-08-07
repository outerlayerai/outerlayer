// @vitest-environment jsdom
/**
 * The shared app-name → id resolver must send the URL-derived request tenant
 * as X-Tenant-Id on its PostgREST read. Without the header, RLS falls back to
 * the JWT's tenant claim — which can name a different org than the one on
 * screen (e.g. right after creating a new org), making the app invisible and
 * collapsing everything downstream that hangs off the lookup (the app-page
 * permission snapshot, hence the whole nav rail).
 */
import { http, HttpResponse } from 'msw';

import { server } from '../../test-helpers/msw-server';

// The global setup mocks headers() with a bare vi.fn() getter (no header
// values). These reads resolve the tenant from the x-tenant-id request
// header, so this file supplies one.
vi.mock('next/headers', () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
  headers: () => ({
    get: (name: string) =>
      name.toLowerCase() === 'x-tenant-id' ? 'tenant-9' : null,
  }),
}));

import { getAppIdByName } from '../get-app-id';

describe('request-tenant scoping of shared server reads', () => {
  it('getAppIdByName sends the request tenant as X-Tenant-Id on the app lookup', async () => {
    let seenTenantHeader: string | null | undefined;
    server.use(
      http.get('http://localhost:54321/rest/v1/app', ({ request }) => {
        seenTenantHeader = request.headers.get('x-tenant-id');
        return HttpResponse.json({ id: 'app-1' });
      }),
    );

    expect(await getAppIdByName('my-app')).toBe('app-1');
    expect(seenTenantHeader).toBe('tenant-9');
  });
});
