/**
 * Acceptance: every SECURITY DEFINER function resists temp-table shadowing.
 *
 * When pg_temp is not listed in a function's search_path, Postgres searches it
 * FIRST for relation names, so a caller-created temp object can shadow a table
 * the function reads and be read with the definer's privileges. Definer
 * functions must pin a search_path that makes that impossible.
 *
 * `supabase db diff` does not detect changes to a function's SET clause, so a
 * regression here produces no migration and no drift warning. This test is the
 * only thing that catches it.
 *
 * Two settings are safe, and both are accepted below:
 *   - pg_temp listed (last)     — the real relation wins
 *   - search_path = ''          — no unqualified relation resolves at all, so
 *                                 there is nothing to shadow
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

/** Schemas we own. Extension schemas are out of scope. */
const OWNED_SCHEMAS = ['public', 'private', 'ops'];

describe('SECURITY DEFINER search_path', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it('lists pg_temp (or sets an empty search_path) on every definer function', async () => {
    const { rows } = await db.query<{ fn: string; cfg: string }>(
      `SELECT n.nspname || '.' || p.proname AS fn,
              coalesce(array_to_string(p.proconfig, ','), 'NONE') AS cfg
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1)
          AND p.prosecdef
          AND coalesce(array_to_string(p.proconfig, ','), 'NONE') NOT LIKE '%pg_temp%'
          AND coalesce(array_to_string(p.proconfig, ','), 'NONE') <> 'search_path=""'
        ORDER BY 1`,
      [OWNED_SCHEMAS],
    );

    // Name the offenders — a count tells you nothing about which function
    // regained the setting, and the fix is per-function.
    expect(rows.map((r) => `${r.fn} [${r.cfg}]`)).toEqual([]);
  });

  it('actually resists a shadowed relation', async () => {
    // The catalog assertion above is a proxy. This proves the mechanism it
    // stands for, so the test cannot pass on a Postgres whose resolution rules
    // differ from the ones the assertion assumes.
    await db.query('BEGIN');
    try {
      await db.query('CREATE SCHEMA shadow_probe');
      await db.query('CREATE TABLE shadow_probe.t(v int)');
      await db.query('INSERT INTO shadow_probe.t VALUES (1)');
      await db.query(
        `CREATE FUNCTION shadow_probe.unlisted() RETURNS int
           LANGUAGE sql SECURITY DEFINER SET search_path = shadow_probe
           AS $$ SELECT max(v) FROM t $$`,
      );
      await db.query(
        `CREATE FUNCTION shadow_probe.listed() RETURNS int
           LANGUAGE sql SECURITY DEFINER SET search_path = shadow_probe, pg_temp
           AS $$ SELECT max(v) FROM t $$`,
      );
      await db.query('CREATE TEMP TABLE t(v int)');
      await db.query('INSERT INTO t VALUES (999)');

      const unlisted = await db.query<{ v: number }>('SELECT shadow_probe.unlisted() AS v');
      const listed = await db.query<{ v: number }>('SELECT shadow_probe.listed() AS v');

      // 999 is the caller's temp table; 1 is the real one.
      expect(unlisted.rows[0]!.v).toBe(999);
      expect(listed.rows[0]!.v).toBe(1);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
