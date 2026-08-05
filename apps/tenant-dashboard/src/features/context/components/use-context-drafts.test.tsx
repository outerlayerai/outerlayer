// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useContextDrafts, type ContextDraft } from "./use-context-drafts";

const editDraft = (path: string, content: string): ContextDraft => ({
  path,
  content,
  baseBlobSha: "sha-1",
  baseContent: "base",
  changeType: "edit",
});

function snapshot(map: ReadonlyMap<string, ContextDraft>): ContextDraft[] {
  return [...map.values()];
}

describe("useContextDrafts", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useContextDrafts());
    expect(result.current.drafts.size).toBe(0);
    expect(snapshot(result.current.drafts)).toEqual([]);
  });

  it("upserts by path — a second setDraft for the same path replaces, never duplicates", () => {
    const { result } = renderHook(() => useContextDrafts());

    act(() => result.current.setDraft(editDraft("a.md", "v1")));
    act(() => result.current.setDraft(editDraft("b.md", "b1")));
    act(() => result.current.setDraft(editDraft("a.md", "v2")));

    // Insertion order preserved, and a.md carries only its latest content.
    expect(snapshot(result.current.drafts)).toEqual([
      { path: "a.md", content: "v2", baseBlobSha: "sha-1", baseContent: "base", changeType: "edit" },
      { path: "b.md", content: "b1", baseBlobSha: "sha-1", baseContent: "base", changeType: "edit" },
    ]);
  });

  it("dropDraft removes only the named path", () => {
    const { result } = renderHook(() => useContextDrafts());
    act(() => result.current.setDraft(editDraft("a.md", "v1")));
    act(() => result.current.setDraft(editDraft("b.md", "b1")));

    act(() => result.current.dropDraft("a.md"));

    expect(snapshot(result.current.drafts)).toEqual([
      { path: "b.md", content: "b1", baseBlobSha: "sha-1", baseContent: "base", changeType: "edit" },
    ]);
  });

  it("dropping an absent path is a no-op that keeps the same map reference (no needless re-render)", () => {
    const { result } = renderHook(() => useContextDrafts());
    act(() => result.current.setDraft(editDraft("a.md", "v1")));
    const before = result.current.drafts;

    act(() => result.current.dropDraft("missing.md"));

    expect(result.current.drafts).toBe(before);
  });

  it("clearDrafts empties every entry", () => {
    const { result } = renderHook(() => useContextDrafts());
    act(() => result.current.setDraft(editDraft("a.md", "v1")));
    act(() =>
      result.current.setDraft({ path: "new.md", content: "x", baseBlobSha: null, baseContent: "", changeType: "create" }),
    );

    act(() => result.current.clearDrafts());

    expect(result.current.drafts.size).toBe(0);
  });

  it("does not persist across a fresh hook instance (drafts are ephemeral)", () => {
    const first = renderHook(() => useContextDrafts());
    act(() => first.result.current.setDraft(editDraft("a.md", "v1")));
    first.unmount();

    const second = renderHook(() => useContextDrafts());
    expect(second.result.current.drafts.size).toBe(0);
  });

  describe("dropDrafts", () => {
    it("removes every named path in one update, preserving the rest", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() => result.current.setDraft(editDraft("a.md", "v1")));
      act(() => result.current.setDraft(editDraft("b.md", "v1")));
      act(() => result.current.setDraft(editDraft("c.md", "v1")));

      act(() => result.current.dropDrafts(["a.md", "c.md"]));

      expect(snapshot(result.current.drafts)).toEqual([
        { path: "b.md", content: "v1", baseBlobSha: "sha-1", baseContent: "base", changeType: "edit" },
      ]);
    });

    it("an empty path list is a no-op that keeps the same map reference", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() => result.current.setDraft(editDraft("a.md", "v1")));
      const before = result.current.drafts;

      act(() => result.current.dropDrafts([]));

      expect(result.current.drafts).toBe(before);
    });
  });

  describe("stageDeletes", () => {
    it("stages a delete draft carrying the base sha and content, with empty content", () => {
      const { result } = renderHook(() => useContextDrafts());

      act(() =>
        result.current.stageDeletes([
          { path: "a.md", baseBlobSha: "sha-a", baseContent: "line1\nline2\n" },
        ]),
      );

      expect(snapshot(result.current.drafts)).toEqual([
        { path: "a.md", content: "", baseBlobSha: "sha-a", baseContent: "line1\nline2\n", changeType: "delete" },
      ]);
    });

    it("delete-over-edit replaces the edit draft on the same path", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() => result.current.setDraft(editDraft("a.md", "edited")));

      act(() =>
        result.current.stageDeletes([{ path: "a.md", baseBlobSha: "sha-a", baseContent: "orig" }]),
      );

      expect(snapshot(result.current.drafts)).toEqual([
        { path: "a.md", content: "", baseBlobSha: "sha-a", baseContent: "orig", changeType: "delete" },
      ]);
    });

    it("delete-of-a-create drops the create draft entirely — no delete row for a file that never existed", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() =>
        result.current.setDraft({ path: "new.md", content: "x", baseBlobSha: null, baseContent: "", changeType: "create" }),
      );

      act(() =>
        result.current.stageDeletes([{ path: "new.md", baseBlobSha: "sha-x", baseContent: "x" }]),
      );

      expect(result.current.drafts.size).toBe(0);
    });

    it("stages many deletes in one update, preserving order after existing drafts", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() => result.current.setDraft(editDraft("keep.md", "e")));

      act(() =>
        result.current.stageDeletes([
          { path: "d1.md", baseBlobSha: "s1", baseContent: "a" },
          { path: "d2.md", baseBlobSha: "s2", baseContent: "b" },
        ]),
      );

      expect(snapshot(result.current.drafts)).toEqual([
        { path: "keep.md", content: "e", baseBlobSha: "sha-1", baseContent: "base", changeType: "edit" },
        { path: "d1.md", content: "", baseBlobSha: "s1", baseContent: "a", changeType: "delete" },
        { path: "d2.md", content: "", baseBlobSha: "s2", baseContent: "b", changeType: "delete" },
      ]);
    });

    it("an empty target list is a no-op that keeps the same map reference", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() => result.current.setDraft(editDraft("a.md", "v1")));
      const before = result.current.drafts;

      act(() => result.current.stageDeletes([]));

      expect(result.current.drafts).toBe(before);
    });

    it("dropDraft restores a staged delete (removes only the named delete)", () => {
      const { result } = renderHook(() => useContextDrafts());
      act(() =>
        result.current.stageDeletes([
          { path: "a.md", baseBlobSha: "s1", baseContent: "a" },
          { path: "b.md", baseBlobSha: "s2", baseContent: "b" },
        ]),
      );

      act(() => result.current.dropDraft("a.md"));

      expect(snapshot(result.current.drafts)).toEqual([
        { path: "b.md", content: "", baseBlobSha: "s2", baseContent: "b", changeType: "delete" },
      ]);
    });
  });
});
