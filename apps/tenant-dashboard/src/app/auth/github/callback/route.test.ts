/**
 * GitHub git-connect callback — the connection lands under the SIGNED-STATE
 * tenant, never the session claim.
 *
 * The property under test: a multi-org user whose session claim points at one
 * org can complete a connect flow whose signed state names a DIFFERENT org, and
 * the git_connection write must follow the state (validated at the DB against
 * membership), not the claim. These tests drive the real route through MSW and
 * assert the `X-Tenant-Id` header the scoped client actually sends on the write.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  seedSupabaseAuth,
  seedSupabaseMswState,
  seedMembershipMswState,
  getInsertedGitConnections,
  getDeletedGitBranchTenantHeaders,
  seedGitConnectionUpsertError,
} from '../../../../test-helpers/msw-handlers';

const OAUTH_STATE_SECRET = 'test-oauth-state-secret-at-least-32-chars';

vi.mock('@/config-global.server', () => ({
  OAUTH_STATE_SECRET: 'test-oauth-state-secret-at-least-32-chars',
}));

// removeGitWebhook is a separate helper with its own DB reads — assert it
// receives the scoped client rather than exercising its internals here.
const removeGitWebhookMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/system/git/remove-git-webhook', () => ({
  removeGitWebhook: (...args: unknown[]) => removeGitWebhookMock(...args),
}));

vi.mock('@/lib/posthog-server', () => ({
  captureActivationEvent: vi.fn().mockResolvedValue(undefined),
}));

// The success path calls next/navigation's redirect(), which throws by design;
// stub it so the handler returns normally after the write.
const redirectMock = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock('../../../../routes/paths', () => ({
  paths: {
    orgs: { org: { apps: { root: (orgName: string) => `/orgs/${orgName}/apps` } } },
  },
}));

import { GET } from './route';

// ---------------------------------------------------------------------------
// Inline state mint — mirrors the gateway's signGitConnectState wire format so
// the test signs a real, verification-passing token without importing the
// gateway package.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintState(params: {
  appId: string;
  tenantId: string;
  provider: string;
}): Promise<string> {
  const payload = {
    app_id: params.appId,
    tenant_id: params.tenantId,
    provider: params.provider,
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: 'deadbeef00112233',
  };
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(OAUTH_STATE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

const STATE_TENANT = '11111111-1111-1111-1111-111111111111';
const CLAIM_TENANT = '22222222-2222-2222-2222-222222222222';
const APP_ID = '33333333-3333-3333-3333-333333333333';

function buildRequest(state: string, installationId: string | number = 42): NextRequest {
  const url = new URL('http://localhost:3000/auth/github/callback');
  url.searchParams.set('state', state);
  if (installationId !== '') url.searchParams.set('installation_id', String(installationId));
  return new NextRequest(url);
}

/** A user whose session claim names CLAIM_TENANT — divergent from the state. */
function seedDivergentClaimUser() {
  seedSupabaseAuth({
    user: {
      id: 'user-1',
      app_metadata: { tenant_id: CLAIM_TENANT },
    } as never,
  });
}

