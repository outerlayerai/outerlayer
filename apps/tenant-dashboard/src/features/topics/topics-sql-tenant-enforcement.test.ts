/**
 * TenantId enforcement for the topics-generation inline SQL.
 *
 * The observability-service guard covers that package's queries; this covers
 * the dashboard-side topics SQL. Topics generation runs on the WRITER identity
 * (getDefaultClient — it re-inserts facet rows and writes a new map version,
 * and the analytics_readonly role cannot INSERT), so these queries carry the
 * tenant predicate themselves and this test is what enforces it: a future edit
 * that drops it must fail here.
 *
 * Mechanism mirrors the observability-service guard: scan the topics directory
 * (so a new topics file can't escape by not being listed), extract SQL template
 * literals, and require a TenantId predicate on every one that touches a tenant
 * table — either literally, or by delegating its WHERE to the shared
 * `samplableRowsClause` (defined in `@repo/observability-service`; its
 * definition, scanned here from the package source, carries the predicate).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TENANT_TABLES = [
  'otel_traces_trace_id_ts',
  'otel_traces',
  'scores',
  'agent_session_summary',
  'agent_blobs',
  'trace_facets',
  'trace_topic_maps',
] as const;

const TENANT_TABLE_PATTERN = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:${TENANT_TABLES.join('|')})\\b`,
  'i',
);
// TenantId in predicate position, not merely projected/grouped (see the
// observability-service guard for the same residual-limit note).
const TENANT_ID_PATTERN = /TenantId\s*(?:=|IN\b)/i;

// The shared sampling WHERE, delegated to via `WHERE ${samplableRowsClause(...)}`.
// Its own definition is a template in this same file and IS scanned below, so
// the predicate it emits is verified; a template that delegates to it is
// therefore tenant-scoped even without a literal predicate of its own.
const VETTED_CLAUSE_PATTERN = /samplableRowsClause/;

const TOPICS_DIR = new URL('./', import.meta.url);

function templateLiterals(source: string): string[] {
  return source.split('`').filter((_, i) => i % 2 === 1);
}

function carriesTenantBoundary(sql: string): boolean {
  return TENANT_ID_PATTERN.test(sql) || VETTED_CLAUSE_PATTERN.test(sql);
}

const files = readdirSync(TOPICS_DIR).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
);

const cases = files.flatMap((file) =>
  templateLiterals(readFileSync(new URL(file, TOPICS_DIR), 'utf8'))
    .map((sql, index) => ({ file, index, sql }))
    .filter(({ sql }) => TENANT_TABLE_PATTERN.test(sql)),
);

describe('topics inline SQL is tenant-scoped (writer identity, no row-policy backstop)', () => {
  it('scans real topics SQL (guard is wired to the source)', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$file inline query #$index carries a tenant boundary', ({ file, index, sql }) => {
    expect(
      carriesTenantBoundary(sql),
      `${file} inline query #${index} touches a tenant table but carries no TenantId ` +
        `predicate (and does not delegate to samplableRowsClause). Add ` +
        `AND TenantId = {tenantId:String}.`,
    ).toBe(true);
  });

  it('the shared samplableRowsClause itself binds the tenant', () => {
    const packageSourcePath = fileURLToPath(
      new URL('../../../../../packages/observability-service/src/services/topics.ts', TOPICS_DIR),
    );
    const source = readFileSync(packageSourcePath, 'utf8');
    const clauseBody = source.slice(source.indexOf('function samplableRowsClause'));
    expect(TENANT_ID_PATTERN.test(clauseBody.slice(0, 400))).toBe(true);
  });

  it('rejects an unscoped tenant-table query (guard has teeth)', () => {
    const unscoped = 'SELECT count() FROM trace_facets WHERE Facet = {facet:String}';
    expect(TENANT_TABLE_PATTERN.test(unscoped)).toBe(true);
    expect(carriesTenantBoundary(unscoped)).toBe(false);
  });
});
