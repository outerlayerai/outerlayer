/**
 * Supabase Vault MSW handlers.
 *
 * Vault is exposed through four RPCs (`read_secret`, `insert_secret`,
 * `delete_secret`, `update_secret`) defined in `supabase/schemas/`.
 * PostgREST routes them at `POST /rest/v1/rpc/<name>` with the body
 * `{ secret_name }` or `{ name, secret }` or `{ secret_name, secret }`.
 * These handlers fake that boundary for tests that exercise services
 * calling `supabase.rpc(...)` for vault access — no Supabase client
 * mocking required.
 *
 * Read-misses return `{ data: null, error: null }` (the
 * cachedSecret-null branch services check); writes succeed unless the
 * test has seeded an explicit error. `update_secret` returns `false` (not
 * an error) for a miss, matching the real function's contract.
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

type SecretValue = string | { value: string; key_id?: string };

type VaultMswState = {
  /** Map of secret_name → stored value. Missing keys = vault miss. */
  secrets: Record<string, SecretValue>;
  /** Optional override: force `read_secret` to return an error envelope. */
  forceReadError?: { message: string };
  /** Optional override: force `insert_secret` to return an error envelope. */
  forceInsertError?: { message: string };
  /** Optional override: force `delete_secret` to return an error envelope. */
  forceDeleteError?: { message: string };
  /** Optional override: force `update_secret` to return an error envelope. */
  forceUpdateError?: { message: string };
  /** Per-name `read_secret` error overrides — for tests that need one
   *  specific name (e.g. the legacy-fallback name) to error while a sibling
   *  name misses cleanly. Checked before `forceReadError`. */
  secretReadErrors?: Record<string, { message: string }>;
};

const defaultState = (): VaultMswState => ({
  secrets: {},
});

let state = defaultState();

export function resetVaultMswState() {
  state = defaultState();
}

export function seedVaultMswState(nextState: Partial<VaultMswState>) {
  state = {
    ...state,
    ...nextState,
    secrets: nextState.secrets ?? state.secrets,
  };
}

/** Read-only view for assertions. */
export function getVaultMswState(): Readonly<VaultMswState> {
  return state;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export const vaultHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/read_secret`, async ({ request }) => {
    const body = await readJsonBody<{ secret_name?: string }>(request);
    const name = body.secret_name;
    const perNameError = name ? state.secretReadErrors?.[name] : undefined;
    if (perNameError) {
      return HttpResponse.json({ message: perNameError.message }, { status: 500 });
    }
    if (state.forceReadError) {
      return HttpResponse.json(
        { message: state.forceReadError.message },
        { status: 500 },
      );
    }
    const value = name ? state.secrets[name] : undefined;
    if (value === undefined) {
      // Vault miss — Supabase returns `data: null, error: null` for the
      // PostgREST RPC, which surfaces as `{}` over the wire and gets
      // wrapped to `{ data: null, error: null }` by the JS client.
      return HttpResponse.json(null);
    }
    return HttpResponse.json(typeof value === 'string' ? value : value.value);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/insert_secret`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json(
        { message: state.forceInsertError.message },
        { status: 500 },
      );
    }
    const body = await readJsonBody<{ name?: string; secret?: string }>(request);
    if (body.name && body.secret !== undefined) {
      state.secrets[body.name] = body.secret;
    }
    // The real `insert_secret` Postgres function returns the new
    // `vault_secret_id` (a UUID) — callers treat a falsy return as failure
    // (`if (!secretId) throw`), so the fake must hand one back too.
    return HttpResponse.json(crypto.randomUUID());
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/delete_secret`, async ({ request }) => {
    if (state.forceDeleteError) {
      return HttpResponse.json(
        { message: state.forceDeleteError.message },
        { status: 500 },
      );
    }
    const body = await readJsonBody<{ secret_name?: string }>(request);
    if (body.secret_name) {
      delete state.secrets[body.secret_name];
    }
    return HttpResponse.json(null);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/update_secret`, async ({ request }) => {
    if (state.forceUpdateError) {
      return HttpResponse.json(
        { message: state.forceUpdateError.message },
        { status: 500 },
      );
    }
    const body = await readJsonBody<{ secret_name?: string; secret?: string }>(request);
    const name = body.secret_name;
    if (!name || state.secrets[name] === undefined) {
      // No secret under this name yet — the real function returns `false`
      // rather than an error so callers can fall back to a plain insert.
      return HttpResponse.json(false);
    }
    if (body.secret !== undefined) {
      state.secrets[name] = body.secret;
    }
    return HttpResponse.json(true);
  }),
];
