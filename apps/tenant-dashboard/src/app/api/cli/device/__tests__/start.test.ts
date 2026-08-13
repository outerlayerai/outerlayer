// @vitest-environment node
/**
 * Tests: POST /api/cli/device/start
 *
 * Unauthenticated by design (see route.ts) — this file's contract is that
 * the response never depends on any identity and always hands back a fresh,
 * usable code pair.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: { error: vi.fn() },
}));

vi.mock('@repo/api-key-service', () => ({
  hashApiKey: vi.fn(async (plaintext: string) => `digest:${plaintext}`),
}));

import { getDeviceAuthMswRows, forceDeviceAuthInsertError } from '@/test-helpers/msw-handlers';
import { POST } from '../start/route';

describe('POST /api/cli/device/start', () => {
  it('creates a pending request and returns the code pair with no auth required', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/),
      verification_url: expect.stringContaining(body.user_code),
      expires_in: 600,
      interval: 5,
    });
  });

  it('every call creates its own row — two calls never collide', async () => {
    const first = await (await POST()).json();
    const second = await (await POST()).json();

    expect(first.device_code).not.toBe(second.device_code);
    expect(first.user_code).not.toBe(second.user_code);
    expect(getDeviceAuthMswRows()).toHaveLength(2);
  });

  it('the verification_url points at the dashboard device page carrying the user_code', async () => {
    const body = await (await POST()).json();
    const url = new URL(body.verification_url);
    expect(url.pathname).toBe('/device');
    expect(url.searchParams.get('user_code')).toBe(body.user_code);
  });

  it('a thrown error inside the handler is caught, logged, and mapped to exactly a 500 with a generic body', async () => {
    forceDeviceAuthInsertError('db exploded');

    const res = await POST();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    const { serverLogger } = await import('@/lib/observability/server-logger');
    expect(serverLogger.error).toHaveBeenCalledWith(expect.anything(), {
      context: '[CLI API] POST /api/cli/device/start failed',
    });
  });
});
