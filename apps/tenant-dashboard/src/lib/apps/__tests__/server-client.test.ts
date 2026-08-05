/**
 * Server-client tests — every dashboard app-CRUD and git-connection door
 * runs server-side through this typed gateway client; there is no
 * browser-held gateway client. MSW asserts the real request shape (method,
 * headers, query) rather than a query-chain mock.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server as mswServer } from '../../../test-helpers/msw-server';

import * as supabaseServerClientModule from '../../../supabaseServerClient';
import * as requestTenantModule from '../../tenant/request-tenant';
import {
  AppsApiError,
  createAppFromServer,
  updateAppFromServer,
  deleteAppFromServer,
  startGitConnectFromServer,
  listGitRepositoriesFromServer,
  listGitBranchesFromServer,
  linkAppRepositoryFromServer,
} from '../server-client';
import { GATEWAY_URL } from '../../../config-global';

const APP_ID = '22222222-2222-4222-8222-222222222222';
const ACCESS_TOKEN = 'server-session-token';

// `vi.spyOn` rather than `vi.mock` because the project lint rule
// (`@repo/supabase-test-mocks/no-supabase-test-mocks`) bans module-
// level mocks of supabaseServerClient. spyOn is the established
// pattern for SSR-helper tests in this app.
let getSessionStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSessionStub = vi.fn().mockResolvedValue({
    data: { session: { access_token: ACCESS_TOKEN, user: { id: 'u-1' } } },
  });
  vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue({
    auth: { getSession: getSessionStub },
  } as unknown as Awaited<
    ReturnType<typeof supabaseServerClientModule.createSupabaseServerClient>
  >);
});

describe('createAppFromServer', () => {
  it('POSTs to /v1/apps WITHOUT X-Outerlayer-App-Id (tenant-scoped, no app yet)', async () => {
    let capturedMethod: string | undefined;
    let hadAppIdHeader = true;
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps`, ({ request }) => {
        capturedMethod = request.method;
        hadAppIdHeader = request.headers.has('x-outerlayer-app-id');
        return HttpResponse.json({
          data: { id: 'app-1', name: 'acme-app', display_name: 'Acme' },
        }, { status: 201 });
      }),
    );

    const app = await createAppFromServer({ name: 'acme-app', display_name: 'Acme' });

    expect(capturedMethod).toBe('POST');
    expect(hadAppIdHeader).toBe(false);
    expect(app).toEqual({ id: 'app-1', name: 'acme-app', display_name: 'Acme' });
  });

  it('throws AppsApiError on a 409 duplicate_app_name, carrying the field hint', async () => {
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps`, () =>
        HttpResponse.json(
          { error: { code: 'duplicate_app_name', message: 'taken', field: 'name' } },
          { status: 409 },
        ),
      ),
    );

    try {
      await createAppFromServer({ name: 'dup' });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe('duplicate_app_name');
      expect(e.field).toBe('name');
    }
  });
});

describe('updateAppFromServer', () => {
  it('PATCHes /v1/apps/:appId with the forwarded app-id header and returns the updated app', async () => {
    let capturedAppIdHeader: string | undefined;
    mswServer.use(
      http.patch(`${GATEWAY_URL}/v1/apps/${APP_ID}`, ({ request }) => {
        capturedAppIdHeader = request.headers.get('x-outerlayer-app-id') ?? undefined;
        return HttpResponse.json({ data: { id: APP_ID, display_name: 'New Name' } });
      }),
    );

    const app = await updateAppFromServer(APP_ID, { display_name: 'New Name' });

    expect(capturedAppIdHeader).toBe(APP_ID);
    expect(app).toEqual({ id: APP_ID, display_name: 'New Name' });
  });
});

describe('deleteAppFromServer', () => {
  it('DELETEs /v1/apps/:appId and resolves on 204', async () => {
    let capturedMethod: string | undefined;
    mswServer.use(
      http.delete(`${GATEWAY_URL}/v1/apps/${APP_ID}`, ({ request }) => {
        capturedMethod = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(deleteAppFromServer(APP_ID)).resolves.toBeUndefined();
    expect(capturedMethod).toBe('DELETE');
  });

  it('throws AppsApiError on a 404 (already gone)', async () => {
    mswServer.use(
      http.delete(`${GATEWAY_URL}/v1/apps/${APP_ID}`, () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 }),
      ),
    );

    try {
      await deleteAppFromServer(APP_ID);
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.status).toBe(404);
    }
  });
});

describe('startGitConnectFromServer', () => {
  it('POSTs to /v1/apps/:appId/git/connect and returns the authorization envelope', async () => {
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/connect`, () =>
        HttpResponse.json({
          data: {
            authorization_url: 'https://github.example/authorize?state=abc',
            state: 'abc',
            expires_at: '2026-07-28T00:10:00.000Z',
          },
        }),
      ),
    );

    const result = await startGitConnectFromServer(APP_ID, { provider: 'github' });

    expect(result.authorization_url).toBe('https://github.example/authorize?state=abc');
  });

  it('throws AppsApiError on a 503 git_connect_not_configured', async () => {
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/connect`, () =>
        HttpResponse.json(
          { error: { code: 'git_connect_not_configured', message: 'unavailable' } },
          { status: 503 },
        ),
      ),
    );

    try {
      await startGitConnectFromServer(APP_ID, { provider: 'github' });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.status).toBe(503);
      expect(e.code).toBe('git_connect_not_configured');
    }
  });
});

describe('listGitRepositoriesFromServer', () => {
  it('forwards bearer + X-Outerlayer-App-Id and returns the data array', async () => {
    let captured: { auth?: string; appId?: string } = {};
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/repositories`, ({ request }) => {
        captured = {
          auth: request.headers.get('authorization') ?? undefined,
          appId: request.headers.get('x-outerlayer-app-id') ?? undefined,
        };
        return HttpResponse.json({
          data: [
            { full_name: 'acme/triage', name: 'triage', default_branch: 'main' },
          ],
        });
      }),
    );

    const repos = await listGitRepositoriesFromServer(APP_ID);

    expect(repos).toEqual([
      { full_name: 'acme/triage', name: 'triage', default_branch: 'main' },
    ]);
    expect(captured.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(captured.appId).toBe(APP_ID);
  });

  it('throws AppsApiError preserving code + status on 409 git_connection_missing', async () => {
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/repositories`, () =>
        HttpResponse.json(
          { error: { code: 'git_connection_missing', message: 'OAuth needed' } },
          { status: 409 },
        ),
      ),
    );

    try {
      await listGitRepositoriesFromServer(APP_ID);
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.code).toBe('git_connection_missing');
      expect(e.status).toBe(409);
    }
  });

  it('forwards the URL-derived request tenant as X-Tenant-Id when one resolves', async () => {
    vi.spyOn(requestTenantModule, 'getRequestTenantId').mockResolvedValue('tenant-from-url');
    let captured: string | null = null;
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/repositories`, ({ request }) => {
        captured = request.headers.get('x-tenant-id');
        return HttpResponse.json({ data: [] });
      }),
    );

    await listGitRepositoriesFromServer(APP_ID);

    expect(captured).toBe('tenant-from-url');
  });

  it('omits X-Tenant-Id when no request tenant resolves, so the gateway falls back to the claim', async () => {
    vi.spyOn(requestTenantModule, 'getRequestTenantId').mockResolvedValue(undefined);
    let hadTenantHeader = true;
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/repositories`, ({ request }) => {
        hadTenantHeader = request.headers.has('x-tenant-id');
        return HttpResponse.json({ data: [] });
      }),
    );

    await listGitRepositoriesFromServer(APP_ID);

    expect(hadTenantHeader).toBe(false);
  });

  it('throws 401 unauthorized when there is no server-side session', async () => {
    getSessionStub.mockResolvedValueOnce({ data: { session: null } });

    try {
      await listGitRepositoriesFromServer(APP_ID);
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.status).toBe(401);
      expect(e.code).toBe('unauthorized');
    }
  });
});

describe('listGitBranchesFromServer', () => {
  it('puts the repository in the query string (slash-safe)', async () => {
    let receivedUrl: URL | null = null;
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/branches`, ({ request }) => {
        receivedUrl = new URL(request.url);
        return HttpResponse.json({ data: ['main', 'develop'] });
      }),
    );

    const branches = await listGitBranchesFromServer(APP_ID, 'acme/triage');
    expect(branches).toEqual(['main', 'develop']);
    expect(receivedUrl!.searchParams.get('repository')).toBe('acme/triage');
  });

  it('propagates extras from the error envelope (e.g. entitlement payload)', async () => {
    mswServer.use(
      http.get(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/branches`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'entitlement_required',
              message: 'Not available on this tier',
              entitlement: 'max_apps',
              limit: 0,
            },
          },
          { status: 402 },
        ),
      ),
    );

    try {
      await listGitBranchesFromServer(APP_ID, 'acme/triage');
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.code).toBe('entitlement_required');
      // Extras (everything beyond code/message/field) preserved so
      // server-action callers can translate to legacy shapes.
      expect(e.extras.entitlement).toBe('max_apps');
      expect(e.extras.limit).toBe(0);
    }
  });
});

describe('linkAppRepositoryFromServer', () => {
  it('POSTs with forwarded bearer and returns the unwrapped data envelope', async () => {
    let capturedMethod: string | undefined;
    let capturedAuth: string | undefined;
    let capturedContentType: string | undefined;
    let capturedBody: unknown;
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/link`, async ({ request }) => {
        capturedBody = await request.json();
        capturedMethod = request.method;
        capturedAuth = request.headers.get('authorization') ?? undefined;
        capturedContentType = request.headers.get('content-type') ?? undefined;
        return HttpResponse.json({
          data: {
            repository: 'acme/triage',
            branch: 'main',
            branch_id: 'b1-uuid-here',
            commit_sha: 'abc123',
          },
        });
      }),
    );

    const result = await linkAppRepositoryFromServer(APP_ID, {
      repository: 'acme/triage',
      branch: 'main',
    });

    expect(capturedMethod).toBe('POST');
    expect(capturedAuth).toBe(`Bearer ${ACCESS_TOKEN}`); // bearer forwarded on writes
    expect(capturedContentType).toContain('application/json'); // sent as a JSON body
    // The caller's arguments must reach the wire unchanged — a typed client
    // still lets a wrong field name or a dropped key through at runtime.
    expect(capturedBody).toEqual({ repository: 'acme/triage', branch: 'main' });
    expect(result).toEqual({
      repository: 'acme/triage',
      branch: 'main',
      branch_id: 'b1-uuid-here',
      commit_sha: 'abc123',
    });
  });

  it('throws AppsApiError on a 400 invalid_request_body and carries the field hint', async () => {
    mswServer.use(
      http.post(`${GATEWAY_URL}/v1/apps/${APP_ID}/git/link`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid_request_body',
              message: 'branch required',
              field: 'branch',
            },
          },
          { status: 400 },
        ),
      ),
    );

    try {
      await linkAppRepositoryFromServer(APP_ID, {
        repository: 'acme/triage',
        // @ts-expect-error intentional invalid shape for the test
        branch: undefined,
      });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as AppsApiError;
      expect(e.status).toBe(400);
      expect(e.code).toBe('invalid_request_body');
      expect(e.field).toBe('branch');
    }
  });
});
