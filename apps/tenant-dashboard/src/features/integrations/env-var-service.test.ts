/**
 * Regression test for `EnvVarService` — legacy-name vault fallback during the
 * per-environment env-var migration window.
 *
 * Background — the data-loss bug:
 *   Before per-environment scoping, an env-var's vault secret was named
 *   `env_${appId}_${key}` — one app-wide value. Scoping env vars per
 *   environment changed the secret name to
 *   `env_${appId}_${environmentId}_${key}`.
 *
 *   The per-environment migration replicates each app-default env-var
 *   row to every environment, copying the SAME `vault_secret_id`. It does NOT
 *   (and cannot) rename the underlying vault secret: N replicated rows share
 *   ONE secret, so no single env-scoped name satisfies all of them.
 *
 *   `read_secret` resolves secrets *by name*. So immediately after the
 *   migration, `getValue()` looks up the new env-scoped name, which does not
 *   exist — and a caller silently loses every env var that existed before
 *   the migration. `collectEnvVars` (`lib/system/collect-env-vars.ts`) hits
 *   the same fallback on the deployment-build read path; its own tests cover it.
 *
 * The fix under test:
 *   `EnvVarService` read paths retry the legacy `env_${appId}_${key}` name on
 *   a miss against the new env-scoped name. These tests exercise that fallback
 *   against a "migrated" row — an `env_var` row whose vault secret
 *   still carries its legacy name — and assert the value resolves.
 *
 * Test boundary: nothing here is mocked. The Supabase REST table and the vault
 * RPCs (`read_secret`) are faked via MSW seed helpers per the rules in
 * `apps/tenant-dashboard/CLAUDE.md`.
 *
 * One behavior per test; assert outcomes, not absence.
 */

import { http, HttpResponse } from "msw";
import { EnvVarService } from "./env-var-service";
import {
  getVaultMswState,
  seedManagedDeploymentTablesState,
  seedVaultMswState,
} from "@/test-helpers/msw-handlers";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { server } from "@/test-helpers/msw-server";

const SUPABASE_URL = "http://localhost:54321";

const APP_ID = "app-1";
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const ENV_VAR_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "DATABASE_URL";

function createService(): EnvVarService {
  return new EnvVarService({ supabase: createMswRestClient() });
}

