/**
 * Read-client enforcement lint.
 *
 * A tenant-scoped analytics/agents API route must obtain its ClickHouse client
 * from `createTenantReadClient` (the analytics_readonly row-policy identity),
 * never `getDefaultClient` (the writer identity, which has no policy backstop).
 * This is the companion to the query-predicate guard in
 * `@repo/observability-service`: it stops a future tenant read from silently
 * running on the un-policed writer identity.
 *
 * Only genuine write / cross-tenant surfaces are allowlisted — a new
 * `getDefaultClient` under these route trees fails CI until it is either
 * switched to the read client or added here with a present-tense reason.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative } from 'node:path';

const ROUTES_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // src/app/api
const SCANNED_DIRS = [
  join(ROUTES_DIR, 'analytics'),
  join(ROUTES_DIR, 'agents'),
  // Canonical tenant-scoped routes live under /api/orgs/[orgName]/… as they
  // migrate off /api/analytics; hold them to the same read-client rule.
  join(ROUTES_DIR, 'orgs'),
];

// Directories named here are allowed not to exist: their surfaces are served
// by React Server Components (RSC) / server actions, or live under the
// canonical `orgs/` path instead. Every OTHER entry in SCANNED_DIRS
// must exist; a typo'd path there still fails loudly instead of silently
// scanning zero files.
const MAY_BE_EMPTY = new Set(['agents']);

// Routes that legitimately keep the writer identity. Each MUST have a reason.
// Empty today — topics generation runs in a server action
// (src/features/topics/actions.ts), outside this route-tree scan; its
// writer-identity use is guarded by that feature's own unit tests instead.
const ALLOWLIST: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  if (MAY_BE_EMPTY.has(basename(dir)) && !existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !join(entry.parentPath, entry.name).includes('__tests__'),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('tenant-scoped routes use the row-policy read client, not the writer identity', () => {
  const files = SCANNED_DIRS.flatMap(sourceFiles);

  it('scans a non-trivial set of route files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s does not use getDefaultClient (unless allowlisted)', (file) => {
    const rel = relative(ROUTES_DIR, file).split('\\').join('/');
    const usesWriterIdentity = /\bgetDefaultClient\b/.test(readFileSync(file, 'utf8'));

    if (rel in ALLOWLIST) {
      // Allowlisted files are expected to use it — pin that so a stale
      // allowlist entry (file no longer uses it) gets pruned.
      expect(
        usesWriterIdentity,
        `${rel} is allowlisted for getDefaultClient but no longer uses it — remove the allowlist entry.`,
      ).toBe(true);
      return;
    }

    expect(
      usesWriterIdentity,
      `${rel} uses getDefaultClient (writer identity, no row-policy backstop). ` +
        `Use createTenantReadClient({ tenantId, appId }) for tenant-scoped reads, ` +
        `or allowlist it with a reason if it is a genuine write/cross-tenant surface.`,
    ).toBe(false);
  });
});
