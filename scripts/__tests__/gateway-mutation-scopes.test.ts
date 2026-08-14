import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CORE_WORKSPACE,
  GATEWAY_WORKSPACE,
  GATEWAY_SCOPED_WORKSPACES,
  scopeForFile,
  scopeEnv,
  // @ts-expect-error — .mjs gate script, no type declarations; the export is plain JS.
} from '../ci/gateway-mutation-scopes.mjs';

describe('scopeForFile — per-file test-discovery scope', () => {
  it('maps gateway-core source areas to the vitestDir that keeps Stryker tractable', () => {
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/services/traces-service.ts')).toEqual({
      vitestDir: 'src/services',
    });
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/lib/foo.ts')).toEqual({ vitestDir: 'src/lib' });
    // utils scopes from dir=src with an include covering BOTH the root file's
    // sibling test (utils.test.ts) and the subdir tests — a plain dir=src/utils
    // would miss utils.test.ts and leave src/utils.ts mutants uncovered.
    const utilsInclude = 'utils.test.ts,utils/**/*.test.ts';
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/utils.ts')).toEqual({
      vitestDir: 'src',
      include: utilsInclude,
    });
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/utils/idempotency.ts')).toEqual({
      vitestDir: 'src',
      include: utilsInclude,
    });
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/openapi/routes/traces.ts')).toEqual({
      vitestDir: 'src/openapi',
    });
    // The MCP mount shares the route handlers' suite scope — its tests live
    // under src/openapi/mcp/__tests__, same as the routes it wraps.
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/openapi/mcp/dispatcher.ts')).toEqual({
      vitestDir: 'src/openapi',
    });
    // git moved to gateway-core; it now gets its own clean dir (no more
    // dir=src + include hack it used when it shared a shard with queues).
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/git/crypto.ts')).toEqual({
      vitestDir: 'src/git',
    });
  });

  it('maps the apps/gateway Cloudflare-shell source areas to their own dirs', () => {
    // storage-cap-service is the one business-logic service that stayed in the
    // shell; it scopes to apps/gateway's own src/services suite.
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/services/storage-cap-service.ts')).toEqual({
      vitestDir: 'src/services',
    });
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/queues/traces-queue.ts')).toEqual({
      vitestDir: 'src/queues',
    });
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/durable-objects/app-connection.ts')).toEqual({
      vitestDir: 'src/durable-objects',
    });
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/jobs/stripe-meter-event-handler.tsx')).toEqual({
      vitestDir: 'src/jobs',
    });
  });

  it('does not cross workspaces: a dir only in one gateway workspace is null in the other', () => {
    // openapi/routes lives in gateway-core, never apps/gateway.
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/openapi/routes/traces.ts')).toBeNull();
    // queues lives in apps/gateway, never gateway-core.
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/queues/traces-queue.ts')).toBeNull();
  });

  it('returns null for thin-wrapper dirs no gateway shard mutates (gate skips them)', () => {
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/stores/app-store.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/policies/rate-limit.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/types.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/runtime/gateway-context.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/runtime/cloudflare-context.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/index.ts')).toBeNull();
  });

  it('skips wrapper files WITHIN a partially-mutated dir (rule matches only the shard targets)', () => {
    // git/: the gateway-git shard mutates only crypto.ts. The other git
    // files are thin provider-API wrappers no shard mutates, so
    // the rule must NOT gate them at the full floor — return null (skipped),
    // matching the nightly. (Regression guard: a `startsWith('src/git/')` rule
    // would gate these, breaking the skip contract.)
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/git/github.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_CORE_WORKSPACE, 'src/git/factory.ts')).toBeNull();
    // apps/gateway/src/services/: only storage-cap-service.ts is mutated; the
    // logger + error-reporting adapters are not, so they must skip too.
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/services/logger.ts')).toBeNull();
    expect(scopeForFile(GATEWAY_WORKSPACE, 'src/services/error-reporting/index.ts')).toBeNull();
  });

  it('returns null for a workspace that has no gateway scope rules', () => {
    expect(scopeForFile('apps/tenant-dashboard', 'src/services/foo.ts')).toBeNull();
  });

  it('translates a scope into the env vars Stryker reads', () => {
    expect(scopeEnv({ vitestDir: 'src/services' })).toEqual({
      STRYKER_VITEST_DIR: 'src/services',
    });
    expect(scopeEnv({ vitestDir: 'src', include: 'git/**/*.test.ts' })).toEqual({
      STRYKER_VITEST_DIR: 'src',
      STRYKER_INCLUDE: 'git/**/*.test.ts',
    });
  });
});

