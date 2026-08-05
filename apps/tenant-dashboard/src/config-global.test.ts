// @vitest-environment node
/**
 * Contract: config-global must re-export the gateway / API base URLs straight
 * from the validated `env`, WITHOUT its own `|| 'https://api.agentmark.co'`
 * fallback.
 *
 * config-global must be a pure passthrough; adding a `|| prod-url` fallback
 * here would silently point a misconfigured deployment at the production
 * gateway. The default lives in the validated env schema
 * (`z.string().url().default(...)` + a runtimeEnv fallback that survives Vercel's
 * forced skipValidation — see env.ts and env-default-invariant.test.ts).
 *
 * The case that matters is `undefined in → undefined out`: an
 * `env.X || 'https://api.agentmark.co'` here would resolve an undefined env
 * value to the prod URL, while a pure passthrough surfaces it as undefined.
 * That's the one assertion that fails if such an override is added. (At real
 * runtime env.ts guarantees a string, so this isolates config-global's own
 * contract — it must add nothing.)
 *
 * unit-test-setup.ts globally mocks BOTH `../env` and `../config-global`; each
 * case therefore unmocks the real config-global and drives it with a controlled
 * `./env` mock. `./env` is an internal config seam (not an HTTP boundary), which
 * the global setup itself already mocks — so overriding it here is in-bounds.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfigGlobalWithEnv(envValues: Record<string, unknown>) {
  vi.resetModules();
  // Bypass the global config-global mock so we exercise the real re-export.
  vi.doUnmock('./config-global');
  // Control what the validated env resolves to for this case.
  vi.doMock('./env', () => ({ env: envValues }));
  return import('./config-global');
}

describe('config-global — gateway/API base URLs re-export validated env with no local fallback', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./env');
  });

  it('passes env.NEXT_PUBLIC_GATEWAY_URL / NEXT_PUBLIC_API_URL through verbatim', async () => {
    const { GATEWAY_URL, API_URL } = await loadConfigGlobalWithEnv({
      NEXT_PUBLIC_GATEWAY_URL: 'https://gw.example.test',
      NEXT_PUBLIC_API_URL: 'https://api.example.test',
    });

    expect(GATEWAY_URL).toBe('https://gw.example.test');
    expect(API_URL).toBe('https://api.example.test');
  });

  it('adds no fallback of its own — undefined from env stays undefined (the `|| prod` override is gone)', async () => {
    const { GATEWAY_URL, API_URL } = await loadConfigGlobalWithEnv({
      NEXT_PUBLIC_GATEWAY_URL: undefined,
      NEXT_PUBLIC_API_URL: undefined,
    });

    expect(GATEWAY_URL).toBeUndefined();
    expect(API_URL).toBeUndefined();
  });
});
