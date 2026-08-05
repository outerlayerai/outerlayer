import { describe, expect, it, vi } from "vitest";
import {
  createSkillInventoryStore,
  type SkillInventoryClient,
} from "./skill-inventory-store";

type Result = { data: unknown[] | null; error: { message: string } | null };

/** A PostgREST-shaped builder: chainable and awaitable, recording every call. */
function builder(result: Result) {
  const calls: unknown[][] = [];
  const b: Record<string, unknown> = {
    calls,
    select: (...a: unknown[]) => (calls.push(["select", ...a]), b),
    eq: (...a: unknown[]) => (calls.push(["eq", ...a]), b),
    order: (...a: unknown[]) => (calls.push(["order", ...a]), b),
    limit: (...a: unknown[]) => (calls.push(["limit", ...a]), b),
    then: (onF: (r: Result) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
  };
  return b;
}

function clientOf(byTable: Record<string, ReturnType<typeof builder>>) {
  const seen: string[] = [];
  const client = {
    seen,
    from: vi.fn((table: string) => {
      seen.push(table);
      return byTable[table];
    }),
  };
  return client as unknown as SkillInventoryClient & { seen: string[] };
}

describe("createSkillInventoryStore", () => {
  it("extracts skill names from the latest snapshot's mirrored tree paths", async () => {
    const head = builder({ data: [{ snapshot_id: "snap-1" }], error: null });
    const entries = builder({
      data: [
        { path: ".outerlayer/skills/writing/SKILL.md" },
        { path: ".outerlayer/skills/writing/references/style.md" },
        { path: "apps/web/.outerlayer/skills/deploy/SKILL.md" },
        { path: ".outerlayer/AGENTS.md" },
      ],
      error: null,
    });
    const client = clientOf({ context_head: head, context_tree_entry: entries });

    expect(await createSkillInventoryStore(client).listInstalledSkills("app-1")).toEqual([
      "deploy",
      "writing",
    ]);
    // Latest head: ordered by synced_at desc, limit 1.
    expect(head.calls).toContainEqual(["order", "synced_at", { ascending: false }]);
    expect(head.calls).toContainEqual(["limit", 1]);
    // Tree entries pinned to the app AND the resolved snapshot.
    expect(entries.calls).toContainEqual(["eq", "app_id", "app-1"]);
    expect(entries.calls).toContainEqual(["eq", "snapshot_id", "snap-1"]);
  });

  it("never-synced app (no head) → null (no repo to compare against), tree table untouched", async () => {
    const head = builder({ data: [], error: null });
    const client = clientOf({ context_head: head });
    expect(await createSkillInventoryStore(client).listInstalledSkills("app-1")).toBeNull();
    expect(client.seen).toEqual(["context_head"]);
  });

  it("surfaces a head read error instead of silently returning []", async () => {
    const head = builder({ data: null, error: { message: "rls denied" } });
    const client = clientOf({ context_head: head });
    await expect(
      createSkillInventoryStore(client).listInstalledSkills("app-1"),
    ).rejects.toThrow(/context_head read: rls denied/);
  });

  it("surfaces a tree-entry read error", async () => {
    const head = builder({ data: [{ snapshot_id: "snap-1" }], error: null });
    const entries = builder({ data: null, error: { message: "boom" } });
    const client = clientOf({ context_head: head, context_tree_entry: entries });
    await expect(
      createSkillInventoryStore(client).listInstalledSkills("app-1"),
    ).rejects.toThrow(/context_tree_entry read: boom/);
  });
});
