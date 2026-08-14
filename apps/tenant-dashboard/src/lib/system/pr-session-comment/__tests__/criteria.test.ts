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
      "2. `AC-082-14` (proof: video) **Given** a thing, **Then** it proves.",
      "1. `AC-082-11` (proof: screenshot) **Given** a thing, **Then** it renders.",
      "3. `AC-082-12` **Given** no annotation, **Then** no requirement.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([
      { id: "AC-082-11", proofKind: "screenshot" },
      { id: "AC-082-14", proofKind: "video" },
    ]);
  });

  it("ignores unknown kinds and keeps the first declaration of a duplicated id", () => {
    const md = [
      "1. `AC-082-01` (proof: hologram) **Given** x, **Then** y.",
      "2. `AC-082-02` (proof: log) **Given** x, **Then** y.",
      "3. `AC-082-02` (proof: video) **Given** x, **Then** y.",
    ].join("\n");

    expect(parseProofCriteria(md)).toEqual([{ id: "AC-082-02", proofKind: "log" }]);
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
      content: "1. `AC-082-11` (proof: screenshot) **Given** x, **Then** y.",
      sha: "s",
      size: 1,
      encoding: "utf-8" as const,
    });

    const criteria = await fetchPrProofCriteria(
      { listPullRequestFiles, getFileContent },
      "acme/app",
      61,
    );

    expect(criteria).toEqual([{ id: "AC-082-11", proofKind: "screenshot" }]);
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
});
