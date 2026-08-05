/**
 * Acceptance: the Data API roles hold only the table privileges RLS can gate.
 *
 * anon and authenticated reach the database exclusively through PostgREST, which
 * issues SELECT / INSERT / UPDATE / DELETE. Every one of those is filtered by
 * row-level security. TRUNCATE is not — RLS does not apply to it at all, so a
 * session that correctly sees zero rows under RLS can still empty the table.
 * REFERENCES and TRIGGER are likewise unreachable through PostgREST and
 * unused.
 *
 * These assert the live privilege state through a direct connection rather than
 * the API, because the hole is invisible from the API side: PostgREST never
 * emits TRUNCATE, so no request an integration test can make would reveal it.
 * The first test proves the grant is gone; the second proves it by execution,
 * which is what actually matters and what would break if the grant returned.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const DATA_API_ROLES = ['anon', 'authenticated'] as const;
const FORBIDDEN = ['TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const REQUIRED = ['SELECT', 'INSERT', 'UPDATE'] as const;

describe('Data API table privileges', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
  });

  it.each(DATA_API_ROLES)('%s holds no TRUNCATE/REFERENCES/TRIGGER on any public table', async (role) => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = $1
          AND privilege_type = ANY($2)
        ORDER BY table_name, privilege_type`,
      [role, FORBIDDEN],
    );

    // Name the offenders — a bare count tells you nothing about which GRANT ALL
    // crept back in.
    expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([]);
  });

  it.each(DATA_API_ROLES)('%s keeps the RLS-gated DML privileges', async (role) => {
    // The revoke must not have overshot: stripping SELECT/INSERT/UPDATE would
    // break every dashboard request, and this test would otherwise pass happily
    // on a role that had lost all access.
    const { rows } = await db.query<{ privilege_type: string; n: string }>(
      `SELECT privilege_type, count(*)::text AS n
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = $1
          AND privilege_type = ANY($2)
        GROUP BY privilege_type`,
      [role, REQUIRED],
    );

    expect(rows.length).toBe(REQUIRED.length);
    for (const row of rows) {
      expect(Number(row.n)).toBeGreaterThan(0);
    }
  });

  it('anon cannot TRUNCATE past RLS', async () => {
    // terms_agreement has RLS enabled and no policy admitting anon, so anon
    // reads zero rows. Without the revoke, a caller holding TRUNCATE empties the
    // table regardless of policy — RLS never sees a TRUNCATE.
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL ROLE anon");

      const visible = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.terms_agreement');
      expect(visible.rows[0]?.n).toBe('0'); // RLS is doing its job on SELECT

      await expect(db.query('TRUNCATE public.terms_agreement')).rejects.toThrow(
        /permission denied for table terms_agreement/,
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
