/**
 * `lib/system/resolve-env-scope` — the admin-client env resolution exception
 * (env-var/webhook actions gate on their own table's permission alone, not
 * `environment.read`). `resolveEnvIdForStorageAdmin` and
 * `environmentBelongsToAppAdmin` are exercised transitively by
 * `EnvVarService.set`'s ownership check; this file pins
 * `listEnvironmentNamesAdmin` directly — the id→name map `loadEnvironmentNames`
 * (features/integrations/read.ts) returns to the env-vars settings page.
 */

import { http, HttpResponse } from "msw";
import { environmentBelongsToAppAdmin, listEnvironmentNamesAdmin } from "./resolve-env-scope";
import { seedApiKeysMswState } from "@/test-helpers/msw-handlers";
import { server } from "@/test-helpers/msw-server";

const SUPABASE_URL = "http://localhost:54321";
const APP_ID = "app-1";
const ENV_ID = "env-1";

// `seedManagedDeploymentTablesState`'s `environment` handler only resolves a
// single row (the env-ownership-check shape other tests need); it is
// registered first and, once seeded, would shadow the list-capable handler
// this function needs. Leaving it unseeded (its default empty state) makes
// its handler fall through to the list-capable one in api-keys.ts.
describe("listEnvironmentNamesAdmin", () => {
  it("maps every environment on the app to its name", async () => {
    seedApiKeysMswState({
      environments: [
        { id: "env-1", app_id: APP_ID, name: "production", is_default: true },
        { id: "env-2", app_id: APP_ID, name: "staging", is_default: false },
        { id: "env-3", app_id: "other-app", name: "unrelated", is_default: true },
      ],
    });

    await expect(listEnvironmentNamesAdmin(APP_ID)).resolves.toEqual({
      "env-1": "production",
      "env-2": "staging",
    });
  });

  it("returns an empty map when the app has no environments", async () => {
    seedApiKeysMswState({ environments: [] });

    await expect(listEnvironmentNamesAdmin(APP_ID)).resolves.toEqual({});
  });
});

describe("environmentBelongsToAppAdmin", () => {
  it("returns true when the environment belongs to the app, false otherwise", async () => {
    seedApiKeysMswState({
      environments: [{ id: ENV_ID, app_id: APP_ID, name: "production", is_default: true }],
    });

    await expect(environmentBelongsToAppAdmin(APP_ID, ENV_ID)).resolves.toBe(true);
    await expect(environmentBelongsToAppAdmin("other-app", ENV_ID)).resolves.toBe(false);
    await expect(environmentBelongsToAppAdmin(APP_ID, "ghost-env")).resolves.toBe(false);
  });

  it("throws (fail-closed) when the ownership lookup itself errors, distinct from a genuine miss", async () => {
    // A DB error during the lookup must not be reported the same way as "no
    // such row" — the caller (EnvVarService.set) treats a `false` return as
    // "refuse the write", so collapsing a transient error into `false` would
    // surface a misleading "does not belong to app" message for what was
    // actually a lookup failure.
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/environment`, () =>
        HttpResponse.json({ message: "ownership lookup boom" }, { status: 500 }),
      ),
    );

    await expect(environmentBelongsToAppAdmin(APP_ID, ENV_ID)).rejects.toThrow(
      /Failed to verify environment ownership.*ownership lookup boom/,
    );
  });
});
