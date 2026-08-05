import type {
  GitFileProvider,
  GitProviderContext,
} from "./types";
import { UnsupportedGitProviderError } from "./types";
import type { Env } from "../types";
import { GitHubProvider } from "./github";

export async function createGitProvider(
  context: GitProviderContext,
  env: Env
): Promise<GitFileProvider> {
  switch (context.provider) {
    case "github":
      if (!context.installationId) {
        throw { message: "GitHub installation ID required", status: 400 };
      }
      return GitHubProvider.create(context.installationId, env);

    default:
      throw new UnsupportedGitProviderError(context.provider);
  }
}
