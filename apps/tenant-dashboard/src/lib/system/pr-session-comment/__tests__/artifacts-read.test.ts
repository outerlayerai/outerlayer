/**
 * readPrArtifacts — the comment's artifact read: exact PR scoping (unmatched
 * rows never surface), emit-time-then-id base ordering, and the app/env name
 * resolution the deep links depend on, fallbacks included.
 */
import { describe, it, expect } from "vitest";

import {
  seedArtifactMswRows,
  seedSupabaseMswState,
  type ArtifactMswRow,
} from "@/test-helpers/msw-handlers";

import { readPrArtifacts } from "../artifacts-read";

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
});
