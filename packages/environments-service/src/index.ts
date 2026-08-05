/**
 * @repo/environments-service
 *
 * Shared Environments domain logic — env lifecycle.
 *
 * Used by both the cloud gateway (Cloudflare Worker) and the tenant dashboard
 * (Next.js). Consumers wire their own dependencies in their composition root:
 * a Supabase client and an optional {@link CheckEnvLimitFn} entitlement source.
 *
 * **An environment owns no runtime.** It is a scoping record — a name, its API
 * keys, env vars, webhooks, and the tenant/app boundary its traces and RLS hang
 * off. Nothing is provisioned when one is created and nothing is torn down when
 * one is deleted, so create and delete are each a single database write.
 *
 * **Scope contract**: every service takes its
 * dependencies via constructor DI — this package has no implicit clients and
 * no Node built-ins, so it bundles cleanly into the Cloudflare Workers runtime.
 *
 * **Scope**: env lifecycle only — there is no promote/rollback orchestrator
 * and no env-promotion snapshot carry-forward here. `getInFlightSaga` is
 * frozen at `null` and `computeCascade().deployments_deleted` is frozen at
 * `0`, because the `deployment` table they would read does not exist.
 */

// --- Environment lifecycle --------------------------------------------------
export { EnvironmentService } from './environment-service';
export type {
  Environment,
  EnvironmentServiceDeps,
  CreateDefaultEnvironmentInput,
  CreateEnvironmentInput,
  CreateEnvironmentResult,
  DeleteEnvironmentInput,
  DeleteEnvironmentCascade,
  DeleteEnvironmentResult,
  CheckEnvLimitFn,
  EnvLimitCheckInput,
  EnvLimitCheckResult,
} from './environment-service';

// --- Pure domain helpers ----------------------------------------------------
export { validateEnvironmentName, ENV_NAME_PATTERN } from './validate-environment-name';
export type { EnvironmentNameValidation } from './validate-environment-name';
