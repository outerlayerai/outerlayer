import { describe, expect, it } from 'vitest';
import {
  targetsForChange,
  thresholdForWorkspace,
  scopeGroups,
  scopedFloorFor,
  thresholdGroupsFor,
  renderGroupResult,
  shardTargets,
  targetWeight,
  parseReport,
  isAllNoCoverage,
  addedLineRanges,
  parseChangedEntries,
  parseUnifiedDiff,
  mutatePatternsFor,
  unmatchedMutateTargets,
  // @ts-expect-error — .mjs gate script, no type declarations; the export is plain JS.
} from '../ci/patch-mutation.mjs';

/**
 * The patch-mutation gate validates CHANGED PRODUCTION CODE. `targetsForChange`
 * decides which source file(s) a changed path pulls into the mutate set; a
 * test-only PR must pull in NONE (so it is skipped), while a changed source
 * file gates itself. Regression guard for the fix that stopped a changed test
 * from dragging its whole source dir — including uncoverable React components —
 * into the gate, which made adding tests to undertested code unshippable.
 */
describe('patch-mutation targetsForChange — gate scope', () => {
  it('maps a changed .ts source file to itself', () => {
    expect(targetsForChange('apps/x/src/foo.ts')).toEqual(['apps/x/src/foo.ts']);
  });

  it('contributes NO targets for a .tsx React component (matches the nightly, which mutates .ts logic only)', () => {
    // Component diffs are dominated by presentational mutants (MUI `sx` style
    // objects, conditional JSX) whose only kill is a brittle computed-style
    // assertion. Real component logic belongs in a `.ts` module, which IS graded.
    expect(targetsForChange('apps/x/src/foo.tsx')).toEqual([]);
    expect(targetsForChange('apps/x/src/sections/y/widget.tsx')).toEqual([]);
  });

  it('contributes NO targets for a test-only change (gate skips test-only PRs)', () => {
    // Co-located and __tests__ suites alike: a test change is not a source
    // change, so it never pulls a source file into the mutate set.
    expect(targetsForChange('apps/x/src/foo.test.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/foo.spec.tsx')).toEqual([]);
    expect(
      targetsForChange('apps/x/src/sections/y/__tests__/actions.test.ts'),
    ).toEqual([]);
  });

  it('never targets type declarations, generated code, or test scaffolding', () => {
    expect(targetsForChange('apps/x/src/types.d.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/test-helpers/seed.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/generated/api.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/__mocks__/thing.ts')).toEqual([]);
  });

  it('never targets high-fan-in declarative env/config wiring', () => {
    // env.ts + config-global[.server].ts are imported app-wide; mutating them
    // re-runs ~the whole suite per mutant for near-zero signal. Excluded so a
    // PR touching env/config doesn't blow the patch-mutation budget. Their
    // logic is covered by unit tests + the env-default-invariant guard.
    expect(targetsForChange('apps/x/src/env.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/config-global.server.ts')).toEqual([]);
    expect(targetsForChange('apps/x/src/config-global.ts')).toEqual([]);
  });

  it('still targets ordinary source files that merely share a prefix', () => {
    // The exclusion is exact-basename, not substring: a real logic file whose
    // name happens to contain "env"/"config" must still be mutated.
    expect(targetsForChange('apps/x/src/env-utils.ts')).toEqual([
      'apps/x/src/env-utils.ts',
    ]);
    expect(targetsForChange('apps/x/src/config/stripe-prices.ts')).toEqual([
      'apps/x/src/config/stripe-prices.ts',
    ]);
  });

  it('ignores non-source files', () => {
    expect(targetsForChange('apps/x/README.md')).toEqual([]);
    expect(targetsForChange('apps/x/src/styles.css')).toEqual([]);
  });
});

/**
 * The PR gate must never be weaker than the nightly: a workspace with a high
 * nightly floor (e.g. api-key-service 87) should be held to that floor on
 * changed code, not the flat base of 60 — otherwise a PR can drag a sensitive
 * file from 87 to 65, pass the PR gate, and only fail the next-day nightly
 * AFTER it has merged and deployed.
 */
