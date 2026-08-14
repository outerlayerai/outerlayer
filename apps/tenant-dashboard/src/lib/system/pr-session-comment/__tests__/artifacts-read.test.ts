/**
 * readPrArtifacts — the comment's artifact read: exact PR scoping (unmatched
 * rows never surface, pending rows only from an app connected to this repo),
 * emit-time-then-id base ordering, kind/provenance vocabulary enforcement,
 * and the app/env name resolution the deep links depend on, fallbacks
 * included.
 */
import { http, HttpResponse } from "msw";
import { describe, it, expect } from "vitest";

import { server } from "@/test-helpers/msw-server";
import {
  seedArtifactMswRows,
  seedSupabaseMswState,
  type ArtifactMswRow,
} from "@/test-helpers/msw-handlers";

import { readPrArtifacts } from "../artifacts-read";

const SUPABASE_URL = "http://localhost:54321";

function seedGitConnections(rows: { app_id: string; repository: string }[]) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/git_connection`, () => HttpResponse.json(rows)),
  );
}

const TENANT = "tenant-1";
const REPO = "acme/api";
const PR = 61;

const row = (over: Partial<ArtifactMswRow> & Pick<ArtifactMswRow, "id">): ArtifactMswRow => ({
  tenant_id: TENANT,
  app_id: "app-1",
  filename: "shot.png",
  kind: "screenshot",
  caption: "cap",
  criterion_id: "",
  provenance: "session",
  repository: REPO,
  pr_number: PR,
  verification: "confirmed",
  emitted_at: "2026-08-14T10:00:00.000Z",
  ...over,
});

describe("readPrArtifacts", () => {
  it("returns only this PR's non-unmatched artifacts, oldest-emitted first with id tiebreak, fully mapped", async () => {
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedArtifactMswRows([
      row({ id: "b-late", emitted_at: "2026-08-14T12:00:00.000Z" }),
      row({ id: "z-tie", emitted_at: "2026-08-14T10:00:00.000Z" }),
      row({ id: "a-tie", emitted_at: "2026-08-14T10:00:00.000Z", caption: "first" }),
      row({ id: "aged-out", verification: "unmatched" }),
      row({ id: "other-pr", pr_number: 62 }),
      row({ id: "other-repo", repository: "acme/other" }),
      row({ id: "other-tenant", tenant_id: "tenant-2" }),
    ]);

    const rows = await readPrArtifacts({ tenantId: TENANT, repository: REPO, prNumber: PR });

    // Positional: base order is emitted_at asc, then id asc — and none of the
    // out-of-scope rows appear.
    expect(rows.map((r) => r.id)).toEqual(["a-tie", "z-tie", "b-late"]);
    expect(rows[0]).toEqual({
      id: "a-tie",
      filename: "shot.png",
      kind: "screenshot",
      caption: "first",
      criterionId: "",
      provenance: "session",
      emittedAt: "2026-08-14T10:00:00.000Z",
      appName: "api",
      envName: "dev",
    });
  });

  it("resolves the app's default environment name and falls back to the raw app id when the app row is gone", async () => {
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedArtifactMswRows([
      row({ id: "named" }),
      row({ id: "orphan", app_id: "app-gone" }),
    ]);

    const rows = await readPrArtifacts({ tenantId: TENANT, repository: REPO, prNumber: PR });
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get("named")).toMatchObject({ appName: "api", envName: "dev" });
    // No app row: the raw id is still a usable (if ugly) URL segment.
    expect(byId.get("orphan")).toMatchObject({ appName: "app-gone", envName: "" });
  });

  it("returns [] when the PR has no artifacts, without the name-resolution reads", async () => {
    expect(
      await readPrArtifacts({ tenantId: TENANT, repository: REPO, prNumber: PR }),
    ).toEqual([]);
  });

  it("degrades an unknown kind to 'file' and an unknown provenance to 'local' — stored text never upgrades a claim", async () => {
    seedSupabaseMswState({ apps: [{ id: "app-1", tenant_id: TENANT, name: "api" }] });
    seedArtifactMswRows([
      row({
        id: "weird",
        kind: "hologram](x)|",
        provenance: "verified-by-god" as ArtifactMswRow["provenance"],
      }),
      row({ id: "normal", kind: "video", provenance: "ci" }),
    ]);

    const rows = await readPrArtifacts({ tenantId: TENANT, repository: REPO, prNumber: PR });
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get("weird")).toMatchObject({ kind: "file", provenance: "local" });
    expect(byId.get("normal")).toMatchObject({ kind: "video", provenance: "ci" });
  });

  it("surfaces a pending row only when its app's own GitHub connection names this repository", async () => {
    seedSupabaseMswState({
      apps: [
        { id: "app-1", tenant_id: TENANT, name: "api" },
        { id: "app-other", tenant_id: TENANT, name: "other" },
        { id: "app-loose", tenant_id: TENANT, name: "loose" },
      ],
    });
    seedGitConnections([
      // Connection spelling differs from the canonical key on purpose.
      { app_id: "app-1", repository: "https://github.com/Acme/API" },
      { app_id: "app-other", repository: "github.com/acme/web" },
    ]);
    seedArtifactMswRows([
      // The legitimate pre-webhook case: pending, direct anchor, emitting
      // app connected to this repo.
      row({ id: "pre-webhook", verification: "pending" }),
      // The forgery shape: pending anchor claiming this repo from an app
      // connected elsewhere — never renders here.
      row({ id: "cross-app", app_id: "app-other", verification: "pending" }),
      // No connection at all: the claim is unvettable — dropped.
      row({ id: "no-connection", app_id: "app-loose", verification: "pending" }),
      // Confirmed rows carry a vetted anchor and are unaffected.
      row({ id: "vetted", app_id: "app-other", verification: "confirmed" }),
    ]);

    const rows = await readPrArtifacts({ tenantId: TENANT, repository: REPO, prNumber: PR });

    expect(rows.map((r) => r.id).sort()).toEqual(["pre-webhook", "vetted"]);
  });
});
