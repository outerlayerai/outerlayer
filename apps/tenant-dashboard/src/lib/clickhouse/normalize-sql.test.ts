/**
 * Migration checksums are computed over normalizeSql() output
 * (clickhouse/migrate.mjs). The contract these tests pin:
 * comment/whitespace edits never change the checksum; schema edits always do.
 */

import { normalizeSql } from '../../../clickhouse/normalize-sql.mjs';

const MIGRATION = `-- Migration 18: Rebuild otel_traces
--
-- Two structural fixes, aligned with common observability-platform trace table design:
CREATE TABLE otel_traces (
  TenantId String,
  Timestamp DateTime64(9)
)
ENGINE = ReplacingMergeTree
-- tenant-first sort key
ORDER BY (TenantId, Timestamp);
`;

describe('normalizeSql', () => {
  it('is invariant under full-line comment edits', () => {
    const scrubbed = MIGRATION.replace(
      '-- Two structural fixes, aligned with common observability-platform trace table design:',
      '-- Two structural fixes:',
    );
    expect(normalizeSql(scrubbed)).toBe(normalizeSql(MIGRATION));
  });

  it('is invariant under comment insertion, deletion, and blank-line churn', () => {
    const decorated = `-- NEW HEADER\n\n\n${MIGRATION}\n\n-- trailing note\n`;
    const stripped = MIGRATION.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(normalizeSql(decorated)).toBe(normalizeSql(MIGRATION));
    expect(normalizeSql(stripped)).toBe(normalizeSql(MIGRATION));
  });

  it('strips every full-line comment and collapses spacing deterministically', () => {
    expect(normalizeSql(MIGRATION)).toBe(
      'CREATE TABLE otel_traces (\n' +
        '  TenantId String,\n' +
        '  Timestamp DateTime64(9)\n' +
        ')\n' +
        'ENGINE = ReplacingMergeTree\n' +
        'ORDER BY (TenantId, Timestamp);\n',
    );
  });

  it('changes when schema content changes', () => {
    const altered = MIGRATION.replace('ReplacingMergeTree', 'MergeTree');
    expect(normalizeSql(altered)).not.toBe(normalizeSql(MIGRATION));
  });

  it('preserves inline -- on code lines (string-literal safety)', () => {
    const sql = "INSERT INTO t VALUES ('a -- not a comment');\n";
    expect(normalizeSql(sql)).toBe("INSERT INTO t VALUES ('a -- not a comment');\n");
  });
});
