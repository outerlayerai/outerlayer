/**
 * advanceCommitPointers — the shared trace-stamping pointer write called by the
 * link, push, and resync trigger sites. These pins nail down exactly which two
 * rows it touches and how they are scoped: `app.commit_sha` by app id, and the
 * DEFAULT env's `current_commit_sha` (never a non-default env).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { advanceCommitPointers } from "../commit-pointers";

interface RecordedUpdate {
  table: string;
  update: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
}

function makeFakeSupabase() {
  const updates: RecordedUpdate[] = [];
  const from = (table: string) => ({
    update: (payload: Record<string, unknown>) => {
      const record: RecordedUpdate = { table, update: payload, eqs: [] };
      updates.push(record);
      const chain = {
        eq(col: string, val: unknown) {
          record.eqs.push([col, val]);
          return chain;
        },
        // Thenable so `await ...eq(...)` resolves like a PostgREST builder.
        then(resolve: (v: { error: null }) => unknown) {
          return resolve({ error: null });
        },
      };
      return chain;
    },
  });
  return { updates, client: { from } as unknown as SupabaseClient<Database> };
}

describe("advanceCommitPointers", () => {
  it("updates app.commit_sha (by app id) and the default env's current_commit_sha (by app + is_default)", async () => {
    const { updates, client } = makeFakeSupabase();

    await advanceCommitPointers(client, { appId: "app-1", commitSha: "sha-123" });

    expect(updates).toEqual([
      {
        table: "app",
        update: { commit_sha: "sha-123" },
        eqs: [["id", "app-1"]],
      },
      {
        table: "environment",
        update: { current_commit_sha: "sha-123" },
        eqs: [
          ["app_id", "app-1"],
          ["is_default", true],
        ],
      },
    ]);
  });

  it("never targets a non-default env", async () => {
    const { updates, client } = makeFakeSupabase();

    await advanceCommitPointers(client, { appId: "app-2", commitSha: "sha-xyz" });

    const envUpdate = updates.find((u) => u.table === "environment")!;
    // The is_default filter is what keeps a pinned env's pointers untouched.
    expect(envUpdate.eqs).toContainEqual(["is_default", true]);
  });
});
