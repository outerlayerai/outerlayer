/**
 * Tests for the bearer permission-client factory — the Supabase client the
 * bearer path builds to run the `app_authorize` RPC.
 *
 * The behavior under test: it forwards the caller's bearer, and when a
 * resolved request tenant is supplied it rides every PostgREST call as
 * `X-Tenant-Id` so `app_authorize` resolves in the viewed org instead of the
 * JWT claim; absent ⇒ no header ⇒ the claim serves. The rest of verify-bearer's
 * suite stubs this factory's return, leaving its own header construction
 * unexercised — asserted here on the REAL outgoing request via MSW, not a
 * module mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test-helpers/msw-server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';
import { bearerPermissionClientFactory } from './verify-bearer';

const { createClientSpy } = vi.hoisted(() => ({ createClientSpy: vi.fn() }));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      createClientSpy(...args);
      return actual.createClient(...args);
    },
  };
});

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

describe('bearerPermissionClientFactory.create', () => {
  it('forwards the bearer and scopes to the request tenant via X-Tenant-Id', async () => {
    const client = bearerPermissionClientFactory.create(FAKE_ENV, 'the-jwt', 'tenant-b');
    const headers = await capturedRequestHeaders(client);
    expect(headers.get('authorization')).toBe('Bearer the-jwt');
    expect(headers.get('x-tenant-id')).toBe('tenant-b');
  });

  it('sends no X-Tenant-Id when no request tenant is supplied — the claim serves', async () => {
    const client = bearerPermissionClientFactory.create(FAKE_ENV, 'the-jwt');
    const headers = await capturedRequestHeaders(client);
    expect(headers.get('authorization')).toBe('Bearer the-jwt');
    expect(headers.get('x-tenant-id')).toBeNull();
  });

  it('treats an empty-string tenant as absent (falsy ⇒ claim serves)', async () => {
    const client = bearerPermissionClientFactory.create(FAKE_ENV, 'the-jwt', '');
    const headers = await capturedRequestHeaders(client);
    expect(headers.get('authorization')).toBe('Bearer the-jwt');
    expect(headers.get('x-tenant-id')).toBeNull();
  });

  it('disables client-side session persistence and auto-refresh — this client is a short-lived, per-request RPC caller, not a browser session', async () => {
    // The gateway runs in a Worker with no storage to persist a session into
    // and no reason to auto-refresh a token it was handed for one request;
    // leaving these on would leak client-side session state across requests.
    bearerPermissionClientFactory.create(FAKE_ENV, 'the-jwt', 'tenant-b');
    expect(createClientSpy).toHaveBeenCalledWith(
      SUPABASE_URL,
      'anon-test',
      expect.objectContaining({
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      }),
    );
  });
});
