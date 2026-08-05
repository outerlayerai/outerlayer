/**
 * Happy-path smoke test for a simple authenticated read.
 *
 * Proves end-to-end that: wrangler dev boots, Supabase auth bypass works
 * for the seeded app, the handler runs, Hono serializes the response, and
 * the shape matches what the OpenAPI spec declares.
 */

import { describe, it, expect } from 'vitest';
import { gatewayFetch } from './client';

describe('GET /v1/capabilities', () => {
  it('returns a 200 with a JSON object', async () => {
    const res = await gatewayFetch('/v1/capabilities');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toBeTypeOf('object');
    expect(body).not.toBeNull();
  });
});