describe('patch-mutation thresholdForWorkspace — PR bar >= nightly floor', () => {
  const floors = {
    'apps/gateway': 77,
    'apps/gateway:shard-floor': 30,
    'apps/tenant-dashboard': 49,
    'packages/api-key-service': 87,
    'packages/llm-costs': null,
  };

  it('uses the nightly floor when it exceeds the base', () => {
    expect(thresholdForWorkspace('packages/api-key-service', floors, 60)).toBe(87);
    expect(thresholdForWorkspace('apps/gateway', floors, 60)).toBe(77);
  });

  it('keeps the base when the floor is lower than the base', () => {
    // tenant-dashboard's nightly floor is 49 — the PR gate must NOT drop below 60.
    expect(thresholdForWorkspace('apps/tenant-dashboard', floors, 60)).toBe(60);
  });

  it('falls back to the base for a null floor (baseline pending)', () => {
    expect(thresholdForWorkspace('packages/llm-costs', floors, 60)).toBe(60);
  });

  it('falls back to the base for a workspace with no floor entry', () => {
    expect(thresholdForWorkspace('apps/builder', floors, 60)).toBe(60);
  });

  it('never matches a suffixed key like <ws>:shard-floor as a workspace id', () => {
    // The shard-floor entry is 30; if it ever leaked into the lookup it would
    // WEAKEN the gate. The exact-id lookup for apps/gateway must return 77.
    expect(thresholdForWorkspace('apps/gateway', floors, 60)).toBe(77);
  });
});

/**
 * One Stryker run uses one test-discovery scope. Non-gateway workspaces run all
 * their changed files together; BOTH gateway workspaces (packages/gateway-core
 * and apps/gateway) must split by source area (their suites overrun Stryker's
 * perTest analysis under a single config), and files no shard mutates are
 * surfaced as skipped rather than gated.
 */
describe('patch-mutation scopeGroups — per-run scoping', () => {
  it('runs a non-gateway workspace as a single group with no scoping env', () => {
    expect(scopeGroups('apps/tenant-dashboard', ['src/a.ts', 'src/b.ts'])).toEqual({
      groups: [{ label: null, files: ['src/a.ts', 'src/b.ts'], env: {} }],
      skipped: [],
    });
  });

  it('splits gateway-core files across source areas into separate scoped runs', () => {
    const { groups, skipped } = scopeGroups('packages/gateway-core', [
      'src/services/traces-service.ts',
      'src/openapi/routes/traces.ts',
    ]);
    expect(skipped).toEqual([]);
    expect(groups).toEqual([
      {
        label: 'src/services',
        files: ['src/services/traces-service.ts'],
        env: { STRYKER_VITEST_DIR: 'src/services' },
      },
      {
        label: 'src/openapi',
        files: ['src/openapi/routes/traces.ts'],
        env: { STRYKER_VITEST_DIR: 'src/openapi' },
      },
    ]);
  });

  it('scopes gateway-core git to its own dir (no more shared-shard include hack)', () => {
    // git is scoped to its own dir in gateway-core, with a clean single dir.
    const { groups, skipped } = scopeGroups('packages/gateway-core', ['src/git/crypto.ts']);
    expect(skipped).toEqual([]);
    expect(groups).toEqual([
      { label: 'src/git', files: ['src/git/crypto.ts'], env: { STRYKER_VITEST_DIR: 'src/git' } },
    ]);
  });

  it('scopes apps/gateway Cloudflare-shell files (queues, durable-objects) per dir', () => {
    const { groups, skipped } = scopeGroups('apps/gateway', [
      'src/queues/traces-queue.ts',
      'src/durable-objects/app-connection.ts',
    ]);
    expect(skipped).toEqual([]);
    expect(groups).toEqual([
      {
        label: 'src/queues',
        files: ['src/queues/traces-queue.ts'],
        env: { STRYKER_VITEST_DIR: 'src/queues' },
      },
      {
        label: 'src/durable-objects',
        files: ['src/durable-objects/app-connection.ts'],
        env: { STRYKER_VITEST_DIR: 'src/durable-objects' },
      },
    ]);
  });

  it('skips a file that belongs to the OTHER gateway workspace (cross-workspace guard)', () => {
    // openapi/routes lives in gateway-core; under apps/gateway it maps to no
    // shard, so it is surfaced as skipped rather than gated.
    const { groups, skipped } = scopeGroups('apps/gateway', [
      'src/queues/traces-queue.ts',
      'src/openapi/routes/traces.ts',
    ]);
    expect(skipped).toEqual(['src/openapi/routes/traces.ts']);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toEqual(['src/queues/traces-queue.ts']);
  });

  it('surfaces out-of-scope gateway files as skipped, not gated', () => {
    const { groups, skipped } = scopeGroups('packages/gateway-core', [
      'src/services/traces-service.ts',
      'src/stores/app-store.ts',
    ]);
    expect(skipped).toEqual(['src/stores/app-store.ts']);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toEqual(['src/services/traces-service.ts']);
  });
});

