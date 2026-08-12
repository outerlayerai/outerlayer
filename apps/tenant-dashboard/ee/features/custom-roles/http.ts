import 'server-only';

/**
 * REST-shape adapter over the custom-role `authorizedAction`s. The `route.ts`
 * shims under `src/app/api/orgs/[orgName]/custom-roles/**` run body/query
 * validation through `withApi` (using this feature's own zod schemas) and
 * hand the parsed input here — this module then calls the same actions the
 * settings UI does, so auth, permission gating, and the `custom_roles`
 * entitlement check all run exactly once, in one place. Its only job is
 * unwrapping the two result layers an action call returns (the action
 * wrapper's `ActionResult`, and the service's own `{ success, data }`
 * envelope) into one HTTP response.
 */

import { NextResponse } from 'next/server';
import type { ActionResult } from '@/lib/action-kit/result';
import { actionResultToResponse } from '@/lib/api/action-result';
import { structuredError } from '@/lib/api/error-envelope';
import type { CreateCustomRoleInput, UpdateCustomRoleInput } from '@/types/custom-role';
import {
  listCustomRolesAction,
  getCustomRoleAction,
  createCustomRoleAction,
  updateCustomRoleAction,
  deleteCustomRoleAction,
} from './actions';

/** Mirrors `CustomRoleService`'s own result shape (`./custom-role-service.ts`). */
type ServiceEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: string; entitlement?: unknown };

/**
 * A `success: false` envelope reaching here passed authentication and the
 * `custom_role.*` permission check but failed a business rule or the
 * `custom_roles` entitlement gate — both need an explicit HTTP status rather
 * than the action wrapper's generic 200. `entitlement_denied` fails closed
 * with 403 so an unlicensed caller can never mutate custom roles over the API,
 * matching the settings UI's upgrade-gated dialogs.
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

export async function listCustomRoles(): Promise<Response> {
  return respond(await listCustomRolesAction({}));
}

export async function createCustomRole(body: CreateCustomRoleInput): Promise<Response> {
  return respond(await createCustomRoleAction(body), 201);
}

export async function getCustomRole(roleId: string): Promise<Response> {
  return respond(await getCustomRoleAction({ roleId }));
}

export async function updateCustomRole(roleId: string, body: UpdateCustomRoleInput): Promise<Response> {
  return respond(await updateCustomRoleAction({ roleId, ...body }));
}

export async function deleteCustomRole(roleId: string, fallbackRole?: string): Promise<Response> {
  return respond(await deleteCustomRoleAction({ roleId, fallbackRole }));
}
