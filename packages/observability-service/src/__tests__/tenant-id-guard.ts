/**
 * Shared guard pieces for the TenantId enforcement suites
 * (tenant-id-enforcement.test.ts + tenant-id-source-scan.test.ts): the
 * tenant-table matcher, the predicate matcher, the allowlist, and the
 * assertion. One definition keeps both suites judging SQL by identical rules.
 */

import { expect } from 'vitest';

// Every table whose rows carry a TenantId (the migration-29 policy set).
// Longer names first so the alternation matches `otel_traces_trace_id_ts`
// before the `otel_traces` prefix.
const TENANT_TABLES = [
  'otel_traces_trace_id_ts',
  'otel_traces',
  'scores',
  'agent_session_summary',
  'agent_blobs',
  'trace_facets',
  'trace_topic_maps',
] as const;

export const TENANT_TABLE_PATTERN = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:${TENANT_TABLES.join('|')})\\b`,
  'i',
);
// Require TenantId in PREDICATE position (`TenantId = …` / `TenantId IN …`),
// not merely as a projected/grouped column — a `SELECT TenantId FROM …` with no
// filter must not pass. Residual limit (present tense): this proves a tenant
// predicate is PRESENT in the query, not that it binds every tenant table a
// multi-table query joins; per-table binding is not cheaply expressible as a
// regex, so the row-policy client remains the by-construction backstop.
export const TENANT_ID_PATTERN = /TenantId\s*(?:=|IN\b)/i;

// ---------------------------------------------------------------------------
// Queries exempt from TenantId enforcement (present-tense reason required)
// ---------------------------------------------------------------------------

const ALLOWLIST = new Set([
  // Health probe — `SELECT 1`, no table, no data access.
  'HEALTH_CHECK_QUERY',
  // Column/dimension maps — not query strings.
  'SORT_FIELD_MAP',
  // Delegates its WHERE entirely to `samplableRowsClause(scope, facet)`,
  // whose own template literal (scanned by the source-scan suite) opens
  // with a literal TenantId predicate — the interpolation just hides that
  // text from the source scan, not from ClickHouse.
  'topics.ts inline query #27',
  // agent-sessions.ts builds its WHERE clauses from a JS array of
  // plain-quoted filter strings (`filters`/`baseWhere`/`vocabWhere`), not a
  // single template literal — the source scan only reads backtick template
  // text, so it can't see that `filters`/`vocabWhere` open with the literal
  // `'TenantId={tenantId:String}'` entry. The identity/repo-resolution
  // queries interpolate the same way.
  'agent-sessions.ts inline query #24', // identity predicate ($identity)
  'agent-sessions.ts inline query #36', // list query, WHERE ${where}
  'agent-sessions.ts inline query #37', // total count, WHERE ${where}
  'agent-sessions.ts inline query #38', // origin counts, WHERE ${baseWhere}
  'agent-sessions.ts inline query #39', // branch vocab, WHERE ${vocabWhere}
  'agent-sessions.ts inline query #40', // actor vocab, WHERE ${vocabWhere}
  'agent-sessions.ts inline query #41', // agentType vocab, WHERE ${vocabWhere}
  'agent-sessions.ts inline query #42', // model vocab, WHERE ${vocabWhere}
  'agent-sessions.ts inline query #43', // workerKind vocab, WHERE ${vocabWhere}
]);

export function assertTenantId(name: string, sql: string): void {
  if (ALLOWLIST.has(name)) return;
  if (!TENANT_TABLE_PATTERN.test(sql)) return; // doesn't query a tenant table

  expect(
    TENANT_ID_PATTERN.test(sql),
    `Query "${name}" references a tenant table but is missing a TenantId predicate.\n` +
      `Add: AND TenantId = {tenantId:String}\n` +
      `(or, if it is genuinely cross-tenant, add it to ALLOWLIST with a reason).`,
  ).toBe(true);
}
