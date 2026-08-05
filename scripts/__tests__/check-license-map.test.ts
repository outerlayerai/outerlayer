import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import {
  EE_LICENSE_FIELD,
  checkDeclaredLicenses,
  checkMappedDirectories,
  checkPublishedMetadata,
  expandWorkspaceGlobs,
  expectedLicense,
  loadWorkspaces,
  mappedDirectories,
} from '../ci/check-license-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'ci', 'check-license-map.mjs');

const APACHE_TEXT = '                                 Apache License\n                           Version 2.0, January 2004\n';
const EE_TEXT = 'AgentMark Enterprise Edition (EE) License\n\nCopyright (c) 2026 Magu Studios, Inc.\n';

describe('license-map gate', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'license-map-'));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Lay down one workspace directory with an optional LICENSE file. */
  function pkg(location: string, manifest: Record<string, unknown>, license?: string) {
    mkdirSync(path.join(cwd, location), { recursive: true });
    writeFileSync(path.join(cwd, location, 'package.json'), JSON.stringify(manifest));
    if (license !== undefined) writeFileSync(path.join(cwd, location, 'LICENSE'), license);
  }

  /**
   * The inherited license is what the whole gate is measured against, so each
   * rule of the map gets its own case — including the precedence one, where a
   * directory named "ee" that happens to carry an Apache LICENSE is still EE.
   */
  describe('expectedLicense', () => {
    it('reads Apache-2.0 for a directory with no LICENSE of its own', () => {
      pkg('packages/plain', { name: 'plain', private: true });
      expect(expectedLicense(cwd, 'packages/plain')).toBe('Apache-2.0');
    });

    it('reads Apache-2.0 for a directory carrying its own copy of the Apache text', () => {
      pkg('packages/pub', { name: 'pub' }, APACHE_TEXT);
      expect(expectedLicense(cwd, 'packages/pub')).toBe('Apache-2.0');
    });

    it('reads EE for a directory carrying the Enterprise text under another name', () => {
      pkg('packages/ee-license', { name: 'ee-license', private: true }, EE_TEXT);
      expect(expectedLicense(cwd, 'packages/ee-license')).toBe(EE_LICENSE_FIELD);
    });

    it('reads EE for any directory named "ee", with or without its own LICENSE', () => {
      expect(expectedLicense(cwd, 'apps/dashboard/ee')).toBe(EE_LICENSE_FIELD);
    });

    it('lets the "ee" name win over an Apache LICENSE sitting inside it', () => {
      // ee/LICENSE self-scopes to every directory of that name, so a stray
      // permissive file inside one must not widen the grant.
      pkg('packages/ee', { name: 'ee', private: true }, APACHE_TEXT);
      expect(expectedLicense(cwd, 'packages/ee')).toBe(EE_LICENSE_FIELD);
    });

    it('does not treat a directory merely containing "ee" as an EE directory', () => {
      pkg('packages/seed', { name: 'seed', private: true });
      expect(expectedLicense(cwd, 'packages/seed')).toBe('Apache-2.0');
    });
  });

  /**
   * Invariant 1. A declared license is a grant, so a wrong one has to fail;
   * an absent one is the legitimate "inherits the root" case and must not.
   */
  describe('checkDeclaredLicenses', () => {
    it('reports a foreign declaration inside the Apache zone', () => {
      pkg('packages/costs', { name: '@repo/llm-costs', private: true, license: 'MIT' });
      expect(checkDeclaredLicenses(loadWorkspaces(cwd), cwd)).toEqual([
        'packages/costs (@repo/llm-costs): declares "MIT" but the license map puts it under "Apache-2.0"',
      ]);
    });

    it('reports a copyleft declaration on an Apache-2.0 published package', () => {
      pkg('packages/cli', { name: 'cli', license: 'AGPL-3.0-only' }, APACHE_TEXT);
      expect(checkDeclaredLicenses(loadWorkspaces(cwd), cwd)).toEqual([
        'packages/cli (cli): declares "AGPL-3.0-only" but the license map puts it under "Apache-2.0"',
      ]);
    });

    it('accepts a package whose declaration matches its directory', () => {
      pkg('packages/cli', { name: 'cli', license: 'Apache-2.0' }, APACHE_TEXT);
      pkg('packages/costs', { name: 'costs', private: true, license: 'Apache-2.0' });
      pkg('packages/ee-license', { name: 'ee-license', private: true, license: EE_LICENSE_FIELD }, EE_TEXT);
      expect(checkDeclaredLicenses(loadWorkspaces(cwd), cwd)).toEqual([]);
    });

    it('accepts a private package that declares no license at all', () => {
      pkg('packages/quiet', { name: 'quiet', private: true });
      expect(checkDeclaredLicenses(loadWorkspaces(cwd), cwd)).toEqual([]);
    });

    it('reports every offender rather than stopping at the first', () => {
      pkg('packages/a', { name: 'a', private: true, license: 'MIT' });
      pkg('packages/b', { name: 'b', private: true, license: 'ISC' });
      expect(checkDeclaredLicenses(loadWorkspaces(cwd), cwd)).toEqual([
        'packages/a (a): declares "MIT" but the license map puts it under "Apache-2.0"',
        'packages/b (b): declares "ISC" but the license map puts it under "Apache-2.0"',
      ]);
    });
  });

  /**
   * Invariant 2. The tarball is all a consumer gets, so the LICENSE file and
   * the three attribution fields have to be on the package itself.
   */
  describe('checkPublishedMetadata', () => {
    const PUBLISHED = {
      name: '@outerlayer/thing',
      license: 'Apache-2.0',
      author: 'Magu Studios, Inc.',
      repository: { type: 'git', url: 'git+https://example.invalid/app.git' },
    };

    it('accepts a published package carrying its LICENSE and all three fields', () => {
      pkg('packages/thing', PUBLISHED, APACHE_TEXT);
      expect(checkPublishedMetadata(loadWorkspaces(cwd), cwd)).toEqual([]);
    });

    it('reports each missing field by name', () => {
      const { author, repository, ...rest } = PUBLISHED;
      pkg('packages/thing', rest, APACHE_TEXT);
      expect(checkPublishedMetadata(loadWorkspaces(cwd), cwd)).toEqual([
        'packages/thing (@outerlayer/thing): published but package.json has no "author"',
        'packages/thing (@outerlayer/thing): published but package.json has no "repository"',
      ]);
    });

    it('reports a published package that ships no LICENSE file', () => {
      pkg('packages/thing', PUBLISHED);
      expect(checkPublishedMetadata(loadWorkspaces(cwd), cwd)).toEqual([
        'packages/thing (@outerlayer/thing): published but ships no LICENSE file',
      ]);
    });

    it('exempts a private package, which never leaves the monorepo', () => {
      pkg('packages/internal', { name: '@repo/internal', private: true });
      expect(checkPublishedMetadata(loadWorkspaces(cwd), cwd)).toEqual([]);
    });
  });

  /**
   * Invariant 3. A row pointing at a deleted directory reads as a live
   * carve-out; the parser has to find directory paths without dragging in the
   * package names and license ids that share the file's backticks.
   */
  describe('mappedDirectories', () => {
    it('takes the trailing-slash paths and leaves every other backticked token', () => {
      const md = [
        'The published packages (`@outerlayer/*` and the `outerlayer` CLI),',
        '`packages/model-registry/`, `actions/eval-action/`, and any directory named `ee/`.',
        'See `./ee/LICENSE` and `LICENSE`, or the `apps/tenant-dashboard/ee/` subtree.',
      ].join('\n');
      expect(mappedDirectories(md)).toEqual([
        'actions/eval-action',
        'apps/tenant-dashboard/ee',
        'ee',
        'packages/model-registry',
      ]);
    });

    it('finds nothing in a map with no directory references', () => {
      expect(mappedDirectories('Licensed `Apache-2.0` or `AGPL-3.0-only`.')).toEqual([]);
    });
  });

  describe('checkMappedDirectories', () => {
    it('reports a mapped directory that does not exist', () => {
      mkdirSync(path.join(cwd, 'packages/real'), { recursive: true });
      writeFileSync(
        path.join(cwd, 'LICENSING.md'),
        'Apache-2.0 covers `packages/real/` and `toolkit-docs/`.',
      );
      expect(checkMappedDirectories(cwd)).toEqual([
        'LICENSING.md maps `toolkit-docs/`, which is not a directory in this repo',
      ]);
    });

    it('reports a mapped path that exists but is a file', () => {
      writeFileSync(path.join(cwd, 'notes'), 'not a directory');
      writeFileSync(path.join(cwd, 'LICENSING.md'), 'See `notes/`.');
      expect(checkMappedDirectories(cwd)).toEqual([
        'LICENSING.md maps `notes/`, which is not a directory in this repo',
      ]);
    });

    it('rejects a mapped path that resolves outside the repo, even when it exists', () => {
      // ../<sibling> exists on disk, so without the containment check the
      // existence test would pass and the gate would vouch for a directory
      // it never inspected.
      mkdirSync(path.join(cwd, '..', 'outside-sibling'), { recursive: true });
      writeFileSync(path.join(cwd, 'LICENSING.md'), 'See `../outside-sibling/`.');
      expect(checkMappedDirectories(cwd)).toEqual([
        'LICENSING.md maps `../outside-sibling/`, which resolves outside this repo',
      ]);
    });

    it('accepts a map whose directories all exist', () => {
      mkdirSync(path.join(cwd, 'packages/real'), { recursive: true });
      writeFileSync(path.join(cwd, 'LICENSING.md'), 'Apache-2.0 covers `packages/real/`.');
      expect(checkMappedDirectories(cwd)).toEqual([]);
    });

    it('reports a missing LICENSING.md rather than passing vacuously', () => {
      expect(checkMappedDirectories(cwd)).toEqual([
        'LICENSING.md is missing — the license map is the map of record',
      ]);
    });
  });

  /**
   * A workspace glob the expander cannot handle must throw, not resolve to
   * nothing: silently skipping it would take those workspaces out of the
   * gate's reach while the gate still reported OK.
   */
  describe('expandWorkspaceGlobs', () => {
    it('expands a trailing-star glob to its child directories', () => {
      mkdirSync(path.join(cwd, 'packages/a'), { recursive: true });
      mkdirSync(path.join(cwd, 'packages/b'), { recursive: true });
      mkdirSync(path.join(cwd, 'packages/node_modules'), { recursive: true });
      expect(expandWorkspaceGlobs(cwd, ['packages/*'])).toEqual(['packages/a', 'packages/b']);
    });

    it('throws on a glob shape it cannot expand', () => {
      expect(() => expandWorkspaceGlobs(cwd, ['packages/*/*'])).toThrow(
        /Unsupported workspace glob "packages\/\*\/\*"/,
      );
    });
  });

  /**
   * End-to-end through the real CLI entrypoint, which is how CI invokes it:
   * `node scripts/ci/check-license-map.mjs` from the repo root, no arguments.
   */
  describe('CLI', () => {
    function run(root: string) {
      return spawnSync(process.execPath, [GATE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, LICENSE_MAP_CWD: root, GITHUB_STEP_SUMMARY: '' },
      });
    }

    it('exits 1 and names the offender on a repo that contradicts the map', () => {
      pkg('packages/costs', { name: '@repo/llm-costs', private: true, license: 'MIT' });
      writeFileSync(path.join(cwd, 'LICENSING.md'), 'Everything else is Apache-2.0.');
      const result = run(cwd);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        '- WRONG LICENSE: packages/costs (@repo/llm-costs): declares "MIT" but the license map puts it under "Apache-2.0"',
      );
    });

    it('exits 0 on a repo that agrees with the map', () => {
      pkg('packages/costs', { name: '@repo/llm-costs', private: true, license: 'Apache-2.0' });
      writeFileSync(path.join(cwd, 'LICENSING.md'), 'Everything else is Apache-2.0.');
      const result = run(cwd);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('OK — 1 workspaces checked');
    });

    it('exits 0 on this repository', () => {
      // The gate is only useful if the tree it guards currently passes it.
      const result = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect([result.status, result.stdout.includes('OK —')]).toEqual([0, true]);
    });
  });
});
