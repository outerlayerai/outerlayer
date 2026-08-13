/**
 * Generated types drift test.
 *
 * Catches the second-order failure mode from spec-drift.test.ts:
 * a developer regenerated `docs/dashboard-openapi.yaml` but forgot to
 * re-run `yarn gen:api-types`, leaving `src/lib/api/generated/types.ts`
 * stale relative to the spec.
 *
 * The committed types file must be byte-identical to what
 * `openapi-typescript` produces from the current spec. Together with
 * `spec-drift.test.ts`, this pins the full chain:
 *
 *   registry.ts → dashboard-openapi.yaml → generated/types.ts
 *
 * Strategy: spawn the local `openapi-typescript` CLI, capture stdout,
 * compare against the committed file. We shell out rather than use the
 * programmatic API because the CLI handles file I/O, line endings, and
 * trailing-newline conventions for us — matching exactly how developers
 * (and CI) regenerate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('Generated types drift', () => {
  it('src/lib/api/generated/types.ts matches openapi-typescript output', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..');
    const specPath = resolve(repoRoot, 'docs', 'dashboard-openapi.yaml');
    const committedPath = resolve(
      __dirname,
      '..',
      'generated',
      'types.ts',
    );
    // openapi-typescript may be linked into the app-local `.bin` (when kept in
    // the app's node_modules) or hoisted to the repo-root `.bin` — resolve
    // whichever exists so the test is agnostic to workspace hoisting.
    const cliCandidates = [
      resolve(repoRoot, 'apps', 'tenant-dashboard', 'node_modules', '.bin', 'openapi-typescript'),
      resolve(repoRoot, 'node_modules', '.bin', 'openapi-typescript'),
    ];
    const cliPath = cliCandidates.find((p) => existsSync(p)) ?? cliCandidates[0]!;

    const committed = readFileSync(committedPath, 'utf8');
    const regenerated = execFileSync(cliPath, [specPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(regenerated).toEqual(committed);
    // Spawns the `openapi-typescript` CLI synchronously — irreducible
    // multi-second codegen. Explicit ceiling so this test is never the flake,
    // independent of the (lower) suite-wide default. Sized for a saturated
    // machine (the pre-push gate runs every workspace's checks concurrently),
    // where the spawn can take an order of magnitude longer than solo.
  }, 120_000);
});
