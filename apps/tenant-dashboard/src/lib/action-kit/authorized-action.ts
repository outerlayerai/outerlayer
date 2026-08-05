/**
 * `authorizedAction` — the single wrapper every Server Action mutation goes
 * through. The action body becomes thin glue; this HOF owns the fixed,
 * reviewable shape:
 *
 *   1. validate input with a zod schema  → validation failure = `fail` (fieldErrors)
 *   2. resolve the `ServiceContext`       → identity/tenant/db for the request
 *   3. check the declared permission      → denial = `fail` (forbidden)
 *   4. call the handler (one service call)→ wrap its return in `ok`
 *   5. map any thrown error               → `fail` (internal); never leaks
 *
 * The two external seams — context resolution and the permission check — are
 * *injected* (`makeAuthorizedAction(deps)`), so the wrapper is fully unit-testable
 * with mocks and imports no Supabase. `authorizedAction` (the default export
 * binding) wires the not-yet-live placeholder seams; feature code imports it.
 */

import { z, type ZodType } from 'zod';

import { checkRequestPermission } from '@/lib/adapters';

import { ok, fail, ActionErrorCodes, type ActionResult } from './result';
import {
  resolveServiceContext,
  type Actor,
  type ResolveServiceContext,
  type ServiceContext,
} from './service-context';

// Re-exported so `authorized-action.test.ts` (and any other direct importer)
// keeps one import source; `./result` is the actual, dependency-free home.
export { ActionErrorCodes };

/**
 * Throw from a handler to deny with the `forbidden` code rather than
 * `internal_error` — for an authorization-class denial the wrapper's own
 * step 3 permission check can't express (e.g. a plan-entitlement gate
 * checked mid-handler, after the DB permission already passed). Any other
 * thrown error still maps to `internal_error`, unchanged.
 */
export class ActionForbiddenError extends Error {}

/**
 * The authorization seam: does this actor hold this permission? An `appId`
 * narrows an app-scoped permission to one app (the DB `app_authorize` check);
 * omitting it is the org-scoped check.
 */
export interface PermissionChecker {
  check(actor: Actor, permission: string, appId?: string): Promise<boolean> | boolean;
}

/** External dependencies the wrapper is built over — injected for testability. */
interface AuthorizedActionDeps {
  resolveContext: ResolveServiceContext;
  permissions: PermissionChecker;
}

/**
 * What `onDenied` receives about the request besides the parsed input: the
 * resolved tenant and the acting user's id. Identifiers only — no `db`, no
 * query capability — so a denial handler can attribute an audit row but
 * cannot read or write anything on the denial path.
 */
export interface DeniedContext {
  tenantId: ServiceContext['tenantId'];
  actorId: Actor['userId'];
}

/** Per-action configuration. */
interface AuthorizedActionConfig<TInput, TOutput> {
  /** Zod schema; the raw action argument is validated against it. */
  input: ZodType<TInput>;
  /** Declared permission checked against the resolved actor. */
  permission: string;
  /**
   * For an app-scoped permission, derives the target app id from the parsed
   * input so the check narrows to that app. Omit for an org-scoped permission.
   */
  appId?: (input: TInput) => string;
  /**
   * Side effect to run when the permission check denies. Supplied only by
   * actions whose denials are themselves auditable events. Its failures are
   * swallowed: an audit problem must never turn a denial into a server error.
   *
   * Receives the resolved tenant and actor id alongside the parsed input —
   * enough to write an attributed audit row — but deliberately NOT `ctx`
   * itself: handing over the context would let a denial handler run
   * tenant-scoped queries on the denial path, which is a bigger surface than
   * "record that this happened" needs.
   */
  onDenied?: (input: TInput, denied: DeniedContext) => Promise<void> | void;
  /** The one service call. Receives the resolved context and the parsed input. */
  handler: (ctx: ServiceContext, input: TInput) => Promise<TOutput> | TOutput;
}

/** A wrapped action: takes the raw (unvalidated) argument, always resolves to an `ActionResult`. */
type Action<TOutput> = (raw: unknown) => Promise<ActionResult<TOutput>>;

/**
 * Build an `authorizedAction` bound to concrete seams. Tests pass mocked deps;
 * production binds the real (later-wired) resolver and permission checker.
 */
export function makeAuthorizedAction(deps: AuthorizedActionDeps) {
  return function authorizedAction<TInput, TOutput>(
    config: AuthorizedActionConfig<TInput, TOutput>,
  ): Action<TOutput> {
    return async (raw: unknown): Promise<ActionResult<TOutput>> => {
      // 1. Validate before touching any seam — invalid input never resolves a
      //    context or runs the handler.
      const parsed = config.input.safeParse(raw);
      if (!parsed.success) {
        return fail({
          code: ActionErrorCodes.VALIDATION,
          message: 'Input validation failed',
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }

      try {
        // 2. Resolve identity/tenant/db for this request.
        const ctx = await deps.resolveContext();

        // 3. Authorize. A denial short-circuits before the handler runs. An
        //    app-scoped action narrows the check to its target app.
        const appId = config.appId?.(parsed.data);
        const allowed = await deps.permissions.check(ctx.actor, config.permission, appId);
        if (!allowed) {
          if (config.onDenied) {
            try {
              await config.onDenied(parsed.data, { tenantId: ctx.tenantId, actorId: ctx.actor.userId });
            } catch {
              // An audit hiccup must never turn a clean denial into a server error.
            }
          }
          return fail({
            code: ActionErrorCodes.FORBIDDEN,
            message: `Permission denied: ${config.permission}`,
          });
        }

        // 4. One service call; wrap its return.
        const data = await config.handler(ctx, parsed.data);
        return ok(data);
      } catch (err) {
        // 5. No exception crosses the action boundary.
        if (err instanceof ActionForbiddenError) {
          return fail({ code: ActionErrorCodes.FORBIDDEN, message: err.message });
        }
        return fail({
          code: ActionErrorCodes.INTERNAL,
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    };
  };
}

/**
 * Default binding feature code imports. Both seams resolve the request's URL
 * tenant and answer under the DB's membership-checked authorization; the seam
 * stays fail-closed for any actor/tenant the DB denies.
 */
export const authorizedAction = makeAuthorizedAction({
  resolveContext: resolveServiceContext,
  permissions: { check: checkRequestPermission },
});
