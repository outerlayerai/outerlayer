/**
 * Acceptance: audit columns are maintained by the database, not by callers.
 *
 * A table with created_by needs set_created_columns() to stamp it, and a table
 * with updated_at needs a trigger to advance it. The convention is applied per
 * table, so a new table can carry the columns without the triggers and leave the
 * values unmaintained — present in the schema, null in practice.
 *
 * A column that looks like an audit trail but is never written is worse than no
 * column: it reads as evidence.
 *
 * The catalog test is what keeps this from decaying again. The behavioural
 * tests below pin the two properties that make the triggers safe to attach
 * everywhere — an explicit created_by survives, and a table without updated_by
 * does not blow up.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

describe('audit column triggers', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it('every table with created_by has the trigger that stamps it', async () => {
    const { rows } = await db.query<{ tbl: string }>(
      `SELECT c.relname AS tbl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'created_by'
          AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
            JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
              AND p.proname = 'set_created_columns')
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.tbl)).toEqual([]);
  });

  it('every table with updated_at has a trigger that advances it', async () => {
    const { rows } = await db.query<{ tbl: string }>(
      `SELECT c.relname AS tbl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'updated_at'
          AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
            JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
              AND p.proname IN ('set_updated_columns', 'set_updated_at_only',
                                'set_profile_updated_at', 'update_registration_requests_updated_at'))
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.tbl)).toEqual([]);
  });

  it('never attaches set_updated_columns to a table without updated_by', async () => {
    // set_updated_columns() assigns NEW.updated_by. On a table without the
    // column that raises `record "new" has no field "updated_by"` — but only on
    // the authenticated branch, so it survives every service_role test and
    // fails in front of a real user.
    const { rows } = await db.query<{ tbl: string }>(
      `SELECT c.relname AS tbl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND p.proname = 'set_updated_columns'
          AND NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'updated_by'
              AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.tbl)).toEqual([]);
  });

  it('keeps an explicit created_by instead of overwriting it', async () => {
    // The reason attaching the trigger broadly is safe: it coalesces. If it
    // assigned unconditionally, every backfill and admin-authored row would
    // lose its real author.
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL myvars.pg_client_role = 'service_role'`);
      await db.query(
        `INSERT INTO public.tenant (tenant_id, organization_name, company_name)
         VALUES ('00000000-0000-0000-0000-00000000fa01', 'zz-audit-trg', 'zz-audit-trg')`,
      );
      await db.query(
        `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, created_at, updated_at)
         VALUES ('00000000-0000-0000-0000-00000000fa02',
                 '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                 'zz-audit-trg@example.com', 'x', now(), now(), now())`,
      );
      await db.query(
        `INSERT INTO public.profile (id, email)
         VALUES ('00000000-0000-0000-0000-00000000fa02', 'zz-audit-trg@example.com')`,
      );
      await db.query(
        `INSERT INTO public.app (id, tenant_id, name, created_by)
         VALUES ('00000000-0000-0000-0000-00000000fa03',
                 '00000000-0000-0000-0000-00000000fa01', 'zz-audit-trg-app',
                 '00000000-0000-0000-0000-00000000fa02')`,
      );
      await db.query(
        `INSERT INTO public.environment (id, tenant_id, app_id, name, created_by)
         VALUES ('00000000-0000-0000-0000-00000000fa04',
                 '00000000-0000-0000-0000-00000000fa01',
                 '00000000-0000-0000-0000-00000000fa03', 'zz-env',
                 '00000000-0000-0000-0000-00000000fa02')`,
      );

      const { rows } = await db.query<{ created_by: string }>(
        `SELECT created_by FROM public.environment
          WHERE id = '00000000-0000-0000-0000-00000000fa04'`,
      );
      expect(rows[0]!.created_by).toBe('00000000-0000-0000-0000-00000000fa02');
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
