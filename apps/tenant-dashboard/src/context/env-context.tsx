'use client';

/**
 * EnvContext — the single source of truth for the environment selected in the
 * app breadcrumb.
 *
 * Responsibilities:
 *  - Own the selected environment for the current app.
 *  - Keep the `/env/<name>/` PATH SEGMENT the canonical store of the
 *    selection. The env is part of the route
 *    (`/orgs/<org>/apps/<app>/env/<name>/<tab>`), NOT a query param — so a
 *    shared URL reproduces the same scoped view, switching env remounts the
 *    page subtree, and env can never be silently dropped by a nav that
 *    rebuilds the query string.
 *  - `setEnv` rewrites the env path segment in place; `envPath` inserts the
 *    current env segment into a bare app path (used by the sidebar nav, whose
 *    items are built from env-less `appPaths.*` strings that cannot read
 *    context at build time).
 *  - Fall back to the app's default environment (`dev`, `is_default=true`,
 *    always no-pin) when the path carries no env segment (e.g. the brief
 *    window on the bare app root before it redirects into `/env/<default>`).
 *
 * The env list itself is sourced from the existing `useEnvironments` SWR hook
 * — this context does not re-fetch; it only owns the *selection* on top of
 * that list. `useSelectedEnv` reads the resolved selection from here so
 * there is exactly one source of truth.
 */

import { createContext, use, useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useEnvironments } from '@/hooks/environments/use-environments';
import { useAppContext } from '@/lib/app-shell/app-context';
import { APP_LEVEL_SEGMENTS } from '@/routes/paths';
import {
  classifyEnvKind,
  envIsReadOnly,
  envReadsSnapshot,
  type EnvKind,
  type Environment,
} from '@/types/environment';

/**
 * Default env name seeded on every app at creation time. The value lives in a
 * plain (server-safe) module — re-exported here so the many client callers
 * that import it from `@/context/env-context` keep working, while server
 * components import it directly from `@/lib/environments/default-env-name`
 * (importing a const out of this `'use client'` module into a server component
 * yields a client-reference stub, not the value).
 */
export { DEFAULT_ENV_NAME } from '@/lib/environments/default-env-name';
import { DEFAULT_ENV_NAME } from '@/lib/environments/default-env-name';

/**
 * Resolved environment-selection shape exposed by `useEnvContext()`.
 *
 * Mirrors the field set `useSelectedEnv` has always returned (`name`, `id`,
 * `isPinned`, `pinnedVersion`, `isDefault`, `isUnknown`) so that hook can be a
 * thin re-projection of this context without breaking its existing callers.
 */
export interface EnvSelection {
  /** Env name from the `/env/<name>/` path segment (or the `dev` fallback). Always present. */
  name: string;
  /** Env row id — null until the env list resolves / if the name is unknown. */
  id: string | null;
  /**
   * What the env IS (`default` | `preview` | `promoted` | `unknown`) — the
   * single source of truth. The booleans below are DERIVED from it via the
   * shared predicates (`envIsReadOnly`, `envReadsSnapshot`, …); prefer those
   * predicates at call sites over the raw booleans.
   */
  kind: EnvKind;
  /** Derived: content is read-only (`promoted` only). Prefer `envIsReadOnly`. */
  isPinned: boolean;
  /** The pinned version number, or null when no-pin / unresolved. */
  pinnedVersion: number | null;
  /**
   * The git commit SHA the env is pinned to (the `commit_sha` of the pinned
   * deployment). Null when no-pin / unresolved. Lets the pinned-env chip show
   * the real commit + a "View on git provider" deep link.
   */
  currentCommitSha: string | null;
  /** True when `name` is the app's default env (`dev`, always no-pin). */
  isDefault: boolean;
  /**
   * True for an ephemeral PR preview env. Publishing here pushes straight to the
   * preview branch (no new PR), so the publish UI doesn't ask for a branch name.
   */
  isEphemeral: boolean;
  /** True when the path's env name matches no current env. */
  isUnknown: boolean;
  /**
   * Where the `name` came from:
   *   - `'url'`     — an explicit `/env/<name>/` path segment (a share-link or
   *                   a manual selection that hasn't been navigated away from).
   *   - `'default'` — implicit fallback to {@link DEFAULT_ENV_NAME} because the
   *                   path carried no env segment.
   *
   * Used by UI surfaces to distinguish "the user picked an env that's gone"
   * (warn + redirect) from "the implicit default fallback can't be resolved
   * yet" (don't warn — the user never picked anything; show graceful state).
   * Without this, a freshly-created app whose env list hasn't seeded the
   * default `dev` row yet would shout "selected environment no longer
   * exists" at users who never selected anything.
   */
  nameSource: 'url' | 'default';
  /**
   * Machine cleanup state for the selected env, or null when the env list
   * hasn't loaded yet. Not currently rendered by any UI surface; retained on
   * the context for a future deployment surface.
   */
}

