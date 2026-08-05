/**
 * useSelectedEnv — resolves the env currently scoped by the breadcrumb env
 * selector.
 *
 * This hook is a thin re-projection of `EnvContext` — the
 * single source of truth for the selected environment. The selection still
 * lives in the `?env=<name>` URL query param (the shareable-URL contract);
 * `EnvContext` owns reading/persisting that param. This hook exists so the
 * many existing callers (traces/scores/sessions/templates query scoping)
 * keep working unchanged while there is exactly one place that resolves the
 * selection.
 *
 * The returned object preserves the historical shape — `name`, `id`,
 * `isPinned`, `pinnedVersion`, `isDefault`, `isUnknown` — so callers that
 * only need the env *name* for query scoping can use `name` immediately
 * without waiting on the env list, exactly as before.
 */

import {
  useEnvContext,
  DEFAULT_ENV_NAME,
  type EnvSelection,
} from '@/context/env-context';

/**
 * Default env name seeded on every app at creation time.
 *
 * `@/context/env-context` is the canonical home; this re-export is a stable
 * import path for callers that reach for the constant here. No in-app module
 * imports it from this path today — the breadcrumb env segment goes to
 * `@/context/env-context` directly — so it trips `import/no-unused-modules`
 * and the gate is disabled on this line.
 */
// eslint-disable-next-line import/no-unused-modules
export { DEFAULT_ENV_NAME };

/**
 * Resolved env-selection shape. The canonical definition lives on `EnvContext`
 * as `EnvSelection`; callers that need the type should import `EnvSelection`.
 * Kept local (not re-exported) until a consumer references it by this name.
 */
type SelectedEnv = EnvSelection;

/**
 * Resolve the breadcrumb-selected environment.
 *
 * @param _appId - retained for call-site compatibility. The selected env is
 *   owned by `EnvContext`, which derives the app from `AppContext`, so
 *   this argument is not read. Existing callers pass it; keeping the
 *   parameter avoids a churny signature change across ~6 files.
 */
export function useSelectedEnv(_appId?: string): SelectedEnv {
  return useEnvContext().selectedEnv;
}
