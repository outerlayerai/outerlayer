import type { User } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import {
  buildSingleResponse,
  filterByEqParams,
  getEqParam,
  projectSelectedFields,
  wantsSingle,
} from '@repo/test-msw';
import type { EntitlementKey, TierId } from '@/config/entitlements';
import {
  resetSupabaseTestSession,
  seedSupabaseSessionCookie,
  type SupabaseTestSession,
} from '../supabase-session';

const SUPABASE_URL = 'http://localhost:54321';

type AppRow = {
  id: string;
  tenant_id: string;
  /** Human-readable app name. Optional so existing seeds that only set
   *  `id`/`tenant_id` keep working — services that read `name` (e.g.
   *  `ManagedBuildService.ensureApiKey`) seed it explicitly. */
  name?: string;
  /** Per-app publish policy — read by the context save-path
   *  service's `PolicyPort` to decide direct-commit vs forced PR. */
  require_pull_request?: boolean;
};

type BillingRow = {
  tenant_id: string;
  tier_id?: TierId;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
};

type PlatformUserRoleRow = {
  user_id: string;
  role: string;
};

type PlatformRolePermissionRow = {
  role: string;
  permission: string;
};

type TempAccessGrantRow = {
  id: string;
  created_by: string;
  tenant_id: string;
  /** ISO timestamp; the guard treats a grant as active only while > now. */
  expires_at: string;
  /** null while active; an ISO timestamp once revoked. */
  revoked_at?: string | null;
  /**
   * The embedded `tenant!temp_access_grant_tenant_id_fkey(...)` resource
   * `getActiveTempAccessGrant` selects. Optional — most callers of this
   * table (the read-only guard) never select it. Accepts an array to let a
   * test emulate PostgREST's array-embed shape for a to-one relation.
   */
  tenant?:
    | { organization_name: string; company_name: string | null }
    | { organization_name: string; company_name: string | null }[]
    | null;
};

type ProfileRow = {
  id: string;
  email: string;
  name?: string;
  last_active_tenant_id?: string | null;
};

/** A `profile` PATCH payload, captured for assertions. */
type ProfileUpdateCapture = {
  id: string;
  last_active_tenant_id?: string | null;
};

type TermsAgreementRow = {
  id: string;
  user_id: string;
  version?: string;
};

export type SavedTraceFilterRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  filter_config: Record<string, unknown>;
  page: string;
  created_at: string;
  updated_at: string | null;
};

type TenantEntitlementOverrideRow = {
  id: string;
  tenant_id: string;
  entitlement_key: EntitlementKey;
  value: { v: boolean | number | string };
  override_reason?: string | null;
  created_at?: string;
  created_by?: string | null;
};

type SupabaseAuthSessionRow = {
  accessToken: string;
  /** Present for sessions minted by the OTP-verify handler — lets the
   *  refresh-token endpoint resolve `auth.refreshSession()` back to the
   *  same user (invite-confirm calls it right after activating the
   *  membership so the new tenant/role claims land in the JWT). */
  refreshToken?: string;
  user: User;
};

type SupabaseOtpVerificationRow = {
  tokenHash: string;
  user: User;
};

type EntitlementOverrideUpsertCapture = {
  tenant_id: string;
  entitlement_key: string;
  value: { v: boolean | number | string };
  override_reason: string | null;
  created_by: string | null;
};

type EntitlementOverrideDeleteCapture = {
  tenant_id: string;
  entitlement_key: string;
};

type BillingUpdateCapture = {
  tenant_id: string;
  tier_id: string;
};

type SsoConfigRow = {
  tenant_id: string;
  allowed_domains: string[];
  is_active: boolean;
  enforcement_enabled: boolean;
};

type TableErrorMap = {
  billing_update?: { message: string };
  profile_update?: { message: string };
  sso_config_select?: { message: string };
  override_upsert?: { message: string };
  override_delete?: { message: string };
  temp_access_grant_select?: { message: string };
  terms_agreement_select?: { message: string };
};

/** The auth user `auth.admin.generateLink({ type: 'invite', ... })` hands
 *  back for the next call — the invite flow's new-user branch reads
 *  `data.user.id` to create the membership and `properties.hashed_token`
 *  to build the confirm link. */
type GeneratedAuthLinkUser = {
  id: string;
  hashedToken: string;
};

