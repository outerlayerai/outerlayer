import { http, HttpResponse } from 'msw';
import {
  buildSingleResponse,
  getEqParam,
  projectSelectedFields,
} from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

type AppRow = {
  id: string;
  tenant_id: string;
  name?: string | null;
};

type TenantRow = {
  tenant_id: string;
  gateway_user_id?: string | null;
};

type GitBranchRow = {
  id: string;
  app_id: string;
};

type MembershipRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  status: string;
};

type DeploymentRow = {
  id: string;
  app: {
    id: string;
    tenant_id: string;
  } | null;
};

type AppAuthorizeResult = {
  requestedPermission: string;
  targetAppId: string;
  allowed: boolean;
};

type EntitlementOverrideRow = {
  tenant_id: string;
  entitlement_key: string;
  value: { v: unknown } | null;
};

type BillingRow = {
  tenant_id: string;
  tier_id: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
};

type ApiKeyRow = {
  tenant_id: string;
  app_id: string;
};

type TableErrorKey =
  | 'tenant_entitlement_override'
  | 'billing'
  | 'api_key';

type RequestLog = {
  app: number;
  tenant: number;
  gitBranch: number;
  membership: number;
  deployment: number;
  appAuthorize: number;
  entitlementOverride: number;
  billing: number;
  apiKey: number;
  verifyApiKey: number;
};

type GatewaySupabaseMswState = {
  apps: AppRow[];
  tenants: TenantRow[];
  gitBranches: GitBranchRow[];
  memberships: MembershipRow[];
  deployments: DeploymentRow[];
  appAuthorizeResults: AppAuthorizeResult[];
  entitlementOverrides: EntitlementOverrideRow[];
  billings: BillingRow[];
  apiKeys: ApiKeyRow[];
  // Per-table forced-error injection. When set, the handler responds with
  // a 503 and a PostgREST-shaped error body so supabase-js surfaces it
  // through `.error` on the response. Used to test fall-through paths in
  // resolvers that read multiple tables.
  tableErrors: Partial<Record<TableErrorKey, { message: string; code?: string }>>;
  // The jsonb payload the `verify_api_key` RPC returns. `null` = no live key
  // matches the digest (unknown/revoked/expired). When `verifyApiKeyError` is
  // set the handler responds 503 so supabase-js surfaces it through `.error`.
  verifyApiKeyResult: unknown;
  verifyApiKeyError: { message: string; code?: string } | null;
  requestLog: RequestLog;
  lastAuthorizationHeader: string | null;
  lastAppAuthorizeBody: Record<string, unknown> | null;
  lastVerifyApiKeyDigest: string | null;
};

const defaultState = (): GatewaySupabaseMswState => ({
  apps: [],
  tenants: [],
  gitBranches: [],
  memberships: [],
  deployments: [],
  appAuthorizeResults: [],
  entitlementOverrides: [],
  billings: [],
  apiKeys: [],
  tableErrors: {},
  verifyApiKeyResult: null,
  verifyApiKeyError: null,
  requestLog: {
    app: 0,
    tenant: 0,
    gitBranch: 0,
    membership: 0,
    deployment: 0,
    appAuthorize: 0,
    entitlementOverride: 0,
    billing: 0,
    apiKey: 0,
    verifyApiKey: 0,
  },
  lastAuthorizationHeader: null,
  lastAppAuthorizeBody: null,
  lastVerifyApiKeyDigest: null,
});

let state = defaultState();

export function resetGatewaySupabaseMswState() {
  state = defaultState();
}

export function seedGatewaySupabaseMswState(
  nextState: Partial<Omit<GatewaySupabaseMswState, 'requestLog' | 'lastAuthorizationHeader' | 'lastAppAuthorizeBody' | 'lastVerifyApiKeyDigest'>>,
) {
  state = {
    ...state,
    ...nextState,
    apps: nextState.apps ?? state.apps,
    tenants: nextState.tenants ?? state.tenants,
    gitBranches: nextState.gitBranches ?? state.gitBranches,
    memberships: nextState.memberships ?? state.memberships,
    deployments: nextState.deployments ?? state.deployments,
    appAuthorizeResults: nextState.appAuthorizeResults ?? state.appAuthorizeResults,
    entitlementOverrides:
      nextState.entitlementOverrides ?? state.entitlementOverrides,
    billings: nextState.billings ?? state.billings,
    apiKeys: nextState.apiKeys ?? state.apiKeys,
    tableErrors: nextState.tableErrors ?? state.tableErrors,
  };
}

export function getGatewaySupabaseMswState(): Readonly<GatewaySupabaseMswState> {
  return state;
}

