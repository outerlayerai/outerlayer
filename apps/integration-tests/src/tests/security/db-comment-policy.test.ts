/**
 * Acceptance: database comments carry no internal program history.
 *
 * Comments ship inside the database. They land in every pg_dump and in the
 * generated db-types, and this repo is public-bound. Feature numbers, bug tags,
 * phase codenames, and spec section refs are dead references to anyone outside
 * the team, and the repo's comment policy forbids them.
 *
 * `supabase db diff` does not detect COMMENT ON changes, so a reintroduced one
 * produces no migration and no drift warning. This test is the only guard.
 *
 * The patterns below match the forbidden shapes, not every mention of a word.
 * "feature flag" and "features" are fine; "Feature 054" is not.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const FORBIDDEN: Array<[string, RegExp]> = [
  ['feature number', /\bfeature\s+\d{3}\b/i],
  ['bug tag', /\bBUG-\d+/],
  ['phase codename', /\bphase\s+[A-Z]\d\b/i],
  ['spec section ref', /(\bspec\s+§|§\s*\d)/i],
  ['requirement ref', /\bFR-\d+/],
  ['internal spec path', /\bspecs\//],
  ['change narration', /\b(LEGACY:|replaces the legacy|previously\b|renamed from)/i],
  // Internal names for a period of work. A deliberately narrow pattern: a
  // broad one on "was removed" flags legitimate prose like "nullable if the
  // config was deleted", and a guard that cries wolf gets switched off.
  ['era or phase codename', /\b(demolition|[a-z]+-era\b)/i],
];

describe('database comment policy', () => {
  let db: Client;
  let comments: Array<{ obj: string; description: string }>;

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    const { rows } = await db.query<{ obj: string; description: string }>(
      `SELECT CASE WHEN d.objsubid = 0 THEN c.relname
                   ELSE c.relname || '.' || a.attname END AS obj,
              d.description
         FROM pg_description d
         JOIN pg_class c ON c.oid = d.objoid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
        WHERE n.nspname = 'public'
        ORDER BY 1`,
    );
    comments = rows;
  });

  afterAll(async () => {
    await db.end();
  });

  it('reads at least one comment, so an empty result cannot pass as clean', () => {
    // Without this, a query that silently returned nothing would make every
    // assertion below vacuously true.
    expect(comments.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)('contains no %s', (_label, pattern) => {
    const offenders = comments
      .filter((c) => pattern.test(c.description))
      .map((c) => `${c.obj}: ${c.description.slice(0, 90)}`);

    // Name the objects — the fix is to rewrite one specific comment.
    expect(offenders).toEqual([]);
  });
});
