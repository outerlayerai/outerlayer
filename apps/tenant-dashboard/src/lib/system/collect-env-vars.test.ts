/**
 * `collectEnvVars` — the admin-authority lift of `EnvVarService.collectAll`'s
 * read path (env-var merge, precedence, and Vault resolution) into a
 * standalone function two non-feature callers reach directly.
 *
 * Test boundary per apps/tenant-dashboard/CLAUDE.md: the Supabase REST table
 * (`env_var`, `environment`) and the vault RPC (`read_secret`) are faked via
 * MSW seed helpers — nothing here mocks the merge/precedence logic itself, so
 * a regression in the wiring (wrong client, dropped args) fails this test.
 * `EnvVarService`'s own CRUD surface (`list`, `set`, `delete`, `getValue`) has
 * its own coverage in `features/integrations/env-var-service.test.ts`; the
 * `collectAll`-specific cases moved here with this lift, assertions unchanged.
 */

import { http, HttpResponse } from "msw";
import { collectEnvVars } from "./collect-env-vars";
import {
  seedManagedDeploymentTablesState,
  seedVaultMswState,
} from "@/test-helpers/msw-handlers";
import { server } from "@/test-helpers/msw-server";

const SUPABASE_URL = "http://localhost:54321";

const APP_ID = "app-1";
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "DATABASE_URL";

describe("collectEnvVars", () => {
  it("returns the same key-value map EnvVarService.collectAll resolved for the env", async () => {
    seedManagedDeploymentTablesState({
      envVars: [
        { id: "plain-id", app_id: APP_ID, environment_id: ENV_ID, key: "PLAIN_VAR" },
        { id: "secret-id", app_id: APP_ID, environment_id: ENV_ID, key: "SECRET_VAR" },
      ],
    });
    seedVaultMswState({
      secrets: {
        [`env_${APP_ID}_${ENV_ID}_PLAIN_VAR`]: "plain-value",
        [`env_${APP_ID}_${ENV_ID}_SECRET_VAR`]: "sk-secret-value",
      },
    });

    const result = await collectEnvVars(APP_ID, ENV_ID);

    expect(result).toEqual({
      PLAIN_VAR: "plain-value",
      SECRET_VAR: "sk-secret-value",
    });
  });

  it("includes a migrated env var by resolving its legacy-named secret", async () => {
    // The deployment-build path: a deployed machine must still receive every
    // pre-migration env var. Without the fallback this would silently omit
    // this key and the machine would boot without it.
    seedManagedDeploymentTablesState({
      envVars: [{ id: "22222222-2222-4222-8222-222222222222", app_id: APP_ID, environment_id: ENV_ID, key: KEY }],
    });
    seedVaultMswState({
      secrets: {
        [`env_${APP_ID}_${KEY}`]: "postgres://legacy-value",
      },
    });

    const envVars = await collectEnvVars(APP_ID, ENV_ID);

    expect(envVars).toEqual({ [KEY]: "postgres://legacy-value" });
  });

  it("resolves a kind-targeted row via the kind Vault name", async () => {
    seedManagedDeploymentTablesState({
      envVars: [{ id: "kind-id", app_id: APP_ID, target_kind: "all", key: "SHARED" }],
      environments: [{ id: ENV_ID, app_id: APP_ID, current_version: 0, is_ephemeral: false }],
    });
    seedVaultMswState({
      secrets: { [`env_${APP_ID}_kind_all_SHARED`]: "shared-value" },
    });

    expect(await collectEnvVars(APP_ID, ENV_ID)).toEqual({
      SHARED: "shared-value",
    });
  });

  it("returns an empty map (no throw) when the row query yields no rows", async () => {
    // Guards the `!rows?.length` early-return: a null/!-length result must short
    // out to {} and never fall through to resolve over a null row set.
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID, current_version: 0, is_ephemeral: false }],
    });
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/env_var`, () => HttpResponse.json(null)),
    );
    expect(await collectEnvVars(APP_ID, ENV_ID)).toEqual({});

    seedManagedDeploymentTablesState({ envVars: [] });
    expect(await collectEnvVars(APP_ID, ENV_ID)).toEqual({});
  });

  it("returns an empty map when the environment has no env vars", async () => {
    seedManagedDeploymentTablesState({ envVars: [] });
    seedVaultMswState({ secrets: {} });

    expect(await collectEnvVars(APP_ID, ENV_ID)).toEqual({});
  });

  it("throws when the candidate-row query errors", async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: ENV_ID, app_id: APP_ID, current_version: 0, is_ephemeral: false }],
    });
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/env_var`, () =>
        HttpResponse.json({ message: "select boom" }, { status: 500 }),
      ),
    );

    await expect(collectEnvVars(APP_ID, ENV_ID)).rejects.toThrow(
      /Failed to fetch env var list.*select boom/,
    );
  });
});
