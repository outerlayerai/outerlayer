import type { User } from '@supabase/supabase-js';

const SUPABASE_SESSION_COOKIE = 'sb-localhost-auth-token';

type CookieInput =
  | string
  | {
      name: string;
      value: string;
    };

export type SupabaseTestSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: User;
};

type SeedSupabaseSessionOptions = {
  user: User;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  tokenType?: string;
};

const cookieValues = new Map<string, string>();

function getCookieName(input: CookieInput) {
  return typeof input === 'string' ? input : input.name;
}

export function getSupabaseTestCookieStore() {
  return {
    get(name: string) {
      const value = cookieValues.get(name);
      return value ? { name, value } : undefined;
    },
    getAll() {
      return Array.from(cookieValues, ([name, value]) => ({ name, value }));
    },
    // Mirrors Next's cookie store, which accepts either the positional
    // `set(name, value, options)` (used by the server client's getAll/setAll
    // adapter) or the object form `set({ name, value, ...options })`.
    set(nameOrInput: string | { name: string; value: string }, value?: string) {
      if (typeof nameOrInput === 'string') {
        cookieValues.set(nameOrInput, value ?? '');
      } else {
        cookieValues.set(nameOrInput.name, nameOrInput.value);
      }
    },
    delete(input: CookieInput) {
      cookieValues.delete(getCookieName(input));
    },
  };
}

export function resetSupabaseTestSession() {
  cookieValues.clear();
}

function setSupabaseSessionCookie(session: SupabaseTestSession) {
  cookieValues.set(SUPABASE_SESSION_COOKIE, JSON.stringify(session));
}

export function seedSupabaseSessionCookie({
  user,
  accessToken = 'test-access-token',
  refreshToken = 'test-refresh-token',
  expiresAt = 4_102_444_800,
  expiresIn = 3600,
  tokenType = 'bearer',
}: SeedSupabaseSessionOptions): SupabaseTestSession {
  const session: SupabaseTestSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: expiresIn,
    token_type: tokenType,
    user,
  };

  setSupabaseSessionCookie(session);

  return session;
}
