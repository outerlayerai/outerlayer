import "server-only";

import type { PolicyFile, PolicySource } from "./policy";

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

/** More validator files than this is not a policy, it's a bulk import;
 * reads stay bounded and the rest are ignored in path order. */
const MAX_VALIDATOR_FILES = 20;

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
  if (!client.getPullRequestBaseBranch || !client.getFileContent) return null;
  const baseRef = await client.getPullRequestBaseBranch(repository, prNumber).catch(() => null);
  if (baseRef === null) return null;

  let policyYaml: PolicyFile | null = null;
  try {
    const file = await client.getFileContent(repository, POLICY_PATH, baseRef);
    policyYaml = { path: POLICY_PATH, content: file.content };
  } catch {
    policyYaml = null;
  }

  const validatorFiles: PolicyFile[] = [];
  if (client.listDirectory) {
    let entries: Array<{ path: string; name: string; type: string }> = [];
    try {
      entries = await client.listDirectory(repository, VALIDATORS_DIR, baseRef);
    } catch {
      entries = [];
    }
    const yamlEntries = entries
      .filter((entry) => entry.type === "file" && YAML_FILE.test(entry.name))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, MAX_VALIDATOR_FILES);
    for (const entry of yamlEntries) {
      try {
        const file = await client.getFileContent(repository, entry.path, baseRef);
        validatorFiles.push({ path: entry.path, content: file.content });
      } catch {
        // An unreadable single file degrades to "that file is absent"; the
        // rest of the policy still applies.
      }
    }
  }

  if (policyYaml === null && validatorFiles.length === 0) return null;
  return { policyYaml, validatorFiles };
}
