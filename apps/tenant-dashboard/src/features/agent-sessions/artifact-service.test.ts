/**
 * getArtifactExhibit — the read behind the artifact page: app-scoped row
 * lookup, aged-out rows are gone, and the returned blob token is a real
 * verifiable capability bound to this viewer.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedArtifactMswRows, type ArtifactMswRow } from "@/test-helpers/msw-handlers";
import { OAUTH_STATE_SECRET } from "@/config-global.server";

import { getArtifactExhibit } from "./artifact-service";
import { verifyAgentBlobToken } from "./blob-url";
import type { AgentSessionsContext } from "./service";

function ctx(overrides: { appId?: string } = {}): AgentSessionsContext {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    appId: overrides.appId ?? "app-1",
    db: createMswRestClient() as unknown as SupabaseClient,
  } as unknown as AgentSessionsContext;
}

const row = (over: Partial<ArtifactMswRow>): ArtifactMswRow => ({
  id: "a1",
  tenant_id: "tenant-1",
  app_id: "app-1",
  filename: "login.png",
  media_type: "image/png",
  kind: "screenshot",
  caption: "Login page after fix",
  criterion_id: "AC-082-01",
  provenance: "session",
  trace_id: "trace-1",
  repository: "acme/api",
  pr_number: 61,
  git_repo: "",
  git_branch: "",
  sha256: "ab".repeat(32),
  verification: "confirmed",
  blob_deleted: false,
  emitted_at: "2026-08-14T10:00:00.000Z",
  ...over,
});

describe("getArtifactExhibit", () => {
  it("returns the exhibit with a verifiable blob token bound to tenant, app, viewer, and sha", async () => {
    seedArtifactMswRows([row({})]);

    const exhibit = await getArtifactExhibit(ctx(), "a1");

    expect(exhibit).toMatchObject({
      id: "a1",
      filename: "login.png",
      mediaType: "image/png",
      kind: "screenshot",
      caption: "Login page after fix",
      criterionId: "AC-082-01",
      provenance: "session",
      prNumber: 61,
      repository: "acme/api",
      traceId: "trace-1",
      sha256: "ab".repeat(32),
    });
    const verified = await verifyAgentBlobToken({
      secret: OAUTH_STATE_SECRET,
      token: exhibit!.blobToken,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toMatchObject({
        tenantId: "tenant-1",
        appId: "app-1",
        userId: "user-1",
        sha256: "ab".repeat(32),
      });
    }
  });

  it("returns null for another app's artifact and for aged-out rows", async () => {
    seedArtifactMswRows([
      row({ id: "other-app", app_id: "app-2" }),
      row({ id: "unmatched", verification: "unmatched" }),
      row({ id: "blobless", blob_deleted: true }),
    ]);

    expect(await getArtifactExhibit(ctx(), "other-app")).toBeNull();
    expect(await getArtifactExhibit(ctx(), "unmatched")).toBeNull();
    expect(await getArtifactExhibit(ctx(), "blobless")).toBeNull();
    expect(await getArtifactExhibit(ctx(), "missing")).toBeNull();
  });
});
