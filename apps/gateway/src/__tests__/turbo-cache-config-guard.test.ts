import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

// Invariant guard for the turbo dependency-hashing config.
//
// `--only` prunes dependency tasks from the graph AND drops their hashes from
// the cache key, so a dependent's cached test/typecheck result survives a
// workspace dependency's source change — a stale-green cache that replays a
// pass for code that no longer holds: a dependency contract change can leave a
// consumer test genuinely red while every cache reports green.
// `typecheck` needs a topological dependency so a dependency's type change
// invalidates dependents' cached typechecks. It uses `^typecheck` (not
// `^build`): typecheck resolves dependency *source* directly, `^typecheck`
// already runs for every workspace in the typecheck scope so it adds hashing
// edges with no new execution, and it never drags an app's runtime build (e.g.
// tenant-dashboard's Next build, which integration-tests depends on and which
// needs runtime env absent in the typecheck context) into the graph. And a
// stray `apps/gateway/turbo.json` re-introduced a second, hand-maintained
// input mechanism that rotted out of sync. These assertions keep all three
// from silently returning.

function findRepoRoot(start: string): string {
  let dir = start;
  // Root is the directory holding both the workspace turbo.json and the CI
  // workflow (an inner package turbo.json has neither the workflow nor a
  // "workspaces" field, so this can't stop early on one).
  for (let i = 0; i < 15; i++) {
    if (
      existsSync(join(dir, 'turbo.json')) &&
      existsSync(join(dir, '.github', 'workflows', 'ci.yml'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repo root walking up from ${start}`);
}

const repoRoot = findRepoRoot(__dirname);

describe('turbo cache config guard', () => {
  it('root ci:unit script does not use --only (it severs dependency-task hashes)', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const ciUnit: string = pkg.scripts['ci:unit'];
    expect(ciUnit).toContain('turbo test');
    expect(ciUnit).not.toContain('--only');
  });

  it('no CI test:coverage invocation uses --only', () => {
    const workflow = readFileSync(
      join(repoRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const coverageLines = workflow
      .split('\n')
      .filter((line) => line.includes('turbo test:coverage'));
    // Both the tenant-dashboard shard lane and the everything-else lane are present.
    expect(coverageLines.length).toBe(2);
    for (const line of coverageLines) {
      expect(line).not.toContain('--only');
    }
  });

  it('root typecheck task depends on ^typecheck (not ^build) so dependency type changes invalidate without forcing app builds', () => {
    const turbo = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8'));
    const dependsOn: string[] = turbo.tasks.typecheck.dependsOn ?? [];
    expect(dependsOn).toContain('^typecheck');
    expect(dependsOn).not.toContain('^build');
  });

  it('root test task does not claim coverage/** outputs (plain test never writes coverage)', () => {
    const turbo = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf8'));
    const outputs: string[] | undefined = turbo.tasks.test.outputs;
    if (outputs !== undefined) {
      expect(outputs).not.toContain('coverage/**');
    }
  });

  it('apps/gateway/turbo.json does not exist (single hashing mechanism, not two)', () => {
    expect(existsSync(join(repoRoot, 'apps', 'gateway', 'turbo.json'))).toBe(false);
  });

  it('db-types exposes a typecheck task so the ^typecheck chain hashes its source', () => {
    // db-types is a source-direct dependency (main -> index.ts) with real type
    // surface. Without its own typecheck task it is invisible to dependents'
    // ^typecheck edge, so a type change there would replay stale-green.
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'db-types', 'package.json'), 'utf8'),
    );
    expect(pkg.scripts?.typecheck).toBe('tsc --noEmit');
  });
});
