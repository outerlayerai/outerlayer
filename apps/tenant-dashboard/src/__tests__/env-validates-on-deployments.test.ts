// @vitest-environment node
/**
 * Guard: `skipValidation` must not key on the hosting provider.
 *
 * Skipping validation on every Vercel build made the whole schema decorative in
 * the only environments where being wrong costs anything — twelve server vars
 * declared required and never checked. That is how a Vercel project migration
 * dropped six staging variables without one error: the schema said they were
 * required, nothing ran, and the app booted into a state where invites reported
 * success and delivered nothing.
 *
 * Restoring the skip would restore that silence, and it would do so invisibly —
 * every test still passes, because tests skip validation too. Hence a source
 * assertion: the same shape as env-default-invariant.test.ts, for the same
 * reason.
 *
 * The explicit escape hatches stay. SKIP_ENV_VALIDATION is how you unblock a
 * deploy that this schema describes wrongly; it is a decision someone makes,
 * not a condition that quietly holds everywhere.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_SRC = readFileSync(path.resolve(__dirname, '../env.ts'), 'utf8');

/** The `skipValidation:` expression, up to the closing of the createEnv call. */
function skipValidationExpression(): string {
  const start = ENV_SRC.indexOf('skipValidation:');
  expect(start).toBeGreaterThan(0);
  const end = ENV_SRC.indexOf('});', start);
  expect(end).toBeGreaterThan(start);
  return ENV_SRC.slice(start, end);
}

describe('env.ts: validation runs on deployments', () => {
  it.each(['process.env.VERCEL', 'VERCEL_ENV'])(
    'does not skip validation based on %s',
    (token) => {
      expect(skipValidationExpression()).not.toContain(token);
    }
  );

  it('keeps the explicit opt-out hatches and the test-env skip, and nothing else', () => {
    const expression = skipValidationExpression();

    expect(expression).toContain('NEXT_PUBLIC_SKIP_ENV_VALIDATION');
    expect(expression).toContain('SKIP_ENV_VALIDATION');
    expect(expression).toContain("process.env.NODE_ENV === 'test'");

    // Three conditions, so a fourth cannot be added without this failing.
    expect(expression.split('||')).toHaveLength(3);
  });
});
