import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

// Structural invariants restated as tests so they survive an eslint-config
// edit and so a violation names the rule in its own failure message rather
// than a generic lint error.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_ROOT = path.resolve(__dirname, '../../..');
const EE_FEATURES_ROOT = path.join(APP_ROOT, 'ee/features');
const THIS_FILE = __filename;

// `.next/types` and `.stryker-tmp` can hold a stale or mid-mutation copy of
// the pre-move tree — scanning either fails this suite for a reason that has
// nothing to do with a real boundary crossing. eslint already excludes
// `.stryker-tmp` for the same reason (eslint.config.mjs).
function scan(root: string, pattern = '**/*.{ts,tsx}') {
  return globSync(pattern, {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.next/**', '**/.stryker-tmp/**'],
  }).filter((file) => file !== THIS_FILE);
}

/** Matches a static `from '<specifier>'` or a dynamic `import('<specifier>')` — a
 *  regex on `from '…'` alone misses dynamic imports entirely (src/instrumentation.ts
 *  uses that form to reach the license slice). */
function importPattern(specifierPattern: string): RegExp {
  return new RegExp(`(?:from\\s+['"]|import\\(\\s*['"])(?:${specifierPattern})`);
}

function offendersMatching(files: string[], relativeTo: string, pattern: RegExp) {
  return files
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(relativeTo, file));
}

/** Relative import/dynamic-import specifiers (`./x`, `../x`) in a source file. */
function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from\s+['"](\.[^'"]*)['"])|(?:import\(\s*['"](\.[^'"]*)['"]\s*\))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

describe('src/features never imports @ee', () => {
  const files = scan(path.join(APP_ROOT, 'src/features'));

  it('scans the real tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no source file imports @ee/**, statically or dynamically', () => {
    const offenders = offendersMatching(files, APP_ROOT, importPattern('@ee/'));
    expect(offenders).toEqual([]);
  });
});

describe('ee/features never reaches the legacy tree', () => {
  const files = scan(EE_FEATURES_ROOT);

  it('scans the real tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no source file imports @/features, @/sections, @/services, or the root Supabase client wrappers', () => {
    const FORBIDDEN = importPattern(
      '@/features/|@/sections/|@/services/|@/supabaseAdminClient|@/supabaseServerClient',
    );
    const offenders = offendersMatching(files, APP_ROOT, FORBIDDEN);
    expect(offenders).toEqual([]);
  });
});

describe('EE features are leaves — no slice imports another', () => {
  const SLICES = ['app-access', 'audit-log', 'custom-roles', 'license', 'sso'];

  it.each(SLICES)('%s does not import a sibling ee/features/* slice, absolute or relative', (slice) => {
    // Must fail on an absolute `@ee/features/<sibling>` import, and equally on
    // the RELATIVE spelling of the same edge
    // (`../../custom-roles/actions` from app-access/components/) — a regex on
    // the `@ee/features/*` alias alone misses it, and so does eslint's
    // crossFeatureInternals (a specifier-pattern rule), which is why this
    // resolves relative specifiers to their real path instead of pattern-matching them.
    const sliceRoot = path.join(EE_FEATURES_ROOT, slice);
    const files = scan(sliceRoot);
    const siblings = SLICES.filter((s) => s !== slice).join('|');
    const absoluteSibling = importPattern(`@ee/features/(?:${siblings})/`);

    const offenders = files
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (absoluteSibling.test(source)) return true;
        return relativeImportSpecifiers(source).some((spec) => {
          const resolved = path.resolve(path.dirname(file), spec);
          return (
            resolved.startsWith(EE_FEATURES_ROOT + path.sep) && !resolved.startsWith(sliceRoot + path.sep)
          );
        });
      })
      .map((file) => path.relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });
});

describe('getAdminDataClient is confined to ee/features/*/service.ts', () => {
  const files = scan(EE_FEATURES_ROOT);

  it('scans the real tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no other ee/features file imports the admin-client factory', () => {
    const offenders = offendersMatching(
      files.filter((file) => !/\/features\/[^/]+\/service\.tsx?$/.test(file)),
      APP_ROOT,
      importPattern("@/lib/system/admin-client"),
    );
    expect(offenders).toEqual([]);
  });
});

describe('ee/sections and ee/services no longer exist', () => {
  it('neither the ee/sections nor the ee/services directory is present on disk', () => {
    expect(fs.existsSync(path.join(APP_ROOT, 'ee/sections'))).toBe(false);
    expect(fs.existsSync(path.join(APP_ROOT, 'ee/services'))).toBe(false);
  });

  it('no source file re-exports from the retired paths, statically or dynamically', () => {
    // The `@ee/*` alias is declared only in tenant-dashboard and
    // integration-tests — the two places a stale reference could resolve.
    const files = [
      ...scan(APP_ROOT),
      ...scan(path.join(REPO_ROOT, 'apps/integration-tests')),
    ];
    const offenders = offendersMatching(files, REPO_ROOT, importPattern('@ee/(?:sections|services)/'));
    expect(offenders).toEqual([]);
  });
});
