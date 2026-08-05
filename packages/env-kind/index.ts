/**
 * Environment KIND — the single source of truth shared by the dashboard (UI
 * read-source / writability rules) and the gateway (the `allowed_env_kinds`
 * authorization boundary on API keys + env-var target resolution).
 *
 * This lives in its own zero-dependency package on purpose: the dashboard
 * imports it from client components, so it must not drag in any server-only
 * code, and the gateway authorizes cross-environment writes against it, so it
 * must not drift from a second copy. One module, two consumers.
 *
 * Two related-but-distinct vocabularies:
 *   - {@link EnvKind}       — what an environment IS (classification of a row).
 *   - {@link EnvTargetKind} — what an env var / API key can TARGET.
 * They differ only in `default` ↔ `development`: the default env's *kind* is
 * `default`, but its user-facing *target* name is `development` (Vercel
 * parlance, which is the mental model the product mirrors).
 */

// ---------------------------------------------------------------------------
// Classification — what an environment IS
// ---------------------------------------------------------------------------

/**
 * What an environment IS — mutually exclusive.
 *  - `default`  — tracks the connected branch HEAD; reads the LIVE table; writable.
 *  - `preview`  — ephemeral PR env; reads its SNAPSHOT; WRITABLE (publishes to the PR branch).
 *  - `promoted` — pinned to a promoted version; reads its SNAPSHOT; READ-ONLY.
 *  - `unknown`  — env ref didn't resolve (stale `?env=`, RLS-filtered, …). Never a target.
 */
export type EnvKind = "default" | "preview" | "promoted" | "unknown";

/** True for an ephemeral PR preview env. */
export function isPreviewEnv(env: { is_ephemeral?: boolean | null }): boolean {
  return env.is_ephemeral === true;
}

/**
 * True when an env is pinned to a promoted version. The pin
 * state is modeled as `current_version > 0` (0 == no-pin, tracks branch HEAD).
 */
export function isEnvPinned(env: { current_version: number }): boolean {
  return env.current_version > 0;
}

/**
 * Classify a resolved env row into its {@link EnvKind}. `preview` WINS over the
 * version proxy: a preview env has `current_version > 0` after its first deploy
 * yet is never part of the promote ladder, so it must not read as `promoted`.
 */
export function classifyEnvKind(env: {
  current_version: number;
  is_ephemeral?: boolean | null;
}): EnvKind {
  if (isPreviewEnv(env)) return "preview";
  if (isEnvPinned(env)) return "promoted";
  return "default";
}

// ---------------------------------------------------------------------------
// Targeting — what an env var / API key can TARGET
// ---------------------------------------------------------------------------

/**
 * The kinds an env var or API key can target. `development` is the user-facing
 * name for the `default` env kind. `unknown` is deliberately excluded — an
 * unresolved env is never a legitimate target.
 */
export type EnvTargetKind = "development" | "preview" | "promoted";

export const ENV_TARGET_KINDS: readonly EnvTargetKind[] = [
  "development",
  "preview",
  "promoted",
];

/**
 * Bridge a concrete env's {@link EnvKind} to its {@link EnvTargetKind}, i.e.
 * the bucket a targeting rule matches against. `default` → `development`;
 * `unknown` → `null` (nothing should resolve against an unknown env).
 */
export function envKindToTarget(kind: EnvKind): EnvTargetKind | null {
  switch (kind) {
    case "default":
      return "development";
    case "preview":
      return "preview";
    case "promoted":
      return "promoted";
    default:
      return null;
  }
}

/** Convenience: classify a row straight to its target bucket (or null). */
export function envTargetOf(env: {
  current_version: number;
  is_ephemeral?: boolean | null;
}): EnvTargetKind | null {
  return envKindToTarget(classifyEnvKind(env));
}

// ---------------------------------------------------------------------------
// Env-var target resolution (`all` + the three kinds)
// ---------------------------------------------------------------------------

/**
 * An `env_var` row targets either a single kind or `all` (the
 * convenience superset of every kind). A specific-environment override is NOT
 * a target kind — it's modeled by a non-null `environment_id` on the row and
 * always wins over any kind match (resolution precedence lives in the service).
 */
export type EnvVarTargetKind = "all" | EnvTargetKind;

export const ENV_VAR_TARGET_KINDS: readonly EnvVarTargetKind[] = [
  "all",
  ...ENV_TARGET_KINDS,
];

