/**
 * Apps route-handler tests.
 *
 * Service-layer behaviour (tenant scoping, FK retry, duplicate detection)
 * lives in `apps/gateway/src/services/__tests__/apps-service.test.ts`.
 * This file covers handler-only concerns:
 *
 *   1. Permission wiring — the four `app.*` permissions are spelled
 *      correctly on each route class.
 *   2. Error mapping — service errors → canonical HTTP status + code.
 *   3. Envelope shape — 2xx responses wrap under `{ data }` (and
 *      `pagination` for list).
 *   4. Body validation — empty PATCH body rejected with 400 + field.
 *
 * The service is mocked so we don't need Supabase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mock service module
// ---------------------------------------------------------------------------

const serviceSpy = {
  listApps: vi.fn(),
  getApp: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  getGitConnection: vi.fn(),
  linkRepository: vi.fn(),
  unlinkRepository: vi.fn(),
};

// Provider stub used by the new link/list-repos/list-branches routes.
// Defaults shadow what a healthy GitHub install would return; per-test
// overrides happen with .mockResolvedValueOnce.
const providerSpy = {
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
  getLatestCommitSha: vi.fn(),
  streamFile: vi.fn(),
};
vi.mock('../../git/factory', () => ({
  createGitProvider: vi.fn(() => Promise.resolve(providerSpy)),
}));

vi.mock('../../services/apps-service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../services/apps-service');
  return {
    ...actual,
    AppsService: class {
      constructor() {
        return serviceSpy;
      }
    },
  };
});

const gitConnectSpy = { buildAuthorizationUrl: vi.fn() };
vi.mock('../../services/git-connect-service', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../services/git-connect-service');
  return {
    ...actual,
    GitConnectService: class {
      constructor() {
        return gitConnectSpy;
      }
    },
  };
});

vi.mock('../../supabase', () => ({
  createTenantScopedClient: vi.fn(() => Promise.resolve({ from: vi.fn() })),
}));

vi.mock('../../lib/authenticated-client', () => ({
  createAuthenticatedClient: vi.fn(() => ({ from: vi.fn() })),
}));

// `buildProviderForApp` (in routes/apps.ts) reads the git_connection row
// via getScopedSupabase to learn provider+installation_id, then hands
// off to `createGitProvider`. The mock here returns a chainable
// builder so the route's `.from('git_connection').select('...').eq(...).maybeSingle()`
// resolves to the connection row.
let gitConnectionRow: { provider: string; installation_id: number | null } | null = {
  provider: 'github',
  installation_id: 12345,
};
function setGitConnectionRow(row: typeof gitConnectionRow) {
  gitConnectionRow = row;
}

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(async () => {
      // Returns the connection row from the module-level slot. Tests
      // override via setGitConnectionRow(null) to simulate the
      // pre-OAuth state.
      const chain: Record<string, any> = {
        from: () => chain,
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: gitConnectionRow, error: null }),
      };
      return chain;
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import {
  ListApps,
  GetApp,
  CreateApp,
  UpdateApp,
  DeleteApp,
  GetAppGitConnection,
  StartGitConnect,
  ListAppGitRepositories,
  ListAppGitBranches,
  LinkAppRepository,
  UnlinkAppRepository,
} from '../routes/apps';
import {
  AppNotFoundError,
  DuplicateAppNameError,
  GitConnectionMissingError,
  RepoBranchAlreadyLinkedError,
} from '../../services/apps-service';
import { GitConnectConfigurationError } from '../../services/git-connect-service';
import { createGitProvider } from '../../git/factory';
import { UnsupportedGitProviderError } from '../../git/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_APP_ID = createVerifiedAppId('11111111-1111-4111-8111-111111111111');
const TEST_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const TEST_USER_ID = 'user-1';

interface CapturedResponse {
  body: unknown;
  status: number;
}

function createMockContext(options?: {
  body?: unknown;
  authMode?: 'apikey' | 'bearer';
}): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };

  const ctx = {
    get: vi.fn((key: string) => {
      if (key === 'user') {
        return {
          appId: TEST_APP_ID,
          tenantId: TEST_TENANT_ID,
          userId: TEST_USER_ID,
          gatewayUserId: TEST_USER_ID,
          authMode: options?.authMode ?? 'apikey',
          userJwt: options?.authMode === 'bearer' ? 'test-jwt' : undefined,
          appName: 'Test App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
          permissions: [],
        };
      }
      return undefined;
    }),
    env: { SUPABASE_API_BASE_URL: 'x', SUPABASE_SECRET_KEY: 'y' },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'GET',
      path: '/v1/apps',
      url: 'http://localhost/v1/apps',
      header: vi.fn(() => undefined),
      json: vi.fn().mockResolvedValue(options?.body ?? {}),
    },
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

function createRoute<T extends new (opts: any) => any>(
  RouteClass: T,
  params?: Record<string, string>,
  body?: unknown,
  query?: Record<string, unknown>,
): InstanceType<T> {
  const instance = new RouteClass({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  instance.getValidatedData = vi.fn().mockResolvedValue({
    params: params ?? {},
    body,
    query: query ?? {},
  });
  return instance;
}

async function invoke<C extends { handle: (ctx: AppContext) => Promise<Response> }>(
  route: C,
  ctx: AppContext,
): Promise<Response> {
  return route.handle(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleApp = {
  id: '11111111-1111-1111-1111-111111111111',
  tenant_id: TEST_TENANT_ID,
  name: 'triage',
  runtime: 'nodejs',
  entry_point: null,
  commit_sha: null,
  fly_app_name: null,
  fly_machine_id: null,
  fly_machine_url: null,
  created_at: '2026-05-21T00:00:00Z',
  created_by: TEST_USER_ID,
  updated_at: null,
  updated_by: null,
};

describe('Apps routes — permission wiring', () => {
  it('declares the four app.* permissions correctly', () => {
    expect(ListApps.requiredPermission).toBe('app.read');
    expect(GetApp.requiredPermission).toBe('app.read');
    expect(CreateApp.requiredPermission).toBe('app.insert');
    expect(UpdateApp.requiredPermission).toBe('app.update');
    expect(DeleteApp.requiredPermission).toBe('app.delete');
    expect(GetAppGitConnection.requiredPermission).toBe('app.read');
    // StartGitConnect requires `app.update` — minting an authorization
    // URL changes the connection state on accept, so it gates on the
    // same scope as patching app config.
    expect(StartGitConnect.requiredPermission).toBe('app.update');
  });
});

describe('StartGitConnect', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
    gitConnectSpy.buildAuthorizationUrl.mockReset();
  });

  const happyResult = {
    authorizationUrl: 'https://github.com/apps/test/installations/new?state=abc.def',
    state: 'abc.def',
    expiresAt: '2026-05-22T13:00:00.000Z',
    payload: {
      app_id: sampleApp.id,
      tenant_id: TEST_TENANT_ID,
      provider: 'github' as const,
      exp: 1_716_385_200,
      nonce: 'deadbeef',
    },
  };

  it('returns 201 with the authorization URL and expiry', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    gitConnectSpy.buildAuthorizationUrl.mockResolvedValue(happyResult);

    const { ctx, getResponse } = createMockContext({ body: { provider: 'github' } });
    const route = createRoute(StartGitConnect, { appId: sampleApp.id }, { provider: 'github' });
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(201);
    expect(body).toEqual({
      data: {
        authorization_url: happyResult.authorizationUrl,
        state: happyResult.state,
        expires_at: happyResult.expiresAt,
      },
    });
    expect(gitConnectSpy.buildAuthorizationUrl).toHaveBeenCalledWith({
      appId: sampleApp.id,
      tenantId: TEST_TENANT_ID,
      provider: 'github',
    });
  });

  it('verifies the app exists in the tenant before minting (404 for stale appId)', async () => {
    // The app lookup must come before the URL mint — otherwise an
    // attacker with `app.update` on tenant A could mint a state token
    // for tenant B's app id by passing it in the URL.
    serviceSpy.getApp.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext({ body: { provider: 'github' } });
    const route = createRoute(StartGitConnect, { appId: sampleApp.id }, { provider: 'github' });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(404);
    expect(getResponse().body).toMatchObject({ error: { code: 'app_not_found' } });
    expect(gitConnectSpy.buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('rejects missing provider with 400 invalid_request_body + field hint', async () => {
    const { ctx, getResponse } = createMockContext({ body: {} });
    const route = createRoute(StartGitConnect, { appId: sampleApp.id }, {});
    await invoke(route, ctx);

    expect(getResponse().status).toBe(400);
    expect(getResponse().body).toMatchObject({
      error: { code: 'invalid_request_body', field: 'provider' },
    });
    expect(serviceSpy.getApp).not.toHaveBeenCalled();
  });

  it('rejects unknown provider with 400', async () => {
    const { ctx, getResponse } = createMockContext({ body: { provider: 'bitbucket' } });
    const route = createRoute(StartGitConnect, { appId: sampleApp.id }, { provider: 'bitbucket' });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(400);
    expect(getResponse().body).toMatchObject({
      error: { code: 'invalid_request_body', field: 'provider' },
    });
  });

  it('maps GitConnectConfigurationError to 503 git_connect_not_configured', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    gitConnectSpy.buildAuthorizationUrl.mockRejectedValue(
      new GitConnectConfigurationError(
        'Failed to resolve GitHub App slug via GET /app (status=401)',
      ),
    );

    const { ctx, getResponse } = createMockContext({ body: { provider: 'github' } });
    const route = createRoute(StartGitConnect, { appId: sampleApp.id }, { provider: 'github' });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(503);
    expect(getResponse().body).toMatchObject({
      error: { code: 'git_connect_not_configured' },
    });
    // The operator-facing detail (the GET /app failure + status) MUST NOT
    // leak into the response — a public 503 shouldn't expose which
    // upstream call failed or its status code.
    const serialized = JSON.stringify(getResponse().body);
    expect(serialized).not.toContain('GET /app');
    expect(serialized).not.toContain('401');
  });
});

describe('GetAppGitConnection', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('returns the connection status wrapped under data', async () => {
    const status = {
      connected: true,
      provider: 'github' as const,
      repository: 'agentmark/triage',
      branch: 'main',
      installation_id: 42,
    };
    serviceSpy.getGitConnection.mockResolvedValue(status);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(GetAppGitConnection, { appId: sampleApp.id });
    await invoke(route, ctx);

    const { body, status: httpStatus } = getResponse();
    expect(httpStatus).toBe(200);
    expect(body).toEqual({ data: status });
    expect(serviceSpy.getGitConnection).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      sampleApp.id,
    );
  });

  it('returns connected:false envelope when no connection exists', async () => {
    const disconnected = {
      connected: false,
      provider: null,
      repository: null,
      branch: null,
      installation_id: null,
    };
    serviceSpy.getGitConnection.mockResolvedValue(disconnected);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(GetAppGitConnection, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().body).toEqual({ data: disconnected });
  });

  it('maps AppNotFoundError to 404 (stale appId is not silent)', async () => {
    serviceSpy.getGitConnection.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(GetAppGitConnection, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(404);
    expect(getResponse().body).toMatchObject({ error: { code: 'app_not_found' } });
  });
});

describe('ListApps', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('returns the list with pagination metadata', async () => {
    serviceSpy.listApps.mockResolvedValue({ data: [sampleApp], total: 1 });

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(ListApps, {}, undefined, { limit: 25, offset: 0 });
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      data: [sampleApp],
      pagination: { total: 1, limit: 25, offset: 0 },
    });
    expect(serviceSpy.listApps).toHaveBeenCalledWith(TEST_TENANT_ID, {
      name: undefined,
      limit: 25,
      offset: 0,
    });
  });

  it('forwards the name filter when supplied', async () => {
    serviceSpy.listApps.mockResolvedValue({ data: [sampleApp], total: 1 });

    const { ctx } = createMockContext();
    const route = createRoute(ListApps, {}, undefined, {
      name: 'triage',
      limit: 25,
      offset: 0,
    });
    await invoke(route, ctx);

    expect(serviceSpy.listApps).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      expect.objectContaining({ name: 'triage' }),
    );
  });
});

describe('GetApp', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('returns the app wrapped under data', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(GetApp, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().body).toEqual({ data: sampleApp });
  });

  it('maps AppNotFoundError to 404 app_not_found', async () => {
    serviceSpy.getApp.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(GetApp, { appId: sampleApp.id });
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'app_not_found' } });
  });
});

describe('CreateApp', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('creates an app and returns 201 with the data envelope', async () => {
    serviceSpy.createApp.mockResolvedValue(sampleApp);

    const { ctx, getResponse } = createMockContext({ body: { name: 'triage' } });
    const route = createRoute(CreateApp, {}, { name: 'triage' });
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(201);
    expect(body).toEqual({ data: sampleApp });
    expect(serviceSpy.createApp).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      expect.objectContaining({ name: 'triage' }),
      TEST_USER_ID,
    );
  });

  it('rejects empty body with 400 invalid_request_body and a field hint', async () => {
    const { ctx, getResponse } = createMockContext({ body: {} });
    const route = createRoute(CreateApp, {}, {});
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'invalid_request_body', field: 'name' },
    });
    expect(serviceSpy.createApp).not.toHaveBeenCalled();
  });

  it('maps DuplicateAppNameError to 409 duplicate_app_name', async () => {
    serviceSpy.createApp.mockRejectedValue(new DuplicateAppNameError('triage'));

    const { ctx, getResponse } = createMockContext({ body: { name: 'triage' } });
    const route = createRoute(CreateApp, {}, { name: 'triage' });
    await invoke(route, ctx);

    const { body, status } = getResponse();
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'duplicate_app_name' } });
  });
});

describe('UpdateApp', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('updates and returns the app wrapped under data', async () => {
    const updated = { ...sampleApp, name: 'renamed' };
    serviceSpy.updateApp.mockResolvedValue(updated);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(
      UpdateApp,
      { appId: sampleApp.id },
      { name: 'renamed' },
    );
    await invoke(route, ctx);

    expect(getResponse().body).toEqual({ data: updated });
    expect(serviceSpy.updateApp).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      sampleApp.id,
      expect.objectContaining({ name: 'renamed' }),
      TEST_USER_ID,
    );
  });

  it('rejects empty PATCH body with 400', async () => {
    const { ctx, getResponse } = createMockContext();
    const route = createRoute(UpdateApp, { appId: sampleApp.id }, {});
    await invoke(route, ctx);

    expect(getResponse().status).toBe(400);
    expect(serviceSpy.updateApp).not.toHaveBeenCalled();
  });

  it('maps AppNotFoundError to 404', async () => {
    serviceSpy.updateApp.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(
      UpdateApp,
      { appId: sampleApp.id },
      { name: 'x' },
    );
    await invoke(route, ctx);

    expect(getResponse().status).toBe(404);
  });

  it('maps DuplicateAppNameError to 409', async () => {
    serviceSpy.updateApp.mockRejectedValue(new DuplicateAppNameError('taken'));

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(
      UpdateApp,
      { appId: sampleApp.id },
      { name: 'taken' },
    );
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
  });
});

describe('DeleteApp', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
  });

  it('returns 204 on success', async () => {
    serviceSpy.deleteApp.mockResolvedValue(undefined);

    const { ctx } = createMockContext();
    const route = createRoute(DeleteApp, { appId: sampleApp.id });
    const response = await invoke(route, ctx);

    expect(response.status).toBe(204);
    expect(serviceSpy.deleteApp).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      sampleApp.id,
    );
  });

  it('maps AppNotFoundError to 404', async () => {
    serviceSpy.deleteApp.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(DeleteApp, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(404);
  });
});

// ===========================================================================
// Git repos / branches / link / unlink
// ===========================================================================

describe('B1 cluster — permission wiring', () => {
  it('reads route the GitHub install via app.read; writes via app.update', () => {
    expect(ListAppGitRepositories.requiredPermission).toBe('app.read');
    expect(ListAppGitBranches.requiredPermission).toBe('app.read');
    expect(LinkAppRepository.requiredPermission).toBe('app.update');
    expect(UnlinkAppRepository.requiredPermission).toBe('app.update');
  });
});

describe('ListAppGitRepositories', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
    Object.values(providerSpy).forEach((spy) => spy.mockReset());
    setGitConnectionRow({ provider: 'github', installation_id: 12345 });
  });

  it('translates provider GitRepositorySummary[] to the gateway envelope shape', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    providerSpy.listRepositories.mockResolvedValue([
      { fullName: 'acme/triage', name: 'triage', defaultBranch: 'main' },
      { fullName: 'acme/eval-bot', name: 'eval-bot', defaultBranch: 'production' },
    ]);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(ListAppGitRepositories, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(200);
    expect(getResponse().body).toEqual({
      data: [
        { full_name: 'acme/triage', name: 'triage', default_branch: 'main' },
        { full_name: 'acme/eval-bot', name: 'eval-bot', default_branch: 'production' },
      ],
    });
  });

  it('returns 409 git_connection_missing when no git_connection row exists', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    setGitConnectionRow(null);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(ListAppGitRepositories, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
    expect((getResponse().body as { error: { code: string } }).error.code).toBe(
      'git_connection_missing',
    );
  });

  // A legacy git_connection row (provider: 'gitlab') is real and readable —
  // the status endpoint's schema deliberately stays wide enough to echo it —
  // but the factory has no client for it anymore. That must surface as a
  // structured 409, not a 500: the row isn't missing, it's just unusable.
  it('returns 409 unsupported_git_provider (not 500) for a legacy gitlab connection row', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    setGitConnectionRow({ provider: 'gitlab', installation_id: null });
    vi.mocked(createGitProvider).mockRejectedValueOnce(
      new UnsupportedGitProviderError('gitlab'),
    );

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(ListAppGitRepositories, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
    const body = getResponse().body as { error: { code: string; message: string; provider?: string } };
    expect(body.error.code).toBe('unsupported_git_provider');
    expect(body.error.provider).toBe('gitlab');
    expect(body.error.message).toContain('gitlab');
  });

  it('maps AppNotFoundError to 404 (stale appId)', async () => {
    serviceSpy.getApp.mockRejectedValue(new AppNotFoundError());

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(ListAppGitRepositories, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(404);
  });
});

describe('ListAppGitBranches', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
    Object.values(providerSpy).forEach((spy) => spy.mockReset());
    setGitConnectionRow({ provider: 'github', installation_id: 12345 });
  });

  it('forwards the `repository` query string to the provider and returns the list', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    providerSpy.listBranches.mockResolvedValue(['main', 'develop', 'feature/x']);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(
      ListAppGitBranches,
      { appId: sampleApp.id },
      undefined,
      { repository: 'acme/triage' },
    );
    await invoke(route, ctx);

    expect(providerSpy.listBranches).toHaveBeenCalledWith('acme/triage');
    expect(getResponse().status).toBe(200);
    expect(getResponse().body).toEqual({ data: ['main', 'develop', 'feature/x'] });
  });

  it('returns 409 git_connection_missing when no install exists', async () => {
    serviceSpy.getApp.mockResolvedValue(sampleApp);
    setGitConnectionRow(null);

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(
      ListAppGitBranches,
      { appId: sampleApp.id },
      undefined,
      { repository: 'acme/triage' },
    );
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
  });
});

describe('LinkAppRepository', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
    Object.values(providerSpy).forEach((spy) => spy.mockReset());
    setGitConnectionRow({ provider: 'github', installation_id: 12345 });
  });

  it('passes the parsed body and the provider into the service and envelopes the result', async () => {
    serviceSpy.linkRepository.mockResolvedValue({
      repository: 'acme/triage',
      branch: 'main',
      branch_id: 'b1-uuid',
      commit_sha: 'abc123',
    });

    const { ctx, getResponse } = createMockContext({
      body: { repository: 'acme/triage', branch: 'main' },
    });
    const route = createRoute(
      LinkAppRepository,
      { appId: sampleApp.id },
      { repository: 'acme/triage', branch: 'main' },
    );
    await invoke(route, ctx);

    expect(serviceSpy.linkRepository).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      sampleApp.id,
      { repository: 'acme/triage', branch: 'main' },
      providerSpy,
      // userId threaded through for the git_branch.created_by FK retry
      // pattern (apps-service.ts). TEST_USER_ID is the value
      // getTenantScope returns from the mock context.
      TEST_USER_ID,
    );
    expect(getResponse().status).toBe(200);
    expect(getResponse().body).toEqual({
      data: {
        repository: 'acme/triage',
        branch: 'main',
        branch_id: 'b1-uuid',
        commit_sha: 'abc123',
      },
    });
  });

  it('rejects empty body with 400 invalid_request_body', async () => {
    const { ctx, getResponse } = createMockContext({ body: {} });
    const route = createRoute(LinkAppRepository, { appId: sampleApp.id }, {});
    await invoke(route, ctx);

    expect(getResponse().status).toBe(400);
    expect((getResponse().body as { error: { code: string } }).error.code).toBe(
      'invalid_request_body',
    );
  });

  it('maps GitConnectionMissingError (raised when row is missing) to 409', async () => {
    setGitConnectionRow(null);

    const { ctx, getResponse } = createMockContext({
      body: { repository: 'acme/triage', branch: 'main' },
    });
    const route = createRoute(
      LinkAppRepository,
      { appId: sampleApp.id },
      { repository: 'acme/triage', branch: 'main' },
    );
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
    expect((getResponse().body as { error: { code: string } }).error.code).toBe(
      'git_connection_missing',
    );
    // Service should NOT have been called — we bailed at the provider build step.
    expect(serviceSpy.linkRepository).not.toHaveBeenCalled();
  });

  it('maps RepoBranchAlreadyLinkedError to 409 repo_branch_already_linked (not the catch-all 500)', async () => {
    // The repo+branch is already watched by another app in the tenant
    // (`git_branch` UNIQUE (repo, branch_name, tenant_id)). The service
    // raises the domain error; the route must surface an actionable 409
    // instead of falling through to 500 internal_error.
    serviceSpy.linkRepository.mockRejectedValue(
      new RepoBranchAlreadyLinkedError('acme/triage', 'main'),
    );

    const { ctx, getResponse } = createMockContext({
      body: { repository: 'acme/triage', branch: 'main' },
    });
    const route = createRoute(
      LinkAppRepository,
      { appId: sampleApp.id },
      { repository: 'acme/triage', branch: 'main' },
    );
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
    const body = getResponse().body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('repo_branch_already_linked');
    // The message is what the dashboard modal renders verbatim — it must
    // name the colliding repo+branch so the user can act on it.
    expect(body.error.message).toContain('acme/triage');
    expect(body.error.message).toContain('"main"');
    expect(body.error.message).toContain('already linked to another app');
  });

});

describe('UnlinkAppRepository', () => {
  beforeEach(() => {
    Object.values(serviceSpy).forEach((spy) => spy.mockReset());
    Object.values(providerSpy).forEach((spy) => spy.mockReset());
    setGitConnectionRow({ provider: 'github', installation_id: 12345 });
  });

  it('returns 204 and calls service.unlinkRepository', async () => {
    serviceSpy.unlinkRepository.mockResolvedValue(undefined);

    const { ctx } = createMockContext();
    const route = createRoute(UnlinkAppRepository, { appId: sampleApp.id });
    const response = await invoke(route, ctx);

    expect(response.status).toBe(204);
    expect(serviceSpy.unlinkRepository).toHaveBeenCalledWith(
      TEST_TENANT_ID,
      sampleApp.id,
    );
  });

  it('maps GitConnectionMissingError to 409 (idempotent-ish — caller can branch on the code)', async () => {
    serviceSpy.unlinkRepository.mockRejectedValue(new GitConnectionMissingError(sampleApp.id));

    const { ctx, getResponse } = createMockContext();
    const route = createRoute(UnlinkAppRepository, { appId: sampleApp.id });
    await invoke(route, ctx);

    expect(getResponse().status).toBe(409);
  });

});
