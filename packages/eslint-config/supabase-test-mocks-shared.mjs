export const BANNED_SUPABASE_TEST_MOCK_SPECIFIERS = new Set([
  '@/supabaseServerClient',
  '@/supabaseAdminClient',
  '@supabase/ssr',
  '@supabase/supabase-js',
]);

export const RELATIVE_SUPABASE_TEST_MOCK_PATTERN =
  /^(?:\.\.\/)+supabase(?:Server|Admin)Client$/;

export function isBannedSupabaseTestMockSpecifier(specifier) {
  return (
    BANNED_SUPABASE_TEST_MOCK_SPECIFIERS.has(specifier) ||
    RELATIVE_SUPABASE_TEST_MOCK_PATTERN.test(specifier)
  );
}

// ---------------------------------------------------------------------------
// Structure-aware detection (source-text). The `vi.mock('<specifier>')` check
// above only catches one of the three banned shapes in the tenant-dashboard
// testing rules. The two below catch the others — the ones that pass review
// today because they don't name a module specifier:
//
//   2. Hand-rolled PostgREST query-builder fake (a `from` mock whose chain
//      stands in for select/insert/eq/single/...).
//   3. `vi.spyOn(<module>, 'createSupabase*Client')` — swapping the whole
//      client factory per-call.
//
// These run on raw source (not the AST) so the same logic can back the CI gate
// (scripts/check-no-supabase-test-mocks.mjs) and any text-level lint use.
// ---------------------------------------------------------------------------

// Spying on a Supabase client *factory* to replace the real client wholesale.
// createClient is the supabase-js factory; the create*Client names are the
// app's own server/admin/browser wrappers; getAdminDataClient is the
// lib/system service-role constructor those wrappers are being replaced by.
const SUPABASE_FACTORY_SPYON_PATTERN =
  /vi\.spyOn\(\s*[^,]+,\s*['"](?:createSupabaseServerClient|createSupabaseAdminClient|createSupabaseBrowserClient|createClient|getAdminDataClient)['"]\s*\)/;

// The entry point of a hand-rolled client fake: a mocked `from`, or a helper
// named for the pattern.
const SUPABASE_FROM_MOCK_PATTERN =
  /\bfrom\s*:\s*(?:vi\.fn|\()|\.from\s*=\s*vi\.fn|createMockSupabase|mockSupabaseClient/;

// PostgREST query-builder methods being mocked. A non-Supabase `{ from: vi.fn() }`
// (e.g. a date range) will not ALSO mock these, so requiring two distinct ones
// alongside a `from` mock keeps the chain detection precise.
const SUPABASE_BUILDER_METHOD_PATTERN =
  /\b(select|insert|update|delete|upsert|eq|neq|in|is|match|single|maybeSingle|order|limit|rpc)\s*:\s*vi\.fn/g;

export function hasSupabaseFactorySpyOn(source) {
  return SUPABASE_FACTORY_SPYON_PATTERN.test(source);
}

export function hasHandRolledSupabaseChain(source) {
  if (!SUPABASE_FROM_MOCK_PATTERN.test(source)) return false;
  const methods = new Set();
  for (const match of source.matchAll(SUPABASE_BUILDER_METHOD_PATTERN)) {
    methods.add(match[1]);
  }
  return methods.size >= 2;
}

/**
 * The banned structure-aware patterns present in a test file's source.
 * Returns the kinds found (empty array = clean). `vi.mock` specifier bans are
 * handled separately — they have no existing debt to grandfather.
 */
export function detectStructuralSupabaseMocks(source) {
  const kinds = [];
  if (hasSupabaseFactorySpyOn(source)) kinds.push('factory-spyOn');
  if (hasHandRolledSupabaseChain(source)) kinds.push('hand-rolled-chain');
  return kinds;
}