/**
 * renderGroupResult turns a Stryker run result into report lines + a fail
 * verdict — the logic that actually decides red vs green, pinned here without
 * spawning Stryker.
 *
 * The case that matters most is `budgetExceeded`: a run that outran the PR
 * wall-clock budget MUST degrade to an advisory pass. Before the self-budget,
 * an over-long run let the JOB hit timeout-minutes → GitHub cancelled it → the
 * CI Gate went red on a mergeable PR. These are the regression guards for that
 * fix and for the existing fake-green-catch behavior it was extracted from.
 */
describe('patch-mutation renderGroupResult — verdict (red vs green)', () => {
  const lowScore = {
    killed: 2,
    survived: 8,
    timeout: 0,
    noCoverage: 0,
    total: 10,
    score: 20,
    survivors: ['foo.ts:3 BooleanLiteral', 'foo.ts:9 ConditionalExpression'],
  };

  it('over-budget degrades to an advisory pass, never a failure', () => {
    const { failed, lines } = renderGroupResult({ budgetExceeded: true }, 60);
    expect(failed).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('budget');
    // points the reader at the real enforcer so "not enforced" isn't read as "skipped forever"
    expect(text).toContain('stryker-nightly.yml');
    // the whole point: an over-budget run must not render a failure marker
    expect(text).not.toContain('❌');
  });

  it('passes its budget minutes through to the advisory message', () => {
    const { lines } = renderGroupResult({ budgetExceeded: true }, 60, 8, 24);
    expect(lines.join('\n')).toContain('24-min PR budget');
  });

  it('treats a missing report (infra / unmutatable) as advisory, not a failure', () => {
    const { failed, lines } = renderGroupResult(null, 60);
    expect(failed).toBe(false);
    expect(lines[0]).toContain('⚠️');
    expect(lines[0]).toContain('not enforced');
  });

  it('FAILS on a real low score and lists the surviving mutants (the fake-green catch)', () => {
    const { failed, lines } = renderGroupResult(lowScore, 60);
    expect(failed).toBe(true);
    expect(lines[0]).toContain('❌');
    expect(lines[0]).toContain('20.0%');
    expect(lines[0]).toContain('2/10 killed');
    expect(lines[0]).toContain('threshold 60%');
    // survivors are surfaced positionally so the author knows WHERE tests are weak
    expect(lines).toContain('- foo.ts:3 BooleanLiteral');
    expect(lines).toContain('- foo.ts:9 ConditionalExpression');
  });

  it('passes when the score clears the threshold and emits no survivor spam', () => {
    const { failed, lines } = renderGroupResult(
      { killed: 9, survived: 1, timeout: 0, noCoverage: 0, total: 10, score: 90, survivors: ['x'] },
      60,
    );
    expect(failed).toBe(false);
    expect(lines[0]).toContain('✅');
    expect(lines[0]).toContain('90.0%');
    expect(lines.join('\n')).not.toContain('Surviving mutants');
  });

  it('does NOT enforce below the minimum mutant count (too few to judge)', () => {
    const { failed, lines } = renderGroupResult(
      { killed: 0, survived: 3, timeout: 0, noCoverage: 0, total: 3, score: 0, survivors: ['a', 'b', 'c'] },
      60,
      8,
    );
    expect(failed).toBe(false);
    expect(lines[0]).toContain('ℹ️');
    expect(lines[0]).toContain('not enforced (<8 mutants)');
  });

  it('truncates a long survivor list to 30 with a "…and N more" line', () => {
    const survivors = Array.from({ length: 42 }, (_, i) => `foo.ts:${i} ArithmeticOperator`);
    const { failed, lines } = renderGroupResult(
      { killed: 0, survived: 42, timeout: 0, noCoverage: 0, total: 42, score: 0, survivors },
      60,
    );
    expect(failed).toBe(true);
    const bullets = lines.filter((l: string) => l.startsWith('- foo.ts:'));
    expect(bullets).toHaveLength(30);
    expect(lines).toContain('- …and 12 more');
  });
});

/**
 * Path-scoped floors hold a high-blast-radius FILE to a stricter bar than its
 * workspace's general floor. The money-and-auth core (the billing feature
 * slice's actions + service, and the payment webhook) lives in tenant-dashboard
 * (lax 49 workspace floor) but must clear its own dedicated floor — otherwise a
 * flipped authz/quota comparison in a billing action merges green at the
 * workspace bar.
 */
