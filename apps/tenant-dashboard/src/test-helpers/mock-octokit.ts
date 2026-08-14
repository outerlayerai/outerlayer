import type { Octokit } from "octokit";

/** The one place a partial Octokit fake becomes the constructor's type —
 * client tests share this instead of each carrying its own double cast. */
export function asOctokit(mock: object): Octokit {
  return mock as unknown as Octokit;
}
