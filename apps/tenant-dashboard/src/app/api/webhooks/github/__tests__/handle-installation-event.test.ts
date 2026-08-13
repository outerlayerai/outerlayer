/**
 * handleInstallationEvent — `installation_repositories` webhook →
 * git-connection cleanup when the GitHub App loses access to a repo.
 *
 * Pins: a repository reported in `repositories_removed` has its
 * `git_connection` row deleted, scoped to the payload's installation id
 * (legacy NULL-installation rows stay matchable by repository name, but a
 * same-named repo under a DIFFERENT installation must survive); a repo not
 * in the removed list is left untouched; an event with no installation id
 * deletes nothing; and the cache revalidation targets the ORGANIZATION-NAME
 * route the apps page actually renders under. Supabase runs through MSW
 * (no client mocks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test-helpers/msw-server";

const API = "http://localhost:54321/rest/v1";

const m = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
// The global test setup stubs `paths` down to `auth`/`dashboard` only (most
// tests never need real org route builders). This handler calls
// `paths.orgs.org.apps.root`, so this file restores the real module.
vi.mock("@/routes/paths", async (importOriginal) => importOriginal());

import { handleInstallationEvent } from "../handle-installtion-event";

const INSTALLATION_ID = 4242;

function installationRepositoriesPayload(
  removedFullNames: string[],
  installationId: number | null = INSTALLATION_ID,
) {
  return {
    action: "removed",
    ...(installationId == null ? {} : { installation: { id: installationId } }),
    repositories_removed: removedFullNames.map((full_name) => ({ full_name })),
  };
}

describe("handleInstallationEvent", () => {
  let deletes: Array<{ search: URLSearchParams }>;
  let existingConnections: Array<{
    repository: string;
    tenant_id: string;
    installation_id: number | null;
  }>;
  let tenants: Array<{ tenant_id: string; organization_name: string }>;
  let tenantFetches: number;

  function matchesScope(
    c: { repository: string; installation_id: number | null },
    params: URLSearchParams,
  ): boolean {
    const repos = params.get("repository");
    const wanted = repos ? repos.replace(/^in\.\(|\)$/g, "").split(",") : [];
    if (!wanted.includes(c.repository)) return false;
    const or = params.get("or");
    if (!or) return true;
    // `(installation_id.eq.N,installation_id.is.null)` — either side admits.
    return (
      or.includes(`installation_id.eq.${c.installation_id}`) ||
      (c.installation_id === null && or.includes("installation_id.is.null"))
    );
  }

  beforeEach(() => {
    m.revalidatePath.mockReset();
    deletes = [];
    tenantFetches = 0;
    existingConnections = [];
    tenants = [{ tenant_id: "t-1", organization_name: "acme-inc" }];
    server.use(
      http.get(`${API}/git_connection`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        return HttpResponse.json(
          existingConnections.filter((c) => matchesScope(c, params)),
        );
      }),
      http.delete(`${API}/git_connection`, ({ request }) => {
        deletes.push({ search: new URL(request.url).searchParams });
        return HttpResponse.json([]);
      }),
      http.get(`${API}/tenant`, ({ request }) => {
        tenantFetches += 1;
        // Faithful to PostgREST: only tenants named by the in() filter come
        // back — an empty id list must resolve to zero rows.
        const filter = new URL(request.url).searchParams.get("tenant_id") ?? "in.()";
        const wanted = filter.replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean);
        return HttpResponse.json(tenants.filter((t) => wanted.includes(t.tenant_id)));
      }),
    );
  });

  // proves AC-068-12
  it("deletes the connection for a removed repository, scoped to the installation, and revalidates the org-name route", async () => {
    existingConnections = [
      { repository: "acme/repo", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/repo"]));

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.search.get("repository")).toBe("in.(acme/repo)");
    // The installation scope keeps a same-named repo connected through a
    // DIFFERENT installation (another tenant's) out of the sweep, while a
    // legacy NULL-installation row stays matchable.
    expect(deletes[0]!.search.get("or")).toBe(
      `(installation_id.eq.${INSTALLATION_ID},installation_id.is.null)`,
    );
    // The apps route is keyed by organization name — a tenant-id path would
    // match no cached route and revalidate nothing.
    expect(tenantFetches).toBe(1);
    expect(m.revalidatePath).toHaveBeenCalledWith("/orgs/acme-inc/apps");
  });

  // proves AC-068-12
  it("targets only the removed repository when the installation still holds others", async () => {
    existingConnections = [
      { repository: "acme/removed", tenant_id: "t-1", installation_id: INSTALLATION_ID },
      { repository: "acme/kept", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/removed"]));

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.search.get("repository")).toBe("in.(acme/removed)");
    expect(m.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("revalidates nothing when the removed repository matches no connection row", async () => {
    existingConnections = [
      { repository: "acme/other-repo", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/ghost"]));

    // The delete still fires (it is repo-scoped and matches nothing), but
    // with zero affected rows there is no tenant to look up or revalidate —
    // the tenant read itself must not run on an empty match.
    expect(deletes).toHaveLength(1);
    expect(tenantFetches).toBe(0);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes nothing when the event carries no repositories_removed", async () => {
    existingConnections = [
      { repository: "acme/other-repo", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload([]));

    expect(deletes).toHaveLength(0);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes nothing when the event carries no installation id", async () => {
    existingConnections = [
      { repository: "acme/repo", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/repo"], null));

    expect(deletes).toHaveLength(0);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});
