/**
 * AppsService.listAppsWithGitStatus — exercised through the real PostgREST
 * query path against the MSW `app` table handler (no query-chain mocks). The
 * service takes a per-request `ctx`; the client arrives as `ctx.db`, so these
 * assert both the request shape (the explicit projection + `!<fk_name>` embed
 * hints) and the join→`AppWithGitConnection` mapping.
 */

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { createMswRestClient } from "@/test-helpers/rest-client";
import {
  seedAppsListMswState,
  getCapturedAppsListSelect,
  type AppsListMswRow,
} from "@/test-helpers/msw-handlers";

import { appsService } from "./service";

const TENANT_ID = "tenant-1";
const ACTOR = { userId: "user-1", role: "owner" };

function ctx(): ServiceContext {
  return { db: createMswRestClient(), tenantId: TENANT_ID, actor: ACTOR };
}

describe("AppsService.listAppsWithGitStatus — query shape", () => {
  it("projects explicit columns (never *) and carries every FK-hinted embed", async () => {
    seedAppsListMswState([
      {
        id: "app-1",
        name: "brave-blue-cat",
        display_name: "Triage Bot",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: null,
        git_connection: [],
        git_branch: [],
        environment: [],
      },
    ]);

    await appsService.listAppsWithGitStatus(ctx());

    const select = getCapturedAppsListSelect();
    expect(select).not.toBeNull();
    // Explicit projection — never the eval_run/worker_run-class `select("*")`.
    expect(select).not.toMatch(/(^|[,\s])\*/);
    expect(select).toContain("id");
    expect(select).toContain("name");
    expect(select).toContain("display_name");
    expect(select).toContain("created_at");
    // The FK hints disambiguating the composite (tenant_id, app_id) FKs.
    expect(select).toContain("git_connection!git_connection_app_id_fkey");
    expect(select).toContain("git_branch!github_branch_app_id_fkey");
    expect(select).toContain("environment!environment_app_id_fkey");
  });
});

describe("AppsService.listAppsWithGitStatus — join mapping", () => {
  it("maps a connected app with a linked branch and multiple environments", async () => {
    const rows: AppsListMswRow[] = [
      {
        id: "app-1",
        name: "brave-blue-cat",
        display_name: "Triage Bot",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-02T00:00:00.000Z",
        git_connection: [
          { app_id: "app-1", installation_id: 999, repository: "acme/triage", provider: "github" },
        ],
        git_branch: [{ app_id: "app-1", branch_name: "main" }],
        environment: [
          { name: "dev", is_default: true, current_version: 3 },
          { name: "staging", is_default: false, current_version: 1 },
        ],
      },
    ];
    seedAppsListMswState(rows);

    const result = await appsService.listAppsWithGitStatus(ctx());

    expect(result).toEqual([
      expect.objectContaining({
        id: "app-1",
        name: "brave-blue-cat",
        display_name: "Triage Bot",
        isGitConnected: true,
        provider: "github",
        repository: "acme/triage",
        connectedBranch: "main",
        environments: [
          { name: "dev", is_default: true, current_version: 3 },
          { name: "staging", is_default: false, current_version: 1 },
        ],
      }),
    ]);
  });

  it("maps an unconnected app to isGitConnected: false, provider: null, repository: null", async () => {
    seedAppsListMswState([
      {
        id: "app-2",
        name: "quiet-red-fox",
        display_name: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: null,
        git_connection: [],
        git_branch: [],
        environment: [],
      },
    ]);

    const [app] = await appsService.listAppsWithGitStatus(ctx());

    expect(app).toEqual(
      expect.objectContaining({
        isGitConnected: false,
        provider: null,
        repository: null,
        connectedBranch: undefined,
        environments: [],
      }),
    );
  });

  it("maps a legacy gitlab connection with no installation_id to isGitConnected: false", async () => {
    // There is no GitLab OAuth provider, but legacy gitlab rows persist with
    // no installation — they must never report as connected.
    seedAppsListMswState([
      {
        id: "app-3",
        name: "old-gitlab-app",
        display_name: null,
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: null,
        git_connection: [
          { app_id: "app-3", installation_id: null, repository: "acme/legacy", provider: "gitlab" },
        ],
        git_branch: [],
        environment: [],
      },
    ]);

    const [app] = await appsService.listAppsWithGitStatus(ctx());

    expect(app).toEqual(
      expect.objectContaining({
        isGitConnected: false,
        provider: "gitlab",
        repository: "acme/legacy",
      }),
    );
  });
});