// The signed state covers the app and tenant; `installation_id` rides outside
// it and is validated on its own.
describe('github git-connect callback — installation_id validation', () => {
  async function callWithInstallationId(installationId: string | number) {
    seedSupabaseAuth({ user: { id: 'user-1', app_metadata: { tenant_id: STATE_TENANT } } as never });
    seedSupabaseMswState({
      apps: [{ id: APP_ID, tenant_id: STATE_TENANT, name: 'app-a' } as never],
    });
    seedMembershipMswState({ tenants: [{ tenant_id: STATE_TENANT, organization_name: 'org-a' }] });
    const token = await mintState({ appId: APP_ID, tenantId: STATE_TENANT, provider: 'github' });
    return GET(buildRequest(token, installationId));
  }

  it.each([
    ['absent', ''],
    ['non-numeric', 'not-a-number'],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    // Beyond Number.MAX_SAFE_INTEGER the value has already lost precision, so
    // it no longer names the installation the caller typed.
    ['past safe-integer range', '9007199254740993'],
  ])('writes no connection when installation_id is %s', async (_label, value) => {
    const res = await callWithInstallationId(value);

    expect(getInsertedGitConnections()).toEqual([]);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=invalid_installation');
  });

  it('reports the cross-tenant claim rejection instead of a routine write error', async () => {
    seedGitConnectionUpsertError({
      code: '23P01',
      message:
        'conflicting key value violates exclusion constraint "excl_git_connection_installation_one_tenant"',
    });
    seedSupabaseAuth({ user: { id: 'user-1', app_metadata: { tenant_id: STATE_TENANT } } as never });
    seedSupabaseMswState({
      apps: [{ id: APP_ID, tenant_id: STATE_TENANT, name: 'app-a' } as never],
    });
    seedMembershipMswState({ tenants: [{ tenant_id: STATE_TENANT, organization_name: 'org-a' }] });
    const token = await mintState({ appId: APP_ID, tenantId: STATE_TENANT, provider: 'github' });

    const res = await GET(buildRequest(token, 4242));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=installation_already_connected');
  });

  it('accepts a well-formed installation id', async () => {
    await callWithInstallationId(4242);

    const inserted = getInsertedGitConnections();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.row).toMatchObject({ app_id: APP_ID, installation_id: 4242 });
  });
});

describe('github git-connect callback — signed-state tenancy', () => {
  it('writes the git_connection under the signed-state tenant, not the divergent claim', async () => {
    seedDivergentClaimUser();
    // The app + org-name reads run under the state tenant (org A).
    seedSupabaseMswState({
      apps: [{ id: APP_ID, tenant_id: STATE_TENANT, name: 'app-a' } as never],
    });
    seedMembershipMswState({ tenants: [{ tenant_id: STATE_TENANT, organization_name: 'org-a' }] });

    const token = await mintState({ appId: APP_ID, tenantId: STATE_TENANT, provider: 'github' });

    await GET(buildRequest(token));

    // The connection upsert carried the STATE tenant on the wire — not the claim.
    const inserted = getInsertedGitConnections();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.tenantHeader).toBe(STATE_TENANT);
    expect(inserted[0]!.tenantHeader).not.toBe(CLAIM_TENANT);
    expect(inserted[0]!.row).toMatchObject({
      app_id: APP_ID,
      provider: 'github',
      installation_id: 42,
    });

    // The branch clear rode the same state-scoped client.
    expect(getDeletedGitBranchTenantHeaders()).toEqual([STATE_TENANT]);

    // removeGitWebhook is handed the scoped client, not left to fall back to the
    // claim inside the helper (which happens when the second arg is undefined).
    expect(removeGitWebhookMock).toHaveBeenCalledWith(APP_ID, expect.anything());
  });

  it('rejects a state minted for the wrong provider without writing a connection', async () => {
    seedDivergentClaimUser();
    seedSupabaseMswState({
      apps: [{ id: APP_ID, tenant_id: STATE_TENANT, name: 'app-a' } as never],
    });
    seedMembershipMswState({ tenants: [{ tenant_id: STATE_TENANT, organization_name: 'org-a' }] });

    const redirectSpy = vi.spyOn(NextResponse, 'redirect');
    // A validly-signed state minted for a different provider arriving at the GitHub callback.
    const token = await mintState({ appId: APP_ID, tenantId: STATE_TENANT, provider: 'not-github' });

    await GET(buildRequest(token));

    expect(getInsertedGitConnections()).toHaveLength(0);
    const redirectedTo = String(redirectSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(redirectedTo).toContain('invalid_oauth_state');
  });

  it('rejects a "<appId>divider<redirectTo>" state (unsigned) without writing a connection', async () => {
    seedDivergentClaimUser();
    const redirectSpy = vi.spyOn(NextResponse, 'redirect');

    // An unsigned "<appId>divider<redirectTo>" state — not the signed envelope.
    await GET(buildRequest(`${APP_ID}divider/some/redirect`));

    expect(getInsertedGitConnections()).toHaveLength(0);
    const redirectedTo = String(redirectSpy.mock.calls.at(-1)?.[0] ?? '');
    expect(redirectedTo).toContain('invalid_oauth_state');
  });
});
