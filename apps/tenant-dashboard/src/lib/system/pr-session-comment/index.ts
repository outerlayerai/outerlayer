import "server-only";

/**
 * Public surface of the PR session comment module. Trigger paths (PRs 8/9/12
 * — the `pull_request` webhook, the session-link event, and the debounced
 * topic-label refresh) import `refreshPrSessionComment` from here rather than
 * reaching into `./refresh` directly, so the module's internals (the read
 * layer, the renderer, the GitHub client composition) stay free to change
 * without touching every caller.
 */

export {
  refreshPrSessionComment,
  type RefreshPrSessionCommentParams,
  type RefreshPrSessionCommentResult,
  type RefreshPrSessionCommentDeps,
  type PrSessionCommentGithubClient,
} from "./refresh";

export { readLinkedSessions, type LinkedSessionRow } from "./read";
export { readTopicLabels, type ReadTopicLabelsInput, type ChQueryFn } from "./topics";
export { renderComment, type RenderLinks } from "./render";
