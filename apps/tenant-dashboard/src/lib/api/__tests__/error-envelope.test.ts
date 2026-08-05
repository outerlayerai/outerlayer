/**
 * Tests: error-envelope.ts + toNextResponse.
 *
 * This is the single source of truth for "how does the wrapper turn a
 * thrown value into an HTTP response?" — the behaviour lives in one place
 * (`errorResponseBody` / `toNextResponse`) and is tested in one place,
 * rather than each route re-asserting "generic throw → 500 internal_error".
 *
 * Route-level tests still assert domain-specific mappings (e.g.
 * `remapNotFound: 'trace_not_found'`, `ValidationError with "already
 * exists" → 409`), because those are contracts the route owns.
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    _headers: Headers;
    constructor(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      this._body = body;
      this.status = init?.status ?? 200;
      this._headers = new Headers(init?.headers);
    }
    async json() {
      return this._body;
    }
    get headers() {
      return this._headers;
    }
    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

import { describe, it, expect, vi } from 'vitest';
import { ZodError, z } from 'zod';
import {
  AnalyticsError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  QueryTimeoutError,
  ServiceUnavailableError,
} from '@repo/observability-service';
import {
  errorResponseBody,
  structuredError,
  toNextResponse,
} from '../error-envelope';

describe('structuredError', () => {
  it('builds the canonical envelope', () => {
    expect(structuredError('forbidden', 'no')).toEqual({
      error: { code: 'forbidden', message: 'no' },
    });
  });

  it('merges extras ahead of code/message', () => {
    // Extras go first so `code` + `message` survive in spread order.
    expect(
      structuredError('invalid_field_value', 'bad', { details: { x: 'y' } }),
    ).toEqual({
      error: { code: 'invalid_field_value', message: 'bad', details: { x: 'y' } },
    });
  });
});

describe('errorResponseBody / toNextResponse — catch-all for unknown throws', () => {
  it('collapses a raw Error to 500 internal_error with a sanitized message', async () => {
    // Asserted once here rather than duplicated per route. If a handler
    // throws anything the wrapper doesn't recognise, the client should see
    // `500` with a generic message (real error goes to logs; never leaks
    // internals).
    const res = toNextResponse(new Error('ClickHouse broke with connection string user=admin'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('An unexpected error occurred');
    // Double-check we didn't leak the raw message.
    expect(body.error.message).not.toMatch(/ClickHouse|admin/);
  });

  it('collapses a non-Error throw (string, null, object) to 500 internal_error', () => {
    for (const thrown of ['boom', null, undefined, 42, { foo: 'bar' }]) {
      const { status, body } = errorResponseBody(thrown);
      expect(status).toBe(500);
      expect(body.error.code).toBe('internal_error');
    }
  });
});

describe('errorResponseBody — mapped error classes', () => {
  it('maps ZodError to 400 invalid_request_body with per-field details', () => {
    const zodErr = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(zodErr.success).toBe(false);
    if (zodErr.success) return;
    const { status, body } = errorResponseBody(zodErr.error);
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_request_body');
    expect('details' in body.error).toBe(true);
    if ('details' in body.error) {
      const details = body.error.details as Record<string, string>;
      // The per-field message must carry the actual Zod issue (type mismatch),
      // not a placeholder — assert that meaning without pinning the exact
      // (version-dependent) wording.
      expect(details.a).toContain('number');
    }
  });

  it('maps ValidationError to 400 invalid_field_value by default', () => {
    const { status, body } = errorResponseBody(new ValidationError('bad field'));
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_field_value');
    expect(body.error.message).toBe('bad field');
  });

  it('remapConflict: ValidationError with "already exists" → 409', () => {
    const { status, body } = errorResponseBody(
      new ValidationError('Dashboard already exists'),
      { remapConflict: 'dashboard_name_conflict' },
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('dashboard_name_conflict');
  });

  it('remapLimit: ValidationError with "Maximum of" → 429', () => {
    const { status, body } = errorResponseBody(
      new ValidationError('Maximum of 10 dashboards per app'),
      { remapLimit: 'dashboard_limit_exceeded' },
    );
    expect(status).toBe(429);
    expect(body.error.code).toBe('dashboard_limit_exceeded');
  });

  it('does not remap when the opts key is absent', () => {
    // Without remapConflict / remapLimit, the same "already exists" /
    // "Maximum of" messages fall through to the generic 400 branch.
    const conflict = errorResponseBody(new ValidationError('X already exists'));
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.code).toBe('invalid_field_value');

    const limit = errorResponseBody(new ValidationError('Maximum of 10 X'));
    expect(limit.status).toBe(400);
    expect(limit.body.error.code).toBe('invalid_field_value');
  });

  it('maps NotFoundError to 404 with `remapNotFound` code when set', () => {
    const { status, body } = errorResponseBody(new NotFoundError('no'), {
      remapNotFound: 'trace_not_found',
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('trace_not_found');
  });

  it('maps NotFoundError without remapNotFound to 404 internal_error', () => {
    // Unusual but valid — a route that throws NotFoundError without
    // declaring `remapNotFound` on its schema is a bug, but the
    // wrapper should still return 404 rather than crash.
    const { status, body } = errorResponseBody(new NotFoundError('no'));
    expect(status).toBe(404);
    expect(body.error.code).toBe('internal_error');
  });

  it('maps ForbiddenError to 403 forbidden', () => {
    const { status, body } = errorResponseBody(new ForbiddenError('no'));
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('maps QueryTimeoutError to 504 service_unavailable', () => {
    // Treating CH slow-query as 504 (not 500) lets the client retry
    // with backoff. 503 is reserved for "explicitly offline".
    const { status, body } = errorResponseBody(new QueryTimeoutError('slow'));
    expect(status).toBe(504);
    expect(body.error.code).toBe('service_unavailable');
  });

  it('maps ServiceUnavailableError to 503 service_unavailable', () => {
    const { status, body } = errorResponseBody(
      new ServiceUnavailableError('CH offline'),
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
  });

  it('maps AnalyticsError using its own statusCode + code', () => {
    class Err extends AnalyticsError {
      constructor() {
        super('nope', 'custom_code', 418);
      }
    }
    const { status, body } = errorResponseBody(new Err());
    expect(status).toBe(418);
    // Cast via DashboardErrorCode happens upstream — we just verify the
    // wrapper passes through both pieces.
    expect(body.error.code).toBe('custom_code');
  });
});

describe('errorResponseBody — ValidationError details passthrough', () => {
  it('attaches .details to the extras when the error carries them', () => {
    const err = new ValidationError('bad', 'foo', { foo: 'required' });
    const { body } = errorResponseBody(err);
    expect('details' in body.error).toBe(true);
    if ('details' in body.error) {
      const details = body.error.details as Record<string, string>;
      expect(details).toEqual({
        foo: 'required',
      });
    }
  });

  it('omits details when the error has none', () => {
    const { body } = errorResponseBody(new ValidationError('bad'));
    expect('details' in body.error).toBe(false);
  });
});

// `toNextResponse` is a thin adapter over `errorResponseBody` + the
// Next.js `Response`. One smoke test is enough; the envelope coverage
// above already exercises the branching logic.
describe('toNextResponse — smoke', () => {
  it('wraps a NotFoundError into a NextResponse with the right status', async () => {
    const res = toNextResponse(new NotFoundError('gone'), {
      remapNotFound: 'widget_not_found',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'widget_not_found', message: 'gone' },
    });
  });

  it('wraps a ZodError as 400 with per-field details', async () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    if (parsed.success) throw new Error('zod should have failed');
    const res = toNextResponse(parsed.error);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request_body');
  });
});

// Silence the unused-import warning — ZodError is brought in for
// downstream tests that spot-check `err instanceof ZodError`.
void ZodError;
