import { describe, it, expect } from 'vitest';
import { EnvSchema, withSupabaseKeyAliases } from './types';

// The two Supabase key fields the migration renamed. Validated together so a
// "neither present" env fails exactly as the full EnvSchema would at boot.
const SupabaseKeySchema = EnvSchema.pick({
  SUPABASE_PUBLISHABLE_KEY: true,
  SUPABASE_SECRET_KEY: true,
});

describe('withSupabaseKeyAliases', () => {
  it('keeps the new-named values when both new and legacy are present', () => {
    const env = {
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new',
      SUPABASE_SECRET_KEY: 'sb_secret_new',
      SUPABASE_ANON_KEY: 'legacy_anon',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy_service',
    };

    withSupabaseKeyAliases(env);

    expect(SupabaseKeySchema.parse(env)).toEqual({
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_new',
      SUPABASE_SECRET_KEY: 'sb_secret_new',
    });
  });

  it('copies legacy-named values onto the new fields when only legacy is set', () => {
    const env = {
      SUPABASE_ANON_KEY: 'legacy_anon',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy_service',
    };

    withSupabaseKeyAliases(env);

    // The new-named fields now carry the legacy values, so schema validation
    // (and every downstream reader) sees only the new names.
    expect(SupabaseKeySchema.parse(env)).toEqual({
      SUPABASE_PUBLISHABLE_KEY: 'legacy_anon',
      SUPABASE_SECRET_KEY: 'legacy_service',
    });
  });

  it('leaves the new fields unset when neither name is present, so validation fails', () => {
    const env: Record<string, unknown> = {};

    withSupabaseKeyAliases(env);

    const result = SupabaseKeySchema.safeParse(env);
    expect(result.success).toBe(false);
    const failedPaths = result.success ? [] : result.error.issues.map((i) => i.path[0]).sort();
    expect(failedPaths).toEqual(['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY']);
  });

  it('falls back to the legacy value when the new field is an empty-string placeholder', () => {
    const env = {
      SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_ANON_KEY: 'legacy_anon',
    };

    withSupabaseKeyAliases(env);

    // An empty placeholder on the new name must not mask the populated legacy
    // secret — the deploy resolves to the legacy value.
    expect(env.SUPABASE_PUBLISHABLE_KEY).toBe('legacy_anon');
  });
});
