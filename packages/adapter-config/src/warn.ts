/**
 * One-time deprecation warnings, keyed per seam.
 *
 * When a seam resolves its config from a deprecated legacy env name, it should
 * warn the operator once — not on every resolve (config is often read per
 * request). The latch is keyed so each seam warns independently within a
 * process.
 */

const warnedKeys = new Set<string>();

/**
 * Emit `message` to `console.warn` the first time it is called for `key` in
 * this process; subsequent calls with the same key are no-ops. Returns whether
 * it actually warned (for testability).
 */
export function warnLegacyOnce(key: string, message: string): boolean {
  if (warnedKeys.has(key)) return false;
  warnedKeys.add(key);
  console.warn(message);
  return true;
}

/**
 * Test-only: clear the one-time latch. Pass a `key` to reset just that seam, or
 * omit it to reset all. @internal
 */
export function resetWarnLatch(key?: string): void {
  if (key === undefined) {
    warnedKeys.clear();
  } else {
    warnedKeys.delete(key);
  }
}
