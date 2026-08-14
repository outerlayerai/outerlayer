import "server-only";

import { MAX_VALIDATOR_FILES, type PolicyFile, type PolicySource } from "./policy";

/**
 * Reads a repo's evidence-policy files from GitHub — always at the PR's
 * BASE branch, never its head. A PR that edits the policy is judged under
 * the policy it started from, so no PR can waive its own checks; the edit
 * takes effect once it merges.
 *
 * Everything degrades to "no policy" (built-in defaults): a client fake
 * without the methods, an unknown base branch, a missing file or directory,
 * a failed read. A config-error row is reserved for a policy that EXISTS
 * but is broken — absence is never an error.
 */

const POLICY_PATH = ".outerlayer/policy.yaml";
const VALIDATORS_DIR = ".outerlayer/validators";

const YAML_FILE = /\.ya?ml$/;

interface PolicySourceClient {
  getPullRequestBaseBranch?(repo: string, prNumber: number): Promise<string | null>;
  getFileContent?(repo: string, path: string, ref: string): Promise<{ content: string }>;
  listDirectory?(
    repo: string,
    path: string,
    ref: string,
  ): Promise<Array<{ path: string; name: string; type: string }>>;
}

export async function readPolicySource(
  client: PolicySourceClient,
  repository: string,
  prNumber: number,
): Promise<PolicySource | null> {
  const { getPullRequestBaseBranch, getFileContent, listDirectory } = client;
  if (!getPullRequestBaseBranch || !getFileContent) return null;
  const baseRef = await getPullRequestBaseBranch(repository, prNumber).catch(() => null);
  if (baseRef === null) return null;

  // The policy file and the directory listing are independent reads; the
  // per-file fetches below fan out the same way. Every refresh pays this
  // read, so the round trips overlap instead of chaining.
  const [policyYaml, entries] = await Promise.all([
    getFileContent(repository, POLICY_PATH, baseRef).then(
      (file): PolicyFile => ({ path: POLICY_PATH, content: file.content }),
      () => null,
    ),
    listDirectory
      ? listDirectory(repository, VALIDATORS_DIR, baseRef).catch(
          () => [] as Array<{ path: string; name: string; type: string }>,
        )
      : Promise.resolve([] as Array<{ path: string; name: string; type: string }>),
  ]);

  const yamlEntries = entries
    .filter((entry) => entry.type === "file" && YAML_FILE.test(entry.name))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const ignoredValidatorPaths = yamlEntries
    .slice(MAX_VALIDATOR_FILES)
    .map((entry) => entry.path);
  const reads = await Promise.all(
    yamlEntries.slice(0, MAX_VALIDATOR_FILES).map((entry) =>
      getFileContent(repository, entry.path, baseRef).then(
        (file): PolicyFile => ({ path: entry.path, content: file.content }),
        // An unreadable single file degrades to "that file is absent"; the
        // rest of the policy still applies.
        () => null,
      ),
    ),
  );
  const validatorFiles = reads.filter((file): file is PolicyFile => file !== null);

  if (policyYaml === null && validatorFiles.length === 0 && ignoredValidatorPaths.length === 0) {
    return null;
  }
  return {
    policyYaml,
    validatorFiles,
    ...(ignoredValidatorPaths.length > 0 ? { ignoredValidatorPaths } : {}),
  };
}
