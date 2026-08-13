/**
 * handleInstallationEvent — `installation_repositories` webhook →
 * git-connection cleanup when the GitHub App loses access to a repo.
 *
 * Pins: a repository reported in `repositories_removed` has its
 * `git_connection` row deleted, matched by repository full name; a repo not
 * in that list is left untouched; and an empty `repositories_removed` list
 * deletes nothing. Supabase runs through MSW (no client mocks).
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

function installationRepositoriesPayload(removedFullNames: string[]) {
  return {
    action: "removed",
    repositories_removed: removedFullNames.map((full_name) => ({ full_name })),
  };
}

describe("handleInstallationEvent", () => {
  let deletes: Array<{ search: URLSearchParams }>;
  let existingConnections: Array<{ repository: string; tenant_id: string }>;

  beforeEach(() => {
    m.revalidatePath.mockReset();
    deletes = [];
    existingConnections = [];
    server.use(
      http.get(`${API}/git_connection`, ({ request }) => {
        const repos = new URL(request.url).searchParams.get("repository");
        const wanted = repos ? repos.replace(/^in\.\(|\)$/g, "").split(",") : [];
        return HttpResponse.json(
          existingConnections.filter((c) => wanted.includes(c.repository)),
        );
      }),
      http.delete(`${API}/git_connection`, ({ request }) => {
        deletes.push({ search: new URL(request.url).searchParams });
        return HttpResponse.json([]);
      }),
    );
  });

  // proves AC-068-12
  it("deletes the git connection for a repository the installation lost access to", async () => {
    existingConnections = [{ repository: "acme/repo", tenant_id: "t-1" }];

    await handleInstallationEvent(installationRepositoriesPayload(["acme/repo"]));

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.search.get("repository")).toBe("in.(acme/repo)");
    expect(m.revalidatePath).toHaveBeenCalledWith("/orgs/t-1/apps");
  });

  // proves AC-068-12
  it("leaves connections for repositories not reported as removed untouched", async () => {
    existingConnections = [{ repository: "acme/other-repo", tenant_id: "t-1" }];

    await handleInstallationEvent(installationRepositoriesPayload([]));

    expect(deletes).toHaveLength(0);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});
