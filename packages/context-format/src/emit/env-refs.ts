/**
 * Shared `${VAR}` / `${VAR:-default}` parsing + per-target rewrite. Cursor is
 * the only consumer today (mcp `env`/`headers`/`url` values); any other
 * target's indirection builds on the same primitives.
 */

export interface EnvRef {
  /** The full matched `${...}` text. */
  raw: string;
  varName: string;
  /** `null` when the reference has no `:-default` clause. */
  defaultValue: string | null;
}

function envRefPattern(): RegExp {
  // Fresh instance per call — a shared global-flag RegExp carries `lastIndex`
  // state across calls, which is a classic source of skipped/duplicated
  // matches when the same pattern is reused across separate input strings.
  return /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
}

/** Finds every `${VAR}` / `${VAR:-default}` occurrence in a string, in order. */
export function findEnvRefs(value: string): EnvRef[] {
  const pattern = envRefPattern();
  const refs: EnvRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    refs.push({ raw: match[0], varName: match[1]!, defaultValue: match[3] ?? null });
  }
  return refs;
}

export interface RewriteEnvRefsResult {
  value: string;
  warnings: string[];
}

/** Rewrites every `${VAR}`/`${VAR:-default}` occurrence in `value` via the per-target `rewrite` fn. */
export function rewriteEnvRefs(
  value: string,
  rewrite: (ref: EnvRef) => { text: string; warning?: string },
): RewriteEnvRefsResult {
  const pattern = envRefPattern();
  const warnings: string[] = [];
  const rewritten = value.replace(pattern, (raw, varName: string, _hasDefault: string | undefined, defaultValue: string | undefined) => {
    const result = rewrite({ raw, varName, defaultValue: defaultValue ?? null });
    if (result.warning) warnings.push(result.warning);
    return result.text;
  });
  return { value: rewritten, warnings };
}

/**
 * Cursor has no native `${VAR}` syntax — it uses `${env:VAR}` — and no
 * default-value syntax at all, so a `:-default` clause is dropped with a
 * warning rather than silently swallowed.
 */
export function cursorEnvRefRewrite(ref: EnvRef): { text: string; warning?: string } {
  if (ref.defaultValue !== null) {
    return {
      text: `\${env:${ref.varName}}`,
      warning: `"\${${ref.varName}:-${ref.defaultValue}}" has no Cursor default-value equivalent — emitted as "\${env:${ref.varName}}", default dropped`,
    };
  }
  return { text: `\${env:${ref.varName}}` };
}
