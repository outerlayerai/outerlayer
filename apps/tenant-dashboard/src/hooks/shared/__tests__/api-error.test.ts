/**
 * Tests: apiFetch — the shared SWR fetcher.
 *
 * Guards against: an expired session makes the middleware 307 API calls to
 * /auth/login; fetch follows the redirect, gets the login page HTML with
 * status 200, and `.json()` throws a raw `SyntaxError: Unexpected token '<'`
 * straight into the UI.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '@/test-helpers/msw-server';
import { ApiError } from '@/lib/api/client';
import { apiFetch } from '../api-error';

const BASE = 'http://localhost';

afterEach(() => {
  server.resetHandlers();
});

describe('apiFetch', () => {
  it('returns the parsed body for a JSON 200', async () => {
    server.use(
      http.get(`${BASE}/api/thing`, () =>
        HttpResponse.json({ value: 42 }),
      ),
    );

    await expect(apiFetch<{ value: number }>(`${BASE}/api/thing`)).resolves.toEqual({
      value: 42,
    });
  });

  it('throws a status-attached ApiError on non-2xx JSON', async () => {
    server.use(
      http.get(`${BASE}/api/thing`, () =>
        HttpResponse.json(
          { error: { code: 'unauthorized', message: 'Not authenticated' } },
          { status: 401 },
        ),
      ),
    );

    const err = (await apiFetch(`${BASE}/api/thing`).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
  });

  it('throws an unauthorized ApiError — not a SyntaxError — when a 200 response is HTML (login-redirect case)', async () => {
    server.use(
      http.get(`${BASE}/api/thing`, () =>
        new HttpResponse('<!DOCTYPE html><html><body>Login</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    const err = (await apiFetch(`${BASE}/api/thing`).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe(
      'Your session has expired. Please refresh the page and sign in again.',
    );
  });
});
