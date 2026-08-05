// @vitest-environment node
/**
 * Regression: DORA_ENVIRONMENT must resolve to a concrete environment at
 * runtime even when t3-env's validation is skipped.
 *
 * On Vercel, `skipValidation` is force-enabled by `!!process.env.VERCEL`
 * (env.ts), which makes t3-env pass `runtimeEnv` through raw and NEVER run
 * zod — so the schema's `.default('production')` is dead. Production never
 * sets DORA_ENVIRONMENT, so before the fix `env.DORA_ENVIRONMENT` was
 * `undefined` at runtime; the DORA collector's env-filter
 * (`incident.environment !== this.environment`) then silently dropped every
 * production incident and CFR/MTTR sat at 0 with no error.
 *
 * The real default therefore lives in `runtimeEnv`
 * (`process.env.DORA_ENVIRONMENT || 'production'`). This pins the case that
 * actually broke prod: unset DORA_ENVIRONMENT under skipValidation → still
 * 'production'. (Revert the runtimeEnv `|| 'production'` and this fails with
 * `undefined`, because the zod `.default` never runs when validation is
 * skipped.) The explicit-value path is trivial `||` behavior and isn't
 * re-tested here: a second case would need env.ts re-evaluated with a
 * different env, but `vi.resetModules()` doesn't force a non-mocked dynamic
 * `import()` to re-run, so it would read this test's cached `env`.
 *
 * Runs in the `node` environment (top-of-file pragma): under jsdom, `window`
 * is defined and t3-env throws on server-var access from "the client".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('DORA_ENVIRONMENT resolution under Vercel skipValidation', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    // VERCEL=1 reproduces the real condition: skipValidation on, zod defaults
    // dead. A bare {} would drop PATH etc.; spread keeps the rest intact.
    // DORA_ENVIRONMENT deleted so only the runtimeEnv `|| 'production'` can
    // supply the value — exactly prod's situation.
    process.env = { ...ORIGINAL_ENV, VERCEL: '1' };
    delete process.env.DORA_ENVIRONMENT;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("defaults to 'production' when unset — the zod .default is dead under skipValidation", async () => {
    const { env } = await import('../env');

    expect(env.DORA_ENVIRONMENT).toBe('production');
  });
});
