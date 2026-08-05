/**
 * Unit tests for `ListApiKeys` and `CreateApiKey`.
 *
 * The integration suite at apps/integration-tests/src/tests/api-keys/
 * covers happy paths against live Supabase. This file fills the unit-layer
 * gap that the existing api-keys-routes.test.ts doesn't cover:
 *
 *   - List: pagination envelope, app-scoping, plaintext absence in rows
 *   - Create: invalid-body 400, invalid-permissions 400, missing-pepper 500,
 *     env-precedence (explicit name → caller env → default env), env_not_found
 *     400, fail-closed 500, duplicate-name 409, generic mint-failure 500,
 *     plaintext returned exactly once on the success body
 *
 * The provider side of create is `@repo/api-key-service.mintApiKey`
 * (peppered-HMAC Postgres key store). `mintApiKey` is mocked here so create
 * failure modes (throw → 500, 23505/uc_api_key → 409) are exercised without
 * a live DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../test-helpers/msw-server';

// ---------------------------------------------------------------------------
// Mocks — installed BEFORE importing the route so the route picks them up.
// ---------------------------------------------------------------------------
//
// vi.hoisted is required because vi.mock factories run before any
// top-level statements in the test file. Without hoisting, the
// closed-over identifier references would resolve to TDZ stubs at
// mock-eval time.

const {
  mockMintApiKey,
  mockSelectChain,
  mockEnvLookup,
  mockCallerKeyLookup,
  mockRpc,
} = vi.hoisted(() => ({
  // The Postgres key store's mint. Owns row insert + digest write + rollback
  // internally — the route does not touch the api_key table directly on
  // create. Resolves `{ plaintext, row }`; a throw surfaces to the route.
  mockMintApiKey: vi.fn(),
  // ListApiKeys `.select().eq().eq()[.eq()].order().range()` terminal.
  mockSelectChain: vi.fn(),
  // CreateApiKey resolves the env for the new key. Named-env and default-env
  // lookups both terminate at `.maybeSingle()` on the `environment` table.
  mockEnvLookup: vi.fn(),
  // Caller-env lookup: `.from('api_key').select('environment_id')
  // .eq('api_key_id', user.apiKeyId).maybeSingle()`.
  mockCallerKeyLookup: vi.fn(),
  // Bearer-mode authority lookups. `get_current_user_app_permissions` is the
  // caller's effective set (the clamp compares against it) and `app_authorize`
  // authorizes an explicitly-supplied app_id. Both are asked through the
  // CALLER's own client, so the answer is theirs and not the service role's.
  mockRpc: vi.fn(),
}));

vi.mock('@repo/api-key-service', () => ({
  mintApiKey: mockMintApiKey,
}));

// A single fluent chain object. `select`/`eq` return the same object so any
// depth of `.eq()` chaining works; `.order().range()` is the list terminal and
// `.maybeSingle()` is the single-row-lookup terminal. `maybeSingle` resolves to
// the caller-key lookup on `api_key` and the env lookup on `environment`.
function makeSupabaseStub() {
  return {
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => mockRpc(fn, args)),
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => ({ range: vi.fn(() => mockSelectChain()) })),
        range: vi.fn(() => mockSelectChain()),
        maybeSingle: vi.fn(() =>
          table === 'api_key' ? mockCallerKeyLookup() : mockEnvLookup(),
        ),
      };
      return chain;
    }),
  };
}

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve(makeSupabaseStub())),
  };
});

import type { AppContext } from '../routes/_shared';
import { InputValidationException } from 'chanfana';
import { ListApiKeys, CreateApiKey } from '../routes/api-keys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  body: unknown;
  status: number;
}

/** A resolved mintApiKey value with the row fields rowToApiKey reads. */
function mintOk(
  overrides: Partial<{
    plaintext: string;
    row: Record<string, unknown>;
  }> = {},
) {
  return {
    plaintext: overrides.plaintext ?? 'sk_outerlayer_real',
    row: {
      id: 'row-1',
      api_key_id: 'key_generated_1',
      app_id: 'app-uuid-1',
      name: 'real',
      key_prefix: 'sk_outerlayer_xxxx',
      permissions: [],
      environment_id: 'env-default-uuid-1',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      ...overrides.row,
    },
  };
}