describe("EnvVarService — migration-window legacy vault-name fallback", () => {
  describe("getValue", () => {
    it("should resolve the value via the legacy app-scoped name when the env-scoped secret is missing", async () => {
      // A migrated row: the `env_var` row is env-scoped (it carries
      // `environment_id`), but the vault secret still has its pre-055 legacy
      // name `env_${appId}_${key}` — the migration could not rename it.
      seedManagedDeploymentTablesState({
        envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
      });
      seedVaultMswState({
        secrets: {
          // ONLY the legacy name exists. The env-scoped name is absent.
          [`env_${APP_ID}_${KEY}`]: "postgres://legacy-value",
        },
      });

      const value = await createService().getValue(APP_ID, ENV_VAR_ID);

      expect(value).toBe("postgres://legacy-value");
    });

    it("should prefer the env-scoped secret over the legacy one when both exist", async () => {
      // After a re-save, `set()` writes the new env-scoped name. The env-scoped
      // value must win — the legacy fallback is only for the migration window.
      seedManagedDeploymentTablesState({
        envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
      });
      seedVaultMswState({
        secrets: {
          [`env_${APP_ID}_${ENV_ID}_${KEY}`]: "postgres://env-scoped-value",
          [`env_${APP_ID}_${KEY}`]: "postgres://legacy-value",
        },
      });

      const value = await createService().getValue(APP_ID, ENV_VAR_ID);

      expect(value).toBe("postgres://env-scoped-value");
    });

    it("should return null when neither the env-scoped nor the legacy secret exists", async () => {
      seedManagedDeploymentTablesState({
        envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
      });
      seedVaultMswState({ secrets: {} });

      const value = await createService().getValue(APP_ID, ENV_VAR_ID);

      expect(value).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Kind-scoped operations — a hand-rolled Supabase fake (the service accepts an
// injected client) so the kind branches (scope Vault naming, kind-secret
// reads, kind inserts/deletes) are unit-covered without the MSW PostgREST
// layer. The migration-window MSW tests above cover the specific-env legacy
// fallback.
// ---------------------------------------------------------------------------

function fakeSupabase(opts: {
  /** Result for any `env_var` query (a single row for delete/getValue lookups). */
  evrResult?: { data: unknown; error: unknown };
  secrets?: Record<string, string | null>;
  /** read_secret errors keyed by secret_name — to exercise the fail-loud
   *  branches (vault error vs a plain miss). */
  secretErrors?: Record<string, { message: string }>;
  /** Forces the `env_var` insert to fail (RLS/unique-constraint
   *  refusal), to exercise the vault-cleanup-on-refused-insert path. */
  insertError?: { message: string };
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const evr: Record<string, unknown> = {};
  Object.assign(evr, {
    select: () => evr,
    eq: () => evr,
    maybeSingle: () =>
      Promise.resolve(opts.evrResult ?? { data: null, error: null }),
    delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    insert: (payload: Record<string, unknown>) => {
      inserts.push(payload);
      return {
        select: () => ({
          single: () =>
            opts.insertError
              ? Promise.resolve({ data: null, error: opts.insertError })
              : Promise.resolve({ data: { id: "new-id", key: "K" }, error: null }),
        }),
      };
    },
  });
  const client = {
    from: () => evr,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "read_secret") {
        const secretName = args.secret_name as string;
        const secretErr = opts.secretErrors?.[secretName];
        if (secretErr) {
          return Promise.resolve({ data: null, error: secretErr });
        }
        return Promise.resolve({
          data: opts.secrets?.[secretName] ?? null,
          error: null,
        });
      }
      if (name === "insert_secret") {
        return Promise.resolve({ data: "secret-id", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, rpcCalls, inserts };
}

function svc(client: unknown): EnvVarService {
  return new EnvVarService({ supabase: client as never });
}

describe("EnvVarService — kind-scoped operations", () => {
  it("getValue reads a kind row's value via the kind Vault name", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, target_kind: "preview", key: "SHARED" }],
    });
    seedVaultMswState({
      secrets: { [`env_${APP_ID}_kind_preview_SHARED`]: "prev-value" },
    });
    expect(await createService().getValue(APP_ID, ENV_VAR_ID)).toBe("prev-value");
  });

  it("delete removes a kind row's kind-named Vault secret", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, target_kind: "preview", key: "SHARED" }],
    });
    const vaultName = `env_${APP_ID}_kind_preview_SHARED`;
    seedVaultMswState({ secrets: { [vaultName]: "prev-value" } });

    await createService().delete(APP_ID, ENV_VAR_ID);

    expect(getVaultMswState().secrets[vaultName]).toBeUndefined();
  });

  it("set writes a kind row under the kind Vault name (no env-ownership check)", async () => {
    seedManagedDeploymentTablesState({ envVars: [] }); // no existing row → insert path
    seedVaultMswState({ secrets: {} });

    const result = await createService().set(
      APP_ID,
      { targetKind: "preview" },
      "tenant-1",
      "NEW_KEY",
      "v",
    );

    expect(result.key).toBe("NEW_KEY");
    expect(getVaultMswState().secrets[`env_${APP_ID}_kind_preview_NEW_KEY`]).toBe("v");
  });
});

