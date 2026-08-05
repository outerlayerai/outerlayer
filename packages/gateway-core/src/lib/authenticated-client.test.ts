/**
 * Unit tests for the bearer-path Supabase client builder.
 *
 * The behavior under test: when a resolved request tenant is supplied it
 * rides every PostgREST call as `X-Tenant-Id`, so the DB's dual-source
 * `tenant_id()` scopes to that tenant instead of the JWT claim. Absent ⇒ no
 * header ⇒ the claim serves. Asserted on the REAL outgoing
 * request via MSW, not a module mock.
 */

import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test-helpers/msw-server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';
import { createAuthenticatedClient } from './authenticated-client';

const SUPABASE_URL = 'http://localhost:54321';
const FAKE_ENV = {
  SUPABASE_API_BASE_URL: SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: 'anon-test',
} as unknown as Env;

/** Issue one PostgREST read and return the headers the client actually sent. */
async function capturedRequestHeaders(client: SupabaseClient): Promise<Headers> {
  let captured: Headers | undefined;
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
      captured = request.headers;
      return HttpResponse.json([]);
    }),
  );
  await client.from('app').select('id');
  if (!captured) throw new Error('request was not captured');
  return captured;
}

describe('createAuthenticatedClient', () => {
  it('sends X-Tenant-Id (plus the user bearer) when a request tenant is supplied', async () => {
    const client = createAuthenticatedClient(FAKE_ENV, 'the-jwt', 'tenant-b');
    const headers = await capturedRequestHeaders(client);
    expect(headers.get('authorization')).toBe('Bearer the-jwt');
    expect(headers.get('x-tenant-id')).toBe('tenant-b');
  });

  it('sends no X-Tenant-Id when no request tenant is supplied — the claim serves', async () => {
    const client = createAuthenticatedClient(FAKE_ENV, 'the-jwt');
    const headers = await capturedRequestHeaders(client);
    expect(headers.get('authorization')).toBe('Bearer the-jwt');
    expect(headers.get('x-tenant-id')).toBeNull();
  });
});
