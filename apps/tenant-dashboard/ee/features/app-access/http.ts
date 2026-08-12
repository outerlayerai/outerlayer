import 'server-only';

/**
 * REST-shape adapter over the app-member-role `authorizedAction`s. The
 * `route.ts` shims under
 * `src/app/api/orgs/[orgName]/apps/[appId]/member-roles/**` run body/query
 * validation through `withApi` (using this feature's own zod schemas) and
 * hand the parsed input here — this module then calls the same actions the
 * settings UI does, so auth, permission gating, and the `app_level_roles`
 * entitlement check all run exactly once, in one place. Its only job is
 * unwrapping the two result layers an action call returns (the action
 * wrapper's `ActionResult`, and the service's own `{ success, data }`
 * envelope) into one HTTP response.
 *
 * `appId` is payload here, not the authz scope — assigning/revoking access TO
 * an app is an org-level operation on the target membership (see the same
 * note in `./actions.ts`), so it's threaded from the URL path into the
 * action's input rather than used to narrow the permission check.
 */

import { NextResponse } from 'next/server';
import type { ActionResult } from '@/lib/action-kit/result';
import { actionResultToResponse } from '@/lib/api/action-result';
import { structuredError } from '@/lib/api/error-envelope';
import type { AppMemberRole } from '@/types/app-member-role';
import type { AppMemberRoleRow as AppMemberRoleListRow } from '@/lib/system/app-access-reads';
import {
  listAppRolesAction,
  assignAppRoleAction,
  updateAppRoleAction,
  updateAppCustomRoleAction,
  revokeAppRoleAction,
} from './actions';

/** Mirrors `AppMemberRoleService`'s own result shape (`./app-member-role-service.ts`). */
type ServiceEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: string; entitlement?: unknown };

/**
 * A `success: false` envelope reaching here passed authentication and the
 * `app_member_role.*` permission check but failed a business rule (e.g. the
 * owner-protection check) or the `app_level_roles` entitlement gate — both
 * need an explicit HTTP status rather than the action wrapper's generic 200.
 * `entitlement_denied` fails closed with 403 so an unlicensed caller can never
 * mutate per-app roles over the API, matching the settings UI's
 * upgrade-gated dialogs.
 */
function respond<T>(result: ActionResult<ServiceEnvelope<T>>, successStatus = 200): Response {
  if (!result.ok) return actionResultToResponse(result);

  const envelope = result.data;
  if (!envelope.success) {
    if (envelope.error === 'entitlement_denied') {
      return NextResponse.json(
        structuredError('forbidden', 'This feature requires an upgraded plan', {
          reason: 'entitlement_denied',
          entitlement: envelope.entitlement,
        }),
        { status: 403 },
      );
    }
    return NextResponse.json(structuredError('invalid_field_value', envelope.error), { status: 400 });
  }

  return NextResponse.json(envelope.data, { status: successStatus });
}

/**
 * `listAppRolesAction` proxies `lib/system`'s enriched read (camelCase,
 * joined app name + member name/email — a different shape than the raw
 * `app_member_role` row the mutation actions return), and that read reports
 * a query failure as its own `{ error }` value rather than throwing — so
 * unlike the other actions here it isn't a `{ success, data }`
 * entitlement-checked envelope; it's a read with no entitlement gate.
 */
export async function listMemberRoles(appId: string, membershipId?: string): Promise<Response> {
  const result = await listAppRolesAction({ appId, membershipId });
  if (!result.ok) return actionResultToResponse(result);

  const listResult = result.data as { data: AppMemberRoleListRow[] } | { error: string };
  if ('error' in listResult) {
    return NextResponse.json(structuredError('internal_error', listResult.error), { status: 500 });
  }
  return NextResponse.json(listResult.data, { status: 200 });
}

export async function assignMemberRole(appId: string, membershipId: string, role: AppMemberRole): Promise<Response> {
  return respond(await assignAppRoleAction({ appId, membershipId, role }), 201);
}

export async function updateMemberRoleBuiltin(appMemberRoleId: string, role: AppMemberRole): Promise<Response> {
  return respond(await updateAppRoleAction({ appMemberRoleId, role }));
}

export async function updateMemberRoleCustom(appMemberRoleId: string, customRoleId: string): Promise<Response> {
  return respond(await updateAppCustomRoleAction({ appMemberRoleId, customRoleId }));
}

export async function revokeMemberRole(appMemberRoleId: string): Promise<Response> {
  return respond(await revokeAppRoleAction({ appMemberRoleId }));
}