describe("EnvVarService — environment-scoped writes", () => {
  it("set verifies env ownership and writes the env-scoped Vault name", async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID }], // ownership OK
      envVars: [], // no existing row → insert
    });
    seedVaultMswState({ secrets: {} });

    const result = await createService().set(
      APP_ID,
      { environmentId: ENV_ID },
      "tenant-1",
      "NEW_KEY",
      "v",
    );

    expect(result.key).toBe("NEW_KEY");
    expect(getVaultMswState().secrets[`env_${APP_ID}_${ENV_ID}_NEW_KEY`]).toBe("v");
    // The row binds to the ENV, not a kind: listAll's env-scoped row for the
    // new key carries environment_id and no target_kind.
    const rows = await createService().listAll(APP_ID);
    expect(rows).toContainEqual(
      expect.objectContaining({
        key: "NEW_KEY",
        environment_id: ENV_ID,
        target_kind: null,
      }),
    );
  });

  it("set cleans up the vault secret when the row insert is refused, leaving no orphan", async () => {
    // The vault write on the create leg happens before the row insert. If the
    // insert is then refused (RLS/unique-constraint), the just-written secret
    // must not be left behind under the deterministic scope name — an orphan
    // there would brick every later legitimate create for the same key/scope.
    // Vault reads/writes always ride the service-role client in
    // `lib/system/env-var-secrets` (MSW-intercepted), independent of the
    // injected `deps.supabase` — so the vault state and the env-ownership
    // check are seeded/asserted through MSW, while the row insert itself is
    // refused via the injected fake client.
    seedManagedDeploymentTablesState({ environments: [{ id: ENV_ID, app_id: APP_ID }] });
    seedVaultMswState({ secrets: {} });
    const vaultName = `env_${APP_ID}_${ENV_ID}_NEW_KEY`;
    const { client } = fakeSupabase({
      evrResult: { data: null, error: null }, // no existing row → insert path
      insertError: { message: "duplicate key value violates unique constraint" },
    });

    await expect(
      svc(client).set(APP_ID, { environmentId: ENV_ID }, "tenant-1", "NEW_KEY", "v"),
    ).rejects.toThrow(/duplicate key value/);

    // The vault write must have happened (that's why the vault-write error
    // branch, "Failed to store secret in vault", was NOT what threw), and it
    // must be gone now — never left behind under the deterministic name.
    expect(getVaultMswState().secrets[vaultName]).toBeUndefined();
  });

  it("set rejects an environment that does not belong to the app, before writing the secret", async () => {
    // No environment seeded on the admin client → ownership resolves false.
    const { client, rpcCalls } = fakeSupabase({});
    await expect(
      svc(client).set(APP_ID, { environmentId: "ghost" }, "tenant-1", "K", "v"),
    ).rejects.toThrow(/does not belong/);
    expect(rpcCalls.find((c) => c.name === "insert_secret")).toBeUndefined();
  });

  it("set throws (fail-closed) when the env-ownership lookup itself errors, distinct from a genuine miss", async () => {
    // A DB error during the ownership check must abort with a lookup-failure
    // error, not the "does not belong to app" message a real miss produces —
    // and it must abort BEFORE any secret is written.
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/environment`, () =>
        HttpResponse.json({ message: "ownership lookup boom" }, { status: 500 }),
      ),
    );

    await expect(
      createService().set(APP_ID, { environmentId: ENV_ID }, "tenant-1", "K", "v"),
    ).rejects.toThrow(/Failed to verify environment ownership.*ownership lookup boom/);

    expect(getVaultMswState().secrets[`env_${APP_ID}_${ENV_ID}_K`]).toBeUndefined();
  });

  it("set throws instead of reporting success when the update leg is RLS-filtered to 0 rows", async () => {
    // Supabase reports an RLS-refused UPDATE as `error: null` with an empty
    // result — indistinguishable from "matched nothing" without .select().
    // The vault secret is replaced in place before this row write runs, so a
    // refused row write here does not orphan anything, but it still must not
    // report success for a metadata write that never applied.
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID }],
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: "EXISTING_KEY" }],
    });
    seedVaultMswState({ secrets: { [`env_${APP_ID}_${ENV_ID}_EXISTING_KEY`]: "old-value" } });
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/env_var`, () => HttpResponse.json([])),
    );

    await expect(
      createService().set(APP_ID, { environmentId: ENV_ID }, "tenant-1", "EXISTING_KEY", "new-value"),
    ).rejects.toThrow(/was not applied/);

    // The new value is already in the vault (the value write happens before
    // the row write, and update-in-place never removes the old value) —
    // asserting this pins that the thrown error reflects a stale row, not a
    // vault write that also failed.
    expect(getVaultMswState().secrets[`env_${APP_ID}_${ENV_ID}_EXISTING_KEY`]).toBe("new-value");
  });

  it("set replaces an existing secret in place, never deleting it first", async () => {
    // Calling deleteEnvVarSecret before writeEnvVarSecret on the update leg
    // leaves the row pointing at a deleted secret whenever the write fails,
    // so the update leg replaces the value in place (`update_secret`): a
    // failed replacement must leave the previous value readable and the
    // row's `vault_secret_id` unchanged.
    const vaultName = `env_${APP_ID}_${ENV_ID}_EXISTING_KEY`;
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID }],
      envVars: [
        { id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: "EXISTING_KEY", vault_secret_id: "orig-secret-id" },
      ],
    });
    seedVaultMswState({ secrets: { [vaultName]: "old-value" } });

    const result = await createService().set(APP_ID, { environmentId: ENV_ID }, "tenant-1", "EXISTING_KEY", "new-value");

    expect(result).toEqual({ id: ENV_VAR_ID, key: "EXISTING_KEY" });
    // Exactly one value lives under the deterministic name — the previous
    // value is replaced, never removed and left absent.
    expect(getVaultMswState().secrets[vaultName]).toBe("new-value");
  });

  it("set leaves the previous value intact when the in-place vault write fails", async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID }],
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: "EXISTING_KEY" }],
    });
    const vaultName = `env_${APP_ID}_${ENV_ID}_EXISTING_KEY`;
    seedVaultMswState({
      secrets: { [vaultName]: "old-value" },
      forceUpdateError: { message: "vault unavailable" },
    });

    await expect(
      createService().set(APP_ID, { environmentId: ENV_ID }, "tenant-1", "EXISTING_KEY", "new-value"),
    ).rejects.toThrow(/Failed to store secret in vault/);

    // No delete ever ran — the previous value is still there, byte for byte.
    expect(getVaultMswState().secrets[vaultName]).toBe("old-value");
  });

  it("set falls back to a plain write when re-saving a row whose secret still lives under the legacy name", async () => {
    // The migration-window case: the row is env-scoped but its live secret
    // has not been re-saved yet, so `update_secret` finds nothing under the
    // new env-scoped name. The re-save must still succeed and write the
    // env-scoped name fresh, per the legacy-fallback contract.
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID }],
      envVars: [
        { id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY, vault_secret_id: "legacy-secret-id" },
      ],
    });
    seedVaultMswState({ secrets: { [`env_${APP_ID}_${KEY}`]: "legacy-value" } });
    // Pin insert_secret's return to a known id (the real handler returns a
    // fresh random UUID) so the row's stored id can be asserted by equality
    // against the actual id the fallback write minted, not just "changed".
    // Still performs the real handler's state write — only the returned id
    // is fixed.
    const NEW_SECRET_ID = "new-fallback-secret-id";
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/insert_secret`, async ({ request }) => {
        const body = (await request.json()) as { name?: string; secret?: string };
        if (body.name && body.secret !== undefined) {
          getVaultMswState().secrets[body.name] = body.secret;
        }
        return HttpResponse.json(NEW_SECRET_ID);
      }),
    );

    await createService().set(APP_ID, { environmentId: ENV_ID }, "tenant-1", KEY, "resaved-value");

    expect(getVaultMswState().secrets[`env_${APP_ID}_${ENV_ID}_${KEY}`]).toBe("resaved-value");
    // The fallback leg creates a BRAND NEW secret under the env-scoped name —
    // the row must be updated to point at that new id, not left carrying the
    // stale id of the legacy secret.
    const { data: updated } = await createMswRestClient()
      .from("env_var")
      .select("vault_secret_id")
      .eq("id", ENV_VAR_ID)
      .single();
    expect((updated as { vault_secret_id: string } | null)?.vault_secret_id).toBe(NEW_SECRET_ID);
  });

});

// ---------------------------------------------------------------------------
// Fail-loud error propagation — a vault/db ERROR (distinct from a miss) must
// surface, never be swallowed into a null/empty result. A swallowed read error
// silently deploys a machine without a credential it should have had; a
// swallowed delete-lookup error silently no-ops a delete the user requested.
// ---------------------------------------------------------------------------
describe("EnvVarService — error propagation (fail loud)", () => {
  it("delete throws when the row lookup errors (does not silently no-op)", async () => {
    const { client, rpcCalls } = fakeSupabase({
      evrResult: { data: null, error: { message: "lookup boom" } },
    });
    await expect(svc(client).delete(APP_ID, ENV_VAR_ID)).rejects.toThrow(
      /lookup boom/,
    );
    // Must abort BEFORE touching the vault — no delete_secret on a failed lookup.
    expect(rpcCalls.find((c) => c.name === "delete_secret")).toBeUndefined();
  });

  it("getValue throws when a kind row's vault read errors (not returned as null)", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, target_kind: "preview", key: "SHARED" }],
    });
    seedVaultMswState({
      secrets: {},
      secretReadErrors: {
        [`env_${APP_ID}_kind_preview_SHARED`]: { message: "vault down" },
      },
    });
    await expect(createService().getValue(APP_ID, ENV_VAR_ID)).rejects.toThrow(
      /Failed to read secret.*vault down/,
    );
  });

  it("getValue throws when an env row's primary (env-scoped) vault read errors", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
    });
    seedVaultMswState({
      secrets: {},
      secretReadErrors: {
        [`env_${APP_ID}_${ENV_ID}_${KEY}`]: { message: "primary vault err" },
      },
    });
    await expect(createService().getValue(APP_ID, ENV_VAR_ID)).rejects.toThrow(
      /Failed to read secret.*primary vault err/,
    );
  });

  it("getValue throws when the legacy-fallback vault read errors after a primary miss", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: ENV_VAR_ID, app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
    });
    // primary name absent (a miss → falls through to legacy), legacy errors.
    seedVaultMswState({
      secrets: {},
      secretReadErrors: {
        [`env_${APP_ID}_${KEY}`]: { message: "legacy vault err" },
      },
    });
    await expect(createService().getValue(APP_ID, ENV_VAR_ID)).rejects.toThrow(
      /Failed to read secret.*legacy vault err/,
    );
  });
});
