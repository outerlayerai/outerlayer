import { FileNotFoundError } from "@/lib/system/git/errors";

/**
 * Reads the policy surface — `.outerlayer/policy.yaml` and
 * `.outerlayer/validators/*.yaml` — from the BASE branch of the PR under
 * evaluation. The base-branch read is the security property, not an
 * implementation detail: a PR that edits the policy is judged under the
 * policy it started from, so no PR can waive its own checks; its changes
 * take effect on merge.
 *
 * Fetch-only: parsing lives in `verdict/policy.ts`. A missing file or
 * directory is the normal no-policy state, returned as absence; provider
 * errors throw, and the caller degrades to the recommended defaults rather
 * than failing the comment.
 */

export const POLICY_FILE_PATH = ".outerlayer/policy.yaml";
const VALIDATORS_DIR = ".outerlayer/validators";

/** A repo with more validator files than this is bulk-importing, not
 * declaring checks; content reads stay bounded per refresh. Files load in
 * sorted-name order, so which ones make the cut is deterministic. */
const MAX_VALIDATOR_FILES = 20;

/** The two provider reads this module performs — `GitHubProvider` satisfies
 * it structurally. `listDirectory` returning entries for a FILE at the path
 * (not a directory) yields [] upstream, which reads here as "no validators
 * directory". */
interface PolicyFileSource {
  getFileContent(repo: string, path: string, ref: string): Promise<{ content: string }>;
  listDirectory(
    repo: string,
    path: string,
    ref: string,
  ): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>>;
}

interface PolicyFiles {
  policyFile: { path: string; content: string } | null;
  validatorFiles: Array<{ path: string; content: string }>;
}

/**
 * The policy surface at `baseRef`, or absences where the repo declares
 * nothing. Only `*.yaml` / `*.yml` regular files under the validators
 * directory are read — anything else in there is someone's scratch space,
 * not config.
 */
export async function fetchPrPolicyFiles(
  github: PolicyFileSource,
  repo: string,
  baseRef: string,
): Promise<PolicyFiles> {
  let policyFile: PolicyFiles["policyFile"] = null;
  try {
    const file = await github.getFileContent(repo, POLICY_FILE_PATH, baseRef);
    policyFile = { path: POLICY_FILE_PATH, content: file.content };
  } catch (error) {
    if (!(error instanceof FileNotFoundError)) throw error;
  }

  let entries: Awaited<ReturnType<PolicyFileSource["listDirectory"]>> = [];
  try {
    entries = await github.listDirectory(repo, VALIDATORS_DIR, baseRef);
  } catch (error) {
    if (!(error instanceof FileNotFoundError)) throw error;
  }

  const paths = entries
    .filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.path)
    .sort()
    .slice(0, MAX_VALIDATOR_FILES);

  const validatorFiles: PolicyFiles["validatorFiles"] = [];
  for (const path of paths) {
    const file = await github.getFileContent(repo, path, baseRef);
    validatorFiles.push({ path, content: file.content });
  }

  return { policyFile, validatorFiles };
}
