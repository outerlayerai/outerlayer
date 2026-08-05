import { useOptionalEnvContext } from "../../context/env-context";

// ----------------------------------------------------------------------

/**
 * Resolve a sidebar nav item's `path` into the href that should actually be
 * rendered, carrying the current env as a `/env/<name>/` path segment.
 *
 * Why this lives at the render layer: `config-navigation.tsx` builds nav items
 * from static env-less `appPaths.*` strings and cannot read React context. The
 * env selection only exists at render time inside `<EnvProvider>`, so the
 * segment has to be injected here, where `NavItem` is actually mounted.
 *
 * Behaviour:
 *  - External links (`http(s)://…`) are returned untouched — env is an in-app
 *    concept and must not leak onto outbound URLs.
 *  - Outside an `<EnvProvider>` (org-level route shells, `loading.tsx`
 *    fallbacks) `useOptionalEnvContext()` returns `null`; the bare `path` is
 *    returned unchanged so org-level nav is unaffected.
 *  - `envPath` inserts `/env/<name>/` after the `/apps/<app>/` prefix; a path
 *    that already carries an env segment or isn't an app path is left as-is.
 */
export function useNavHref(path: string, externalLink?: boolean): string {
  const envCtx = useOptionalEnvContext();

  if (externalLink || envCtx === null) {
    return path;
  }

  return envCtx.envPath(path);
}