/**
 * DRIFT GUARD. The PR mutation gate and the nightly shard matrix both encode
 * "which test-discovery scope makes a gateway source dir tractable". This test
 * is the contract that keeps them identical: for every gateway shard in
 * stryker-nightly.yml — across BOTH gateway workspaces (packages/gateway-core
 * and apps/gateway) — the scope this module computes for the shard's first
 * mutate target must equal the shard's declared vitestDir / stryker_include.
 * If a shard is re-split or a new source area is added to the nightly without
 * updating gateway-mutation-scopes.mjs, this fails — which is the point.
 */
describe('drift guard — module agrees with the nightly gateway shards', () => {
  const nightly = readFileSync(
    path.join(process.cwd(), '.github/workflows/stryker-nightly.yml'),
    'utf8',
  );

  // Each matrix entry is a `- { path: <ws> ... }` object. There are no braces
  // inside the single-quoted field values, so each block runs from the marker
  // to the next `}`. We keep only blocks whose path is a gateway workspace
  // (the only ones that declare a vitestDir).
  const MARKER = '- { path: ';
  const blocks: Array<{ workspace: string; body: string }> = [];
  for (let i = nightly.indexOf(MARKER); i !== -1; i = nightly.indexOf(MARKER, i + 1)) {
    const body = nightly.slice(i, nightly.indexOf('}', i));
    const workspace = /path:\s*([\w/-]+)/.exec(body)?.[1] ?? '';
    if (GATEWAY_SCOPED_WORKSPACES.includes(workspace)) blocks.push({ workspace, body });
  }

  it('finds the gateway shard blocks across both workspaces (guards a broken parser)', () => {
    // Assert a sane lower bound so a parser that silently matches nothing
    // can't make the contract vacuous.
    expect(blocks.length).toBeGreaterThanOrEqual(13);
    // Both workspaces must be represented — a regression that dropped one side
    // (e.g. all shards accidentally pointed at one path) would still clear the
    // count bound above.
    const workspaces = new Set(blocks.map((b) => b.workspace));
    expect(workspaces.has(GATEWAY_CORE_WORKSPACE)).toBe(true);
    expect(workspaces.has(GATEWAY_WORKSPACE)).toBe(true);
  });

  it.each(
    blocks.map(({ workspace, body }) => {
      const name = /name:\s*([\w-]+)/.exec(body)?.[1] ?? '(unnamed)';
      const vitestDir = /vitestDir:\s*'([^']+)'/.exec(body)?.[1] ?? null;
      const include = /stryker_include:\s*'([^']+)'/.exec(body)?.[1] ?? null;
      const mutate = /mutate:\s*'([^']+)'/.exec(body)?.[1] ?? '';
      const firstTarget = mutate
        .split(',')
        .map((s) => s.trim())
        .find((s) => s && !s.startsWith('!'));
      return { workspace, name, vitestDir, include, firstTarget };
    }),
  )(
    'shard $name ($workspace) scope matches the module',
    ({ workspace, name, vitestDir, include, firstTarget }) => {
      expect(firstTarget, `${name}: could not parse a mutate target`).toBeTruthy();
      const scope = scopeForFile(workspace, firstTarget as string);
      expect(scope, `${name}: ${firstTarget} should be in ${workspace} scope`).not.toBeNull();
      expect(scope.vitestDir, `${name}: vitestDir`).toBe(vitestDir);
      expect(scope.include ?? null, `${name}: stryker_include`).toBe(include);
    },
  );
});