describe('patch-mutation scopedFloorFor — path-scoped bar lookup', () => {
  const floors = {
    'apps/tenant-dashboard': 49,
    'apps/tenant-dashboard:money-auth': 85,
  };

  it('returns the scoped floor for a file in the money-auth scope', () => {
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/features/billing/actions.ts', floors),
    ).toBe(85);
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/app/api/webhooks/payment/route.ts', floors),
    ).toBe(85);
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/config/stripe-prices.ts', floors),
    ).toBe(85);
  });

  it('returns null for a file not in any scope (caller uses the workspace floor)', () => {
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/features/billing/other.ts', floors),
    ).toBeNull();
  });

  it('returns null when the scope key is absent or null (baseline pending)', () => {
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/features/billing/actions.ts', {
        'apps/tenant-dashboard': 49,
        'apps/tenant-dashboard:money-auth': null,
      }),
    ).toBeNull();
    expect(
      scopedFloorFor('apps/tenant-dashboard', 'src/features/billing/actions.ts', {
        'apps/tenant-dashboard': 49,
      }),
    ).toBeNull();
  });

  it('does not apply a scope to the wrong workspace', () => {
    expect(
      scopedFloorFor('apps/gateway', 'src/features/billing/actions.ts', floors),
    ).toBeNull();
  });
});

/**
 * Scope groups must be split by effective threshold so each file is graded at
 * exactly its own bar. A money-auth file (85) and an ordinary tenant-dashboard
 * file (60) changed in the same PR must run as two groups — a single combined
 * run yields one score and would grade the ordinary file at 85 (false block) or
 * the money file at 60 (silent weakening).
 */
describe('patch-mutation thresholdGroupsFor — split by effective bar', () => {
  const floors = {
    'apps/tenant-dashboard': 49,
    'apps/tenant-dashboard:money-auth': 85,
  };

  it('keeps a non-scoped group at the workspace threshold (max with base)', () => {
    const groups = [{ label: null, files: ['src/features/billing/other.ts'], env: {} }];
    const result = thresholdGroupsFor('apps/tenant-dashboard', groups, floors, 60);
    expect(result).toHaveLength(1);
    expect(result[0].threshold).toBe(60); // max(60, 49)
    expect(result[0].files).toEqual(['src/features/billing/other.ts']);
  });

  it('uses the scoped floor for a money-auth file', () => {
    const groups = [
      { label: null, files: ['src/features/billing/actions.ts'], env: {} },
    ];
    const result = thresholdGroupsFor('apps/tenant-dashboard', groups, floors, 60);
    expect(result).toHaveLength(1);
    expect(result[0].threshold).toBe(85);
  });

  it('splits a mixed group into a 60-bar group and an 85-bar group, lower first', () => {
    const groups = [
      {
        label: null,
        files: [
          'src/features/billing/actions.ts', // scoped → 85
          'src/features/billing/other.ts', //   workspace → 60
        ],
        env: { FOO: 'bar' },
      },
    ];
    const result = thresholdGroupsFor('apps/tenant-dashboard', groups, floors, 60);
    expect(result).toEqual([
      { label: null, env: { FOO: 'bar' }, threshold: 60, files: ['src/features/billing/other.ts'] },
      { label: null, env: { FOO: 'bar' }, threshold: 85, files: ['src/features/billing/actions.ts'] },
    ]);
  });

  it('preserves the per-group scoping env when splitting (gateway-style groups)', () => {
    const groups = [
      { label: 'src/services', files: ['src/services/a.ts'], env: { STRYKER_VITEST_DIR: 'src/services' } },
    ];
    const result = thresholdGroupsFor('apps/gateway', { ...groups }[0] ? groups : [], { 'apps/gateway': 77 }, 60);
    expect(result).toHaveLength(1);
    expect(result[0].env).toEqual({ STRYKER_VITEST_DIR: 'src/services' });
    expect(result[0].threshold).toBe(77);
  });
});

/**
 * targetWeight proxies a changed target's mutant load for shard balancing: the
 * count of changed mutable lines, or the file's own length when the whole file
 * is mutated (ranges unknown/deletion-only). Wrong weights don't break the gate
 * (every target still runs in exactly one shard) but do un-balance the shards —
 * the tail this proxy exists to flatten — so pin the arithmetic exactly.
 */
describe('patch-mutation targetWeight — shard-balancing load proxy', () => {
  it('sums the changed-line count across ranges', () => {
    // 5 lines (11..15) + 1 line (30) = 6; wholeFileLines is irrelevant here.
    expect(targetWeight([{ start: 11, end: 15 }, { start: 30, end: 30 }], 999)).toBe(6);
  });

  it('weights a whole-file target (null ranges) by the file length', () => {
    expect(targetWeight(null, 120)).toBe(120);
  });

  it('weights an empty-range target (deletion-only shape) by the file length', () => {
    expect(targetWeight([], 80)).toBe(80);
  });

  it('never returns a zero weight (floors whole-file length at 1)', () => {
    expect(targetWeight(null, 0)).toBe(1);
  });
});

