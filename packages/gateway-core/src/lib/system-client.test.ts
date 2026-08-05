import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../types';

// ─── Module mocks ──────────────────────────────────────────────────────────

// Admin client: returns an object with .from(table).select().eq().single()
// chain so the default gateway_user_id lookup inside resolveTenantAndScope
// can resolve without talking to a real Supabase instance.
const mockTenantSingle = vi.fn();
const adminClientFactory = vi.fn(() => ({
  from: vi.fn((_table: string) => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({ single: mockTenantSingle })),
    })),
  })),
}));

vi.mock('./admin-client', () => ({
  createSupabaseAdminClient: (env: Env) => adminClientFactory(env),
}));

const scopedClientFactory = vi.fn(() => Promise.resolve({ __scoped: true }));
vi.mock('./scoped-client', () => ({
  createTenantScopedClient: (...args: unknown[]) => scopedClientFactory(...(args as [])),
}));

import { resolveTenantAndScope, createSystemAdminClient, createStorageClient, asServiceClient, listAppEnvironments } from './system-client';

// ─── Helpers ────────────────────────────────────────────────────────────────

const FAKE_ENV = {
  SUPABASE_API_BASE_URL: 'http://x',
  SUPABASE_SECRET_KEY: 'sr',
  SUPABASE_JWT_SECRET: 'jwt',
  SUPABASE_PUBLISHABLE_KEY: 'anon',
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantSingle.mockResolvedValue({ data: { gateway_user_id: 'gw-user-1' }, error: null });
});

// ─── resolveTenantAndScope ──────────────────────────────────────────────────

describe('resolveTenantAndScope', () => {
  it('returns null when the lookup callback returns null', async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const result = await resolveTenantAndScope(FAKE_ENV, lookup);

    expect(result).toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
    expect(scopedClientFactory).not.toHaveBeenCalled();
  });

  it('mints a scoped client with the tenant id as the sub', async () => {
    const lookup = vi.fn().mockResolvedValue({ tenantId: 'tenant-123' });

    const result = await resolveTenantAndScope(FAKE_ENV, lookup);

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-123');
    expect(result!.supabase).toEqual({ __scoped: true });
    // The sub is the tenant id, not a resolved gateway system
    // user — created_by/updated_by are owned by their triggers.
    expect(scopedClientFactory).toHaveBeenCalledWith(
      FAKE_ENV,
      'tenant-123',
      'tenant-123',
      [], // empty permissions — RLS checks tenant_id only
    );
  });

  it('does not look up the tenant gateway_user_id', async () => {
    const lookup = vi.fn().mockResolvedValue({ tenantId: 'tenant-nogateway' });

    await resolveTenantAndScope(FAKE_ENV, lookup);

    expect(mockTenantSingle).not.toHaveBeenCalled();
    expect(scopedClientFactory).toHaveBeenCalledWith(
      FAKE_ENV,
      'tenant-nogateway',
      'tenant-nogateway',
      [],
    );
  });

  it('propagates extras from the lookup callback', async () => {
    interface Extras {
      configId: string;
    }
    const lookup = vi
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-x', extras: { configId: 'cfg-1' } });

    const result = await resolveTenantAndScope<Extras>(FAKE_ENV, lookup);

    expect(result!.extras).toEqual({ configId: 'cfg-1' });
  });

  it('passes a short-lived admin client to the lookup callback', async () => {
    const lookup = vi.fn(async (admin) => {
      expect(admin).toBeTypeOf('object');
      expect(admin.from).toBeTypeOf('function');
      return { tenantId: 't' };
    });

    await resolveTenantAndScope(FAKE_ENV, lookup);

    expect(lookup).toHaveBeenCalledOnce();
    // The helper mints exactly one short-lived admin client (with the env)
    // and hands it to the lookup callback — the callback reuses that client
    // rather than minting its own.
    expect(adminClientFactory).toHaveBeenCalledTimes(1);
    expect(adminClientFactory).toHaveBeenCalledWith(FAKE_ENV);
  });
});

// ─── createSystemAdminClient ────────────────────────────────────────────────

describe('createSystemAdminClient', () => {
  it('returns the underlying admin client unchanged', () => {
    const client = createSystemAdminClient(FAKE_ENV);
    expect(client).toBeTypeOf('object');
    expect(adminClientFactory).toHaveBeenCalledWith(FAKE_ENV);
  });
});

// ─── createStorageClient ────────────────────────────────────────────────────

