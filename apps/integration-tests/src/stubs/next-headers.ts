/**
 * Test stub for `next/headers`, wired in vitest.config the same way as the
 * `server-only` stub. The real `headers()`/`cookies()` read from a Next request
 * scope that does not exist when a route handler is invoked directly in a test
 * (they throw "… was called outside a request scope"). This stub lets a test
 * inject the header/cookie values the handler will read.
 *
 * Aliasing (not vi.mock) is required because the handler under test resolves
 * `next/headers` from tenant-dashboard's own `next` install, a different module
 * instance than the integration-tests' `next` — so a bare `vi.mock('next/headers')`
 * in the test would miss it. The alias makes both resolve to this single module.
 *
 * Shared singleton state: set the header/cookies before invoking the handler;
 * reset between cases.
 *
 * knip-ignored (see `knip.json`): every export here is reached only through
 * the alias, which knip's static import graph cannot trace — the same reason
 * `server-only.ts` is ignored there.
 */
let store: Record<string, string | null> = {};

export function __setHeader(name: string, value: string | null): void {
  store[name.toLowerCase()] = value;
}

export function __resetHeaders(): void {
  store = {};
}

export async function headers(): Promise<{ get(name: string): string | null }> {
  return { get: (name: string) => store[name.toLowerCase()] ?? null };
}

// -----------------------------------------------------------------------------
// cookies() — shaped like Next's `ReadonlyRequestCookies`: getAll()/get()/set()/
// delete(). `createSupabaseServerClient` (apps/tenant-dashboard/src/supabaseServerClient.ts)
// reads the session via `getAll()` and writes refreshed tokens back via `set()`;
// `set()` must not throw here the same way it must not throw in a real Server
// Component — the real code wraps writes in a try/catch and treats a throw as
// "not writable, safe to ignore" (the middleware is what actually persists a
// refresh). Recording the write instead of throwing keeps that path exercised.
interface StoredCookie {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

let cookieStore = new Map<string, StoredCookie>();

export function __setCookie(name: string, value: string, options?: Record<string, unknown>): void {
  cookieStore.set(name, { name, value, options });
}

export function __setCookies(cookies: Array<{ name: string; value: string }>): void {
  for (const { name, value } of cookies) {
    cookieStore.set(name, { name, value });
  }
}

export function __getAllCookies(): StoredCookie[] {
  return Array.from(cookieStore.values());
}

export function __resetCookies(): void {
  cookieStore = new Map();
}

export async function cookies(): Promise<{
  getAll(): Array<{ name: string; value: string }>;
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
}> {
  return {
    getAll: () => Array.from(cookieStore.values()).map(({ name, value }) => ({ name, value })),
    get: (name: string) => {
      const found = cookieStore.get(name);
      return found ? { name: found.name, value: found.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieStore.set(name, { name, value, options });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  };
}
