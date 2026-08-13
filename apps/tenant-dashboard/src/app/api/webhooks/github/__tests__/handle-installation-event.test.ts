/**
 * handleInstallationEvent — `installation_repositories` webhook →
 * git-connection cleanup when the GitHub App loses access to a repo.
 *
 * Pins: a repository reported in `repositories_removed` has its
 * `git_connection` row deleted, scoped to the payload's installation id (a
 * same-named repo connected through a different installation must survive);
 * a repo not in the removed list is left untouched; an event with no
 * installation id deletes nothing. Supabase runs through MSW (no client
 * mocks).
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
    installation_id: number;
  }>;

  beforeEach(() => {
    m.revalidatePath.mockReset();
    deletes = [];
    existingConnections = [];
    server.use(
      http.get(`${API}/git_connection`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const repos = params.get("repository");
        const wanted = repos ? repos.replace(/^in\.\(|\)$/g, "").split(",") : [];
        const installation = params.get("installation_id");
        return HttpResponse.json(
          existingConnections.filter(
            (c) =>
              wanted.includes(c.repository) &&
              (installation === null || `eq.${c.installation_id}` === installation),
          ),
        );
      }),
      http.delete(`${API}/git_connection`, ({ request }) => {
        deletes.push({ search: new URL(request.url).searchParams });
        return HttpResponse.json([]);
      }),
    );
  });

  // proves AC-068-12
  it("deletes the git connection for a repository the installation lost access to, scoped to that installation", async () => {
    existingConnections = [
      { repository: "acme/repo", tenant_id: "t-1", installation_id: INSTALLATION_ID },
    ];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/repo"]));

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.search.get("repository")).toBe("in.(acme/repo)");
    // The installation filter is what keeps a same-named repo connected
    // through a DIFFERENT installation (another tenant's) out of the sweep.
    expect(deletes[0]!.search.get("installation_id")).toBe(`eq.${INSTALLATION_ID}`);
    expect(m.revalidatePath).toHaveBeenCalledWith("/orgs/t-1/apps");
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
    // Only the removed repo's tenant path revalidates — once, not per row.
    expect(m.revalidatePath).toHaveBeenCalledTimes(1);
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
