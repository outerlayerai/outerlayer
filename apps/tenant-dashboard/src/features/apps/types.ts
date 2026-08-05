import type { App } from "@/types/app";
import type { GitProviderType } from "@/lib/adapters/git-provider-type";

export type AppEnvSummary = {
  name: string;
  is_default: boolean;
  current_version: number;
};

export type AppWithGitConnection = App & {
  isGitConnected: boolean;
  provider: GitProviderType | null;
  repository: string | null;
  connectedBranch?: string | null;
  environments: AppEnvSummary[];
};

/**
 * A domain-level failure a CRUD action's handler *returns* (never throws) so
 * the wrapper's own `ok(...)` still applies and the modal branches on
 * `errorCode` instead of a try/catch. Distinct from the action-kit wrapper's
 * own validation/forbidden/internal codes (`ActionErrorCodes`) — this is the
 * gateway's envelope translated for the UI: `duplicate_app_name` (create),
 * `entitlement_required` (create, with the extras the upgrade prompt needs),
 * or any other gateway `code` passed through verbatim.
 */
export interface AppActionFailure {
  ok: false;
  errorCode: string;
  message: string;
  field?: string;
  entitlement?: string;
  limit?: number;
  current?: number;
}

interface CreateAppSuccess {
  ok: true;
  app: { id: string; name: string; display_name: string | null };
}
export type CreateAppOutcome = CreateAppSuccess | AppActionFailure;

interface RenameAppSuccess {
  ok: true;
  app: { id: string; display_name: string | null };
}
export type RenameAppOutcome = RenameAppSuccess | AppActionFailure;

interface DeleteAppSuccess {
  ok: true;
}
export type DeleteAppOutcome = DeleteAppSuccess | AppActionFailure;

interface LinkRepositorySuccess {
  ok: true;
}
export type LinkRepositoryOutcome = LinkRepositorySuccess | AppActionFailure;

interface FetchRepositoriesSuccess {
  ok: true;
  repositories: string[];
}
export type FetchRepositoriesOutcome = FetchRepositoriesSuccess | AppActionFailure;

interface FetchBranchesSuccess {
  ok: true;
  branches: string[];
}
export type FetchBranchesOutcome = FetchBranchesSuccess | AppActionFailure;
