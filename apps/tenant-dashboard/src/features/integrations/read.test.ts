/**
 * React Server Component (RSC) read loaders behind the env-vars and integrations settings pages.
 * Pins that each loader resolves the per-request ServiceContext, runs its
 * query through the real service (RLS-scoped `ctx.db`, except
 * `loadEnvironmentNames` which is the documented admin-client exception),
 * and returns the exact projected shape the page seeds its client
 * components with.
 */

import { http } from "msw";
import { buildSingleResponse } from "@repo/test-msw";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { server } from "@/test-helpers/msw-server";
import {
  seedManagedDeploymentTablesState,
} from "@/test-helpers/msw-handlers";

vi.mock("server-only", () => ({}));

const { loadCtxMock } = vi.hoisted(() => ({ loadCtxMock: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ loadRequestServiceContext: loadCtxMock }));

const { listEnvironmentNamesAdminMock } = vi.hoisted(() => ({
  listEnvironmentNamesAdminMock: vi.fn(),
}));
vi.mock("@/lib/system/resolve-env-scope", () => ({
  listEnvironmentNamesAdmin: listEnvironmentNamesAdminMock,
}));

import {
  loadEnvironmentNames,
  loadEnvVarsForApp,
  resolveAppIdByName,
} from "./read";

const SUPABASE_URL = "http://localhost:54321";
const APP_ID = "app-1";
const ENV_ID = "env-1";
const TENANT_ID = "tenant-1";

beforeEach(() => {
  loadCtxMock.mockResolvedValue({
    db: createMswRestClient(),
    tenantId: TENANT_ID,
    actor: { userId: "user-1", role: "owner" },
  } satisfies ServiceContext);
});

describe("resolveAppIdByName", () => {
  it("resolves the request context and returns the id of the app matching the given name", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) =>
        buildSingleResponse(request, { id: APP_ID }),
      ),
    );

    await expect(resolveAppIdByName("my-app")).resolves.toBe(APP_ID);
    expect(loadCtxMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when no app matches the given name (RLS-scoped: outside the tenant reads as absent)", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/app`, ({ request }) => buildSingleResponse(request, null)),
    );

    await expect(resolveAppIdByName("nonexistent")).resolves.toBeNull();
  });
});

describe("loadEnvVarsForApp", () => {
  it("resolves the request context and returns every env-var row for the app", async () => {
    seedManagedDeploymentTablesState({
      envVars: [
        { id: "ev-1", app_id: APP_ID, environment_id: ENV_ID, key: "A_KEY" },
        { id: "ev-2", app_id: "other-app", environment_id: ENV_ID, key: "OTHER" },
      ],
    });

    const rows = await loadEnvVarsForApp(APP_ID);

    expect(loadCtxMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      expect.objectContaining({ id: "ev-1", key: "A_KEY", environment_id: ENV_ID }),
    ]);
  });
});

describe("loadEnvironmentNames", () => {
  it("delegates to the admin-client resolver with the given appId and returns its map verbatim", async () => {
    listEnvironmentNamesAdminMock.mockResolvedValue({ "env-1": "production" });

    await expect(loadEnvironmentNames(APP_ID)).resolves.toEqual({ "env-1": "production" });
    expect(listEnvironmentNamesAdminMock).toHaveBeenCalledWith(APP_ID);
  });
});