/**
 * shardTargets fans the changed-file set across N parallel CI shards by greedy
 * LPT bin-packing on estimated mutant load. Two invariants protect the gate:
 * every target is mutated in EXACTLY ONE shard (complete + disjoint), so
 * sharding changes WHERE a file runs, never WHETHER it's enforced; and the split
 * is deterministic, so a file lands on the same shard every run. Below the
 * min-size floor the split collapses to shard 1 so a tiny PR never pays a
 * tripled whole-suite dry-run.
 */
describe('patch-mutation shardTargets — parallel split preserves the gate', () => {
  const mk = (entries: Array<[string, string[]]>): Map<string, string[]> =>
    new Map(entries);
  const flatten = (m: Map<string, string[]>): string[] =>
    [...m].flatMap(([ws, files]) => files.map((f) => `${ws}/${f}`)).sort();
  const shardWeight = (m: Map<string, string[]>, weightOf: (ws: string, f: string) => number): number =>
    [...m].reduce((sum, [ws, files]) => sum + files.reduce((s, f) => s + weightOf(ws, f), 0), 0);

  it('no spec / single shard / malformed spec → unchanged (today’s behaviour)', () => {
    const m = mk([['apps/a', ['src/x.ts', 'src/y.ts']]]);
    expect(shardTargets(m, '')).toBe(m);
    expect(shardTargets(m, '1/1')).toBe(m);
    expect(shardTargets(m, 'nonsense')).toBe(m);
    expect(shardTargets(m, '4/3')).toBe(m); // k out of range
    expect(shardTargets(m, '1/0')).toBe(m); // n < 2
  });

  it('a diff below the min floor runs entirely on shard 1; other shards skip', () => {
    // 3 targets, min 4 → not worth fanning out (the per-shard dry-run would be
    // duplicated for no wall-clock gain). Count-based floor, not weight-based.
    const m = mk([['apps/a', ['src/a.ts', 'src/b.ts', 'src/c.ts']]]);
    expect(shardTargets(m, '1/3', 4)).toBe(m);
    expect(shardTargets(m, '2/3', 4).size).toBe(0);
    expect(shardTargets(m, '3/3', 4).size).toBe(0);
  });

  it('keeps a multi-file workspace on ONE shard when its weight fits the fair share', () => {
    // Two workspaces, each fitting a shard's fair share (total 12, ceil(12/2)=6,
    // each workspace = 6). A per-file split would fragment each workspace across
    // both shards, doubling its whole-suite dry-run; packing by workspace keeps
    // every workspace's files together on a single shard.
    const m = mk([
      ['apps/alpha', ['src/a1.ts', 'src/a2.ts', 'src/a3.ts']],
      ['apps/beta', ['src/b1.ts', 'src/b2.ts', 'src/b3.ts']],
    ]);
    const weightOf = (): number => 2;
    const s1 = shardTargets(m, '1/2', 4, weightOf);
    const s2 = shardTargets(m, '2/2', 4, weightOf);

    // Each workspace's files stay whole on one shard (positional, not just present).
    expect(flatten(s1)).toEqual([
      'apps/alpha/src/a1.ts',
      'apps/alpha/src/a2.ts',
      'apps/alpha/src/a3.ts',
    ]);
    expect(flatten(s2)).toEqual([
      'apps/beta/src/b1.ts',
      'apps/beta/src/b2.ts',
      'apps/beta/src/b3.ts',
    ]);

    // Complete + disjoint across the two shards.
    const union = [...flatten(s1), ...flatten(s2)].sort();
    expect(union).toEqual(flatten(m));
    expect(new Set(union).size).toBe(union.length);
  });

  it('LPT-balances a skewed diff: the heavy file lands alone, no shard exceeds 1.5x mean', () => {
    // One file carrying 4x the mutant load of eight one-line siblings. A naive
    // equal-count split would strand the heavy file on a shard alongside small
    // ones, leaving that shard the tail; LPT isolates it and spreads the rest.
    const m = mk([
      ['apps/dash', ['src/heavy.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']],
      ['apps/gw', ['src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts']],
    ]); // 9 targets
    const weightOf = (_ws: string, f: string): number => (f.endsWith('heavy.ts') ? 4 : 1);
    const shards = [1, 2, 3].map((k) => shardTargets(m, `${k}/3`, 4, weightOf));

    // Complete + disjoint: union == exact input set, no overlap.
    const union = shards.flatMap(flatten).sort();
    expect(union).toEqual(flatten(m));
    expect(new Set(union).size).toBe(union.length);

    // The heavy file is isolated on its own shard (positional, not just present).
    expect(flatten(shards[0])).toEqual(['apps/dash/src/heavy.ts']);

    // Balance: total weight 12 over 3 shards → mean 4; no shard exceeds 1.5x.
    const weights = shards.map((s) => shardWeight(s, weightOf));
    const mean = 12 / 3;
    expect(Math.max(...weights)).toBeLessThanOrEqual(1.5 * mean);
    // The concrete optimum for this input is a perfectly even 4/4/4 split.
    expect(weights).toEqual([4, 4, 4]);
  });

  it('assigns a file to the same shard regardless of map insertion order', () => {
    const a = mk([
      ['apps/a', ['src/z.ts', 'src/a.ts']],
      ['apps/b', ['src/m.ts', 'src/n.ts']],
    ]);
    const b = mk([
      ['apps/b', ['src/n.ts', 'src/m.ts']],
      ['apps/a', ['src/a.ts', 'src/z.ts']],
    ]);
    for (const k of ['1/3', '2/3', '3/3']) {
      expect(flatten(shardTargets(a, k, 4))).toEqual(flatten(shardTargets(b, k, 4)));
    }
  });
});

