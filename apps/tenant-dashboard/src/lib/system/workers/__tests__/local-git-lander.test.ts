/**
 * landChangesToLocalRepo lands a run's diff into a real local bare repo. These
 * run actual git against temp repos (no mocks) to lock the branch-creation +
 * file-application contract the e2e exercises.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { isLocalRepo, landChangesToLocalRepo } from "../local-git-lander";
import type { LandChangesContext } from "@repo/worker-core";

vi.mock("server-only", () => ({}));

const execFileAsync = promisify(execFile);

async function makeBareRepoWithSeed(): Promise<{ bare: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lander-test-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await execFileAsync("git", ["init", "-q", seed]);
  const g = (args: string[]) => execFileAsync("git", args, { cwd: seed });
  await g(["config", "user.email", "seed@local"]);
  await g(["config", "user.name", "seed"]);
  await fs.writeFile(path.join(seed, "README.md"), "# Seed\n");
  await g(["add", "-A"]);
  await g(["commit", "-qm", "init"]);
  await g(["branch", "-M", "main"]);
  await g(["remote", "add", "origin", bare]);
  await g(["push", "-q", "origin", "main"]);
  return { bare, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function ctx(changes: LandChangesContext["changes"], branchSlug = "add-thing"): LandChangesContext {
  return { appId: "app-1", workerRunId: "run-abcdef12", taskPrompt: "add a thing", changes, branchSlug };
}

describe("isLocalRepo", () => {
  it("recognizes absolute paths and file:// URLs, rejects owner/repo", () => {
    expect(isLocalRepo("/tmp/x.git")).toBe(true);
    expect(isLocalRepo("file:///tmp/x.git")).toBe(true);
    expect(isLocalRepo("agentmark-ai/app")).toBe(false);
    expect(isLocalRepo("https://github.com/o/r")).toBe(false);
  });
});

describe("landChangesToLocalRepo", () => {
  it("creates the worker branch with the applied changes and returns branch + file URL", async () => {
    const { bare, cleanup } = await makeBareRepoWithSeed();
    try {
      const result = await landChangesToLocalRepo(bare, "main", ctx([
        { path: "NEW.md", operation: "write", content: "hello\n", encoding: "utf8" },
        { path: "README.md", operation: "write", content: "# Seed edited\n", encoding: "utf8" },
      ]));

      expect(result.branchName).toBe("outerlayer/worker/add-thing");
      expect(result.prNumber).toBeNull();
      expect(result.prUrl).toBe(`file://${bare}#outerlayer/worker/add-thing`);

      // The branch exists in the bare repo with the new + edited files.
      const files = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "outerlayer/worker/add-thing"], { cwd: bare });
      expect(files.stdout.split("\n").filter(Boolean).sort()).toEqual(["NEW.md", "README.md"]);
      const newContent = await execFileAsync("git", ["show", "outerlayer/worker/add-thing:NEW.md"], { cwd: bare });
      expect(newContent.stdout).toBe("hello\n");
      const readme = await execFileAsync("git", ["show", "outerlayer/worker/add-thing:README.md"], { cwd: bare });
      expect(readme.stdout).toBe("# Seed edited\n");
    } finally {
      await cleanup();
    }
  });

  it("applies a delete and decodes base64 binary content", async () => {
    const { bare, cleanup } = await makeBareRepoWithSeed();
    try {
      await landChangesToLocalRepo(bare, "main", ctx([
        { path: "README.md", operation: "delete", encoding: "utf8" },
        { path: "logo.bin", operation: "write", content: "AAEC/w==", encoding: "base64" },
      ], "swap"));

      const files = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "outerlayer/worker/swap"], { cwd: bare });
      expect(files.stdout.split("\n").filter(Boolean).sort()).toEqual(["logo.bin"]);
      const bin = await execFileAsync("git", ["show", "outerlayer/worker/swap:logo.bin"], { cwd: bare, encoding: "buffer" });
      expect(Buffer.from(bin.stdout as unknown as Buffer)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff]));
    } finally {
      await cleanup();
    }
  });
});
