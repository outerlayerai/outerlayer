/**
 * Acceptance: no index on a public table duplicates another index on that table.
 *
 * Two shapes cost writes and buy nothing:
 *
 *   - an exact duplicate, where a plain index has the same columns as a unique
 *     index sitting beside it
 *   - a leading-column prefix, where a single-column index's column is already
 *     the first column of a wider index that serves the same lookups
 *
 * Both accumulate quietly. Someone adds `idx_foo_app_id` for a lookup, someone
 * else later adds a `(app_id, name)` unique constraint for a different reason,
 * and nothing connects the two.
 *
 * Partial indexes are excluded from the prefix check on purpose. A predicate
 * makes an index narrower rather than redundant, so a partial index over the
 * same columns as a full one is a legitimate pair.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

interface IndexRow {
  tbl: string;
  name: string;
  cols: string;
  is_unique: boolean;
  is_primary: boolean;
  predicate: string | null;
}

describe('redundant indexes', () => {
  let db: Client;
  let indexes: IndexRow[];

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const { rows } = await db.query<IndexRow>(
      `SELECT c.relname AS tbl,
              i.relname AS name,
              pg_get_indexdef(i.oid) AS cols,
              idx.indisunique AS is_unique,
              idx.indisprimary AS is_primary,
              pg_get_expr(idx.indpred, idx.indrelid) AS predicate
         FROM pg_index idx
         JOIN pg_class i ON i.oid = idx.indexrelid
         JOIN pg_class c ON c.oid = idx.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY c.relname, i.relname`,
    );
    // pg_get_indexdef returns the full statement; keep the key expression only.
    indexes = rows.map((r) => ({
      ...r,
      cols: (/USING \w+ \((.*?)\)(?:\s+WHERE|$)/.exec(r.cols)?.[1] ?? '').trim(),
    }));
  });

  afterAll(async () => {
    await db.end();
  });

  it('has no two indexes on the same table with identical columns and predicate', () => {
    const seen = new Map<string, string[]>();
    for (const r of indexes) {
      const key = `${r.tbl}(${r.cols})${r.predicate ?? ''}`;
      seen.set(key, [...(seen.get(key) ?? []), r.name]);
    }
    const dupes = [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([key, names]) => `${key} -> ${names.join(' + ')}`);

    // Name the pairs — the fix is to drop one of a specific two.
    expect(dupes).toEqual([]);
  });

  it('has no non-unique index whose columns are a leading prefix of another', () => {
    const cols = (r: IndexRow) => r.cols.split(',').map((c) => c.trim());
    const offenders: string[] = [];

    for (const r of indexes) {
      if (r.is_unique || r.is_primary || r.predicate) continue;
      const rc = cols(r);
      const covering = indexes.find((o) => {
        if (o.name === r.name || o.tbl !== r.tbl || o.predicate) return false;
        const oc = cols(o);
        return oc.length > rc.length && oc.slice(0, rc.length).join(',') === rc.join(',');
      });
      if (covering) {
        offenders.push(`${r.tbl}.${r.name} (${r.cols}) covered by ${covering.name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
