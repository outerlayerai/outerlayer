// @vitest-environment node
/**
 * Guard (generic, for ALL current + FUTURE env vars): every server-side var
 * that env.ts reads via `process.env.KEY` MUST be listed in the root
 * turbo.json `build` task's `passThroughEnv`.
 *
 * Why this invariant exists: Vercel builds run `turbo run build`, and Turbo's
 * strict env mode strips every var not declared for the task. A var can be
 * set on the Vercel project yet be invisible to `next build` — so a schema
 * requirement added in env.ts fails the deploy's build even though the
 * deployment is correctly configured, and refinement inputs like
 * BILLING_ENABLED silently read as unset. NEXT_PUBLIC_* vars are exempt
 * (Turbo's framework inference passes them into Next builds), as is NODE_ENV
 * (set by `next build` itself).
 *
 * This test parses env.ts source (not the evaluated module) so it sees every
 * read, including raw `process.env` reads inside zod refinements.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_SRC = readFileSync(path.resolve(__dirname, '../env.ts'), 'utf8');
const TURBO_JSON = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../turbo.json'), 'utf8'),
) as { tasks: Record<string, { passThroughEnv?: string[] }> };

const EXEMPT = new Set([
  // `next build` sets NODE_ENV=production itself; Turbo never strips it.
  'NODE_ENV',
]);

const readKeys = [
  ...new Set(
    [...ENV_SRC.matchAll(/process\.env\.([A-Z0-9_]+)/g)]
      .map((m) => m[1]!)
      .filter((key) => !key.startsWith('NEXT_PUBLIC_') && !EXEMPT.has(key)),
  ),
].sort();

describe('env.ts: every server-side process.env read survives Turbo strict env into the build', () => {
  it('found the build-critical vars (sanity check the parser works)', () => {
    // The vars whose absence fails the build outright when billing is enabled.
    // A parser regression that finds nothing must not pass as "no offenders".
    const required = [
      'CRON_SECRET',
      'OAUTH_STATE_SECRET',
      'STRIPE_GROWTH_FLAT_PRICE_ID',
      'STRIPE_GROWTH_STORAGE_PRICE_ID',
      'STRIPE_GROWTH_USAGE_PRICE_ID',
      'STRIPE_STORAGE_METER_ID',
      'STRIPE_TEAM_FLAT_PRICE_ID',
      'STRIPE_TEAM_STORAGE_PRICE_ID',
      'STRIPE_TEAM_USAGE_PRICE_ID',
    ];
    expect(readKeys).toEqual(expect.arrayContaining(required));
    expect(readKeys.length).toBeGreaterThan(30);
  });

  it('lists each read var in the root build task passThroughEnv', () => {
    const passThrough = new Set(TURBO_JSON.tasks.build?.passThroughEnv ?? []);
    const offenders = readKeys
      .filter((key) => !passThrough.has(key))
      .map(
        (key) =>
          `${key}: read in env.ts but missing from turbo.json tasks.build.passThroughEnv — ` +
          `Turbo strips it before \`next build\`, so the Vercel deploy build cannot see it ` +
          `even when the project sets it.`,
      );
    expect(offenders).toEqual([]);
  });
});
