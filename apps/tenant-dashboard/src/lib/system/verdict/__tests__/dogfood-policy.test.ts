/**
 * This repo's own `.outerlayer/` policy is real config, evaluated on our
 * PRs. A parser change that invalidates it — or an edit to the files that
 * the parser rejects — would silently demote our own evidence comments to
 * an error row, so the files are pinned to load with zero problems.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePolicy } from "../policy";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..", "..");

function repoFile(path: string) {
  return { path, content: readFileSync(join(REPO_ROOT, path), "utf8") };
}

describe("this repo's dogfood policy", () => {
  it("loads with zero problems: the recommended registry plus migration-must-run", () => {
    const loaded = parsePolicy(repoFile(".outerlayer/policy.yaml"), [
      repoFile(".outerlayer/validators/migration-must-run.yaml"),
    ]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.levels).toEqual({
      "commits-from-sessions": "warn",
      "red-then-green": "warn",
      "no-test-tampering": "warn",
      "migration-must-run": "warn",
    });
    expect(loaded.customs).toEqual([
      {
        id: "migration-must-run",
        row: "Migrations ran against a local database",
        level: "warn",
        whenPaths: ["apps/tenant-dashboard/supabase/migrations/**"],
        requireAny: [
          { type: "session-ran", command: "supabase migration up", status: "ok" },
          { type: "session-ran", command: "supabase db reset", status: "ok" },
        ],
        needs: ["commands"],
        declaresEmit: null,
      },
    ]);
  });
});