function makeContext(opts: {
  bodyJson?: unknown;
  envOverrides?: Record<string, string | undefined>;
  /** Set to a string to simulate API-key auth (the route's user.apiKeyId).
   *  Omit / undefined → bearer / no-binding case. */
  apiKeyId?: string;
  /** The CALLER's own permissions. A mint is clamped to this set, so a test
   *  that requests permissions must grant them to the caller first. */
  callerPermissions?: string[];
  /** The caller's bound app. Override with a real UUID for the tests that pass
   *  `app_id` in the body, since the schema requires a UUID there. */
  appId?: string;
  /** 'apikey' (default) or 'bearer' — they resolve the caller's authority from
   *  entirely different places, so the clamp branches on it. */
  authMode?: string;
  executionCtx?: { waitUntil: (p: Promise<any>) => void };
}): { ctx: AppContext; captured: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? {
            appId: opts.appId ?? 'app-uuid-1',
            tenantId: 'tenant-uuid-1',
            appName: 'Test App',
            authMode: opts.authMode ?? 'apikey',
            permissions: opts.callerPermissions ?? [],
            apiKeyId: opts.apiKeyId,
          }
        : k === 'gtx'
          ? { waitUntil: opts.executionCtx?.waitUntil ?? vi.fn() }
          : undefined,
    ),
    env: {
      // The Postgres key store's HMAC pepper — missing → 500 at the guard.
      API_KEY_PEPPER: 'test-pepper',
      // createSupabaseAdminClient(c.env) runs before the mint; give it a
      // well-formed URL + key so `createClient` constructs (mintApiKey is
      // mocked, so the admin client is never actually used).
      SUPABASE_API_BASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'service-role-test',
      NODE_ENV: 'production',
      ...opts.envOverrides,
    },
    executionCtx: opts.executionCtx,
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'POST',
      path: '/v1/api-keys',
      json: vi.fn(() =>
        opts.bodyJson === undefined
          ? Promise.reject(new SyntaxError('no body'))
          : Promise.resolve(opts.bodyJson),
      ),
    },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function makeQueryContext(): { ctx: AppContext; captured: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? { appId: 'app-uuid-1', tenantId: 'tenant-uuid-1' }
        : undefined,
    ),
    env: {},
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'GET', path: '/v1/api-keys' },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function createRouteInstance<T extends new (opts: any) => any>(
  RouteClass: T,
  validatedData: Record<string, unknown>,
): InstanceType<T> {
  const instance = new RouteClass({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

function newCreateRoute(): CreateApiKey {
  return new CreateApiKey({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof CreateApiKey>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // CreateApiKey resolves the env for the new key — caller's env when API-key
  // authenticated, app's default env otherwise. Default both lookups to
  // success so the happy-path tests exercise the mint; env-missing /
  // caller-key-missing cases override these with their own resolved values.
  mockEnvLookup.mockResolvedValue({
    data: { id: 'env-default-uuid-1' },
    error: null,
  });
  mockCallerKeyLookup.mockResolvedValue({
    data: { environment_id: 'env-default-uuid-1' },
    error: null,
  });
  mockMintApiKey.mockResolvedValue(mintOk());
});

// ===========================================================================
// ListApiKeys (GET /v1/api-keys)
// ===========================================================================

describe('ListApiKeys handler', () => {
  it('returns canonical { data, pagination } with no plaintext fields', async () => {
    mockSelectChain.mockResolvedValue({
      data: [
        {
          id: 'row-1',
          app_id: 'app-uuid-1',
          name: 'CI key',
          created_at: '2026-04-01T00:00:00.000Z',
          environment_id: 'env-1',
          key_prefix: 'sk_outerlayer_ci01',
          permissions: ['trace.write'],
          expires_at: null,
        },
      ],
      count: 1,
    });

    const route = createRouteInstance(ListApiKeys, { query: { limit: 50, offset: 0 } });
    const { ctx, captured } = makeQueryContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    const b = body as { data: any[]; pagination: any };
    expect(b.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
    expect(b.data[0]!.name).toBe('CI key');
    // Plaintext is NEVER present on list responses.
    expect((b.data[0] as Record<string, unknown>).plaintext_key).toBeUndefined();
    // Permissions now come straight off the row's enum[] column.
    expect(b.data[0]!.permissions).toEqual(['trace.write']);
  });

  it('falls back to data.length when count is null', async () => {
    mockSelectChain.mockResolvedValue({
      data: [{ id: 'r-1', app_id: 'app-uuid-1', name: 'k', created_at: null }],
      count: null,
    });

    const route = createRouteInstance(ListApiKeys, { query: { limit: 50, offset: 0 } });
    const { ctx, captured } = makeQueryContext();
    await route.handle(ctx);

    const b = captured().body as { pagination: any };
    expect(b.pagination.total).toBe(1);
  });

  it('returns an empty list (NOT an error) when no rows exist', async () => {
    mockSelectChain.mockResolvedValue({ data: [], count: 0 });

    const route = createRouteInstance(ListApiKeys, { query: { limit: 50, offset: 0 } });
    const { ctx, captured } = makeQueryContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect((body as { data: any[] }).data).toEqual([]);
  });
});

// ===========================================================================
// CreateApiKey (POST /v1/api-keys)
// ===========================================================================

describe('CreateApiKey handler', () => {
  it('rejects malformed JSON with an InputValidationException (→ 400)', async () => {
    const route = newCreateRoute();
    // bodyJson === undefined makes c.req.json reject with SyntaxError; the
    // handler wraps that as InputValidationException → 400.
    const { ctx, captured } = makeContext({ bodyJson: undefined });
    await expect(route.handle(ctx)).rejects.toBeInstanceOf(InputValidationException);
    expect(captured().body).toBeUndefined();
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('rejects body missing required `name` field with 400 invalid_request_body', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({ bodyJson: { permissions: [] } });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_request_body');
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('rejects unknown permission strings with invalid_field_value 400', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'bad', permissions: ['definitely.not.a.real.permission'] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_field_value');
    // The key store is never reached when validation fails.
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('returns 500 + api_key_creation_failed when API_KEY_PEPPER is not configured', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'k', permissions: [] },
      envOverrides: { API_KEY_PEPPER: undefined },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe('api_key_creation_failed');
    // Guard short-circuits before any env resolution or mint.
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('returns 201 with plaintext_key and mints with the resolved args on the happy path', async () => {
    mockMintApiKey.mockResolvedValue(
      mintOk({ plaintext: 'sk_outerlayer_real', row: { name: 'real', permissions: [] } }),
    );

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'real', permissions: [] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(201);
    const b = body as { data: { plaintext_key: string; permissions: string[] } };
    // Plaintext is surfaced exactly once, straight from the mint result.
    expect(b.data.plaintext_key).toBe('sk_outerlayer_real');
    // Response permissions echo the validated request body.
    expect(b.data.permissions).toEqual([]);
    // The mint is driven with the caller-resolved binding, no human author.
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-uuid-1',
        appId: 'app-uuid-1',
        name: 'real',
        permissions: [],
        environmentId: 'env-default-uuid-1',
        createdBy: null,
      }),
    );
  });

  it('passes the requested permissions through to the mint', async () => {
    mockMintApiKey.mockResolvedValue(
      mintOk({ row: { name: 'scoped', permissions: ['trace.write', 'session.read'] } }),
    );

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'scoped', permissions: ['trace.write', 'session.read'] },
      // The mint is clamped to the caller's own set, so grant it here.
      callerPermissions: ['trace.write', 'session.read', 'api_key.insert'],
    });
    await route.handle(ctx);

    expect(captured().status).toBe(201);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['trace.write', 'session.read'] }),
    );
  });

  it('returns 500 + api_key_creation_failed when mintApiKey throws a generic error', async () => {
    mockMintApiKey.mockRejectedValue(new Error('key store 503'));

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'k', permissions: [] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe('api_key_creation_failed');
  });

  it('returns 500 for a non-unique Postgres error (e.g. FK violation) from the mint', async () => {
    // A 23503 (or any code that is not a 23505 on uc_api_key) is NOT a caller
    // name conflict — it must stay on the 500 path, not be misclassified as 409.
    mockMintApiKey.mockRejectedValue({ code: '23503', message: 'fk violation' });

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'k', permissions: [] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe('api_key_creation_failed');
  });

  // Regression: a duplicate (name, app_id) — Postgres 23505 on `uc_api_key` —
  // must surface as the documented 409, not an undifferentiated 500. The mint
  // rethrows the raw PostgREST error, so the route classifies from the code +
  // constraint name.
  it('returns 409 + duplicate_api_key_name on a uc_api_key unique violation', async () => {
    mockMintApiKey.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "uc_api_key"',
      details: 'Key (name, app_id)=(0, app-uuid-1) already exists.',
    });

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: '0', permissions: [] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(409);
    expect((body as { error: { code: string; field?: string } }).error).toEqual({
      code: 'duplicate_api_key_name',
      message: 'An API key with this name already exists on this app',
      field: 'name',
    });
  });

  // A 23505 on a DIFFERENT constraint is NOT a name conflict — it must stay on
  // the 500 path, not get misclassified as a 409.
  it('keeps 500 for a 23505 on a non-name constraint', async () => {
    mockMintApiKey.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "api_key_api_key_id_key"',
    });

    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'k', permissions: [] },
    });
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe('api_key_creation_failed');
  });

  // -------------------------------------------------------------------------
  // Env binding must follow the CALLER's env, not the app's default — a
  // prod-bound writer minting a child key must get a prod-bound child key,
  // not a dev-bound one (env-isolation). The resolved env flows to
  // `mintApiKey` as `environmentId`.
  // -------------------------------------------------------------------------

  describe('binds the new key to the caller\'s env (regression for the default-env hardcode)', () => {
    it('mints with the caller\'s environment_id when the caller is API-key authenticated', async () => {
      mockCallerKeyLookup.mockResolvedValue({
        data: { environment_id: 'env-prod-uuid' },
        error: null,
      });
      // Default-env lookup must NOT be consulted on this path.
      mockEnvLookup.mockRejectedValue(
        new Error('default-env lookup must not run when caller has an env-bound key'),
      );
      mockMintApiKey.mockResolvedValue(
        mintOk({ row: { name: 'prod-child', environment_id: 'env-prod-uuid' } }),
      );

      const route = newCreateRoute();
      const { ctx, captured } = makeContext({
        bodyJson: { name: 'prod-child', permissions: [] },
        apiKeyId: 'caller-prod',
      });
      await route.handle(ctx);

      expect(captured().status).toBe(201);
      expect(mockMintApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'env-prod-uuid' }),
      );
    });

    it('mints with the default env only when the caller has no apiKeyId (bearer auth)', async () => {
      // No apiKeyId on user → caller-key lookup must NOT run, default-env
      // lookup is the source of truth.
      mockCallerKeyLookup.mockRejectedValue(
        new Error('caller-key lookup must not run for bearer-auth callers'),
      );
      mockEnvLookup.mockResolvedValue({ data: { id: 'env-default-uuid-1' }, error: null });
      mockMintApiKey.mockResolvedValue(
        mintOk({ row: { name: 'bearer-child', environment_id: 'env-default-uuid-1' } }),
      );

      const route = newCreateRoute();
      const { ctx, captured } = makeContext({
        bodyJson: { name: 'bearer-child', permissions: [] },
        // apiKeyId omitted
      });
      await route.handle(ctx);

      expect(captured().status).toBe(201);
      expect(mockMintApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'env-default-uuid-1' }),
      );
    });

    it('fails closed (500) when caller-key lookup returns no environment_id, and mints nothing', async () => {
      // A caller with apiKeyId whose row is missing / DB blip → must NOT fall
      // back to the default env. Env resolves BEFORE the mint, so this
      // short-circuits with no key created.
      mockCallerKeyLookup.mockResolvedValue({ data: null, error: null });

      const route = newCreateRoute();
      const { ctx, captured } = makeContext({
        bodyJson: { name: 'orphan', permissions: [] },
        apiKeyId: 'caller-orphan',
      });
      await route.handle(ctx);

      const { body, status } = captured();
      expect(status).toBe(500);
      expect((body as { error: { code: string } }).error.code).toBe('api_key_creation_failed');
      expect(mockMintApiKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // environment_name targeting: a session/bearer caller can mint a key for a
  // SPECIFIC env by name (e.g. production). The resolved env id is stored on
  // the key and surfaced on the response. An unknown name is a 400, not a 500.
  // -------------------------------------------------------------------------

  describe('binds the new key to an explicit environment_name', () => {
    it('resolves environment_name to its env id, mints with it, and surfaces it on the response', async () => {
      // Named-env lookup resolves. The caller-key lookup must NOT run — the
      // explicit name takes precedence over caller-env inheritance.
      mockEnvLookup.mockResolvedValue({ data: { id: 'env-prod-uuid' }, error: null });
      mockCallerKeyLookup.mockRejectedValue(
        new Error('caller-key lookup must not run when environment_name is given'),
      );
      mockMintApiKey.mockResolvedValue(
        mintOk({ row: { name: 'prod-key', environment_id: 'env-prod-uuid' } }),
      );

      const route = newCreateRoute();
      const { ctx, captured } = makeContext({
        // apiKeyId present, but the explicit name must win over caller-env.
        bodyJson: { name: 'prod-key', permissions: [], environment_name: 'production' },
        apiKeyId: 'caller-dev',
      });
      await route.handle(ctx);

      expect(captured().status).toBe(201);
      // The resolved env must reach the mint...
      expect(mockMintApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'env-prod-uuid' }),
      );
      // ...and be surfaced on the create response so the caller sees the binding.
      expect(
        (captured().body as { data: { environment_id: string } }).data.environment_id,
      ).toBe('env-prod-uuid');
    });

    it('returns 400 env_not_found for an unknown env name and mints no key', async () => {
      // Clean lookup, no row → caller error, not a server fault.
      mockEnvLookup.mockResolvedValue({ data: null, error: null });

      const route = newCreateRoute();
      const { ctx, captured } = makeContext({
        bodyJson: { name: 'k', permissions: [], environment_name: 'nope' },
      });
      await route.handle(ctx);

      const { body, status } = captured();
      expect(status).toBe(400);
      expect((body as { error: { code: string; message: string; field?: string } }).error).toEqual({
        code: 'env_not_found',
        message: 'No environment named "nope" on this app',
        field: 'environment_name',
      });
      // Resolution fails before minting — nothing created.
      expect(mockMintApiKey).not.toHaveBeenCalled();
    });
  });

  it('fires org_api_key_created to PostHog on successful key creation', async () => {
    const capturedBodies: unknown[] = [];
    server.use(
      http.post('https://us.i.posthog.com/capture/', async ({ request }) => {
        capturedBodies.push(await request.json());
        return HttpResponse.json({});
      }),
    );

    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'ph-key' } }));

    const waitUntilPromises: Promise<unknown>[] = [];
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'ph-key', permissions: [] },
      envOverrides: { POSTHOG_PROJECT_API_KEY: 'phc_test123' },
      executionCtx: { waitUntil: (p) => { waitUntilPromises.push(p.catch(() => {})); } },
    });
    await route.handle(ctx);
    await Promise.all(waitUntilPromises);

    expect(captured().status).toBe(201);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toEqual(
      expect.objectContaining({
        api_key: 'phc_test123',
        event: 'org_api_key_created',
        distinct_id: 'tenant:tenant-uuid-1',
        properties: expect.objectContaining({
          tenant_id: 'tenant-uuid-1',
          $groups: { tenant: 'tenant-uuid-1' },
          app_id: 'app-uuid-1',
        }),
      }),
    );
  });
});