/**
 * parseReport turns a Stryker mutation.json into the score record the gate
 * grades against. The fake-green catch hinges on NoCoverage mutants counting
 * toward the denominator (an untested changed line drags the score down), so
 * pin that tally and the survivor labelling rather than just "it returns an
 * object".
 */
describe('patch-mutation parseReport — score tally', () => {
  const report = (mutants: Array<{ status: string; line?: number; mutatorName?: string }>) =>
    JSON.stringify({
      files: {
        'src/foo.ts': {
          mutants: mutants.map((m, i) => ({
            status: m.status,
            mutatorName: m.mutatorName ?? 'ConditionalExpression',
            location: { start: { line: m.line ?? i + 1 } },
          })),
        },
      },
    });

  it('counts Killed and Timeout as detected, Survived and NoCoverage as not', () => {
    const r = parseReport(
      report([
        { status: 'Killed' },
        { status: 'Killed' },
        { status: 'Timeout' },
        { status: 'Survived' },
        { status: 'NoCoverage' },
      ]),
    );
    expect(r).toEqual({
      killed: 2,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      total: 5,
      score: 60, // (2 killed + 1 timeout) / 5
      survivors: ['foo.ts:4 ConditionalExpression', 'foo.ts:5 ConditionalExpression (no coverage)'],
    });
  });

  it('excludes CompileError / RuntimeError / Ignored from the denominator', () => {
    const r = parseReport(
      report([
        { status: 'Killed' },
        { status: 'CompileError' },
        { status: 'RuntimeError' },
        { status: 'Ignored' },
      ]),
    );
    expect(r.total).toBe(1);
    expect(r.score).toBe(100);
    expect(r.survivors).toEqual([]);
  });

  it('scores an empty report as 100 (nothing to grade, never a false fail)', () => {
    expect(parseReport(JSON.stringify({ files: {} })).score).toBe(100);
  });
});

/**
 * addedLineRanges turns a unified-diff patch into the NEW-file line ranges the
 * gate mutates (Stryker mutation ranges). This is what lets the gate mutate a
 * 39-line diff instead of 2,122 lines of whole files: at whole-file scale the
 * run is ~840 mutants and 3-4 h, well past the nightly's 24-min budget, so it
 * enforces nothing. The subtlety that matters: API patches carry 3 context
 * lines per hunk and the
 * `+start,count` header counts them, so the parser must walk hunk BODIES — a
 * header-only implementation would mutate context lines the PR never touched.
 */
describe('patch-mutation addedLineRanges — diff → mutation ranges', () => {
  it('returns exactly the added lines, excluding hunk context lines', () => {
    // Hunk at new-file line 10 with 1 context line either side of 2 added
    // lines: header span is 10-13 but only 11-12 were added.
    const patch = [
      '@@ -10,2 +10,4 @@ function foo() {',
      ' context-before',
      '+added-one',
      '+added-two',
      ' context-after',
    ].join('\n');
    expect(addedLineRanges(patch)).toEqual([{ start: 11, end: 12 }]);
  });

  it('tracks the new-file counter across deletions (deleted lines consume none)', () => {
    // 2 deletions then 1 addition at new line 5: a parser that counted deleted
    // lines would misplace the range at 7.
    const patch = ['@@ -5,3 +5,1 @@', '-gone-one', '-gone-two', '+replacement'].join('\n');
    expect(addedLineRanges(patch)).toEqual([{ start: 5, end: 5 }]);
  });

  it('produces one range per disjoint hunk, in order', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' ctx',
      '+early',
      '@@ -100,1 +101,2 @@',
      ' ctx',
      '+late',
    ].join('\n');
    expect(addedLineRanges(patch)).toEqual([
      { start: 2, end: 2 },
      { start: 102, end: 102 },
    ]);
  });

  it('keeps additions separated by an unchanged context line as DISJOINT ranges', () => {
    // first=1, ctx=2 (untouched), third=3. Bridging the gap would mutate line
    // 2, which the PR never changed — the gate must grade only the diff.
    const patch = ['@@ -1,3 +1,4 @@', '+first', ' ctx', '+third', ' ctx'].join('\n');
    expect(addedLineRanges(patch)).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
    ]);
  });

  it('returns [] for a deletion-only patch (nothing to mutate → no target)', () => {
    expect(addedLineRanges('@@ -4,2 +3,0 @@\n-gone\n-also-gone')).toEqual([]);
  });

  it('returns null when no patch text is available (→ whole-file fallback)', () => {
    expect(addedLineRanges(undefined)).toBeNull();
    expect(addedLineRanges(null)).toBeNull();
    expect(addedLineRanges('')).toBeNull();
  });

  it('ignores file-header lines (+++ /---) and the no-newline marker', () => {
    const patch = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '+only',
      '\\ No newline at end of file',
    ].join('\n');
    expect(addedLineRanges(patch)).toEqual([{ start: 1, end: 1 }]);
  });
});