type SupabaseMswState = {
  sessions: SupabaseAuthSessionRow[];
  otpVerifications: SupabaseOtpVerificationRow[];
  apps: AppRow[];
  billing: BillingRow[];
  ssoConfigs: SsoConfigRow[];
  platformUserRoles: PlatformUserRoleRow[];
  platformRolePermissions: PlatformRolePermissionRow[];
  tempAccessGrants: TempAccessGrantRow[];
  profiles: ProfileRow[];
  termsAgreements: TermsAgreementRow[];
  savedTraceFilters: SavedTraceFilterRow[];
  tenantEntitlementOverrides: TenantEntitlementOverrideRow[];
  // Captured mutation payloads — tests assert against these instead of
  // hand-rolled spies. Lets the test verify "the right upsert payload
  // was sent" without coupling to the Supabase query-builder chain shape.
  upsertedEntitlementOverrides: EntitlementOverrideUpsertCapture[];
  deletedEntitlementOverrides: EntitlementOverrideDeleteCapture[];
  updatedBilling: BillingUpdateCapture[];
  updatedProfiles: ProfileUpdateCapture[];
  tableErrors: TableErrorMap;
  /** Queued response for the next `auth.admin.generateLink` call. */
  generatedAuthLinkUser: GeneratedAuthLinkUser | null;
  /** Force `auth.admin.generateLink` to fail with this message. */
  forceGenerateLinkError: string | null;
  /** Force `auth.admin.deleteUser` to fail with this message. */
  forceDeleteUserError: string | null;
  /** Every user id `auth.admin.deleteUser` was called with, in order. */
  deletedAuthUserIds: string[];
};

type SeedSupabaseAuthOptions = {
  user: User;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  tokenType?: string;
};

const defaultState = (): SupabaseMswState => ({
  sessions: [],
  otpVerifications: [],
  apps: [],
  billing: [],
  ssoConfigs: [],
  platformUserRoles: [],
  platformRolePermissions: [
    { role: 'platform_admin', permission: 'platform.org.read' },
    { role: 'platform_admin', permission: 'platform.org.delete' },
    { role: 'platform_admin', permission: 'platform.user.read' },
    { role: 'platform_admin', permission: 'platform.user.delete' },
    { role: 'platform_admin', permission: 'platform.temp_access.grant' },
    { role: 'platform_admin', permission: 'platform.flag.manage' },
    { role: 'platform_admin', permission: 'platform.audit.read' },
  ],
  tempAccessGrants: [],
  profiles: [],
  termsAgreements: [],
  savedTraceFilters: [],
  tenantEntitlementOverrides: [],
  upsertedEntitlementOverrides: [],
  deletedEntitlementOverrides: [],
  updatedBilling: [],
  updatedProfiles: [],
  tableErrors: {},
  generatedAuthLinkUser: null,
  forceGenerateLinkError: null,
  forceDeleteUserError: null,
  deletedAuthUserIds: [],
});

let state = defaultState();
// `refresh_token` values from every `auth.refreshSession()` call the token
// endpoint served — the invite-confirm route only refreshes once both claim
// writes succeed, so this is how a test proves that gating without spying on
// the Supabase client directly.
let tokenRefreshCalls: string[] = [];

function applyOverrideDefaults(
  row: TenantEntitlementOverrideRow,
): TenantEntitlementOverrideRow {
  return {
    override_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: null,
    ...row,
  };
}

/** Every `profile` PATCH payload, in order, for assertions. */
export function getProfileUpdateCalls(): readonly ProfileUpdateCapture[] {
  return [...state.updatedProfiles];
}

export function resetSupabaseMswState() {
  state = defaultState();
  tokenRefreshCalls = [];
  resetSupabaseTestSession();
}