/**
 * A minted key may reproduce the caller's authority or narrow it, never widen
 * it. The route's own comparison is what holds that line: the stored array IS
 * the whole authorization model for api-key traffic, since the gateway Postgres
 * role's RLS is tenant-wide with no permission awareness. Without the clamp
 * there is no fixed point either — a key holding only `api_key.insert` could
 * mint a stronger key, then use THAT to mint stronger again.
 */
describe('CreateApiKey clamps the grant to the caller', () => {
  it('refuses a permission the caller does not hold, and names only the surplus', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      // The everyday shape: a `write` member picking "Full Access".
      bodyJson: {
        name: 'escalated',
        permissions: ['trace.read', 'app.delete', 'api_key.delete'],
      },
      callerPermissions: ['trace.read', 'api_key.insert'],
    });
    await route.handle(ctx);

    expect(captured().status).toBe(403);
    const body = captured().body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden');
    // Sorted and surplus-only: the held permission must not be listed.
    expect(body.error.message).toBe(
      'Cannot grant permissions you do not hold: api_key.delete, app.delete',
    );
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('closes the ladder: a key holding only api_key.insert cannot mint anything stronger', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'ladder', permissions: ['api_key.insert', 'trace.read'] },
      callerPermissions: ['api_key.insert'],
    });
    await route.handle(ctx);

    expect(captured().status).toBe(403);
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('allows an exact-parity mint (a key may reproduce its own authority)', async () => {
    mockMintApiKey.mockResolvedValue(
      mintOk({ row: { name: 'parity', permissions: ['trace.read', 'api_key.insert'] } }),
    );
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'parity', permissions: ['trace.read', 'api_key.insert'] },
      callerPermissions: ['trace.read', 'api_key.insert'],
    });
    await route.handle(ctx);

    expect(captured().status).toBe(201);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['trace.read', 'api_key.insert'] }),
    );
  });

  it('allows a strictly weaker mint (the normal delegation case)', async () => {
    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'weaker', permissions: ['trace.read'] } }));
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'weaker', permissions: ['trace.read'] },
      callerPermissions: ['trace.read', 'app.delete', 'api_key.insert'],
    });
    await route.handle(ctx);

    expect(captured().status).toBe(201);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['trace.read'] }),
    );
  });

  it('refuses an explicit app_id that is not the api-key caller’s own app', async () => {
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      // `verify-key` binds an api key to one app and cross-checks it, so a
      // different app id is outside that key's scope by construction. The
      // route's check is the only thing that says so — the gateway role's
      // INSERT policy is tenant-wide.
      bodyJson: { name: 'sibling', permissions: [], app_id: '22222222-2222-4222-8222-222222222222' },
      callerPermissions: ['api_key.insert'],
      appId: '11111111-1111-4111-8111-111111111111',
    });
    await route.handle(ctx);

    expect(captured().status).toBe(403);
    const body = captured().body as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('still allows the caller’s own app id passed explicitly', async () => {
    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'own', permissions: [] } }));
    const route = newCreateRoute();
    const { ctx, captured } = makeContext({
      bodyJson: { name: 'own', permissions: [], app_id: '11111111-1111-4111-8111-111111111111' },
      callerPermissions: ['api_key.insert'],
      appId: '11111111-1111-4111-8111-111111111111',
    });
    await route.handle(ctx);

    expect(captured().status).toBe(201);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '11111111-1111-4111-8111-111111111111' }),
    );
  });
});

