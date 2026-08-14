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
      "2. `AC-083-14` (proof: video) **Given** a thing, **Then** it proves.",
      "1. `AC-083-11` (proof: screenshot) **Given** a thing, **Then** it renders.",
      "3. `AC-083-12` **Given** no annotation, **Then** no requirement.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([
      { id: "AC-083-11", proofKind: "screenshot" },
      { id: "AC-083-14", proofKind: "video" },
    ]);
  });

  it("ignores unknown kinds and keeps the first declaration of a duplicated id", () => {
    const md = [
      "1. `AC-083-01` (proof: hologram) **Given** x, **Then** y.",
      "2. `AC-083-02` (proof: log) **Given** x, **Then** y.",
      "3. `AC-083-02` (proof: video) **Given** x, **Then** y.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([{ id: "AC-083-02", proofKind: "log" }]);
  });
});

describe("fetchPrProofCriteria", () => {
  it("reads only changed acceptance files at the PR head and merges their declarations", async () => {
    const listPullRequestFiles = vi.fn().mockResolvedValue({
      headSha: "abc123",
      files: [
        { path: "src/index.ts", status: "modified" },
        { path: "acceptance/082-artifacts.md", status: "added" },
        { path: "acceptance/090-other.md", status: "removed" },
        { path: "acceptance/not-numbered.md", status: "added" },
      ],
    });
    const getFileContent = vi.fn().mockResolvedValue({
      path: "acceptance/082-artifacts.md",
      content: "1. `AC-083-11` (proof: screenshot) **Given** x, **Then** y.",
      sha: "s",
      size: 1,
      encoding: "utf-8" as const,
    });

    const criteria = await fetchPrProofCriteria(
      { listPullRequestFiles, getFileContent },
      "acme/app",
      61,
    );

    expect(criteria).toEqual([{ id: "AC-083-11", proofKind: "screenshot" }]);
    expect(getFileContent).toHaveBeenCalledTimes(1);
    expect(getFileContent).toHaveBeenCalledWith(
      "acme/app",
      "acceptance/082-artifacts.md",
      "abc123",
    );
  });

  it("returns [] without content reads when the PR touches no acceptance files", async () => {
    const listPullRequestFiles = vi.fn().mockResolvedValue({
      headSha: "abc123",
      files: [{ path: "src/index.ts", status: "modified" }],
    });
    const getFileContent = vi.fn();

    const criteria = await fetchPrProofCriteria(
      { listPullRequestFiles, getFileContent },
      "acme/app",
      61,
    );

    expect(criteria).toEqual([]);
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it("caps content reads at five acceptance files and skips entirely without a head sha", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `acceptance/0${80 + i}-x.md`,
      status: "modified",
    }));
    const getFileContent = vi.fn().mockResolvedValue({ content: "" });

    await fetchPrProofCriteria(
      { listPullRequestFiles: vi.fn().mockResolvedValue({ headSha: "abc", files }), getFileContent },
      "acme/app",
      61,
    );
    expect(getFileContent).toHaveBeenCalledTimes(5);

    getFileContent.mockClear();
    const noSha = await fetchPrProofCriteria(
      {
        listPullRequestFiles: vi.fn().mockResolvedValue({ headSha: null, files }),
        getFileContent,
      },
      "acme/app",
      61,
    );
    expect(noSha).toEqual([]);
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it("merges declarations across files — first file wins a duplicated id, output sorted by id", async () => {
    const listPullRequestFiles = vi.fn().mockResolvedValue({
      headSha: "abc",
      files: [
        { path: "acceptance/090-z.md", status: "modified" },
        { path: "acceptance/091-a.md", status: "modified" },
      ],
    });
    const getFileContent = vi
      .fn()
      .mockResolvedValueOnce({
        content: "1. `AC-083-02` (proof: video) x\n2. `AC-083-01` (proof: log) x",
      })
      .mockResolvedValueOnce({ content: "1. `AC-083-02` (proof: screenshot) x" });

    const criteria = await fetchPrProofCriteria(
      { listPullRequestFiles, getFileContent },
      "acme/app",
      61,
    );

    expect(criteria).toEqual([
      { id: "AC-083-01", proofKind: "log" },
      { id: "AC-083-02", proofKind: "video" },
    ]);
  });
});
