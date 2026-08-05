/**
 * Pins the generated permission map (packages/db-types/permissions.ts, emitted
 * by `yarn codegen:permissions` from permission-seed.json) to the permission
 * rows actually seeded into the database by the migrations.
 *
 * This is the equivalence net for the ONE source: the SQL seed block and the TS
 * map are both generated from the same JSON, but they reach the database and the
 * app via different paths (migrations vs a compiled import). If either drifts —
 * a hand-edited migration, a stale regenerate, a role removed from one but not
 * the other — the generated TS no longer describes the live grants, and this
 * test fails with the exact role/permission that diverged.
 */

import { Client } from 'pg';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { APP_PERMISSIONS, BUILT_IN_ROLE_PERMISSIONS } from '@repo/db-types/permissions';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54332/postgres';

const BUILT_IN_ROLES = ['owner', 'admin', 'write', 'read'] as const;

let client: Client;

describe('generated permission map matches the seeded role_permissions', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  }, 30000);

  afterAll(async () => {
    if (client) await client.end();
  });

  it('BUILT_IN_ROLE_PERMISSIONS equals the DB seed for every built-in role', async () => {
    const res = await client.query<{ role: string; permission: string }>(
      `SELECT role::text AS role, permission::text AS permission
         FROM public.role_permissions
        WHERE role::text = ANY($1)`,
      [[...BUILT_IN_ROLES]],
    );

    const dbByRole: Record<string, string[]> = { owner: [], admin: [], write: [], read: [] };
    for (const row of res.rows) dbByRole[row.role]!.push(row.permission);

    for (const role of BUILT_IN_ROLES) {
      const fromDb = [...dbByRole[role]!].sort();
      const fromMap = [...BUILT_IN_ROLE_PERMISSIONS[role]].sort();
      expect(fromMap, `role ${role} permission set`).toEqual(fromDb);
    }
  });

  it('APP_PERMISSIONS equals the distinct set of seeded permissions', async () => {
    const res = await client.query<{ permission: string }>(
      `SELECT DISTINCT permission::text AS permission
         FROM public.role_permissions
        WHERE role::text = ANY($1)`,
      [[...BUILT_IN_ROLES]],
    );
    const fromDb = res.rows.map((r) => r.permission).sort();
    const fromCatalog = [...APP_PERMISSIONS].sort();
    expect(fromCatalog).toEqual(fromDb);
  });
});