export const gatewaySupabaseHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
    state.requestLog.app += 1;
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const tenantId = getEqParam(url, 'tenant_id');
    const row =
      state.apps.find(
        (app) =>
          (id ? app.id === id : true) &&
          (tenantId ? app.tenant_id === tenantId : true),
      ) ?? null;

    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/tenant`, ({ request }) => {
    state.requestLog.tenant += 1;
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const row = state.tenants.find((tenant) => tenant.tenant_id === tenantId) ?? null;

    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/git_branch`, ({ request }) => {
    state.requestLog.gitBranch += 1;
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const row = state.gitBranches.find((branch) => branch.app_id === appId) ?? null;

    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/membership`, ({ request }) => {
    state.requestLog.membership += 1;
    const url = new URL(request.url);
    const userId = getEqParam(url, 'user_id');
    const tenantId = getEqParam(url, 'tenant_id');
    const status = getEqParam(url, 'status');
    const row =
      state.memberships.find(
        (membership) =>
          (userId ? membership.user_id === userId : true) &&
          (tenantId ? membership.tenant_id === tenantId : true) &&
          (status ? membership.status === status : true),
      ) ?? null;

    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/deployment`, ({ request }) => {
    state.requestLog.deployment += 1;
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const row = state.deployments.find((deployment) => deployment.id === id) ?? null;

    if (!row) {
      return buildSingleResponse(request, null);
    }

    const select = url.searchParams.get('select') ?? '';
    if (select.includes('app:app_id(')) {
      return buildSingleResponse(request, { app: row.app ? { ...row.app } : null });
    }

    return buildSingleResponse(
      request,
      projectSelectedFields(url, row),
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/tenant_entitlement_override`, ({ request }) => {
    state.requestLog.entitlementOverride += 1;
    const forced = state.tableErrors.tenant_entitlement_override;
    if (forced) {
      return HttpResponse.json(
        { message: forced.message, code: forced.code ?? '503' },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const entitlementKey = getEqParam(url, 'entitlement_key');
    const row =
      state.entitlementOverrides.find(
        (r) =>
          (tenantId ? r.tenant_id === tenantId : true) &&
          (entitlementKey ? r.entitlement_key === entitlementKey : true),
      ) ?? null;
    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/billing`, ({ request }) => {
    state.requestLog.billing += 1;
    const forced = state.tableErrors.billing;
    if (forced) {
      return HttpResponse.json(
        { message: forced.message, code: forced.code ?? '503' },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const row = state.billings.find((r) => (tenantId ? r.tenant_id === tenantId : true)) ?? null;
    return buildSingleResponse(
      request,
      row ? projectSelectedFields(url, row) : null,
    );
  }),

  http.get(`${SUPABASE_URL}/rest/v1/api_key`, ({ request }) => {
    state.requestLog.apiKey += 1;
    const forced = state.tableErrors.api_key;
    if (forced) {
      return HttpResponse.json(
        { message: forced.message, code: forced.code ?? '503' },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const matches = state.apiKeys.filter(
      (r) => (tenantId ? r.tenant_id === tenantId : true),
    );
    // PostgREST `count=exact` returns the total count in the
    // Content-Range header (e.g. `0-0/3`). Our resolveApiKeyCount helper
    // uses `head: true, count: 'exact'` so it only needs the header —
    // the body can be an empty array.
    const headers = new Headers({
      'Content-Range': `0-${Math.max(matches.length - 1, 0)}/${matches.length}`,
      'Content-Type': 'application/json',
    });
    return new HttpResponse(JSON.stringify([]), { status: 200, headers });
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/app_authorize`, async ({ request }) => {
    state.requestLog.appAuthorize += 1;
    state.lastAuthorizationHeader = request.headers.get('authorization');
    const body = await request.json() as Record<string, unknown>;
    state.lastAppAuthorizeBody = body;

    const requestedPermission = typeof body.requested_permission === 'string'
      ? body.requested_permission
      : '';
    const targetAppId = typeof body.target_app_id === 'string' ? body.target_app_id : '';

    const result = state.appAuthorizeResults.find(
      (entry) =>
        entry.requestedPermission === requestedPermission &&
        entry.targetAppId === targetAppId,
    );

    return HttpResponse.json(result?.allowed ?? false);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/verify_api_key`, async ({ request }) => {
    state.requestLog.verifyApiKey += 1;
    const body = (await request.json()) as Record<string, unknown> | null;
    state.lastVerifyApiKeyDigest =
      typeof body?.p_key_digest === 'string' ? body.p_key_digest : null;

    // Forced error → supabase-js surfaces it on `.error` (verify maps to 502).
    if (state.verifyApiKeyError) {
      return HttpResponse.json(
        { message: state.verifyApiKeyError.message, code: state.verifyApiKeyError.code },
        { status: 503 },
      );
    }

    // `null` body = no live key matched (unknown/revoked/expired) → verify 401s.
    return HttpResponse.json(state.verifyApiKeyResult ?? null);
  }),
];