/**
 * Bearer mode carries authority somewhere completely different from api-key
 * mode: `UserMeta.permissions` is deliberately EMPTY on this path (see
 * verify-bearer.ts — authz is resolved by RLS), so reading the clamp off that
 * field would grant nothing and deny everything. The real set has to come from
 * the database, asked through the caller's own client.
 */
describe('CreateApiKey clamp — bearer mode resolves authority from the database', () => {
  const bearerCtx = (bodyJson: unknown) =>
    makeContext({ bodyJson, callerPermissions: [], authMode: 'bearer' });

  it('clamps against get_current_user_app_permissions, not the empty UserMeta set', async () => {
    mockRpc.mockResolvedValue({ data: ['trace.read', 'api_key.insert'], error: null });
    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'b', permissions: ['trace.read'] } }));

    const { ctx, captured } = bearerCtx({ name: 'b', permissions: ['trace.read'] });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('get_current_user_app_permissions', {
      target_app_id: 'app-uuid-1',
    });
  });

  it('refuses a permission the RPC does not return', async () => {
    mockRpc.mockResolvedValue({ data: ['trace.read'], error: null });

    const { ctx, captured } = bearerCtx({ name: 'b', permissions: ['trace.read', 'app.delete'] });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(403);
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the permissions RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const { ctx, captured } = bearerCtx({ name: 'b', permissions: ['trace.read'] });
    await createRouteAndHandle(ctx);

    // An empty set on error means any non-empty request is refused, rather than
    // passing unchecked.
    expect(captured().status).toBe(403);
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('tolerates a non-array RPC payload without granting anything', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { ctx, captured } = bearerCtx({ name: 'b', permissions: ['trace.read'] });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(403);
  });

  it('allows an empty permission request even with no authority at all', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'b', permissions: [] } }));

    const { ctx, captured } = bearerCtx({ name: 'b', permissions: [] });
    await createRouteAndHandle(ctx);

    // Nothing is being granted, so there is nothing to clamp.
    expect(captured().status).toBe(201);
  });
});

