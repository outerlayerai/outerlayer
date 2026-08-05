/**
 * Shared test seam for the browser-side Supabase session.
 *
 * --------------------------------------------------------------------------
 * WHY THIS IS A `vi.mock` MODULE, NOT AN MSW HANDLER
 * --------------------------------------------------------------------------
 * `gatewayFetch` (src/lib/api/gateway-client.ts) calls
 * `createSupabaseFontendClient().auth.getSession()` before every gateway
 * request to attach the bearer token. `getSession()` reads the browser's
 * local-storage / cookie jar — it does NOT issue an HTTP request — so MSW
 * cannot intercept it. The session is therefore a genuine *configuration
 * seam* (a function with a stable signature), and `vi.mock` is the sanctioned
 * tool for seams per `apps/tenant-dashboard/CLAUDE.md`.
 *
 * The problem this helper solves is DUPLICATION: six test files each
 * hand-rolled an identical 10-line
 * `vi.mock('@/supabaseFrontendClient', ...)` block, which drifts the moment
 * the client surface changes. This module is the single shared
 * implementation — it re-exports
 * the exact `createSupabaseFontendClient` named export the real module has,
 * so a test can mock the real module *with this module*.
 *
 * --------------------------------------------------------------------------
 * HOW TO USE IT
 * --------------------------------------------------------------------------
 * `vi.mock` factories are hoisted above imports, so the factory cannot close
 * over an imported value. Pass a dynamic `import()` of this module instead —
 * the `import()` runs lazily when the mocked module is first resolved:
 *
 *   import { seedGatewaySession } from '@/test-helpers/msw-handlers';
 *
 *   vi.mock('@/supabaseFrontendClient', () =>
 *     import('@/test-helpers/msw-handlers/frontend-session'),
 *   );
 *
 *   beforeEach(() => {
 *     seedGatewaySession();          // default token, gateway calls reach MSW
 *   });
 *
 * Tests that need to exercise the no-session branch call
 * `seedGatewaySession(null)` — `gatewayFetch` then throws `unauthorized`.
 *
 * The shared `resetMswState()` resets the seeded token between tests, so a
 * stale session never bleeds across the suite.
 */

/** The token attached to gateway requests; `null` means "no active session". */
let accessToken: string | null = 'test-access-token';

const DEFAULT_ACCESS_TOKEN = 'test-access-token';

/**
 * Seed the browser session the gateway client reads.
 *
 * - `seedGatewaySession()` — default token; gateway calls reach MSW.
 * - `seedGatewaySession('custom')` — a specific token (assert header forwarding).
 * - `seedGatewaySession(null)` — no session; `gatewayFetch` throws `unauthorized`.
 */
export function seedGatewaySession(token: string | null = DEFAULT_ACCESS_TOKEN): void {
  accessToken = token;
}

/** Resets the seeded session to the default token. Called by `resetMswState()`. */
export function resetGatewaySession(): void {
  accessToken = DEFAULT_ACCESS_TOKEN;
}

/**
 * Drop-in replacement for the real `@/supabaseFrontendClient` export of the
 * same name. Returns a client whose `auth.getSession()` resolves the token
 * currently seeded via {@link seedGatewaySession}, mirroring the real
 * `getSession()` contract (`{ data: { session }, error }`).
 *
 * A test mocks the real module *with this module*:
 *
 *   vi.mock('@/supabaseFrontendClient', () =>
 *     import('@/test-helpers/msw-handlers/frontend-session'),
 *   );
 */
export function createSupabaseFontendClient() {
  return {
    auth: {
      getSession: async () => ({
        data: {
          session: accessToken ? { access_token: accessToken } : null,
        },
        error: null,
      }),
    },
  };
}
