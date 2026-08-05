/**
 * Environment types.
 *
 * Wire-format shapes returned by the gateway `/v1/environments/*` routes per
 * [contracts/environments-api.md]. Field names are snake_case because they
 * come straight off the gateway response envelope; the dashboard's hook layer
 * surfaces them unchanged so we keep one source of truth across server +
 * client.
 *
 * The service-layer cousin is `@repo/environments-service`'s `Environment`,
 * which is the FULL `environment` table row (snake_case, with `tenant_id` /
 * `app_id` / audit columns). The types here are deliberately distinct: they
 * are the gateway WIRE shape consumed by the dashboard's SWR hooks — a subset
 * of the DB row, plus client-only extras like `api_key_creation_url`. They are
 * transport types, not domain types, so they stay app-local (not in the
 * shared package).
 *
 * There are no deployment-as-audit-log saga types here (`DeploymentSagaRow`,
 * `SagaResponseEnvelope`): env-promotion isn't driven through a saga, and
 * there is no `deployment` table. `cascade_preview` and `in_flight_saga_id`
 * still exist on {@link EnvironmentDetail} because the gateway's wire
 * contract is unchanged — the gateway returns them frozen at `0` / `null`
 * respectively.
 */

import { classifyEnvKind, type EnvKind } from "@repo/env-kind";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Shape returned by `GET /v1/environments` (one element of `data[]`).
 * The detail endpoint `GET /v1/environments/:id` returns the same fields
 * plus `api_key_count`, `in_flight_saga_id`, `updated_at` — modeled as
 * `EnvironmentDetail` below.
 */
export interface Environment {
  id: string;
  name: string;
  is_default: boolean;
  /**
   * The monotonic deployment-version counter. `0` means the env
   * is in the no-pin state (tracks branch HEAD); `> 0` means it is pinned to
   * that promoted version.
   */
  current_version: number;
  /**
   * The git commit SHA the env is pinned to. NULL for a no-pin env.
   * `current_commit_sha` is a plain denormalized column — there is no
   * `deployment` table or `latest_deployment_id` FK to join through.
   */
  current_commit_sha: string | null;
  /**
   * Ephemeral PR preview env — branch-backed, auto-torn-down.
   * Optional: absent on responses from a gateway predating this field (same
   * rollout-defensive stance as `current_version`).
   */
  is_ephemeral?: boolean;
  /** PR number this ephemeral env previews; null/absent for normal envs. */
  source_pr_number?: number | null;
  epoch: number;
  created_at: string;
  created_by_id: string | null;
}

/**
 * Environment classification (`EnvKind`, `classifyEnvKind`, `isEnvPinned`,
 * `isPreviewEnv`) lives in the zero-dependency `@repo/env-kind` package so the
 * gateway can authorize `allowed_env_kinds` against the SAME logic the UI uses
 * for its read-source / writability rules — one classifier, no drift.
 * `classifyEnvKind` is re-exported here so existing `@/types/environment`
 * import sites are unchanged; the `isEnvPinned` / `isPreviewEnv` predicates
 * are imported straight from `@repo/env-kind` by their call sites.
 */
export { classifyEnvKind };
export type { EnvKind };

/** Resolve an {@link EnvKind} from a bare kind or anything carrying one (an
 *  `EnvSelection`, an `EnvContentScope`, …) so the predicates below read
 *  cleanly at every call site: `envIsWritable(selectedEnv)`. */
type HasKind = EnvKind | { kind: EnvKind };
function kindOf(env: HasKind): EnvKind {
  return typeof env === "string" ? env : env.kind;
}

/**
 * The env's content comes from a frozen versioned SNAPSHOT (its
 * `current_version`), not the live `template` table. True for `preview` AND
 * `promoted`; false for `default`. This is the "read source" axis — distinct
 * from {@link envIsReadOnly}. Use this instead of re-inlining
 * `pinnedVersion !== null` (the inline form is how preview envs got read as the
 * wrong branch).
 */
export function envReadsSnapshot(env: HasKind): boolean {
  const k = kindOf(env);
  return k === "preview" || k === "promoted";
}

/**
 * The env's content is READ-ONLY (no edits / publishes). ONLY `promoted` envs —
 * `preview` and `default` are both writable. The "writability" axis, distinct
 * from {@link envReadsSnapshot}: keeping them separate is the whole point of
 * {@link EnvKind}. Use this instead of `selectedEnv.isPinned`.
 */
export function envIsReadOnly(env: HasKind): boolean {
  return kindOf(env) === "promoted";
}

/** Inverse of {@link envIsReadOnly}: content can be edited / published.
 *  `default` and `preview`. Use instead of `!selectedEnv.isPinned`. */
export function envIsWritable(env: HasKind): boolean {
  return !envIsReadOnly(env);
}

/** True for an ephemeral PR preview env. The kind-aware companion to
 *  {@link isPreviewEnv} (which takes a raw row); use this on a resolved env that
 *  already carries `kind`, instead of a separate `isEphemeral` boolean. */
export function envIsPreview(env: HasKind): boolean {
  return kindOf(env) === "preview";
}

/**
 * Cascade-delete preview returned by `GET /v1/environments/:id` (the
 * `cascade_preview` field). Counts the resources a delete will sweep so the
 * delete dialog can list everything the delete will remove. Field names are
 * the gateway's `*_count` wire names.
 *
 * Not exported — only referenced by `EnvironmentDetail` in this module;
 * consumers read it via `EnvironmentDetail['cascade_preview']` inference.
 */
interface CascadePreview {
  api_key_count: number;
  alert_count: number;
  deployment_count: number;
}

/**
 * Extended shape returned by `GET /v1/environments/:id` per contracts/
 * environments-api.md §"GET /v1/environments/:id". Adds the cascade-preview
 * fields and the in-flight saga indicator used by the env detail page.
 */
export interface EnvironmentDetail extends Environment {
  /** ID of an in-flight promotion saga if one exists, else null. */
  in_flight_saga_id: string | null;
  updated_at: string | null;
  /**
   * Resource counts a delete would cascade — see {@link CascadePreview}. The
   * bound-api-key count lives here (`cascade_preview.api_key_count`); the
   * gateway does NOT return a top-level `api_key_count` (verified against the
   * `GET /v1/environments/:id` response builder + generated spec).
   */
  cascade_preview?: CascadePreview;
}
