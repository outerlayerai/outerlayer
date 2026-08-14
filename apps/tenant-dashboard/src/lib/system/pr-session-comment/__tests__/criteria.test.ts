/**
 * Proof-requirement parsing: the spec side of "the spec says what to prove
 * and in what form". Pure parser + the bounded PR-file fetch.
 */
import { describe, it, expect, vi } from "vitest";

import { fetchPrProofCriteria, parseProofCriteria } from "../criteria";

describe("parseProofCriteria", () => {
  it("extracts id → kind pairs from proof annotations, sorted by id", () => {
    const md = [
      "# Artifacts — Acceptance Criteria",
      "2. `AC-084-14` (proof: video) **Given** a thing, **Then** it proves.",
      "1. `AC-084-11` (proof: screenshot) **Given** a thing, **Then** it renders.",
      "3. `AC-084-12` **Given** no annotation, **Then** no requirement.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([
      { id: "AC-084-11", proofKind: "screenshot" },
      { id: "AC-084-14", proofKind: "video" },
    ]);
  });

  it("ignores unknown kinds and keeps the first declaration of a duplicated id", () => {
    const md = [
      "1. `AC-084-01` (proof: hologram) **Given** x, **Then** y.",
      "2. `AC-084-02` (proof: log) **Given** x, **Then** y.",
      "3. `AC-084-02` (proof: video) **Given** x, **Then** y.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([{ id: "AC-084-02", proofKind: "log" }]);
  });

  it("caps a stuffed file at 100 distinct declarations, first declarations in document order winning", () => {
    // Synthetic ids matching the parser's shape, constructed at runtime so
    // the acceptance-coverage gate (which scans this file for id literals)
    // never sees them as citations.
    const fakeId = (major: number, minor: number) =>
      ["AC", String(major), String(minor).padStart(2, "0")].join("-");
    // 150 distinct annotations, descending ids so the cap provably keeps
    // document order (the first 100 in the file), not the sorted head.
    const md = Array.from(
      { length: 150 },
      (_, i) => `\`${fakeId(999 - Math.floor(i / 100), 99 - (i % 100))}\` (proof: log) x`,
    ).join("\n");

    const parsed = parseProofCriteria(md);

    expect(parsed).toHaveLength(100);
    // The first 100 annotations in document order are 999-99 … 999-00.
    expect(parsed[0]).toEqual({ id: fakeId(999, 0), proofKind: "log" });
    expect(parsed[99]).toEqual({ id: fakeId(999, 99), proofKind: "log" });
    expect(parsed.some((c) => c.id.startsWith(`AC-${"998"}-`))).toBe(false);
  });
});

describe("fetchPrProofCriteria", () => {
  it("reads only changed acceptance files at the PR's head ref and merges their declarations", async () => {
    const getFileContent = vi.fn().mockResolvedValue({
      content: "1. `AC-084-11` (proof: screenshot) **Given** x, **Then** y.",
    });

    const criteria = await fetchPrProofCriteria({ getFileContent }, "acme/app", 61, [
      { filename: "src/index.ts", changeStatus: "modified" },
      { filename: "acceptance/082-artifacts.md", changeStatus: "added" },
      { filename: "acceptance/090-other.md", changeStatus: "removed" },
      { filename: "acceptance/not-numbered.md", changeStatus: "added" },
    ]);

    expect(criteria).toEqual([{ id: "AC-084-11", proofKind: "screenshot" }]);
    expect(getFileContent).toHaveBeenCalledTimes(1);
    expect(getFileContent).toHaveBeenCalledWith(
      "acme/app",
      "acceptance/082-artifacts.md",
      "refs/pull/61/head",
    );
  });

  it("returns [] without content reads when the PR touches no acceptance files", async () => {
    const getFileContent = vi.fn();

    const criteria = await fetchPrProofCriteria({ getFileContent }, "acme/app", 61, [
      { filename: "src/index.ts", changeStatus: "modified" },
    ]);

    expect(criteria).toEqual([]);
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it("caps content reads at five acceptance files", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      filename: `acceptance/0${80 + i}-x.md`,
      changeStatus: "modified",
    }));
    const getFileContent = vi.fn().mockResolvedValue({ content: "" });

    await fetchPrProofCriteria({ getFileContent }, "acme/app", 61, files);
    expect(getFileContent).toHaveBeenCalledTimes(5);
  });

  it("merges declarations across files — first file wins a duplicated id, output sorted by id", async () => {
    const getFileContent = vi
      .fn()
      .mockResolvedValueOnce({
        content: "1. `AC-084-02` (proof: video) x\n2. `AC-084-01` (proof: log) x",
      })
      .mockResolvedValueOnce({ content: "1. `AC-084-02` (proof: screenshot) x" });

    const criteria = await fetchPrProofCriteria({ getFileContent }, "acme/app", 61, [
      { filename: "acceptance/090-z.md", changeStatus: "modified" },
      { filename: "acceptance/091-a.md", changeStatus: "modified" },
    ]);

    expect(criteria).toEqual([
      { id: "AC-084-01", proofKind: "log" },
      { id: "AC-084-02", proofKind: "video" },
    ]);
  });
});