/**
 * parseChangedEntries reads the CI changed-files file. It must accept BOTH the
 * new NDJSON format (filename+patch from the PR files API) and the legacy
 * plain-path list — the latter degrades to whole-file mutation rather than
 * breaking, so a stale caller or local file can never crash the gate.
 */
describe('patch-mutation parseChangedEntries — changed-files formats', () => {
  it('parses NDJSON lines into files with ranges from the patch', () => {
    const content = [
      JSON.stringify({ filename: 'apps/x/src/a.ts', patch: '@@ -1,0 +1,2 @@\n+x\n+y' }),
      JSON.stringify({ filename: 'apps/x/src/b.ts', patch: null }),
    ].join('\n');
    expect(parseChangedEntries(content)).toEqual([
      { file: 'apps/x/src/a.ts', ranges: [{ start: 1, end: 2 }] },
      { file: 'apps/x/src/b.ts', ranges: null }, // API omitted patch → whole file
    ]);
  });

  it('parses a legacy plain list into whole-file entries (ranges null)', () => {
    expect(parseChangedEntries('apps/x/src/a.ts\n\napps/x/src/b.ts\n')).toEqual([
      { file: 'apps/x/src/a.ts', ranges: null },
      { file: 'apps/x/src/b.ts', ranges: null },
    ]);
  });

  it('treats a malformed JSON-looking line as a plain path, not a crash', () => {
    expect(parseChangedEntries('{not json')).toEqual([{ file: '{not json', ranges: null }]);
  });
});

/**
 * parseUnifiedDiff is the local-run (`git diff -U0`) counterpart of the NDJSON
 * path: split multi-file diff output per file and reuse the same hunk parser,
 * so local and CI grade the same ranges.
 */