export function seedSupabaseMswState(nextState: Partial<SupabaseMswState>) {
  state = {
    ...state,
    ...nextState,
    sessions: nextState.sessions ?? state.sessions,
    otpVerifications: nextState.otpVerifications ?? state.otpVerifications,
    apps: nextState.apps ?? state.apps,
    billing: nextState.billing ?? state.billing,
    ssoConfigs: nextState.ssoConfigs ?? state.ssoConfigs,
    platformUserRoles: nextState.platformUserRoles ?? state.platformUserRoles,
    platformRolePermissions:
      nextState.platformRolePermissions ?? state.platformRolePermissions,
    tempAccessGrants: nextState.tempAccessGrants ?? state.tempAccessGrants,
    profiles: nextState.profiles ?? state.profiles,
    termsAgreements: nextState.termsAgreements ?? state.termsAgreements,
    savedTraceFilters: nextState.savedTraceFilters ?? state.savedTraceFilters,
    tenantEntitlementOverrides:
      nextState.tenantEntitlementOverrides?.map(applyOverrideDefaults) ??
      state.tenantEntitlementOverrides,
    upsertedEntitlementOverrides:
      nextState.upsertedEntitlementOverrides ?? state.upsertedEntitlementOverrides,
    deletedEntitlementOverrides:
      nextState.deletedEntitlementOverrides ?? state.deletedEntitlementOverrides,
    updatedBilling: nextState.updatedBilling ?? state.updatedBilling,
    tableErrors: nextState.tableErrors ?? state.tableErrors,
    generatedAuthLinkUser: nextState.generatedAuthLinkUser ?? state.generatedAuthLinkUser,
    forceGenerateLinkError: nextState.forceGenerateLinkError ?? state.forceGenerateLinkError,
    forceDeleteUserError: nextState.forceDeleteUserError ?? state.forceDeleteUserError,
    deletedAuthUserIds: nextState.deletedAuthUserIds ?? state.deletedAuthUserIds,
  };
}

export function getSupabaseMswState(): Readonly<SupabaseMswState> {
  return state;
}

/** Inspect what `EntitlementService.setOverride` upserted into the override table. */
export function getUpsertedEntitlementOverrides(): readonly EntitlementOverrideUpsertCapture[] {
  return state.upsertedEntitlementOverrides;
}

/** Inspect what `EntitlementService.removeOverride` deleted. */
export function getDeletedEntitlementOverrides(): readonly EntitlementOverrideDeleteCapture[] {
  return state.deletedEntitlementOverrides;
}

/** Inspect what `EntitlementService.setTenantTier` patched on `billing`. */
export function getUpdatedBilling(): readonly BillingUpdateCapture[] {
  return state.updatedBilling;
}

/** Every user id `auth.admin.deleteUser` was called with, in order. */
export function getDeletedAuthUserIds(): readonly string[] {
  return state.deletedAuthUserIds;
}

export function seedSupabaseAuth({
  user,
  accessToken,
  refreshToken,
  expiresAt,
  expiresIn,
  tokenType,
}: SeedSupabaseAuthOptions): SupabaseTestSession {
  const session = seedSupabaseSessionCookie({
    user,
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn,
    tokenType,
  });

  state.sessions = [
    { accessToken: session.access_token, refreshToken: session.refresh_token, user: session.user },
    ...state.sessions.filter((row) => row.accessToken !== session.access_token),
  ];

  return session;
}

/**
 * Register an email-OTP token so `auth.verifyOtp({ token_hash })` succeeds
 * for `user`. The session minted by the verify handler is also registered,
 * so a follow-up `auth.getUser()` resolves the same user — mirroring the
 * GoTrue confirm-link flow (`/auth/confirm?token_hash=…`).
 */
export function seedSupabaseOtpVerification({
  tokenHash,
  user,
}: {
  tokenHash: string;
  user: User;
}) {
  state.otpVerifications = [
    { tokenHash, user },
    ...state.otpVerifications.filter((row) => row.tokenHash !== tokenHash),
  ];
}

export function seedPlatformAdminAccess(user: User, role = 'platform_admin') {
  seedSupabaseAuth({ user });
  state.profiles = [
    { id: user.id, email: user.email ?? '', name: user.user_metadata?.name as string | undefined },
    ...state.profiles.filter((profile) => profile.id !== user.id),
  ];
  state.platformUserRoles = [
    { user_id: user.id, role },
    ...state.platformUserRoles.filter((row) => row.user_id !== user.id),
  ];
}

