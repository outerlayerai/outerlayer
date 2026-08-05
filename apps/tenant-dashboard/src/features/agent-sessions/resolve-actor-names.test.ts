/**
 * Seat privacy contract: local seat syncs are anonymous BY DESIGN.
 * `key:*` actors must label as "anonymous" — the raw `key:<id>` internal
 * actor string must never be the display label. Membership actors resolve
 * to names elsewhere; a key-only input must not touch Supabase at all.
 */

import { resolveActorNames } from "./resolve-actor-names";

describe("resolveActorNames — anonymous seat actors", () => {
  it("labels a single key actor as plain 'anonymous'", async () => {
    const out = await resolveActorNames("tenant-1", ["key:key_237de4cde0d7d5338a9d6822"]);
    expect(out).toEqual({ "key:key_237de4cde0d7d5338a9d6822": "anonymous" });
  });

  it("suffixes only when multiple distinct key actors need distinguishing", async () => {
    const out = await resolveActorNames("tenant-1", [
      "key:key_aaaaaaaaaaaaaaaaaaaa1111",
      "key:key_bbbbbbbbbbbbbbbbbbbb2222",
      "key:key_aaaaaaaaaaaaaaaaaaaa1111",
    ]);
    expect(out).toEqual({
      "key:key_aaaaaaaaaaaaaaaaaaaa1111": "anonymous (…1111)",
      "key:key_bbbbbbbbbbbbbbbbbbbb2222": "anonymous (…2222)",
    });
  });

  it("never exposes the raw key id in a single-key label", async () => {
    const out = await resolveActorNames("tenant-1", ["key:key_237de4cde0d7d5338a9d6822"]);
    expect(JSON.stringify(Object.values(out))).not.toContain("key_237de4cde0d7d5338a9d6822");
  });

  it("keeps key labels even when membership resolution fails", async () => {
    // Membership id present alongside a key actor; no MSW seed for membership
    // → the Supabase read fails → catch path. Key labels must survive.
    const out = await resolveActorNames("tenant-1", [
      "key:key_237de4cde0d7d5338a9d6822",
      "67665041-4960-421d-8254-a825840dd74b",
    ]);
    expect(out["key:key_237de4cde0d7d5338a9d6822"]).toBe("anonymous");
  });
});