/** Does a row's target apply to an env of the given target bucket? */
export function envVarTargetMatches(
  target: EnvVarTargetKind,
  envTarget: EnvTargetKind,
): boolean {
  return target === "all" || target === envTarget;
}

/**
 * Precedence rank for a kind target when merging rows for one key (higher wins).
 * A specific-environment row outranks all of these and is handled separately.
 *   exact kind (3) > `all` (1). Used to pick a single winning value per key.
 */
export function envVarTargetRank(target: EnvVarTargetKind): number {
  return target === "all" ? 1 : 3;
}

/** An `env_var` row, reduced to the fields resolution needs. */
export interface EnvVarRowLike {
  key: string;
  /** Set on a kind-targeted row; null on a specific-environment row. */
  target_kind: EnvVarTargetKind | null;
  /** Set on a specific-environment row; null on a kind-targeted row. */
  environment_id: string | null;
}

/** Precedence rank of a single candidate row (higher wins). A specific-env row
 *  (4) always beats any kind row; among kind rows, an exact kind (3) beats
 *  `all` (1). Rows that don't apply to the target env are never passed here. */
function envVarRowRank(row: EnvVarRowLike): number {
  if (row.environment_id != null) return 4;
  return row.target_kind != null ? envVarTargetRank(row.target_kind) : 0;
}

/**
 * Resolve the winning `env_var` row per key for a concrete
 * environment, applying most-specific-wins precedence:
 *
 *   specific environment_id == envId  (4)
 *     > exact kind == envTarget        (3)
 *       > `all`                        (1)
 *
 * `rows` is every candidate row for the app (the caller fetches
 * `environment_id == envId OR target_kind IS NOT NULL`). Rows that don't apply
 * to this env — a specific row for a different env, or a kind row whose target
 * doesn't match `envTarget` — are dropped. Overlap is intentional and resolved
 * here (an `all` default plus a `preview` override is the whole point); ties on
 * rank cannot occur because the two partial unique indexes forbid duplicate
 * (app,key,env) and (app,key,kind) rows. Returns one row per key — the caller
 * then reads each winner's secret value.
 */
export function resolveEnvVarRows<T extends EnvVarRowLike>(
  rows: readonly T[],
  envId: string,
  envTarget: EnvTargetKind | null,
): T[] {
  const winnerByKey = new Map<string, T>();
  for (const row of rows) {
    const applies =
      row.environment_id === envId ||
      (row.environment_id == null &&
        row.target_kind != null &&
        envTarget != null &&
        envVarTargetMatches(row.target_kind, envTarget));
    if (!applies) continue;

    const current = winnerByKey.get(row.key);
    if (current == null || envVarRowRank(row) > envVarRowRank(current)) {
      winnerByKey.set(row.key, row);
    }
  }
  return [...winnerByKey.values()];
}

// ---------------------------------------------------------------------------
// Vault secret naming — the ONE scheme the dashboard write path
// (`EnvVarService`) and the gateway deployment-build read path
// (`GatewayManagedBuildService`) must agree on byte-for-byte. They live in
// separate apps; a one-character drift means the dashboard writes a secret
// the deployed agent can never read (silent missing-credential at runtime).
// Centralized here so the two sides are provably the same string.
// ---------------------------------------------------------------------------

/** A resolved env-var scope: a specific environment XOR a target kind. */
export type EnvVarVaultScope =
  | { environmentId: string; targetKind?: undefined }
  | { targetKind: EnvVarTargetKind; environmentId?: undefined };

/** Vault secret name for an environment-scoped value. */
export function envVarEnvVaultName(
  appId: string,
  environmentId: string,
  key: string,
): string {
  return `env_${appId}_${environmentId}_${key}`;
}

/** Vault secret name for a kind-targeted value. */
export function envVarKindVaultName(
  appId: string,
  kind: EnvVarTargetKind,
  key: string,
): string {
  return `env_${appId}_kind_${kind}_${key}`;
}

/**
 * Pre-055 legacy app-scoped Vault name. Read-only fallback for migrated rows
 * whose secret was never renamed; never written by current code.
 */
export function envVarLegacyVaultName(appId: string, key: string): string {
  return `env_${appId}_${key}`;
}

/** Vault secret name for any {@link EnvVarVaultScope}. */
export function envVarVaultName(
  appId: string,
  scope: EnvVarVaultScope,
  key: string,
): string {
  return scope.environmentId != null
    ? envVarEnvVaultName(appId, scope.environmentId, key)
    : envVarKindVaultName(appId, scope.targetKind, key);
}
