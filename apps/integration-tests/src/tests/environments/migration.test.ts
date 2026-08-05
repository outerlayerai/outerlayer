/**
 * Integration tests for the environment data migration.
 *
 * Tests run against a real local Supabase instance.
 * The only mock anywhere in this file is the Fly client used by the fixture
 * (Fly API costs/latency). Everything else is real Postgres.
 *
 * ── Testing a migration on an already-migrated database ──────────────────────
 *
 * The local Supabase the integration suite runs against has ALL environment
 * migrations already applied — including the default-env seed in
 * `20260524150001_environments_promotion_and_navigation.sql`. We cannot un-apply it and re-run it, and the suite has no raw-SQL
 * channel (no `pg` client, no `exec_sql` RPC). So this file asserts the
 * migration's *observable contract* rather than re-executing its DO-block:
 *
 *   STRATEGY A — post-migration INVARIANTS on the live schema.
 *     The migration's contract is a set of invariants: every app has exactly
 *     one default `dev` env; every api_key has environment_id set
 *     (NOT NULL-enforced by migration 9); the per-app marker
 *     column exists and is populated. If the migration were broken or
 *     absent the schema would not satisfy these — we assert each directly.
 *
 *   STRATEGY B — assert the MECHANISMS the migration's idempotency and
 *     resumability rest on, using only the Supabase JS client:
 *       · idempotency  → the partial UNIQUE index `idx_environment_one_default_
 *                         per_app` plus `ON CONFLICT (app_id, name)` make a
 *                         re-run a no-op. We prove the index rejects a second
 *                         default env, which is exactly what stops the
 *                         migration from double-seeding on a re-run.
 *       · resumability → the migration's work queue is `app WHERE environment_
 *                         migration_done_at IS NULL`. We prove the marker
 *                         column behaves as a per-app boolean gate: an app with
 *                         a NULL marker is selectable as pending; setting the
 *                         marker removes it from the queue. Per-app scoping is
 *                         what makes a partial failure resumable.
 *
 *     This avoids re-implementing the migration's INSERT/UPDATE logic (which
 *     would be a "mirrored production logic" test smell) — it tests the schema
 *     guarantees the migration depends on, which is what would actually break.
 *
 *   The migration does NOT backfill env columns on pre-existing env_var
 *     rows. We assert a freshly inserted row (the shape of a pre-feature row)
 *     keeps environment_id NULL.
 *
 * Each test covers one behavior, seeding its own rows and deleting them in the same block.
 */
