import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'glob';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import {
  isNegationPattern,
  findStrykerConfigs,
  unmatchedPatterns,
  unmatchedScopedFloorFiles,
  parseNightlyMutateEntries,
  isKnownStaleNightlyTarget,
  staleEntriesThatNowResolve,
  KNOWN_STALE_NIGHTLY_MUTATE_TARGETS,
} from '../ci/check-stryker-mutate-targets.mjs';
// @ts-expect-error — .mjs gate script, no type declarations; plain JS exports.
import { SCOPED_FLOORS } from '../ci/patch-mutation.mjs';

describe('isNegationPattern', () => {
  it('treats a leading `!` as a negation, not a target', () => {
    expect(isNegationPattern('!src/**/*.test.ts')).toBe(true);
    expect(isNegationPattern('src/features/billing/actions.ts')).toBe(false);
  });
});

/**
 * A stale `mutate` pattern (renamed/deleted file, or a glob that no longer
 * matches anything) must be caught — that's the whole point of this gate. A
 * negation pattern must never be treated as a target: `!src/**\/*.test.ts`
 * legitimately matches nothing on its own (it only subtracts from a positive
 * match), so flagging it would make the gate permanently red.
 */
describe('unmatchedPatterns', () => {
  it('flags a positive pattern that resolves to no files', () => {
    const resolve = (p: string) => (p === 'src/deleted-file.ts' ? [] : ['src/real-file.ts']);
    expect(unmatchedPatterns(['src/deleted-file.ts', 'src/real-file.ts'], resolve)).toEqual([
      'src/deleted-file.ts',
    ]);
  });

  it('never flags a negation pattern, even when it resolves to nothing', () => {
    const resolve = () => [];
    expect(unmatchedPatterns(['!src/**/*.test.ts'], resolve)).toEqual([]);
  });

  it('returns nothing when every positive pattern resolves', () => {
    const resolve = () => ['src/real-file.ts'];
    expect(unmatchedPatterns(['src/a.ts', 'src/b.ts', '!src/**/*.test.ts'], resolve)).toEqual([]);
  });
});

describe('unmatchedScopedFloorFiles', () => {
  const scoped = [
    {
      key: 'apps/tenant-dashboard:money-auth',
      workspace: 'apps/tenant-dashboard',
      files: ['src/features/billing/actions.ts', 'src/deleted.ts'],
    },
  ];

  it('flags a SCOPED_FLOORS file entry that does not exist', () => {
    const exists = (_ws: string, file: string) => file !== 'src/deleted.ts';
    expect(unmatchedScopedFloorFiles(scoped, exists)).toEqual([
      { key: 'apps/tenant-dashboard:money-auth', workspace: 'apps/tenant-dashboard', file: 'src/deleted.ts' },
    ]);
  });

  it('flags nothing when every file exists', () => {
    expect(unmatchedScopedFloorFiles(scoped, () => true)).toEqual([]);
  });
});

/**
 * Regression guard for the defect this gate exists to catch: a real
 * SCOPED_FLOORS entry (the money-and-auth path-scoped floor) drifted to a
 * deleted file for months with nothing failing loudly. Runs the SAME check
 * this gate enforces in CI against the SAME data structure it reads there —
 * if a future refactor deletes one of these files without updating
 * SCOPED_FLOORS, this test fails locally before the gate ever needs to.
 */
describe('unmatchedScopedFloorFiles — against the real SCOPED_FLOORS', () => {
  it('every real SCOPED_FLOORS file exists on disk', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const exists = (workspace: string, file: string) => {
      try {
        return globSync(file, { cwd: path.join(repoRoot, workspace), nodir: true }).length > 0;
      } catch {
        return false;
      }
    };
    expect(unmatchedScopedFloorFiles(SCOPED_FLOORS, exists)).toEqual([]);
  });
});

/**
 * The nightly workflow's `mutate` job overrides a workspace's mutate glob
 * per-shard via an inline `mutate:` string in its matrix — a mechanism
 * entirely separate from `stryker.config*.mjs` (CLI `--mutate` beats the
 * config file). It needs its own parser because it's a different file with
 * different syntax: a fix to the `.mjs` config alone can leave a matching
 * YAML entry stale with nothing else noticing.
 */
describe('parseNightlyMutateEntries', () => {
  const fixtureYaml = `
jobs:
  mutate:
    strategy:
      matrix:
        workspace:
          - { path: apps/gateway, name: gateway-queues, pkg: gateway,
              mutate: 'src/queues/traces-queue.ts,!src/**/*.test.ts,!src/**/*.d.ts' }
          - { path: apps/tenant-dashboard, name: tenant-dashboard, pkg: tenant-dashboard }
          - { path: packages/entitlements, name: entitlements, pkg: '@repo/entitlements',
              mutate: 'src/resolver.ts, src/other.ts ,!src/**/*.test.ts' }
  aggregate-gateway:
    steps: []
`;

  it('extracts name/path/patterns for entries that carry an inline mutate override', () => {
    expect(parseNightlyMutateEntries(fixtureYaml)).toEqual([
      {
        name: 'gateway-queues',
        path: 'apps/gateway',
        patterns: ['src/queues/traces-queue.ts', '!src/**/*.test.ts', '!src/**/*.d.ts'],
      },
      {
        name: 'entitlements',
        path: 'packages/entitlements',
        patterns: ['src/resolver.ts', 'src/other.ts', '!src/**/*.test.ts'],
      },
    ]);
  });

  it('omits entries with no mutate field (they inherit their workspace config)', () => {
    const names = parseNightlyMutateEntries(fixtureYaml).map((e: { name: string }) => e.name);
    expect(names).not.toContain('tenant-dashboard');
  });

  it('returns an empty array when the workflow has no mutate job', () => {
    expect(parseNightlyMutateEntries('jobs:\n  other-job:\n    steps: []\n')).toEqual([]);
  });
});

