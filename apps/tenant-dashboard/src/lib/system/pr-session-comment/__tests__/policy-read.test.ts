/**
 * fetchPrPolicyFiles: the base-branch read behind the policy. Missing files
 * are the normal no-policy state; only yaml files under the validators
 * directory load, in sorted order, bounded; and every read carries the base
 * ref — the property that stops a PR from loosening its own evaluation.
 */
import { describe, it, expect } from "vitest";

import { FileNotFoundError } from "@/lib/system/git/errors";
import { fetchPrPolicyFiles, POLICY_FILE_PATH } from "../policy-read";

interface Entry {
  path: string;
  name: string;
  type: "file" | "dir";
}

function source(over: {
  files?: Record<string, string>;
  entries?: Entry[];
  calls?: Array<{ path: string; ref: string }>;
}) {
  const files = over.files ?? {};
  return {
    async getFileContent(repo: string, path: string, ref: string) {
      over.calls?.push({ path, ref });
      const content = files[path];
      if (content === undefined) throw new FileNotFoundError("github", repo, path);
      return { content };
    },
    async listDirectory(_repo: string, path: string, _ref: string) {
      if (over.entries === undefined) throw new FileNotFoundError("github", _repo, path);
      return over.entries;
    },
  };
}

const VALIDATORS_DIR = ".outerlayer/validators";

function entry(name: string, type: "file" | "dir" = "file"): Entry {
  return { path: `${VALIDATORS_DIR}/${name}`, name, type };
}

describe("fetchPrPolicyFiles", () => {
  // proves AC-085-02
  it("returns absences for a repo declaring nothing — the no-policy state, not an error", async () => {
    const result = await fetchPrPolicyFiles(source({}), "acme/app", "main");
    expect(result).toEqual({ policyFile: null, validatorFiles: [] });
  });

  // proves AC-085-04
  it("reads the policy file and every validator file at the base ref it was given", async () => {
    const calls: Array<{ path: string; ref: string }> = [];
    const result = await fetchPrPolicyFiles(
      source({
        calls,
        files: {
          [POLICY_FILE_PATH]: "extends: outerlayer:recommended@v1",
          [`${VALIDATORS_DIR}/migration.yaml`]: "id: migration-must-run",
        },
        entries: [entry("migration.yaml")],
      }),
      "acme/app",
      "release/2026-08",
    );
    expect(result).toEqual({
      policyFile: { path: POLICY_FILE_PATH, content: "extends: outerlayer:recommended@v1" },
      validatorFiles: [
        { path: `${VALIDATORS_DIR}/migration.yaml`, content: "id: migration-must-run" },
      ],
    });
    // Every content read carried the base ref — never a PR head ref.
    expect(calls).toEqual([
      { path: POLICY_FILE_PATH, ref: "release/2026-08" },
      { path: `${VALIDATORS_DIR}/migration.yaml`, ref: "release/2026-08" },
    ]);
  });

  it("loads only yaml regular files, sorted, and caps the count", async () => {
    const files: Record<string, string> = {};
    const entries: Entry[] = [
      entry("z-last.yaml"),
      entry("a-first.yml"),
      entry("notes.md"),
      entry("nested", "dir"),
    ];
    for (let i = 0; i < 25; i += 1) {
      const name = `v${String(i).padStart(2, "0")}.yaml`;
      entries.push(entry(name));
      files[`${VALIDATORS_DIR}/${name}`] = `id: v${i}`;
    }
    files[`${VALIDATORS_DIR}/z-last.yaml`] = "id: z";
    files[`${VALIDATORS_DIR}/a-first.yml`] = "id: a";

    const result = await fetchPrPolicyFiles(source({ files, entries }), "acme/app", "main");
    expect(result.validatorFiles).toHaveLength(20);
    // Sorted by path: a-first.yml, then v00..v18 fill the cap; notes.md,
    // the directory, and everything past the cap never load.
    expect(result.validatorFiles[0]!.path).toBe(`${VALIDATORS_DIR}/a-first.yml`);
    expect(result.validatorFiles[1]!.path).toBe(`${VALIDATORS_DIR}/v00.yaml`);
    expect(result.validatorFiles.map((f) => f.path)).not.toContain(`${VALIDATORS_DIR}/notes.md`);
    expect(result.validatorFiles.map((f) => f.path)).not.toContain(`${VALIDATORS_DIR}/z-last.yaml`);
  });

  it("propagates a non-404 provider failure instead of treating it as no policy", async () => {
    const failing = {
      async getFileContent(): Promise<{ content: string }> {
        throw new Error("rate limited");
      },
      async listDirectory(): Promise<Entry[]> {
        return [];
      },
    };
    await expect(fetchPrPolicyFiles(failing, "acme/app", "main")).rejects.toThrow("rate limited");
  });
});
