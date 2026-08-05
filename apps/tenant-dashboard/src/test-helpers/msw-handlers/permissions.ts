import { http, HttpResponse } from 'msw';

/**
 * MSW handlers for the Supabase permission RPCs that `utils/permission-check.ts`
 * invokes via the server client:
 *
 *   - `POST /rest/v1/rpc/authorize`     (body: { requested_permission })
 *   - `POST /rest/v1/rpc/app_authorize` (body: { requested_permission, target_app_id })
 *
 * Both RPCs return a single boolean (PostgREST serialises a SQL function's
 * scalar result as the bare value), so the handler responds with `true` or
 * `false`. Tests seed the allow-list per RPC; an empty allow-list denies.
 *
 * Errors can be simulated via `authorizeError` / `appAuthorizeError` for the
 * "RPC failed" branch of the handler under test.
 *
 * Why a separate file (and not added to supabase.ts):
 *   The permission RPCs are a distinct seam from CRUD tables — tests
 *   exercising authorization want to swap the allow-list per case without
 *   touching unrelated row state. Co-locating with supabase.ts would couple
 *   them to a much larger shared-state surface.
 */

const SUPABASE_URL = 'http://localhost:54321';

export interface PermissionsMswState {
  /** Permissions returned `true` from the `authorize(perm)` RPC. */
  allowedPermissions: string[];
  /**
   * Per-app permissions returned `true` from `app_authorize(perm, app_id)`.
   * Map shape: `{ [appId]: ['perm.a', 'perm.b'] }`.
   */
  allowedAppPermissions: Record<string, string[]>;
  /**
   * When set, `authorize` RPC returns this error instead of a boolean,
   * exercising the "permissionError" branch in the handler under test.
   */
  authorizeError: { message: string; code?: string } | null;
  /**
   * When set, `app_authorize` RPC returns this error instead of a boolean.
   */
  appAuthorizeError: { message: string; code?: string } | null;
  /**
   * When set, the `get_current_user_app_permissions` RPC returns this error
   * instead of a permission array (exercises the fail-closed branch of the
   * `getAppPermissionSet` helper).
   */
  appPermissionsError: { message: string; code?: string } | null;
}

let state: PermissionsMswState = freshState();

function freshState(): PermissionsMswState {
  return {
    allowedPermissions: [],
    allowedAppPermissions: {},
    authorizeError: null,
    appAuthorizeError: null,
    appPermissionsError: null,
  };
}

export function resetPermissionsMswState(): void {
  state = freshState();
  authorizeCalls.length = 0;
  appAuthorizeCalls.length = 0;
}

export function seedPermissionsMswState(
  next: Partial<PermissionsMswState>,
): void {
  state = { ...state, ...next };
}

/**
 * Captures of each RPC invocation — tests can assert that the handler
 * forwarded the right `target_app_id` to `app_authorize` (the bug class
 * "tenant A passes app B's id to bypass per-app scoping").
 */
interface AuthorizeCall {
  requested_permission: string;
}
interface AppAuthorizeCall {
  requested_permission: string;
  target_app_id: string;
}

const authorizeCalls: AuthorizeCall[] = [];
const appAuthorizeCalls: AppAuthorizeCall[] = [];

export function getAuthorizeCalls(): readonly AuthorizeCall[] {
  return authorizeCalls;
}
export function getAppAuthorizeCalls(): readonly AppAuthorizeCall[] {
  return appAuthorizeCalls;
}

export const permissionsHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/authorize`, async ({ request }) => {
    const body = (await request.json()) as { requested_permission?: string };
    authorizeCalls.push({
      requested_permission: body.requested_permission ?? '',
    });

    if (state.authorizeError) {
      return HttpResponse.json(
        {
          message: state.authorizeError.message,
          code: state.authorizeError.code ?? 'P0001',
        },
        { status: 400 },
      );
    }

    const granted = state.allowedPermissions.includes(
      body.requested_permission ?? '',
    );
    return HttpResponse.json(granted);
  }),

  http.post(
    `${SUPABASE_URL}/rest/v1/rpc/app_authorize`,
    async ({ request }) => {
      const body = (await request.json()) as {
        requested_permission?: string;
        target_app_id?: string;
      };
      appAuthorizeCalls.push({
        requested_permission: body.requested_permission ?? '',
        target_app_id: body.target_app_id ?? '',
      });

      if (state.appAuthorizeError) {
        return HttpResponse.json(
          {
            message: state.appAuthorizeError.message,
            code: state.appAuthorizeError.code ?? 'P0001',
          },
          { status: 400 },
        );
      }

      const appId = body.target_app_id ?? '';
      const grantedForApp = state.allowedAppPermissions[appId] ?? [];
      const granted = grantedForApp.includes(body.requested_permission ?? '');
      return HttpResponse.json(granted);
    },
  ),

  // get_current_user_app_permissions(target_app_id) — the set-returning sibling
  // of app_authorize. PostgREST serialises a SETOF scalar as a flat JSON array,
  // so the handler returns the seeded per-app permission list (same allow-list
  // app_authorize reads). An unseeded app → [].
  http.post(
    `${SUPABASE_URL}/rest/v1/rpc/get_current_user_app_permissions`,
    async ({ request }) => {
      const body = (await request.json()) as { target_app_id?: string };

      if (state.appPermissionsError) {
        return HttpResponse.json(
          {
            message: state.appPermissionsError.message,
            code: state.appPermissionsError.code ?? 'P0001',
          },
          { status: 400 },
        );
      }

      const appId = body.target_app_id ?? '';
      return HttpResponse.json(state.allowedAppPermissions[appId] ?? []);
    },
  ),
];
