/**
 * `preTenantAction` — the wrapper for a Server Action that authenticates but
 * deliberately has no tenant to scope to. A sibling of `authorizedAction`, not
 * a mode of it: the two hand the handler genuinely different things (one a
 * tenant-scoped `db`, the other neither), so sharing an implementation behind
 * a discriminant would make every read of `authorizedAction` a read of both
 * paths.
 *
 *   1. validate input with a zod schema → validation failure = `fail` (fieldErrors)
 *   2. resolve the authenticated actor   → unresolved = `fail` (unauthenticated)
 *   3. call the handler with (actor, parsedInput) → wrap its return in `ok`
 *   4. map any thrown error              → `fail` (internal); never leaks
 *
 * The actor seam is injected (`makePreTenantAction(deps)`), so the wrapper is
 * fully unit-testable with mocks and imports no Supabase.
 */

import { z, type ZodType } from 'zod';

import { loadPreTenantActor } from '@/lib/adapters';

import { ok, fail, ActionErrorCodes, type ActionResult } from './result';

/**
 * The reason an action legitimately has no tenant scope. A closed union, not
 * free text: adding a reason is a reviewable diff in this file, and every
 * existing reason is greppable across the repo.
 */
type PreTenantReason =
  /** The actor has no tenant yet; this action is how one comes to exist. */
  | 'no-tenant-yet'
  /** The actor's membership in the target tenant is not active yet. */
  | 'pending-membership'
  /** The actor acts across tenants rather than within one. */
  | 'cross-tenant'
  /** The subject is the user themselves, not any tenant. */
  | 'user-scoped';

/** The authenticated identity, with deliberately no tenant and no `db`. */
export interface PreTenantActor {
  userId: string;
  email: string | null;
  /**
   * The verified auth user, for the legacy service signatures that take it
   * whole. Widened to `unknown` so action-kit commits to no Supabase types —
   * the same treatment `ServiceContext.db` gets; cast at the call site.
   */
  raw: unknown;
}

/**
 * The actor-resolution seam: the authenticated identity for this request, or
 * `null` if there isn't one. Injected into the wrapper so it can be mocked in
 * unit tests with no Supabase or auth.
 */
export type ResolvePreTenantActor = () => Promise<PreTenantActor | null>;

/** External dependencies the wrapper is built over — injected for testability. */
interface PreTenantActionDeps {
  resolveActor: ResolvePreTenantActor;
}

/** Per-action configuration. */
interface PreTenantActionConfig<TInput, TOutput> {
  /** Zod schema; the raw action argument is validated against it. */
  input: ZodType<TInput>;
  /** Required. Why this action has no tenant scope. */
  reason: PreTenantReason;
  /** The one service call. Receives the resolved actor and the parsed input. */
  handler: (actor: PreTenantActor, input: TInput) => Promise<TOutput> | TOutput;
}

/** A wrapped action: takes the raw (unvalidated) argument, always resolves to an `ActionResult`. */
type Action<TOutput> = (raw: unknown) => Promise<ActionResult<TOutput>>;

/**
 * Build a `preTenantAction` bound to a concrete actor seam. Tests pass a
 * mocked resolver; production binds the real request-bound one.
 */
export function makePreTenantAction(deps: PreTenantActionDeps) {
  return function preTenantAction<TInput, TOutput>(
    config: PreTenantActionConfig<TInput, TOutput>,
  ): Action<TOutput> {
    return async (raw: unknown): Promise<ActionResult<TOutput>> => {
      // 1. Validate before touching any seam — invalid input never resolves an
      //    actor or runs the handler.
      const parsed = config.input.safeParse(raw);
      if (!parsed.success) {
        return fail({
          code: ActionErrorCodes.VALIDATION,
          message: 'Input validation failed',
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }

      try {
        // 2. Resolve the authenticated identity. No tenant is resolved or
        //    checked — that is the point of this wrapper.
        const actor = await deps.resolveActor();
        if (!actor) {
          return fail({
            code: ActionErrorCodes.UNAUTHENTICATED,
            message: 'Not authenticated',
          });
        }

        // 3. One service call; wrap its return. The handler never receives a
        //    db or tenantId — a tenant-scoped need belongs in authorizedAction.
        const data = await config.handler(actor, parsed.data);
        return ok(data);
      } catch (err) {
        // 4. No exception crosses the action boundary.
        return fail({
          code: ActionErrorCodes.INTERNAL,
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    };
  };
}

/**
 * Default binding feature code imports. Resolves the authenticated user with
 * no tenant argument, so the underlying client sends no tenant scope header.
 * The `loadPreTenantActor` binding is read inside this closure, at call time,
 * rather than assigned directly here at module init — this module's static
 * import of `@/lib/adapters` still evaluates that module (and its transitive
 * imports) the moment this file loads, same as any import. What the closure
 * defers is only the *read* of the `loadPreTenantActor` export, so a test that
 * mocks the `@/lib/action-kit` barrel without declaring that export doesn't
 * fail just by importing this module — only if it actually invokes an action
 * built on this binding.
 */
export const preTenantAction = makePreTenantAction({
  resolveActor: () => loadPreTenantActor(),
});