describe('patch-mutation parseUnifiedDiff — local git fallback', () => {
  it('splits a multi-file -U0 diff into per-file added ranges', () => {
    const diff = [
      'diff --git a/apps/x/src/a.ts b/apps/x/src/a.ts',
      'index 111..222 100644',
      '--- a/apps/x/src/a.ts',
      '+++ b/apps/x/src/a.ts',
      '@@ -9,0 +10,2 @@',
      '+one',
      '+two',
      'diff --git a/apps/x/src/b.ts b/apps/x/src/b.ts',
      '--- a/apps/x/src/b.ts',
      '+++ b/apps/x/src/b.ts',
      '@@ -4,2 +3,0 @@',
      '-gone',
      '-also',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'apps/x/src/a.ts', ranges: [{ start: 10, end: 11 }] },
      { file: 'apps/x/src/b.ts', ranges: [] }, // deletion-only → no target
    ]);
  });

  it('skips deleted files (+++ /dev/null) entirely', () => {
    const diff = [
      'diff --git a/apps/x/src/dead.ts b/apps/x/src/dead.ts',
      '--- a/apps/x/src/dead.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it('returns [] for empty diff output', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

/**
 * mutatePatternsFor composes the actual `--mutate` argument. Ranged files emit
 * one `file:start-end` pattern per range (Stryker UNIONS same-file ranges in
 * the mutate list); unknown ranges fall back to the whole file — the pre-fix
 * behavior, kept as the safe degradation.
 */
describe('patch-mutation mutatePatternsFor — --mutate composition', () => {
  it('emits one range pattern per range and whole files for unknown ranges', () => {
    const ranges = new Map<string, Array<{ start: number; end: number }> | null>([
      ['src/a.ts', [{ start: 5, end: 9 }, { start: 30, end: 30 }]],
      ['src/b.ts', null],
    ]);
    expect(
      mutatePatternsFor(['src/a.ts', 'src/b.ts'], (f: string) => ranges.get(f) ?? null),
    ).toEqual(['src/a.ts:5-9', 'src/a.ts:30-30', 'src/b.ts']);
  });

  it('defaults to whole-file patterns when no range lookup is provided', () => {
    expect(mutatePatternsFor(['src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('glob-escapes bracketed route paths so the pattern matches the literal file', () => {
    // Unescaped, `[appId]` reads as a character class: the pattern would not
    // match its own file, Stryker would mutate nothing, and the gate's
    // no-report tolerance would silently pass the group.
    expect(mutatePatternsFor(['src/app/api/apps/[appId]/workers/runs/route.ts'])).toEqual([
      'src/app/api/apps/[[]appId[]]/workers/runs/route.ts',
    ]);
  });

  it('composes escaping with line ranges (Stryker strips :start-end before glob matching)', () => {
    expect(
      mutatePatternsFor(['src/app/[id]/actions.ts'], () => [{ start: 12, end: 40 }]),
    ).toEqual(['src/app/[[]id[]]/actions.ts:12-40']);
  });

  it('escaped patterns for every Next.js path convention match their own file and nothing else', () => {
    const files = [
      'src/app/api/apps/[appId]/workers/runs/route.ts',
      'src/app/[...slug]/actions.ts',
      'src/app/[[...slug]]/actions.ts',
      'src/app/(dashboard)/@modal/(.)photo/[id]/actions.ts',
      'src/lib/plain.ts',
    ];
    for (const file of files) {
      const [pattern] = mutatePatternsFor([file]);
      expect(unmatchedMutateTargets([file], [pattern!])).toEqual([]);
    }
    // No false positives: the escaped bracket pattern is literal, not a class.
    expect(
      unmatchedMutateTargets(
        ['src/app/api/apps/a/workers/runs/route.ts'],
        mutatePatternsFor(['src/app/api/apps/[appId]/workers/runs/route.ts']),
      ),
    ).toEqual(['src/app/api/apps/a/workers/runs/route.ts']);
  });
});

/**
 * unmatchedMutateTargets is the hard-fail guard: main() refuses to run a
 * group whose composed patterns cannot match their own files, instead of
 * letting Stryker find nothing and the no-report tolerance fake a pass.
 */
describe('patch-mutation unmatchedMutateTargets — silent-skip guard', () => {
  it('returns empty when every file is matched (incl. ranged patterns)', () => {
    expect(
      unmatchedMutateTargets(
        ['src/a.ts', 'src/b.ts'],
        ['src/a.ts:5-9', 'src/a.ts:30-30', 'src/b.ts'],
      ),
    ).toEqual([]);
  });

  it('flags the bug class: an UNescaped bracketed pattern misses its own file', () => {
    expect(
      unmatchedMutateTargets(
        ['src/app/api/apps/[appId]/workers/runs/route.ts'],
        ['src/app/api/apps/[appId]/workers/runs/route.ts:10-20'],
      ),
    ).toEqual(['src/app/api/apps/[appId]/workers/runs/route.ts']);
  });
});

/**
 * isAllNoCoverage gates the full-suite fallback: it must fire ONLY when the
 * related-scoped run resolved zero covering tests (every mutant NoCoverage),
 * and never on a run that actually exercised code — otherwise the fallback
 * would re-run the slow full suite needlessly, or worse, mask a real survivor.
 */
describe('patch-mutation isAllNoCoverage — fallback trigger', () => {
  it('is true when every mutant is NoCoverage (scoping found no tests)', () => {
    expect(isAllNoCoverage({ killed: 0, survived: 0, timeout: 0, noCoverage: 4, total: 4 })).toBe(
      true,
    );
  });

  it('is false when any mutant was actually exercised', () => {
    expect(isAllNoCoverage({ killed: 1, survived: 0, timeout: 0, noCoverage: 3, total: 4 })).toBe(
      false,
    );
    expect(isAllNoCoverage({ killed: 0, survived: 2, timeout: 0, noCoverage: 2, total: 4 })).toBe(
      false,
    );
    expect(isAllNoCoverage({ killed: 0, survived: 0, timeout: 1, noCoverage: 3, total: 4 })).toBe(
      false,
    );
  });

  it('is false for empty, null, and advisory (budgetExceeded) results', () => {
    expect(isAllNoCoverage({ killed: 0, survived: 0, timeout: 0, noCoverage: 0, total: 0 })).toBe(
      false,
    );
    expect(isAllNoCoverage(null)).toBe(false);
    expect(isAllNoCoverage({ budgetExceeded: true })).toBe(false);
  });
});