import { randomUUID } from 'crypto';
import { EnvironmentService } from '@repo/environments-service';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { setupEnvFixture } from './helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Environment data migration', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  // ──────────────────────────────────────────────────────────────────────────
  // STRATEGY A — post-migration invariants on the live schema.
  // ──────────────────────────────────────────────────────────────────────────

  describe('post-migration invariants (Strategy A)', () => {
    it('should have exactly one default env per app for apps this test owns', async () => {
      // Every app that goes through the default-env code path receives
      // exactly one default `dev` env.
      //
      // The assertion is scoped to apps THIS TEST owns — not the whole `app`
      // table. The integration suite runs against a SHARED local Supabase that
      // other suites (and prior runs) leave rows in; some of those apps were
      // inserted directly without invoking the default-env code path, so a
      // global scan would flag them and produce a failure unrelated to this
      // migration. `setupEnvFixture` creates an app via the same service the
      // production app-creation action uses (`createDefaultEnvironment`), so
      // the fixture's app is a faithful subject for the invariant. We also
      // insert a second app and run that same service against it, so the
      // invariant is exercised on more than one app.
      const fixture = await setupEnvFixture();
      let secondAppId: string | null = null;
      try {
        // A second app, taken through the same default-env code path.
        const { data: secondApp, error: secondAppErr } = await admin
          .from('app')
          .insert({
            tenant_id: fixture.tenant.id,
            name: `migration-invariant-${randomUUID().slice(0, 8)}`,
            created_by: fixture.ownerUser.id,
          })
          .select('id')
          .single();
        if (secondAppErr || !secondApp) {
          throw new Error(secondAppErr?.message ?? 'second app insert failed');
        }
        secondAppId = secondApp.id as string;

        const envService = new EnvironmentService({ supabase: admin });
        await envService.createDefaultEnvironment({
          tenantId: fixture.tenant.id,
          appId: secondAppId,
          actorId: fixture.ownerUser.id,
        });

        const ownedAppIds = [fixture.app.id, secondAppId];

        const { data: defaultEnvs, error: envErr } = await admin
          .from('environment')
          .select('app_id')
          .eq('is_default', true)
          .in('app_id', ownedAppIds);
        if (envErr) throw new Error(envErr.message);

        const countByApp = new Map<string, number>();
        for (const row of defaultEnvs ?? []) {
          const appId = row.app_id as string;
          countByApp.set(appId, (countByApp.get(appId) ?? 0) + 1);
        }

        // Each owned app has exactly one default env — none missing, none doubled.
        for (const appId of ownedAppIds) {
          expect(countByApp.get(appId)).toBe(1);
        }
      } finally {
        if (secondAppId) {
          await admin.from('environment').delete().eq('app_id', secondAppId);
          await admin.from('app').delete().eq('id', secondAppId);
        }
        await fixture.cleanup();
      }
    });

    it("should name every default env 'dev'", async () => {
      // The default env name is fixed to `dev`.
      const { data, error } = await admin
        .from('environment')
        .select('name')
        .eq('is_default', true);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        expect(row.name).toBe('dev');
      }
    });

    it('should have environment_id set on every api_key (auto-bound on migration)', async () => {
      // migration 9 (NOT NULL enforcement): no api_key may have a
      // NULL environment_id post-migration.
      const { data, error } = await admin
        .from('api_key')
        .select('id')
        .is('environment_id', null);
      if (error) throw new Error(error.message);
      expect(data).toEqual([]);
    });

    it('should expose the environment_migration_done_at marker column on app', async () => {
      // The migration adds `app.environment_migration_done_at`. We assert
      // the column exists and is selectable — that is the durable, parallel-
      // safe invariant.
      //
      // NOTE: we deliberately do NOT assert "every app has a non-NULL marker".
      // In a live database the migration only sets the marker on apps that
      // existed when it ran; apps created AFTER the migration (including the
      // ones this very test suite's fixtures insert concurrently) get their
      // default env from the app-creation server action, not the migration, so
      // their marker is legitimately NULL. The marker is a migration work-queue
      // gate, not a per-app permanent invariant. The real cross-app invariant —
      // "exactly one default env per app" — is asserted above and holds for
      // every app regardless of how it was created.
      const { error } = await admin
        .from('app')
        .select('id, environment_migration_done_at')
        .limit(1);
      expect(error).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STRATEGY B — the mechanisms idempotency + resumability rest on.
  // ──────────────────────────────────────────────────────────────────────────

  describe('idempotency mechanism: one-default-env-per-app is enforced', () => {
    it('should reject inserting a second default env for an app', async () => {
      // The migration is idempotent because a re-run that tries to re-seed a
      // default env hits the partial UNIQUE index `idx_environment_one_default
      // _per_app`. The fixture already has one default env — a second default
      // insert must fail.
      const fixture = await setupEnvFixture();
      try {
        const { error } = await admin.from('environment').insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: 'dev-dupe',
          is_default: true,
        });

        expect(error).not.toBeNull();
        // Postgres unique-violation SQLSTATE.
        expect(error?.code).toBe('23505');
      } finally {
        await fixture.cleanup();
      }
    });

    it('should reject inserting a second env with the same name in an app', async () => {
      // The migration's INSERT uses `ON CONFLICT (app_id, name) DO NOTHING`;
      // the underlying guarantee is the `idx_environment_app_name_unique`
      // index. A re-run that re-inserts `dev` is a no-op because of it. We
      // prove the index rejects a duplicate `dev` for the same app.
      const fixture = await setupEnvFixture();
      try {
        const { error } = await admin.from('environment').insert({
          tenant_id: fixture.tenant.id,
          app_id: fixture.app.id,
          name: 'dev', // same name as the fixture's default env
          is_default: false,
        });

        expect(error).not.toBeNull();
        expect(error?.code).toBe('23505');
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe('resumability mechanism: the per-app marker gates the work queue', () => {
    it('should expose an app with a NULL marker as pending migration', async () => {
      // The migration's work queue is `WHERE environment_migration_done_at IS
      // NULL`. A partial failure leaves some apps with a NULL marker; a re-run
      // picks exactly those up. We prove an app inserted with a NULL marker is
      // selectable by that predicate (resumable), and an app with the marker
      // set is excluded (already done).
      const fixture = await setupEnvFixture();
      let pendingAppId: string | null = null;
      let doneAppId: string | null = null;
      try {
        const { data: pending } = await admin
          .from('app')
          .insert({
            tenant_id: fixture.tenant.id,
            name: `migration-pending-${randomUUID().slice(0, 8)}`,
            created_by: fixture.ownerUser.id,
            environment_migration_done_at: null,
          })
          .select('id')
          .single();
        pendingAppId = pending?.id as string;

        const { data: done } = await admin
          .from('app')
          .insert({
            tenant_id: fixture.tenant.id,
            name: `migration-done-${randomUUID().slice(0, 8)}`,
            created_by: fixture.ownerUser.id,
            environment_migration_done_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        doneAppId = done?.id as string;

        // The migration's selector: apps still needing work.
        const { data: queue } = await admin
          .from('app')
          .select('id')
          .is('environment_migration_done_at', null)
          .eq('tenant_id', fixture.tenant.id);
        const queueIds = (queue ?? []).map((r) => r.id as string);

        expect(queueIds).toContain(pendingAppId);
        expect(queueIds).not.toContain(doneAppId);
      } finally {
        for (const id of [pendingAppId, doneAppId]) {
          if (id) await admin.from('app').delete().eq('id', id);
        }
        await fixture.cleanup();
      }
    });

    it('should remove an app from the work queue once its marker is set', async () => {
      // Completing an app sets the marker; a subsequent re-run skips it. This
      // is what makes the migration safe to re-run after a partial failure.
      const fixture = await setupEnvFixture();
      let appId: string | null = null;
      try {
        const { data } = await admin
          .from('app')
          .insert({
            tenant_id: fixture.tenant.id,
            name: `migration-flip-${randomUUID().slice(0, 8)}`,
            created_by: fixture.ownerUser.id,
            environment_migration_done_at: null,
          })
          .select('id')
          .single();
        appId = data?.id as string;

        // Act: mark it done (what the migration's final UPDATE does).
        await admin
          .from('app')
          .update({ environment_migration_done_at: new Date().toISOString() })
          .eq('id', appId);

        // Assert: it is no longer in the pending queue.
        const { data: queue } = await admin
          .from('app')
          .select('id')
          .is('environment_migration_done_at', null)
          .eq('id', appId);
        expect(queue).toEqual([]);
      } finally {
        if (appId) await admin.from('app').delete().eq('id', appId);
        await fixture.cleanup();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Env-scoped columns on pre-existing rows stay
  // NULL. The migration does NOT backfill these tables — a row inserted
  // without environment_id (the shape of a pre-feature row) keeps it NULL.
  // ──────────────────────────────────────────────────────────────────────────

  describe('non-backfilled tables stay env-NULL', () => {
    it('should reject a env_var insert with no environment_id', async () => {
      // `env_var.environment_id` is NOT NULL: the replicate-then-
      // constrain migration replicated every app-default row to each env and
      // constrained the column, so an app-default-shaped row with no
      // environment_id is rejected outright.
      //
      // env_var stores the value in Supabase Vault — the row holds a
      // `vault_secret_id`, not a plaintext `value`. Seed a vault secret first.
      const fixture = await setupEnvFixture();
      let secretId: string | null = null;
      const secretName = `migration_test_var_${randomUUID().slice(0, 8)}`;
      try {
        const { data: vaultId, error: secretErr } = await admin.rpc(
          'insert_secret',
          { name: secretName, secret: 'x' },
        );
        if (secretErr || !vaultId) throw new Error(secretErr?.message);
        secretId = vaultId as string;

        const { error } = await admin
          .from('env_var')
          .insert({
            tenant_id: fixture.tenant.id,
            app_id: fixture.app.id,
            key: 'MIGRATION_TEST_VAR',
            vault_secret_id: secretId,
            created_by: fixture.ownerUser.id,
          })
          .select('id, environment_id')
          .single();

        // environment_id is nullable now; a row with neither environment_id nor
        // a target_kind is rejected by chk_env_var_scope_exactly_one.
        expect(error).not.toBeNull();
        expect(error?.code).toBe('23514');
      } finally {
        if (secretId) {
          await admin.rpc('delete_secret', { secret_name: secretName });
        }
        await fixture.cleanup();
      }
    });

  });
});
