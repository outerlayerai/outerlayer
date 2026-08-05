/**
 * checkApiKeyLimit — the api-keys entitlement gate. Both the existing-key
 * count and the tier/override read run service-role, exercised for real
 * against MSW (no mocked EntitlementService, no mocked count).
 */

import { http, HttpResponse } from 'msw';
import { server } from '@/test-helpers/msw-server';
import { seedApiKeysMswState, seedSupabaseMswState } from '@/test-helpers/msw-handlers';

import { checkApiKeyLimit } from './api-key-limit';

const SUPABASE_URL = 'http://localhost:54321';
const TENANT = 'tenant-1';

// proves AC-9
it('excludes machine-minted keys from the count (is_machine=false filter)', async () => {
  let capturedUrl: URL | undefined;
  server.use(
    http.head(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
      capturedUrl = new URL(request.url);
      return new HttpResponse(null, {
        status: 200,
        headers: { 'content-range': '0-6/7', 'content-type': 'application/json' },
      });
    }),
  );
  seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: 'hobby' }] });

  await checkApiKeyLimit(TENANT);

  expect(capturedUrl?.searchParams.get('tenant_id')).toBe(`eq.${TENANT}`);
  expect(capturedUrl?.searchParams.get('is_machine')).toBe('eq.false');
});

// A custom role holding an api-key write verb without api_key.read must not
// get a vacuous (zero) count that passes the limit check open. The count
// here runs on the ADMIN client — `rlsServiceRoleKey` simulates RLS hiding
// every api_key row from a non-admin caller, and the count must still
// reflect all of them.
it('counts every tenant key even when RLS would hide them from a non-admin caller', async () => {
  seedSupabaseMswState({ billing: [{ tenant_id: TENANT, tier_id: 'hobby' }] });
  seedApiKeysMswState({
    // hobby's max_api_keys is 25 — 25 existing keys must deny a 26th.
    apiKeys: Array.from({ length: 25 }, (_, i) => ({
      id: `key-${i + 1}`,
      api_key_id: `k-${i + 1}`,
      app_id: 'app-1',
      name: `Key ${i + 1}`,
      tenant_id: TENANT,
    })),
    // Hides api_key rows from every client except the service-role one —
    // matches SUPABASE_SECRET_KEY the unit-test setup seeds.
    rlsServiceRoleKey: 'test-service-role-key',
  });

  const result = await checkApiKeyLimit(TENANT);

  // A caller-restricted (zero) count would resolve `allowed: true` instead.
  expect(result).toEqual(
    expect.objectContaining({ allowed: false, currentCount: 25 }),
  );
});