/**
 * Regression guard for the gap the cold review caught: the guard originally
 * only scanned `stryker.config*.mjs` files, so a nightly matrix `mutate:`
 * string could drift to a deleted file and pass the gate. This proves the
 * SAME shape of probe the reviewer ran against a config file — a bogus path
 * fed through the real parser and resolver — is caught for a YAML entry too.
 */
describe('parseNightlyMutateEntries + unmatchedPatterns — a bogus YAML matrix path fails', () => {
  it('flags a nightly matrix mutate pattern that resolves to no file', () => {
    const yamlWithBogusPath = `
jobs:
  mutate:
    strategy:
      matrix:
        workspace:
          - { path: apps/gateway, name: gateway-fake-shard, pkg: gateway,
              mutate: 'src/this-file-does-not-exist.ts,!src/**/*.test.ts' }
`;
    const [entry] = parseNightlyMutateEntries(yamlWithBogusPath);
    const resolve = (p: string) => (p === 'src/this-file-does-not-exist.ts' ? [] : ['src/real.ts']);
    expect(unmatchedPatterns(entry.patterns, resolve)).toEqual(['src/this-file-does-not-exist.ts']);
  });
});

/**
 * The known-stale allowlist exists so an already-identified route-shard
 * target (removed by a product-surface retirement, pending a shard
 * re-derive) doesn't red the gate on every run — but it must not become a
 * blanket exemption. A stale pattern NOT on the list has to fail exactly
 * like before. Exercised against a local fixture, not the real (currently
 * empty) `KNOWN_STALE_NIGHTLY_MUTATE_TARGETS`, so this test stays meaningful
 * whether or not the repo is carrying any stale entries right now.
 */
describe('isKnownStaleNightlyTarget', () => {
  const fixture = [{ shard: 'some-shard', pattern: 'src/openapi/routes/some-removed-file.ts' }];

  it('matches an entry on the allowlist by shard + pattern', () => {
    expect(isKnownStaleNightlyTarget(fixture[0]!.shard, fixture[0]!.pattern, fixture)).toBe(true);
  });

  it('does not match a new stale pattern in the same shard the allowlist already covers', () => {
    expect(
      isKnownStaleNightlyTarget(fixture[0]!.shard, 'src/openapi/routes/some-other-new-file.ts', fixture),
    ).toBe(false);
  });

  it('does not match a stale pattern in a shard the allowlist has never seen', () => {
    expect(isKnownStaleNightlyTarget('some-unrelated-shard', 'src/anything.ts', fixture)).toBe(false);
  });

  it('defaults to the real allowlist, currently empty for gateway-core', () => {
    expect(KNOWN_STALE_NIGHTLY_MUTATE_TARGETS).toEqual([]);
    expect(isKnownStaleNightlyTarget('gateway-routes-apps', 'src/openapi/routes/apps.ts')).toBe(false);
  });
});

/**
 * SHRINK-ONLY enforcement, the other direction: once a listed shard is
 * repointed, its allowlist line must be deleted — this fails loudly if one
 * is left behind pointing at a pattern that now resolves.
 */
describe('staleEntriesThatNowResolve', () => {
  const known = [
    { shard: 'gateway-routes-small-a', pattern: 'src/openapi/routes/templates.ts' },
    { shard: 'gateway-routes-datasets', pattern: 'src/openapi/routes/datasets.ts' },
  ];

  it('flags a known-stale entry whose shard was repointed but the allowlist line was not removed', () => {
    const resolve = (shard: string, pattern: string) =>
      shard === 'gateway-routes-small-a' ? ['src/openapi/routes/templates.ts'] : [];
    expect(staleEntriesThatNowResolve(known, resolve)).toEqual([known[0]]);
  });

  it('flags nothing while every known-stale entry is still genuinely unresolved', () => {
    expect(staleEntriesThatNowResolve(known, () => [])).toEqual([]);
  });
});

/**
 * `findStrykerConfigs` must find every `stryker.config*.mjs` under apps/ and
 * packages/ — including suffixed variants (`.money-auth.mjs`, `.patch.mjs`),
 * which is exactly where the money-auth drift hid (the base config wasn't
 * the only file with a stale `mutate` target).
 */
describe('findStrykerConfigs', () => {
  let dir: string;

  const write = (relPath: string, content = 'export default {};\n') => {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it('finds base and suffixed configs under apps/ and packages/, ignores unrelated files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stryker-config-fixture-'));
    try {
      write('apps/foo/stryker.config.mjs');
      write('apps/foo/stryker.config.money-auth.mjs');
      write('apps/foo/stryker.config.patch.mjs');
      write('packages/bar/stryker.config.mjs');
      write('apps/foo/not-a-stryker-config.mjs');
      write('apps/foo/vitest.config.ts', '');

      expect(findStrykerConfigs(dir)).toEqual([
        'apps/foo/stryker.config.mjs',
        'apps/foo/stryker.config.money-auth.mjs',
        'apps/foo/stryker.config.patch.mjs',
        'packages/bar/stryker.config.mjs',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
