/**
 * Structural regression guard: trace preprocessor module boundary.
 *
 * `preprocessTraceToText` lives in `packages/trace-topics`, an internal
 * package, not the publishable `@repo/shared-utils` package. Pure Node.js
 * filesystem checks (no browser) guarding against the preprocessor leaking
 * into published `@outerlayer/*` toolkit packages:
 *   - source lives in `packages/trace-topics/` and is exported there.
 *   - `@repo/shared-utils` does not export it.
 *   - no `@outerlayer/*` toolkit package imports `@repo/trace-topics`
 *     or `preprocessTraceToText` (the toolkit must not depend on internal
 *     trace handling).
 *   - no importer outside `packages/trace-topics` references it.
 */

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Resolve the monorepo root from the e2e package location
const REPO_ROOT = join(__dirname, '../../../../');

/**
 * Discover every `packages/*` workspace published under the `@outerlayer/`
 * npm scope (or the `outerlayer` CLI itself), by reading each package.json's
 * `name` field — mirrors the dynamic-discovery pattern used by
 * `lint-staged.config.mjs` rather than hardcoding the package list, so this
 * stays correct as toolkit packages are added or removed.
 */
function discoverOuterlayerPackageDirs(): string[] {
  const packagesRoot = join(REPO_ROOT, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .filter((dir) => {
      const pkgJsonPath = join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) return false;
      const { name } = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      return name === 'outerlayer' || (typeof name === 'string' && name.startsWith('@outerlayer/'));
    });
}

test.describe('Trace Topics module boundary @structural', () => {
  test('preprocessTraceToText source exists in packages/trace-topics', () => {
    const srcPath = join(REPO_ROOT, 'packages/trace-topics/src/trace-preprocessor.ts');
    expect(existsSync(srcPath), `Expected source at ${srcPath}`).toBe(true);

    const src = readFileSync(srcPath, 'utf-8');
    expect(src).toContain('function preprocessTraceToText');
  });

  test('@repo/trace-topics index re-exports preprocessTraceToText', () => {
    const indexPath = join(REPO_ROOT, 'packages/trace-topics/src/index.ts');
    expect(existsSync(indexPath), `Expected index at ${indexPath}`).toBe(true);

    const index = readFileSync(indexPath, 'utf-8');
    // The barrel re-exports everything from trace-preprocessor
    expect(index).toMatch(/export \* from ['"]\.\/trace-preprocessor['"]/);
  });

  test('@repo/shared-utils index does NOT export preprocessTraceToText', () => {
    const indexPath = join(
      REPO_ROOT,
      'packages/shared-utils/src/index.ts',
    );
    expect(existsSync(indexPath), `Expected shared-utils index at ${indexPath}`).toBe(true);

    const index = readFileSync(indexPath, 'utf-8');
    expect(index).not.toContain('preprocessTraceToText');
    expect(index).not.toContain('trace-preprocessor');
  });

  test('no @outerlayer/* toolkit package imports @repo/trace-topics or preprocessTraceToText', () => {
    const outerlayerDirs = discoverOuterlayerPackageDirs();
    expect(outerlayerDirs.length, 'Expected to discover @outerlayer/* packages under packages/').toBeGreaterThan(0);

    // Search for the package specifier or the function symbol — either one
    // entering a toolkit package's import graph is the boundary violation.
    // Pattern: import ... from '@repo/trace-topics' OR import { ... preprocessTraceToText ... } from '...'
    const matchedFiles: string[] = [];
    for (const dir of outerlayerDirs) {
      let grepOutput = '';
      try {
        grepOutput = execSync(
          `grep -rE "from ['\"]@repo/trace-topics|import[^'\"]*preprocessTraceToText" "${dir}" --include="*.ts" --include="*.tsx" -l`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch {
        // grep exits 1 when no matches found — this is the expected (passing) case
        grepOutput = '';
      }
      matchedFiles.push(...grepOutput.trim().split('\n').filter(Boolean));
    }

    expect(
      matchedFiles,
      `Found @outerlayer/* toolkit files that import trace-topics: ${matchedFiles.join(', ')}`,
    ).toHaveLength(0);
  });

  test('no apps/** or packages/** file (outside trace-topics) imports preprocessTraceToText', () => {
    const traceTopicsDir = join(REPO_ROOT, 'packages/trace-topics');
    // Exclude the e2e spec files themselves (this file mentions the name for documentation)
    const e2eDir = join(REPO_ROOT, 'apps/e2e');

    let grepOutput = '';
    try {
      // Search for actual import statements only
      grepOutput = execSync(
        `grep -rE "import[^'\"]*preprocessTraceToText" "${join(REPO_ROOT, 'apps')}" "${join(REPO_ROOT, 'packages')}" --include="*.ts" --include="*.tsx" -l`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      grepOutput = '';
    }

    // Allow files within trace-topics itself and the e2e spec suite
    const externalMatches = grepOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.startsWith(traceTopicsDir) && !f.startsWith(e2eDir));

    expect(
      externalMatches,
      `Found importers of preprocessTraceToText outside trace-topics: ${externalMatches.join(', ')}`,
    ).toHaveLength(0);
  });
});