describe('CreateApiKey — an explicit app_id is authorized on its own', () => {
  const OTHER_APP = '22222222-2222-4222-8222-222222222222';

  it('bearer: consults app_authorize for the supplied app and proceeds when allowed', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'app_authorize'
        ? Promise.resolve({ data: true, error: null })
        : Promise.resolve({ data: ['api_key.insert'], error: null }),
    );
    mockMintApiKey.mockResolvedValue(mintOk({ row: { name: 'x', permissions: [] } }));

    const { ctx, captured } = makeContext({
      bodyJson: { name: 'x', permissions: [], app_id: OTHER_APP },
      authMode: 'bearer',
      callerPermissions: [],
    });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('app_authorize', {
      requested_permission: 'api_key.insert',
      target_app_id: OTHER_APP,
    });
  });

  it('bearer: 403s when app_authorize says no', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'app_authorize'
        ? Promise.resolve({ data: false, error: null })
        : Promise.resolve({ data: ['api_key.insert'], error: null }),
    );

    const { ctx, captured } = makeContext({
      bodyJson: { name: 'x', permissions: [], app_id: OTHER_APP },
      authMode: 'bearer',
      callerPermissions: [],
    });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(403);
    expect(mockMintApiKey).not.toHaveBeenCalled();
  });

  it('bearer: fails CLOSED when app_authorize errors', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'app_authorize'
        ? Promise.resolve({ data: null, error: { message: 'boom' } })
        : Promise.resolve({ data: ['api_key.insert'], error: null }),
    );

    const { ctx, captured } = makeContext({
      bodyJson: { name: 'x', permissions: [], app_id: OTHER_APP },
      authMode: 'bearer',
      callerPermissions: [],
    });
    await createRouteAndHandle(ctx);

    expect(captured().status).toBe(403);
  });
});


/** Build a CreateApiKey route and run it against `ctx`. */
async function createRouteAndHandle(ctx: AppContext): Promise<void> {
  await newCreateRoute().handle(ctx);
}
