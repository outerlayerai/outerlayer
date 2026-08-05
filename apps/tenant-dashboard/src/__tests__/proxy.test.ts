/**
 * The proxy (Next.js middleware) must refresh the Supabase session through a
 * SINGLE server-side refresher.
 *
 * Random mid-session logouts traced back to `/api/analytics/*` having its own
 * middleware branch that called `getUser()` and rotated the refresh token
 * independently of `updateSession`. Two refreshers racing on the shared token —
 * on the dashboard's most heavily polled routes — regressed the auth cookie and
 * tripped Supabase's refresh-token-reuse revocation. Every matched route,
 * analytics included, must now flow through the one refresher, so the token is
 * rotated in exactly one place. These tests fail if a bespoke analytics branch
 * is reintroduced.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../utils/supabase/middleware', () => ({
  updateSession: vi.fn(async () => new Response('ok', { status: 200 })),
}));

import proxy, { config } from '../proxy';
import { updateSession } from '../utils/supabase/middleware';

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, 'https://app.example.com'));
}

describe('proxy — single session refresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    '/dashboards',
    '/api/dashboards',
    '/api/analytics/widget-data?appId=abc',
    '/api/analytics/traces/xyz',
  ])('routes %s through updateSession and returns its response', async (path) => {
    const request = req(path);

    const response = await proxy(request);

    // Exactly one refresher, handed the untouched request.
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith(request);
    // proxy is a thin pass-through: its response IS updateSession's.
    await expect(
      (updateSession as ReturnType<typeof vi.fn>).mock.results[0]!.value,
    ).resolves.toBe(response);
  });

  it('does not special-case analytics with a second refresher path', async () => {
    const request = req('/api/analytics/widget-data?appId=abc');

    await proxy(request);

    const handledPath = (updateSession as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].nextUrl.pathname;
    expect(handledPath).toBe('/api/analytics/widget-data');
  });
});

describe('proxy matcher — image-extension exclusion is scoped to non-api paths', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it('still matches an api path whose last segment ends in an image extension', () => {
    // A runId of `foo.png` must NOT let a request skip the middleware strip as if
    // it were a static asset — the forged x-tenant-id would otherwise survive.
    expect(matcher.test('/api/apps/app-1/workers/runs/foo.png')).toBe(true);
  });

  it('excludes genuine static assets (non-api image files, _next)', () => {
    expect(matcher.test('/logo.png')).toBe(false);
    expect(matcher.test('/_next/static/chunk.js')).toBe(false);
    expect(matcher.test('/favicon.ico')).toBe(false);
  });

  it('matches ordinary api and page routes', () => {
    expect(matcher.test('/api/apps/app-1/workers/runs')).toBe(true);
    expect(matcher.test('/orgs/acme/apps/x')).toBe(true);
  });
});
