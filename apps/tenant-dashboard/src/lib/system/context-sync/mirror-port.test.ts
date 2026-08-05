// @vitest-environment node
//
// Unit tests for the Supabase-backed ContextMirrorPort — the only I/O this
// service does against Postgres. Every method is pinned against the real HTTP
// boundary (MSW), never a hand-rolled Supabase mock, per the tenant-dashboard
// testing rules. Focus: the EXACT query/RPC/insert/update shapes the port
// sends (camelCase -> snake_case field renames, nested array mapping), and
// that every read/write error path throws the `context-sync: <op> failed: …`
// wrapper instead of swallowing the PostgREST error.
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test-helpers/msw-server";
import { getAdminDataClient } from "@/lib/system/admin-client";
import {
  seedContextSaveMswState,
  getPatchedContextHeads,
  seedContextSnapshotMswState,
  getCreateSnapshotCalls,
  seedContextSyncEventMswState,
  getInsertedContextSyncEvents,
} from "@/test-helpers/msw-handlers";
import type { CreateSnapshotInput, AdvanceHeadInput, SyncEventInput } from "@repo/context-sync";
import { createSupabaseContextMirrorPort } from "./mirror-port";

const SUPABASE_URL = "http://localhost:54321";

function makePort() {
  return createSupabaseContextMirrorPort(getAdminDataClient());
}

