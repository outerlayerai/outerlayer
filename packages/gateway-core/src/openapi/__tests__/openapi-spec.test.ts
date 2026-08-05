/**
 * OpenAPI spec enrichment tests.
 *
 * Tests that the post-processing middleware correctly adds security schemes,
 * global security requirements, and expected metadata to the generated spec.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for external dependencies used by route handlers/middleware
// ---------------------------------------------------------------------------

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    query: vi.fn(),
  })),
}));

// Import after mocks
import { openApiApp } from '../index';
import '../../test-helpers/inject-fake-gateway-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchSpec(): Promise<Record<string, any>> {
  const res = await openApiApp.fetch(
    new Request('http://localhost/v1/openapi.json'),
    // Provide a minimal env binding so the app doesn't crash
    {
      CLICKHOUSE_HOST: 'http://localhost:8123',
      CLICKHOUSE_PASSWORD: '',
      NODE_ENV: 'production',
    } as any,
  );
  expect(res.status).toBe(200);
  return res.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAPI spec enrichment', () => {
  it('should return valid JSON from /v1/openapi.json', async () => {
    const spec = await fetchSpec();
    expect(typeof spec).toBe('object');
    // A real OpenAPI document declares its spec version.
    expect(typeof spec.openapi).toBe('string');
    expect(spec.openapi).toMatch(/^3\./);
  });

  it('should have BearerAuth security scheme with type http and scheme bearer', async () => {
    const spec = await fetchSpec();
    const bearerAuth = spec.components?.securitySchemes?.BearerAuth;
    expect(bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('should model X-Outerlayer-App-Id as an apiKey security scheme', async () => {
    const spec = await fetchSpec();
    const appId = spec.components?.securitySchemes?.AppId;
    expect(appId).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-Outerlayer-App-Id',
    });
  });

  it('should have global security requiring BearerAuth and AppId', async () => {
    const spec = await fetchSpec();
    expect(spec.security).toEqual([{ BearerAuth: [], AppId: [] }]);
  });

  it('should not duplicate X-Outerlayer-App-Id as an operation header parameter', async () => {
    const spec = await fetchSpec();
    const spansGet = spec.paths?.['/v1/spans']?.get;
    const headerNames = (spansGet?.parameters ?? [])
      .filter((p: any) => p?.in === 'header')
      .map((p: any) => p?.name);
    expect(headerNames).not.toContain('X-Outerlayer-App-Id');
  });

  it('should set info.title to OuterLayer Gateway API', async () => {
    const spec = await fetchSpec();
    expect(spec.info?.title).toBe('OuterLayer Gateway API');
  });

  it('should set info.version to 1.0', async () => {
    const spec = await fetchSpec();
    expect(spec.info?.version).toBe('1.0');
  });

  it('should contain span routes in paths', async () => {
    const spec = await fetchSpec();
    expect(spec.paths).toHaveProperty('/v1/spans');
    expect(spec.paths['/v1/spans']).toHaveProperty('get');
  });

  it('should contain score routes in paths', async () => {
    const spec = await fetchSpec();
    expect(spec.paths).toHaveProperty('/v1/scores');
    expect(spec.paths['/v1/scores']).toHaveProperty('get');
  });

  it('should contain health ingestion route in paths', async () => {
    const spec = await fetchSpec();
    expect(spec.paths).toHaveProperty('/v1/health/ingestion');
  });

  it('should contain span detail route with parameter', async () => {
    const spec = await fetchSpec();
    // chanfana may represent the path as /v1/spans/{spanId}
    const spanDetailPath = Object.keys(spec.paths).find(
      (p) => p.includes('/v1/spans/') && p.includes('spanId'),
    );
    expect(spanDetailPath).toBe('/v1/spans/{spanId}');
  });

});