// Not exported until a consumer imports it by name — `useEnvContext()` callers
// get this type by inference. Exporting it now trips `import/no-unused-modules`.
interface EnvContextValue {
  /** The resolved selected environment. */
  selectedEnv: EnvSelection;
  /** The raw env list for the current app (from `useEnvironments`). */
  environments: Environment[] | undefined;
  /** True while the env list is still loading. */
  isLoading: boolean;
  /**
   * Switch the selected environment by name. Rewrites the `/env/<name>/` path
   * segment in place (preserving the tab + remaining path) without a full-page
   * reload, and drops the `page` pagination cursor.
   */
  setEnv: (name: string) => void;
  /**
   * Insert the current env segment into a bare app path. The sidebar nav
   * builds its items from env-less `appPaths.*` strings (it can't read context
   * at build time), so `useNavHref` routes each through this to produce the
   * env-scoped href. A path that already carries an `/env/<name>/` segment,
   * one that isn't an app-scoped path, or an app-level (env-less) surface
   * such as `appPaths.context` (see `APP_LEVEL_SEGMENTS`), is returned unchanged.
   */
  envPath: (path: string) => string;
}

const EnvContext = createContext<EnvContextValue | null>(null);

/**
 * Match the env segment of an app-scoped path:
 * `/orgs/<org>/apps/<app>/env/<envName>(/...)?`. Capture group 1 is the
 * `/orgs/<org>/apps/<app>/env/` prefix; group 2 is the env name.
 */
const ENV_SEGMENT_RE = /^(\/orgs\/[^/]+\/apps\/[^/]+\/env\/)([^/]+)/;

/** Match an app-scoped path with NO env segment yet (for `envPath` insertion). */
const APP_PREFIX_RE = /^(\/orgs\/[^/]+\/apps\/[^/]+)(\/.*)?$/;

/**
 * True when `rest` (the `APP_PREFIX_RE` capture after the app prefix, e.g.
 * `/context`) names an app-level, intentionally env-less surface. Shared by
 * `envPath` and `setEnv`'s insertion branch so the two can't drift.
 */
function isAppLevelPath(rest: string | undefined): boolean {
  const segment = rest?.split('/').filter(Boolean)[0];
  return segment != null && APP_LEVEL_SEGMENTS.has(segment);
}

/**
 * Resolve the `?env=` name against the env list into a full `EnvSelection`.
 * Pure — extracted so the provider's `useMemo` stays readable and so the
 * resolution logic has one home.
 */
function resolveSelection(
  name: string,
  environments: Environment[] | undefined,
  nameSource: 'url' | 'default',
): EnvSelection {
  const match = environments?.find((env) => env.name === name);
  if (!match) {
    return {
      name,
      id: null,
      kind: 'unknown',
      isPinned: false,
      pinnedVersion: null,
      currentCommitSha: null,
      // Without the list we cannot prove `name` is the default env, but the
      // `dev` fallback is the default for every freshly-seeded app — treat the
      // un-parameterized default name as default so legacy scoping holds
      // during the brief list-loading window.
      isDefault: name === DEFAULT_ENV_NAME,
      isEphemeral: false,
      // Only "unknown" once the list has actually resolved — a still-loading
      // list is not yet evidence the name is bogus.
      isUnknown: environments !== undefined,
      nameSource,
    };
  }
  // Classify ONCE into the canonical kind; derive every behavior boolean from
  // it via the shared predicates. The env wire shape exposes `current_version`
  // (0 == no-pin, > 0 == versioned) in place of the nullable
  // `pinned_version`.
  const kind = classifyEnvKind(match);
  return {
    name: match.name,
    id: match.id,
    kind,
    // Read-only (write block) and reads-snapshot (read source) are SEPARATE
    // axes — a preview env reads its snapshot yet stays writable. Never
    // re-inline these; derive from `kind`.
    isPinned: envIsReadOnly(kind),
    pinnedVersion: envReadsSnapshot(kind) ? match.current_version : null,
    currentCommitSha: envReadsSnapshot(kind) ? match.current_commit_sha : null,
    isDefault: match.is_default,
    isEphemeral: kind === 'preview',
    isUnknown: false,
    nameSource,
  };
}

