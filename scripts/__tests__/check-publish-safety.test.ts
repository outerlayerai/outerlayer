import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { sourcemapLeaks } from '../ci/check-publish-safety.mjs';

/**
 * A tsup sourcemap inlines `sourcesContent`, so it publishes the readable
 * source of everything bundled — including a private workspace vendored via
 * `noExternal`, which the dependency allowlist blesses only as compiled output.
 * Both conditions are checked independently because either one alone is a
 * single edit away from leaking again.
 */
describe('sourcemapLeaks', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'publish-safety-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Lay down a workspace fixture and return the shape the gate consumes. */
  function workspace(opts: { tsup?: string; files?: unknown }) {
    const location = 'packages/thing';
    mkdirSync(path.join(cwd, location), { recursive: true });
    if (opts.tsup !== undefined) {
      writeFileSync(path.join(cwd, location, 'tsup.config.ts'), opts.tsup);
    }
    const pkg = { name: '@scope/thing', ...(opts.files !== undefined ? { files: opts.files } : {}) };
    return { name: '@scope/thing', location, private: false, pkg };
  }

  const CLEAN_TSUP = 'export default defineConfig({\n  sourcemap: false,\n});';
  const CLEAN_FILES = ['dist', '!dist/**/*.map', 'LICENSE'];

  it('passes a package that disables sourcemaps and excludes them from files', () => {
    expect(sourcemapLeaks(cwd, workspace({ tsup: CLEAN_TSUP, files: CLEAN_FILES }))).toEqual([]);
  });

  it('reports the build when tsup emits sourcemaps', () => {
    const ws = workspace({
      tsup: 'export default defineConfig({\n  sourcemap: true,\n});',
      files: CLEAN_FILES,
    });
    expect(sourcemapLeaks(cwd, ws)).toEqual([
      '@scope/thing: tsup.config.ts must set `sourcemap: false`',
    ]);
  });

  it('reports an omitted sourcemap key rather than trusting the tool default', () => {
    // tsup defaults to off today; a future default flip must not silently
    // start publishing source.
    const ws = workspace({ tsup: 'export default defineConfig({\n  dts: true,\n});', files: CLEAN_FILES });
    expect(sourcemapLeaks(cwd, ws)).toEqual([
      '@scope/thing: tsup.config.ts must set `sourcemap: false`',
    ]);
  });

  it('reports files when it would ship maps', () => {
    const ws = workspace({ tsup: CLEAN_TSUP, files: ['dist', 'LICENSE'] });
    expect(sourcemapLeaks(cwd, ws)).toEqual([
      '@scope/thing: package.json "files" must exclude "!dist/**/*.map"',
    ]);
  });

  it('reports both conditions independently when both fail', () => {
    const ws = workspace({
      tsup: 'export default defineConfig({\n  sourcemap: true,\n});',
      files: ['dist'],
    });
    expect(sourcemapLeaks(cwd, ws)).toEqual([
      '@scope/thing: tsup.config.ts must set `sourcemap: false`',
      '@scope/thing: package.json "files" must exclude "!dist/**/*.map"',
    ]);
  });

  it('skips the build check for a package with no tsup config', () => {
    // Not every published workspace is bundled by tsup; those have no map to
    // ship, so demanding the key would be noise.
    expect(sourcemapLeaks(cwd, workspace({ files: CLEAN_FILES }))).toEqual([]);
  });

  it('skips the files check when the package declares no files allowlist', () => {
    // Without `files`, npm's own ignore rules apply; there is no array to amend.
    expect(sourcemapLeaks(cwd, workspace({ tsup: CLEAN_TSUP }))).toEqual([]);
  });
});