describe('createStorageClient', () => {
  // Override the admin client for these tests: real admin-mock above has
  // only `.from()` for DB; storage tests need `.storage.from()` too.
  const mockCreateSignedUrl = vi.fn();
  const mockStorageFrom = vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl }));

  beforeEach(() => {
    mockCreateSignedUrl.mockReset();
    mockStorageFrom.mockClear();
    adminClientFactory.mockImplementation(() => ({
      from: vi.fn(),
      storage: { from: mockStorageFrom },
    }) as unknown as ReturnType<typeof adminClientFactory>);
  });

  it('rejects paths that are not prefixed with tenantId/', async () => {
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    await expect(
      storage.createSignedUrl('template', 'tenant-b/foo.mdx', 60),
    ).rejects.toThrow(/not scoped to tenant tenant-a/);
    // Guard fires before touching storage-api.
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it('rejects the empty string', async () => {
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');
    await expect(storage.createSignedUrl('template', '', 60)).rejects.toThrow(
      /not scoped to tenant tenant-a/,
    );
  });

  it('rejects a path that only partially matches the tenant prefix', async () => {
    // "tenant-a" is a prefix of "tenant-abc" as a plain string — the guard
    // must match on the full `tenant-a/` prefix, not just the uuid.
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');
    await expect(
      storage.createSignedUrl('template', 'tenant-abc/foo.mdx', 60),
    ).rejects.toThrow(/not scoped to tenant tenant-a/);
  });

  it.each([
    ['tenant-a/../tenant-b/foo.mdx', 'parent segment out of the tenant folder'],
    ['tenant-a/../../etc/passwd', 'two parent segments'],
    ['tenant-a/./foo.mdx', 'current-directory segment'],
    ['tenant-a//foo.mdx', 'empty segment'],
    ['tenant-a/sub/../../tenant-b/foo.mdx', 'parent segments deeper in the path'],
  ])('rejects %j (%s) — a prefix test alone would pass it', async (path) => {
    // Every one of these starts with `tenant-a/` and still resolves outside the
    // tenant's folder, so the prefix test cannot be the whole scope check.
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    await expect(storage.createSignedUrl('template', path, 60)).rejects.toThrow(
      /not scoped to tenant tenant-a/,
    );
    // Never reaches storage-api — the signed URL is never minted.
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it('still signs a legitimate nested path', async () => {
    // The segment check must not reject ordinary sub-folders.
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.test/nested' },
      error: null,
    });
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    const result = await storage.createSignedUrl('template', 'tenant-a/sub/dir/x.mdx', 60);

    expect(result).toEqual({ signedUrl: 'https://storage.test/nested' });
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('tenant-a/sub/dir/x.mdx', 60);
  });

  it('signs a URL for a correctly-prefixed path', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.test/x' },
      error: null,
    });
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    const result = await storage.createSignedUrl(
      'template',
      'tenant-a/sha.prompt.mdx',
      120,
    );

    expect(result).toEqual({ signedUrl: 'https://storage.test/x' });
    expect(mockStorageFrom).toHaveBeenCalledWith('template');
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(
      'tenant-a/sha.prompt.mdx',
      120,
    );
  });

  it('returns null and logs when storage-api returns an error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'Object not found' },
    });
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    const result = await storage.createSignedUrl(
      'template',
      'tenant-a/missing.mdx',
      60,
    );

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[storage] createSignedUrl failed:',
      expect.objectContaining({
        bucket: 'template',
        path: 'tenant-a/missing.mdx',
        error: 'Object not found',
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('returns null when storage-api returns neither data nor error', async () => {
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: null });
    const storage = createStorageClient(FAKE_ENV, 'tenant-a');

    const result = await storage.createSignedUrl(
      'template',
      'tenant-a/x.mdx',
      60,
    );

    expect(result).toBeNull();
  });
});

// ─── asServiceClient ──────────────────────────────────────────────────────────

describe('asServiceClient', () => {
  it('returns the SAME client handle — a runtime-identity cast, not a copy', () => {
    // The whole point of the seam is that it changes only the compile-time type
    // (untyped service surface); at runtime the caller must get back the exact
    // client it passed in. Reference equality pins that (kills a mutant that
    // returns undefined / a fresh object).
    const handle = { from: () => ({}), rpc: () => ({}) };

    expect(asServiceClient(handle)).toBe(handle);
  });
});


// ─── listAppEnvironments ────────────────────────────────────────────────────

/**
 * Feeds the kind-scope resolution for an API key that carries `allowedEnvKinds`
 * instead of a pinned environment. Two properties matter and neither is
 * cosmetic: the query must be scoped by BOTH tenant and app (the gateway role's
 * environment policy is tenant-wide, so app scoping exists only here), and a
 * query failure must THROW rather than return an empty list — an empty list
 * legitimately means "may read no environment", so conflating the two would turn
 * a Supabase blip into a silent scope change.
 */
describe('listAppEnvironments', () => {
  const mockEnvSelect = vi.fn();

  function stubEnvironmentTable() {
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      then: (...a: unknown[]) => (mockEnvSelect() as Promise<unknown>).then(...(a as [])),
    };
    adminClientFactory.mockImplementation(
      () => ({ from: vi.fn(() => chain) }) as unknown as ReturnType<typeof adminClientFactory>,
    );
    return chain;
  }

  beforeEach(() => {
    mockEnvSelect.mockReset();
  });

  it('returns the rows and scopes the query by tenant AND app', async () => {
    const rows = [{ name: 'dev', current_version: 0, is_ephemeral: false }];
    const chain = stubEnvironmentTable();
    mockEnvSelect.mockResolvedValue({ data: rows, error: null });

    const result = await listAppEnvironments(FAKE_ENV, 'tenant-a', 'app-1');

    expect(result).toEqual(rows);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-a');
    expect(chain.eq).toHaveBeenCalledWith('app_id', 'app-1');
  });

  it('returns an empty array when the app genuinely has no environments', async () => {
    stubEnvironmentTable();
    mockEnvSelect.mockResolvedValue({ data: [], error: null });

    expect(await listAppEnvironments(FAKE_ENV, 'tenant-a', 'app-1')).toEqual([]);
  });

  it('treats a null payload as no rows rather than crashing', async () => {
    stubEnvironmentTable();
    mockEnvSelect.mockResolvedValue({ data: null, error: null });

    expect(await listAppEnvironments(FAKE_ENV, 'tenant-a', 'app-1')).toEqual([]);
  });

  it('THROWS on a query error instead of degrading to an empty list', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubEnvironmentTable();
    mockEnvSelect.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    await expect(listAppEnvironments(FAKE_ENV, 'tenant-a', 'app-1')).rejects.toThrow(
      'environment kind resolution failed',
    );
    consoleErrorSpy.mockRestore();
  });
});