describe("createSupabaseContextMirrorPort", () => {
  describe("loadHead", () => {
    it("returns the exact head record when a row exists", async () => {
      seedContextSaveMswState({
        contextHeads: [{ app_id: "app-1", branch: "main", snapshot_id: "snap-1" }],
      });

      const result = await makePort().loadHead("app-1");

      expect(result).toEqual({ branch: "main", commitSha: undefined, snapshotId: "snap-1" });
    });

    it("returns null when no head row exists", async () => {
      const result = await makePort().loadHead("app-missing");

      expect(result).toBeNull();
    });

    it("throws the wrapped error when the query fails", async () => {
      server.use(
        http.get(`${SUPABASE_URL}/rest/v1/context_head`, () =>
          HttpResponse.json({ message: "connection refused" }, { status: 500 }),
        ),
      );

      await expect(makePort().loadHead("app-1")).rejects.toThrow(
        /context-sync: loadHead failed: connection refused/,
      );
    });
  });

  describe("getSnapshotPaths", () => {
    it("returns exactly the paths belonging to the snapshot", async () => {
      seedContextSaveMswState({
        contextTreeEntries: [
          { snapshot_id: "snap-1", path: "skills/a/SKILL.md", blob_sha: "sha-a" },
          { snapshot_id: "snap-1", path: "skills/b/SKILL.md", blob_sha: "sha-b" },
          { snapshot_id: "snap-other", path: "skills/c/SKILL.md", blob_sha: "sha-c" },
        ],
      });

      const result = await makePort().getSnapshotPaths("snap-1");

      expect(result).toEqual(["skills/a/SKILL.md", "skills/b/SKILL.md"]);
    });

    it("degrades to an empty list on a null response body (defensive `data ?? []`)", async () => {
      server.use(
        http.get(`${SUPABASE_URL}/rest/v1/context_tree_entry`, () => HttpResponse.json(null)),
      );

      const result = await makePort().getSnapshotPaths("snap-1");

      expect(result).toEqual([]);
    });

    it("throws the wrapped error when the query fails", async () => {
      server.use(
        http.get(`${SUPABASE_URL}/rest/v1/context_tree_entry`, () =>
          HttpResponse.json({ message: "timeout" }, { status: 500 }),
        ),
      );

      await expect(makePort().getSnapshotPaths("snap-1")).rejects.toThrow(
        /context-sync: getSnapshotPaths failed: timeout/,
      );
    });
  });

  describe("hasBlob", () => {
    it("returns true when the blob exists for the app", async () => {
      seedContextSnapshotMswState({
        contextBlobs: [{ app_id: "app-1", blob_sha: "sha-a" }],
      });

      const result = await makePort().hasBlob("app-1", "sha-a");

      expect(result).toBe(true);
    });

    it("returns false when the blob is not present", async () => {
      seedContextSnapshotMswState({ contextBlobs: [] });

      const result = await makePort().hasBlob("app-1", "sha-missing");

      expect(result).toBe(false);
    });

    it("throws the wrapped error when the count query fails", async () => {
      seedContextSnapshotMswState({ forceHasBlobError: { message: "count failed" } });

      await expect(makePort().hasBlob("app-1", "sha-a")).rejects.toThrow(
        /context-sync: hasBlob failed: count failed/,
      );
    });
  });

  describe("createSnapshot", () => {
    const input: CreateSnapshotInput = {
      appId: "app-1",
      tenantId: "tenant-1",
      branch: "main",
      commitSha: "c".repeat(40),
      classifierVersion: 3,
      blobs: [
        { blobSha: "sha-a", content: "content-a", size: 9 },
        { blobSha: "sha-b", content: "content-b", size: 9 },
      ],
      entries: [
        { path: "skills/a/SKILL.md", blobSha: "sha-a", kind: "skill", scopePath: "skills/a" },
      ],
      excludedCounts: [{ scopePath: "skills/a", skillName: "a", count: 2 }],
    };

    it("sends the exact snake_case RPC payload and returns the snapshotId", async () => {
      seedContextSnapshotMswState({ createSnapshotResult: "snap-new" });

      const result = await makePort().createSnapshot(input);

      expect(result).toEqual({ snapshotId: "snap-new" });
      expect(getCreateSnapshotCalls()).toEqual([
        {
          p_app_id: "app-1",
          p_tenant_id: "tenant-1",
          p_branch: "main",
          p_commit_sha: "c".repeat(40),
          p_classifier_version: 3,
          p_blobs: [
            { blob_sha: "sha-a", content: "content-a", size: 9 },
            { blob_sha: "sha-b", content: "content-b", size: 9 },
          ],
          p_entries: [
            { path: "skills/a/SKILL.md", blob_sha: "sha-a", kind: "skill", scope_path: "skills/a" },
          ],
          p_excluded_counts: [{ scopePath: "skills/a", skillName: "a", count: 2 }],
        },
      ]);
    });

    it("sends a null p_branch for a bare-sha materialization", async () => {
      await makePort().createSnapshot({ ...input, branch: null });

      const [call] = getCreateSnapshotCalls();
      expect(call?.p_branch).toBeNull();
    });

    it("throws the wrapped error when the RPC fails", async () => {
      seedContextSnapshotMswState({ createSnapshotResult: { error: "constraint violation" } });

      await expect(makePort().createSnapshot(input)).rejects.toThrow(
        /context-sync: createSnapshot failed: constraint violation/,
      );
    });
  });

  describe("advanceHead", () => {
    const input: AdvanceHeadInput = {
      appId: "app-1",
      tenantId: "tenant-1",
      branch: "main",
      commitSha: "d".repeat(40),
      snapshotId: "snap-2",
    };

    it("patches context_head with the exact filter and update payload", async () => {
      await makePort().advanceHead(input);

      expect(getPatchedContextHeads()).toEqual([
        {
          appId: "app-1",
          branch: "main",
          update: {
            commit_sha: "d".repeat(40),
            snapshot_id: "snap-2",
            synced_at: expect.any(String),
          },
        },
      ]);
    });

    it("throws the wrapped error when the update fails", async () => {
      seedContextSaveMswState({ forceContextHeadPatchError: { message: "row locked" } });

      await expect(makePort().advanceHead(input)).rejects.toThrow(
        /context-sync: advanceHead failed: row locked/,
      );
    });
  });

  describe("recordSyncEvent", () => {
    const event: SyncEventInput = {
      appId: "app-1",
      tenantId: "tenant-1",
      branch: "main",
      commitSha: "e".repeat(40),
      commitMessage: "fix: the thing",
      trigger: "push",
      status: "synced",
      error: null,
      durationMs: 1234,
      snapshotId: "snap-3",
    };

    it("inserts the exact sync event row", async () => {
      await makePort().recordSyncEvent(event);

      expect(getInsertedContextSyncEvents()).toEqual([
        expect.objectContaining({
          app_id: "app-1",
          tenant_id: "tenant-1",
          branch: "main",
          commit_sha: "e".repeat(40),
          commit_message: "fix: the thing",
          trigger: "push",
          status: "synced",
          error: null,
          duration_ms: 1234,
          snapshot_id: "snap-3",
        }),
      ]);
    });

    it("throws the wrapped error when the insert fails", async () => {
      seedContextSyncEventMswState({ forceInsertError: { message: "constraint violation" } });

      await expect(makePort().recordSyncEvent(event)).rejects.toThrow(
        /context-sync: recordSyncEvent failed: constraint violation/,
      );
    });
  });
});
