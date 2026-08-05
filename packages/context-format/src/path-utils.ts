/**
 * Path normalization for repo-relative paths. This package is published and
 * consumed standalone, so every path that crosses its public API boundary is
 * normalized to forward slashes here — never assert `path.join` output
 * against these functions, and never let a `path.win32`/`path.sep` value
 * reach a classifier input unnormalized.
 */

/** Normalizes a repo-relative path to `/`-separated segments with no leading/trailing slash. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

/** Splits a normalized path into its segments. */
export function segments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p.length > 0).join('/'));
}

export function dirname(path: string): string {
  const segs = segments(path);
  segs.pop();
  return segs.join('/');
}

export function basename(path: string): string {
  const segs = segments(path);
  return segs[segs.length - 1] ?? '';
}

/** True when `child` is `parent` itself or nested under it. Root scope is `''`. */
export function isAncestorScope(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (parent === '') return true;
  return child.startsWith(`${parent}/`);
}