export const supabaseHandlers = [
  http.post(`${SUPABASE_URL}/auth/v1/verify`, async ({ request }) => {
    const body = (await request.json()) as { token_hash?: string };
    const match = state.otpVerifications.find(
      (row) => row.tokenHash === body.token_hash,
    );

    if (!match) {
      // GoTrue's expired/invalid-link shape
      return HttpResponse.json(
        { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' },
        { status: 403 },
      );
    }

    const session = {
      access_token: `otp-access-${match.tokenHash}`,
      refresh_token: `otp-refresh-${match.tokenHash}`,
      expires_at: 4_102_444_800,
      expires_in: 3600,
      token_type: 'bearer',
      user: match.user,
    };

    state.sessions = [
      { accessToken: session.access_token, refreshToken: session.refresh_token, user: session.user },
      ...state.sessions.filter((row) => row.accessToken !== session.access_token),
    ];

    return HttpResponse.json(session);
  }),

  // `auth.refreshSession()` — the invite-confirm route calls this right
  // after activating the membership and writing the tenant/role claims, so
  // the JWT the browser ends up with reflects the new claims immediately
  // instead of on next natural refresh.
  http.post(`${SUPABASE_URL}/auth/v1/token`, async ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('grant_type') !== 'refresh_token') {
      return HttpResponse.json({ message: 'unsupported grant_type' }, { status: 400 });
    }

    const body = (await request.json()) as { refresh_token?: string };
    if (body.refresh_token) {
      tokenRefreshCalls.push(body.refresh_token);
    }
    const session = state.sessions.find((row) => row.refreshToken === body.refresh_token);
    if (!session) {
      return HttpResponse.json(
        { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' },
        { status: 401 },
      );
    }

    return HttpResponse.json({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_at: 4_102_444_800,
      expires_in: 3600,
      token_type: 'bearer',
      user: session.user,
    });
  }),

  http.get(`${SUPABASE_URL}/auth/v1/user`, ({ request }) => {
    const authorization = request.headers.get('authorization');

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json({ message: 'Missing bearer token' }, { status: 401 });
    }

    const accessToken = authorization.slice('Bearer '.length);
    const session = state.sessions.find((row) => row.accessToken === accessToken);

    if (!session) {
      return HttpResponse.json({ message: 'Invalid access token' }, { status: 401 });
    }

    return HttpResponse.json(session.user);
  }),

  // GoTrue admin user lookup — `auth.admin.getUserById`. Looked up from
  // sessions the same way `auth/v1/user` resolves the caller: whichever
  // `seedSupabaseAuth` call registered that user's id, regardless of whose
  // bearer token the caller authenticated with — the service-role client
  // this endpoint serves has no per-caller identity of its own.
  http.get(`${SUPABASE_URL}/auth/v1/admin/users/:id`, ({ params }) => {
    const session = state.sessions.find((row) => row.user.id === params.id);
    if (!session) {
      return HttpResponse.json({ message: 'User not found' }, { status: 404 });
    }
    return HttpResponse.json({ user: session.user });
  }),

  // `auth.admin.generateLink({ type: 'invite', ... })` — the new-user invite
  // branch provisions the auth account here before the membership transaction
  // runs. The response shape mirrors GoTrue's `_generateLinkResponse` xform:
  // user fields at the top level, link metadata under separate keys.
  http.post(`${SUPABASE_URL}/auth/v1/admin/generate_link`, () => {
    if (state.forceGenerateLinkError) {
      return HttpResponse.json({ message: state.forceGenerateLinkError }, { status: 500 });
    }
    const queued = state.generatedAuthLinkUser ?? { id: '00000000-0000-4000-a000-000000000001', hashedToken: 'generated-token' };
    return HttpResponse.json({
      id: queued.id,
      hashed_token: queued.hashedToken,
      action_link: `${SUPABASE_URL}/auth/v1/verify?token=${queued.hashedToken}`,
      verification_type: 'invite',
    });
  }),

  // `auth.admin.deleteUser(id)` — the new-user invite branch calls this to
  // clean up the just-provisioned auth account when the membership
  // transaction fails, so the account is never left orphaned.
  http.delete(`${SUPABASE_URL}/auth/v1/admin/users/:id`, ({ params }) => {
    if (state.forceDeleteUserError) {
      return HttpResponse.json({ message: state.forceDeleteUserError }, { status: 500 });
    }
    state.deletedAuthUserIds.push(String(params.id));
    return HttpResponse.json({});
  }),

  http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => {
    const url = new URL(request.url);
    const rows = filterByEqParams(url, state.apps, ['id', 'tenant_id', 'name']);

    // Honour a single-column `order=<col>.<asc|desc>` the way PostgREST does,
    // so a caller relying on the ordering (e.g. the app-access dropdown's
    // name sort) is actually exercised. Default order is the seeded order.
    const order = url.searchParams.get('order');
    const [col, dir] = (order ?? '').split('.');
    if (col) {
      const factor = dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = String((a as Record<string, unknown>)[col] ?? '');
        const bv = String((b as Record<string, unknown>)[col] ?? '');
        return av < bv ? -factor : av > bv ? factor : 0;
      });
    }

    // Single-row callers (`.single()`/`.maybeSingle()`) keep their existing
    // shape; list callers (e.g. CLI `GET /api/cli/apps`, which selects every
    // app for a tenant) get the full filtered array.
    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }

    return HttpResponse.json(rows);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/billing`, ({ request }) => {
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const row = state.billing.find((billing) => (tenantId ? billing.tenant_id === tenantId : true)) ?? null;

    return buildSingleResponse(request, row);
  }),

  // sso_config — the login-flow domain check (lib/auth/sso-domain-check.ts)
  // queries `allowed_domains cs {domain}` + `is_active eq true`. Both filters
  // are EMULATED (not ignored) so tests pin the query's behavior — an inactive
  // row or a row for a different domain must not match. PostgREST `cs.{}`
  // (empty containment) matches every row; the emulation mirrors that, which
  // is what lets a `[domain]` → `[]` mutation in the production query fail a
  // different-domain test instead of surviving.
  http.get(`${SUPABASE_URL}/rest/v1/sso_config`, ({ request }) => {
    const selectError = state.tableErrors.sso_config_select;
    if (selectError) {
      return HttpResponse.json({ message: selectError.message }, { status: 500 });
    }

    const url = new URL(request.url);
    const containsParam = url.searchParams.get('allowed_domains');
    const containedDomains = containsParam?.startsWith('cs.')
      ? containsParam
          .slice(3)
          .replace(/[{}"]/g, '')
          .split(',')
          .filter(Boolean)
      : [];
    const isActive = getEqParam(url, 'is_active');

    const rows = state.ssoConfigs.filter(
      (config) =>
        containedDomains.every((domain) => config.allowed_domains.includes(domain)) &&
        (isActive !== null && isActive !== undefined
          ? String(config.is_active) === isActive
          : true),
    );

    return buildSingleResponse(request, rows[0] ?? null);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/platform_user_role`, ({ request }) => {
    const url = new URL(request.url);
    const userId = getEqParam(url, 'user_id');
    const row =
      state.platformUserRoles.find((platformRole) =>
        userId ? platformRole.user_id === userId : true,
      ) ?? null;

    return buildSingleResponse(request, row);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/platform_role_permissions`, ({ request }) => {
    const url = new URL(request.url);
    const role = getEqParam(url, 'role');
    const permission = getEqParam(url, 'permission');
    const rows = state.platformRolePermissions.filter(
      (platformPermission) =>
        (role ? platformPermission.role === role : true) &&
        (permission ? platformPermission.permission === permission : true),
    );

    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }

    return HttpResponse.json(rows);
  }),

  // temp_access_grant — read via the service-role client by the read-only
  // guard (services/temp-access-guard.ts). The `revoked_at=is.null` and
  // `expires_at=gt.<now>` filters are EMULATED (not ignored) so a revoked or
  // expired grant does NOT match: a test seeding one of those must see the
  // guard return false, which is what pins the "active grant only" behaviour.
  http.get(`${SUPABASE_URL}/rest/v1/temp_access_grant`, ({ request }) => {
    const selectError = state.tableErrors.temp_access_grant_select;
    if (selectError) {
      return HttpResponse.json({ message: selectError.message }, { status: 500 });
    }

    const url = new URL(request.url);
    const createdBy = getEqParam(url, 'created_by');
    const tenantId = getEqParam(url, 'tenant_id');
    // `.gt('expires_at', iso)` → `expires_at=gt.<iso>`; only-active means the
    // grant must still be in the future relative to that bound.
    const expiresAfter = url.searchParams.get('expires_at')?.startsWith('gt.')
      ? url.searchParams.get('expires_at')!.slice(3)
      : null;
    // `.is('revoked_at', null)` → `revoked_at=is.null`.
    const requireActive = url.searchParams.get('revoked_at') === 'is.null';

    const rows = state.tempAccessGrants.filter(
      (grant) =>
        (createdBy ? grant.created_by === createdBy : true) &&
        (tenantId ? grant.tenant_id === tenantId : true) &&
        (requireActive ? grant.revoked_at == null : true) &&
        (expiresAfter ? grant.expires_at > expiresAfter : true),
    );

    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }

    return HttpResponse.json(rows);
  }),

  // terms_agreement — read via the service-role client by
  // checkNeedsTermsAgreement (lib/system/org-actions-admin.ts) for a pending
  // invitee with no tenant-scoped RLS client yet. `.maybeSingle()` over GET
  // sends `Accept: application/json` (not the single-object header), so
  // postgrest-js does the array-to-single unwrap client-side — this handler
  // just returns the filtered array.
  http.get(`${SUPABASE_URL}/rest/v1/terms_agreement`, ({ request }) => {
    const selectError = state.tableErrors.terms_agreement_select;
    if (selectError) {
      return HttpResponse.json({ message: selectError.message }, { status: 500 });
    }

    const url = new URL(request.url);
    const userId = getEqParam(url, 'user_id');
    const rows = state.termsAgreements.filter((row) =>
      userId ? row.user_id === userId : true,
    );

    return HttpResponse.json(rows);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/profile`, ({ request }) => {
    const url = new URL(request.url);

    // Batch lookup (`id=in.(a,b)`) — used by the audit viewer's actor
    // resolution. Returns an array like PostgREST does.
    const rawId = url.searchParams.get('id');
    if (rawId?.startsWith('in.(') && rawId.endsWith(')')) {
      const ids = rawId.slice(4, -1).split(',').filter(Boolean);
      return HttpResponse.json(state.profiles.filter((profile) => ids.includes(profile.id)));
    }

    const id = getEqParam(url, 'id');
    const row = state.profiles.find((profile) => (id ? profile.id === id : true)) ?? null;

    return buildSingleResponse(request, row);
  }),

  // The preference write behind setLastActiveOrg / invite-confirm
  // activation — records which tenant is the caller's last-active org.
  http.patch(`${SUPABASE_URL}/rest/v1/profile`, async ({ request }) => {
    if (state.tableErrors.profile_update) {
      return HttpResponse.json(
        { message: state.tableErrors.profile_update.message },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const body = (await request.json()) as Partial<ProfileRow>;
    state.updatedProfiles.push({
      id: id ?? '',
      last_active_tenant_id: body.last_active_tenant_id,
    });
    state.profiles = state.profiles.map((profile) =>
      profile.id === id ? { ...profile, ...body } : profile,
    );
    const updated = state.profiles.find((profile) => profile.id === id) ?? null;
    return buildSingleResponse(request, updated);
  }),

  http.head(`${SUPABASE_URL}/rest/v1/saved_trace_filters`, ({ request }) => {
    const url = new URL(request.url);
    const appId = getEqParam(url, 'app_id');
    const total = state.savedTraceFilters.filter((filter) =>
      appId ? filter.app_id === appId : true,
    ).length;

    return new HttpResponse(null, {
      status: 200,
      headers: {
        'content-range': `0-${Math.max(total - 1, 0)}/${total}`,
      },
    });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/saved_trace_filters`, ({ request }) => {
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const appId = getEqParam(url, 'app_id');
    const page = getEqParam(url, 'page');
    const rows = state.savedTraceFilters
      .filter(
        (filter) =>
          (id ? filter.id === id : true) &&
          (appId ? filter.app_id === appId : true) &&
          (page ? filter.page === page : true),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    if (wantsSingle(request)) {
      const row = rows[0] ? projectSelectedFields(url, rows[0]) : null;
      return buildSingleResponse(request, row);
    }

    return HttpResponse.json(rows.map((row) => projectSelectedFields(url, row)));
  }),

  http.post(`${SUPABASE_URL}/rest/v1/saved_trace_filters`, async ({ request }) => {
    const body = (await request.json()) as Omit<SavedTraceFilterRow, 'id' | 'created_at' | 'updated_at'>;
    const duplicate = state.savedTraceFilters.find(
      (filter) =>
        filter.app_id === body.app_id &&
        filter.page === body.page &&
        filter.name === body.name,
    );

    if (duplicate) {
      return HttpResponse.json({ code: '23505' }, { status: 409 });
    }

    const inserted: SavedTraceFilterRow = {
      id: `saved-filter-${state.savedTraceFilters.length + 1}`,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: null,
      ...body,
    };

    state.savedTraceFilters.push(inserted);

    return HttpResponse.json(projectSelectedFields(new URL(request.url), inserted), { status: 201 });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/saved_trace_filters`, async ({ request }) => {
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    // `app_id` is an optional extra `.eq()` narrowing on top of `id` —
    // PostgREST applies every filter a caller sends, so a
    // present-but-mismatched app_id must miss the row just like a bad id.
    const appId = getEqParam(url, 'app_id');
    const body = (await request.json()) as Partial<SavedTraceFilterRow>;
    const index = state.savedTraceFilters.findIndex(
      (filter) => filter.id === id && (appId ? filter.app_id === appId : true),
    );

    if (index === -1) {
      return HttpResponse.json({ code: 'PGRST116' }, { status: 406 });
    }

    if (body.name) {
      const conflict = state.savedTraceFilters.find(
        (filter) =>
          filter.id !== id &&
          filter.app_id === state.savedTraceFilters[index]?.app_id &&
          filter.page === state.savedTraceFilters[index]?.page &&
          filter.name === body.name,
      );
      if (conflict) {
        return HttpResponse.json({ code: '23505' }, { status: 409 });
      }
    }

    const existing = state.savedTraceFilters[index];
    if (!existing) {
      return HttpResponse.json({ code: 'PGRST116' }, { status: 406 });
    }

    const updated: SavedTraceFilterRow = {
      ...existing,
      ...body,
      updated_at: '2026-01-02T00:00:00Z',
    };
    state.savedTraceFilters[index] = updated;

    return HttpResponse.json(projectSelectedFields(url, updated));
  }),

  http.delete(`${SUPABASE_URL}/rest/v1/saved_trace_filters`, ({ request }) => {
    const url = new URL(request.url);
    const id = getEqParam(url, 'id');
    const appId = getEqParam(url, 'app_id');
    const index = state.savedTraceFilters.findIndex(
      (filter) => filter.id === id && (appId ? filter.app_id === appId : true),
    );

    if (index === -1) {
      return HttpResponse.json({ code: 'PGRST116' }, { status: 406 });
    }

    const [deleted] = state.savedTraceFilters.splice(index, 1);
    return HttpResponse.json(projectSelectedFields(url, { id: deleted?.id }));
  }),

  http.get(`${SUPABASE_URL}/rest/v1/tenant_entitlement_override`, ({ request }) => {
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const entitlementKey = getEqParam(url, 'entitlement_key');
    const rows = state.tenantEntitlementOverrides.filter(
      (row) =>
        (tenantId ? row.tenant_id === tenantId : true) &&
        (entitlementKey ? row.entitlement_key === entitlementKey : true),
    );

    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }

    return HttpResponse.json(rows);
  }),

  // PostgREST routes upserts through POST with the
  // `Prefer: resolution=merge-duplicates` header — supabase-js sends this
  // automatically for `.upsert()` calls. We don't differentiate between
  // insert and upsert in MSW; both land here.
  http.post(`${SUPABASE_URL}/rest/v1/tenant_entitlement_override`, async ({ request }) => {
    if (state.tableErrors.override_upsert) {
      return HttpResponse.json(
        { message: state.tableErrors.override_upsert.message },
        { status: 503 },
      );
    }
    const raw = (await request.json()) as Partial<EntitlementOverrideUpsertCapture>;
    const captured: EntitlementOverrideUpsertCapture = {
      tenant_id: raw.tenant_id ?? '',
      entitlement_key: raw.entitlement_key ?? '',
      value: raw.value ?? { v: false },
      override_reason: raw.override_reason ?? null,
      created_by: raw.created_by ?? null,
    };
    state.upsertedEntitlementOverrides.push(captured);
    return HttpResponse.json({}, { status: 201 });
  }),

  http.delete(`${SUPABASE_URL}/rest/v1/tenant_entitlement_override`, ({ request }) => {
    if (state.tableErrors.override_delete) {
      return HttpResponse.json(
        { message: state.tableErrors.override_delete.message },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const entitlementKey = getEqParam(url, 'entitlement_key');
    state.deletedEntitlementOverrides.push({
      tenant_id: tenantId ?? '',
      entitlement_key: entitlementKey ?? '',
    });
    return HttpResponse.json({}, { status: 204 });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/billing`, async ({ request }) => {
    if (state.tableErrors.billing_update) {
      return HttpResponse.json(
        { message: state.tableErrors.billing_update.message },
        { status: 503 },
      );
    }
    const url = new URL(request.url);
    const tenantId = getEqParam(url, 'tenant_id');
    const body = (await request.json()) as { tier_id?: string };
    state.updatedBilling.push({
      tenant_id: tenantId ?? '',
      tier_id: body.tier_id ?? '',
    });
    return HttpResponse.json({}, { status: 204 });
  }),
];