export function EnvProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { app } = useAppContext();
  const appId = app?.id ?? '';

  const { data: environments, isLoading } = useEnvironments(appId);

  // Default-env-only posture: the multi-env UI (breadcrumb switcher, promotion)
  // is removed, so the selection is ALWAYS pinned to the app's default env and
  // any `/env/<name>/` path segment is ignored — a hand-typed `/env/<other>/`
  // URL renders as the default env rather than scoping the page to a hidden
  // env. `nameSource` is therefore always `'default'` (the name is the implicit
  // default, never a URL choice).
  const name = DEFAULT_ENV_NAME;
  const nameSource: 'url' | 'default' = 'default';

  const selectedEnv = useMemo(
    () => resolveSelection(name, environments, nameSource),
    [name, environments, nameSource],
  );

  const setEnv = useCallback(
    (next: string) => {
      // Rewrite the env segment in place, preserving the tab + rest of the
      // path. If the path somehow has no env segment, insert one after the
      // app prefix.
      const encoded = encodeURIComponent(next);
      let nextPath: string;
      if (ENV_SEGMENT_RE.test(pathname)) {
        nextPath = pathname.replace(ENV_SEGMENT_RE, `$1${encoded}`);
      } else {
        const m = APP_PREFIX_RE.exec(pathname);
        nextPath =
          m && !isAppLevelPath(m[2]) ? `${m[1]}/env/${encoded}${m[2] ?? ''}` : pathname;
      }
      // Switching env invalidates the current pagination cursor; preserve the
      // rest of the query string.
      const params = new URLSearchParams(searchParams.toString());
      params.delete('page');
      const query = params.toString();
      router.push(query ? `${nextPath}?${query}` : nextPath);
    },
    [router, pathname, searchParams],
  );

  const envPath = useCallback(
    (path: string) => {
      // Already env-scoped, or not an app path → leave untouched.
      if (ENV_SEGMENT_RE.test(path)) return path;
      const m = APP_PREFIX_RE.exec(path);
      if (!m) return path;
      // App-level surfaces (e.g. `appPaths.context`) intentionally carry no env
      // segment — injecting one produces a URL with no matching route.
      if (isAppLevelPath(m[2])) return path;
      return `${m[1]}/env/${encodeURIComponent(name)}${m[2] ?? ''}`;
    },
    [name],
  );

  const value = useMemo<EnvContextValue>(
    () => ({ selectedEnv, environments, isLoading, setEnv, envPath }),
    [selectedEnv, environments, isLoading, setEnv, envPath],
  );

  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
}

/**
 * Access the environment-selection context. Must be called inside an
 * `<EnvProvider>` — which the app-scoped layout mounts, so every page
 * inside an app has it.
 */
export function useEnvContext(): EnvContextValue {
  const ctx = use(EnvContext);
  if (ctx === null) {
    throw new Error('useEnvContext must be used within an <EnvProvider>');
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useEnvContext}: returns `null` instead of
 * throwing when no `<EnvProvider>` is mounted above the caller.
 *
 * Why this exists: the breadcrumb spine (`<AppBreadcrumb.EnvSelect>`) is
 * rendered by BOTH headers — `layouts/dashboard` (wrapped by `EnvProvider`
 * via `[appName]/layout.tsx`) and `layouts/app` (NOT wrapped). The
 * `layouts/app` header is mounted by the `loading.tsx` fallbacks
 * (`[orgName]/loading.tsx`, `apps/loading.tsx`) which Next.js renders while
 * navigating *into* an app route. At that moment `useParams().appName` is
 * already populated, so the breadcrumb would render `<EnvSelect>` and the
 * throwing `useEnvContext()` would crash the whole page into the route error
 * boundary ("Something went wrong" — never recovers). A loading skeleton has
 * no environment to offer anyway, so `<EnvSelect>` reads the context through
 * this accessor and renders `null` when it is absent.
 */
export function useOptionalEnvContext(): EnvContextValue | null {
  return use(EnvContext);
}
