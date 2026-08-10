// @vitest-environment node
/**
 * Guard (generic, for ALL current + FUTURE env vars): every var with a zod
 * `.default(X)` in the createEnv schema MUST also supply that default in
 * `runtimeEnv` as `process.env.KEY || X` (or `?? X`).
 *
 * Why this invariant exists: env.ts force-enables t3-env `skipValidation` on
 * every Vercel deploy (`!!process.env.VERCEL`). When validation is skipped,
 * t3-env returns `runtimeEnv` raw and NEVER runs zod — so the schema's
 * `.default()` is dead code at runtime. A var that relies on the zod default
 * (rather than a runtimeEnv fallback) therefore resolves to `undefined` on
 * Vercel whenever its env var is unset, and the failure is silent — e.g. an
 * unset NEXT_PUBLIC_GATEWAY_URL sends the dashboard's traffic nowhere
 * instead of to the production gateway.
 *
 * This test parses env.ts source (not the evaluated module) so it sees the
 * schema and runtimeEnv shapes directly. Add a new `.default()` without the
 * runtimeEnv fallback and this fails with an actionable message.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_SRC = readFileSync(path.resolve(__dirname, '../env.ts'), 'utf8');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('env.ts: every schema .default() is backed by a runtimeEnv fallback', () => {
  // Split source at runtimeEnv so schema defaults and runtime fallbacks are
  // searched in their own regions (both contain `KEY:` lines).
  const rtIndex = ENV_SRC.indexOf('runtimeEnv:');

  it('locates the runtimeEnv block', () => {
    // If this moves/renames, the parsing below is meaningless — fail loudly.
    expect(rtIndex).toBeGreaterThan(0);
  });

  const schemaRegion = ENV_SRC.slice(0, rtIndex);
  const runtimeRegion = ENV_SRC.slice(rtIndex);

  // Collect every real schema declaration line of the form `KEY: z....default(X)`.
  // Anchoring on `^\s*KEY: z.` excludes `//`/`*` comment lines that merely
  // mention `.default(...)` in prose.
  const defaulted: Array<{ key: string; def: string }> = [];
  for (const line of schemaRegion.split('\n')) {
    const key = line.match(/^\s*([A-Z0-9_]+):\s*z\./)?.[1];
    if (!key) continue;
    const def = line.match(/\.default\(([^)]+)\)/)?.[1];
    if (!def) continue;
    defaulted.push({ key, def: def.trim() });
  }

  it('found the known defaulted vars (sanity check the parser works)', () => {
    const keys = defaulted.map((d) => d.key).sort();
    // Pin the current set so a parser regression (matching nothing) is caught
    // rather than silently passing. Update this list when adding a defaulted var.
    expect(keys).toEqual(
      [
        'BILLING_ENABLED',
        'EMAIL_ENABLED',
        'EMAIL_PROVIDER',
        'NEXT_PUBLIC_API_URL',
        'NEXT_PUBLIC_GATEWAY_URL',
        'NODE_ENV',
      ].sort(),
    );
  });

  it('backs each schema .default() with a `process.env.KEY || <default>` in runtimeEnv', () => {
    const offenders: string[] = [];
    for (const { key, def } of defaulted) {
      // runtimeEnv line for KEY must read process.env.KEY then `||`/`??` <def>.
      const fallback = new RegExp(
        `\\b${key}:\\s*process\\.env\\.${key}\\s*(?:\\|\\||\\?\\?)\\s*${escapeRegExp(def)}`,
      );
      if (!fallback.test(runtimeRegion)) {
        offenders.push(
          `${key}: schema has .default(${def}) but runtimeEnv does not fall back ` +
            `to it. Add \`${key}: process.env.${key} || ${def}\` — the zod default ` +
            `is DEAD under Vercel skipValidation and ${key} will be undefined at ` +
            `runtime when unset.`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
