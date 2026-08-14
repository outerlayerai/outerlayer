/**
 * Pins the policy read's two invariants: everything is fetched at the PR's
 * BASE branch (a PR must not be judged under its own policy edits), and
 * every failure shape degrades to "no policy" — absence is never an error.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readPolicySource } from "../policy-source";

const REPO = "acme/api";

function client(over: Record<string, unknown> = {}) {
  return {
    getPullRequestBaseBranch: vi.fn(async () => "main"),
    getFileContent: vi.fn(async (_repo: string, path: string) => ({
      content: `# ${path}`,
    })),
    listDirectory: vi.fn(async () => [
      { path: ".outerlayer/validators/b.yaml", name: "b.yaml", type: "file" },
      { path: ".outerlayer/validators/a.yaml", name: "a.yaml", type: "file" },
      { path: ".outerlayer/validators/notes.md", name: "notes.md", type: "file" },
      { path: ".outerlayer/validators/sub", name: "sub", type: "dir" },
    ]),
    ...over,
  };
}

describe("readPolicySource", () => {
  // AC-085-02
  it("reads the policy and validator files at the base branch, in path order", async () => {
    const fake = client();
    const source = await readPolicySource(fake, REPO, 42);

    expect(fake.getPullRequestBaseBranch).toHaveBeenCalledWith(REPO, 42);
    expect(fake.getFileContent).toHaveBeenCalledWith(REPO, ".outerlayer/policy.yaml", "main");
    expect(fake.listDirectory).toHaveBeenCalledWith(REPO, ".outerlayer/validators", "main");
    expect(fake.getFileContent).toHaveBeenCalledWith(REPO, ".outerlayer/validators/a.yaml", "main");
    expect(fake.getFileContent).toHaveBeenCalledWith(REPO, ".outerlayer/validators/b.yaml", "main");
    expect(source).toEqual({
      policyYaml: { path: ".outerlayer/policy.yaml", content: "# .outerlayer/policy.yaml" },
      validatorFiles: [
        { path: ".outerlayer/validators/a.yaml", content: "# .outerlayer/validators/a.yaml" },
        { path: ".outerlayer/validators/b.yaml", content: "# .outerlayer/validators/b.yaml" },
      ],
    });
  });

  it("returns null when the client cannot answer or nothing is adopted", async () => {
    await expect(readPolicySource({}, REPO, 42)).resolves.toEqual(null);
    const noReads = client({ getFileContent: undefined });
    await expect(readPolicySource(noReads, REPO, 42)).resolves.toEqual(null);
    expect(noReads.getPullRequestBaseBranch).not.toHaveBeenCalled();
    await expect(
      readPolicySource(client({ getPullRequestBaseBranch: vi.fn(async () => null) }), REPO, 42),
    ).resolves.toEqual(null);
    const nothingAdopted = client({
      getFileContent: vi.fn(async () => {
        throw new Error("404");
      }),
      listDirectory: vi.fn(async () => []),
    });
    await expect(readPolicySource(nothingAdopted, REPO, 42)).resolves.toEqual(null);
  });

  it("keeps the validator files when only the policy file is absent, and vice versa", async () => {
    const noPolicyFile = client({
      getFileContent: vi.fn(async (_repo: string, path: string) => {
        if (path === ".outerlayer/policy.yaml") throw new Error("404");
        return { content: `# ${path}` };
      }),
    });
    const source = await readPolicySource(noPolicyFile, REPO, 42);
    expect(source?.policyYaml).toEqual(null);
    expect(source?.validatorFiles.map((file) => file.path)).toEqual([
      ".outerlayer/validators/a.yaml",
      ".outerlayer/validators/b.yaml",
    ]);

    const noDirectory = client({ listDirectory: vi.fn(async () => {
      throw new Error("404");
    }) });
    const policyOnly = await readPolicySource(noDirectory, REPO, 42);
    expect(policyOnly).toEqual({
      policyYaml: { path: ".outerlayer/policy.yaml", content: "# .outerlayer/policy.yaml" },
      validatorFiles: [],
    });
  });
});
