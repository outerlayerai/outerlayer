import { describe, expect, it } from 'vitest';
import {
  hasSupabaseFactorySpyOn,
  hasHandRolledSupabaseChain,
  detectStructuralSupabaseMocks,
  // @ts-expect-error — .mjs shared module, no type declarations; plain JS exports.
} from '../../packages/eslint-config/supabase-test-mocks-shared.mjs';

/**
 * These detectors turn two prose-only bans (the tenant-dashboard testing rules'
 * forms #2 and #3) into a CI block. The bar: catch the real fake-client shapes
 * WITHOUT false-flagging legitimate non-Supabase mocks — a false PR failure
 * erodes trust faster than a missed one.
 */
describe('hasSupabaseFactorySpyOn — vi.spyOn on a client factory', () => {
  it.each([
    "vi.spyOn(mod, 'createSupabaseServerClient')",
    "vi.spyOn(adminModule, 'createSupabaseAdminClient')",
    'vi.spyOn(m, "createSupabaseBrowserClient")',
    "vi.spyOn(supabaseLib, 'createClient')",
    // The lib/system service-role constructor the create*Client wrappers are
    // being replaced by — a spy on it wholesale-replaces the real client the
    // same way, so it needs the same detection.
    "vi.spyOn(adminClientModule, 'getAdminDataClient')",
  ])('flags %s', (snippet) => {
    expect(hasSupabaseFactorySpyOn(snippet)).toBe(true);
  });

  it('does not flag vi.spyOn on an unrelated function', () => {
    expect(hasSupabaseFactorySpyOn("vi.spyOn(dateUtils, 'createTimer')")).toBe(false);
    // A real seam the rules explicitly ALLOW mocking — a permission gate.
    expect(hasSupabaseFactorySpyOn("vi.spyOn(perm, 'checkPermission')")).toBe(false);
  });
});

describe('hasHandRolledSupabaseChain — fake PostgREST builder', () => {
  it('flags a from() mock that stands in for a query chain', () => {
    const src = `
      const fake = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(),
        })),
      };
    `;
    expect(hasHandRolledSupabaseChain(src)).toBe(true);
  });

  it('flags a named createMockSupabase helper with builder methods', () => {
    const src = `function createMockSupabase() {
      return { select: vi.fn(), insert: vi.fn(), eq: vi.fn() };
    }`;
    expect(hasHandRolledSupabaseChain(src)).toBe(true);
  });

  it('does NOT flag a non-Supabase from: mock (the FP guard)', () => {
    // A `from` mock with no PostgREST builder methods — e.g. a date range or a
    // mailer. Requiring >=2 builder methods is what prevents this false flag.
    expect(hasHandRolledSupabaseChain('const d = { from: vi.fn(() => new Date()) };')).toBe(false);
  });

  it('does NOT flag a single builder-shaped method without the pattern', () => {
    // One `select: vi.fn()` and no `from` mock is not a hand-rolled client.
    expect(hasHandRolledSupabaseChain('const x = { select: vi.fn() };')).toBe(false);
  });
});

describe('detectStructuralSupabaseMocks — combined kinds', () => {
  it('returns both kinds when a file has factory spy AND a fake chain', () => {
    const src = `
      vi.spyOn(mod, 'createSupabaseServerClient').mockReturnValue({
        from: vi.fn(() => ({ select: vi.fn(), eq: vi.fn(), single: vi.fn() })),
      });
    `;
    expect(detectStructuralSupabaseMocks(src).sort()).toEqual([
      'factory-spyOn',
      'hand-rolled-chain',
    ]);
  });

  it('returns an empty array for a clean MSW-based test', () => {
    const src = `
      seedSupabaseAuth({ user: mockUser });
      seedSupabaseMswState({ apps: [] });
      await createOrganization('Acme');
    `;
    expect(detectStructuralSupabaseMocks(src)).toEqual([]);
  });
});
