/**
 * The Vercel boot assert for API_KEY_PEPPER.
 *
 * env.ts declares the pepper required, but t3-env validation is force-skipped
 * on Vercel, so the module-load throw in config-global.server.ts is the ONLY
 * thing standing between a missing secret and a deployed dashboard that cannot
 * mint API keys. These tests pin that the assert fires exactly on
 * (Vercel × missing pepper) and nowhere else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// unit-test-setup globally mocks env.ts with a fixed object, which would make
// the stubbed process.env invisible here. The real env.ts is safe to load in
// tests: skipValidation is on under NODE_ENV=test, so it passes raw
// process.env through — exactly the Vercel behavior this file pins.
vi.unmock('./env');

describe('config-global.server — API_KEY_PEPPER Vercel boot assert', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws at module load on Vercel when the pepper is missing', async () => {
    vi.resetModules();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('API_KEY_PEPPER', '');

    await expect(import('./config-global.server')).rejects.toThrow(
      /API_KEY_PEPPER is not set/,
    );
  });

  it('loads on Vercel when the pepper is present and exports it verbatim', async () => {
    vi.resetModules();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('API_KEY_PEPPER', 'vercel-pepper');

    const mod = await import('./config-global.server');

    expect(mod.API_KEY_PEPPER).toBe('vercel-pepper');
  });

  it('does not throw off-Vercel without a pepper (env.ts zod owns local/CI enforcement)', async () => {
    vi.resetModules();
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('API_KEY_PEPPER', '');

    const mod = await import('./config-global.server');

    // Loads cleanly with the pepper absent (t3-env's emptyStringAsUndefined
    // maps the stubbed '' to undefined) — enforcement off-Vercel belongs to
    // env.ts's zod schema, not this module.
    expect(mod.API_KEY_PEPPER).toBeUndefined();
  });
});
