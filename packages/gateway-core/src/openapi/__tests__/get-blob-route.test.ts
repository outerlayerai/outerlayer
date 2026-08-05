/**
 * GET /v1/blobs — fetch an offloaded span field payload from object storage.
 *
 * Handler-level tests (auth/permission/validation are enforced by the route
 * registration + chanfana and covered elsewhere). The security-critical logic
 * lives here: the requested key MUST be prefixed with the caller's tenantId, so
 * a caller can never read another tenant's blobs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetBlob } from '../routes/spans';
import type { AppContext } from '../routes/_shared';

const encoder = new TextEncoder();

interface Captured {
  body: unknown;
  status: number;
}

/** Fake R2 bucket binding: returns an R2-object-like value or null. */
function fakeBucket(store: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) => {
      if (!(key in store)) return null;
      const bytes = encoder.encode(store[key]!);
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }),
  };
}

function makeContext(tenantId: string, store: Record<string, string>) {
  let captured: Captured = { body: undefined, status: 200 };
  const bucket = fakeBucket(store);
  const ctx = {
    get: vi.fn((k: string) => (k === 'user' ? { tenantId, appId: 'app-1' } : undefined)),
    env: { TRACE_BLOBS: bucket },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'GET', path: '/v1/blobs' },
  } as unknown as AppContext;
  return { ctx, bucket, captured: () => captured };
}

function createRoute(path: string): GetBlob {
  const instance = new GetBlob({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof GetBlob>[0]);
  instance.getValidatedData = vi.fn().mockResolvedValue({ query: { path } });
  return instance;
}

beforeEach(() => vi.clearAllMocks());

describe('GetBlob', () => {
  const TENANT = 'tenant-1';
  const KEY = `${TENANT}/app-1/trace-1/span-1/Output`;

  it('returns the full blob content for a tenant-owned key', async () => {
    const { ctx, captured } = makeContext(TENANT, { [KEY]: 'the full output payload' });
    await createRoute(KEY).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect((body as { data: { content: string } }).data.content).toBe('the full output payload');
  });

  it('404s a key under a DIFFERENT tenant without ever touching storage (isolation)', async () => {
    const otherKey = 'tenant-2/app-x/trace/span/Output';
    const { ctx, bucket, captured } = makeContext(TENANT, { [otherKey]: 'secret' });
    await createRoute(otherKey).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('blob_not_found');
    // The prefix guard must reject BEFORE any storage read.
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('404s when the tenant-owned key is absent in storage', async () => {
    const { ctx, captured } = makeContext(TENANT, {}); // empty store
    await createRoute(KEY).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('blob_not_found');
  });

  it('treats a path that merely contains the tenant id (not prefixed) as cross-tenant', async () => {
    // e.g. another tenant's key that happens to embed our id mid-string.
    const sneaky = `tenant-2/${TENANT}/trace/span/Output`;
    const { ctx, bucket, captured } = makeContext(TENANT, { [sneaky]: 'secret' });
    await createRoute(sneaky).handle(ctx);

    expect(captured().status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  // The route's OpenAPI contract is the public surface generated into
  // docs/openapi.yaml + consumed by the SDK/CLI; pin its shape so a regression
  // (dropped auth, undocumented error, loosened path validation) fails here.
  describe('contract', () => {
    const schema = () => createRoute('x').schema;

    it('requires span.read permission', () => {
      expect(GetBlob.requiredPermission).toBe('span.read');
    });

    it('is tagged + operation-id stable for the generated spec', () => {
      expect(schema().tags).toEqual(['Spans']);
      expect(schema().operationId).toBe('get-blob');
    });

    it('validates the `path` query param: required, non-empty', () => {
      const query = schema().request.query;
      expect(query.safeParse({ path: 'tnt/app/tr/sp/Output' }).success).toBe(true);
      expect(query.safeParse({}).success).toBe(false); // path is required
      expect(query.safeParse({ path: '' }).success).toBe(false); // .min(1)
    });

    it('documents 200 (content blob), 401 and 404, and the 200 body shape', () => {
      const responses = schema().responses;
      expect(Object.keys(responses).sort()).toEqual(['200', '401', '404']);
      const okSchema = responses['200'].content['application/json'].schema;
      expect(okSchema.safeParse({ data: { content: 'full payload' } }).success).toBe(true);
      expect(okSchema.safeParse({ data: {} }).success).toBe(false); // content required
    });
  });
});
