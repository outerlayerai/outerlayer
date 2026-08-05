import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

// The `@repo/ui` alias seam is fully retired: every UI primitive is imported
// directly from `@/components/*` and the theme entry from `@/theme`. No live
// module reference — a static import, a dynamic import, or a vi/jest mock
// specifier — may name `@repo/ui` again. Typecheck already catches a missed
// import, but a stale mock string is invisible to the type checker, so this
// guard's real job is the mock specifiers.

const SRC = path.resolve(__dirname, '..');
const THIS_FILE = __filename;

// Matches a reference that actually resolves the alias at runtime: a static
// import specifier, a dynamic import specifier, or a vi/jest mock/unmock/doMock
// specifier that names it. Plain prose mentions of the alias are stale-doc
// debt, not a resolution risk, so they are intentionally out of scope.
const REPO_UI_SPECIFIER =
  /(?:from\s+['"]@repo\/ui|(?:vi|jest)\.(?:mock|unmock|doMock)\(\s*['"]@repo\/ui|import\(\s*['"]@repo\/ui)/;

const files = globSync('**/*.{ts,tsx}', {
  cwd: SRC,
  absolute: true,
  ignore: ['**/node_modules/**'],
}).filter((file) => file !== THIS_FILE);

describe('@repo/ui seam is retired', () => {
  it('scans the real source tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no source file imports or mocks the `@repo/ui` alias', () => {
    const offenders = files
      .filter((file) => REPO_UI_SPECIFIER.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
