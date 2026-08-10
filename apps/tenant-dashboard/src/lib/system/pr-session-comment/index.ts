import "server-only";

/**
 * Public surface of the PR session comment module. Every trigger path — the
 * `pull_request` webhook, the debounced queue off session sync, and the
 * hourly cron gap-repair sweep — imports `refreshPrSessionComment` from here
 * rather than reaching into `./refresh` directly, so the module's internals
 * (the read layer, the renderer, the GitHub client composition) stay free
 * to change without touching every caller.
 */

/**
 * Deliberately narrow: the entry point and the params every caller has to
 * name, and nothing else. The read layer, the topic reader and the renderer
 * are composed BY `refreshPrSessionComment` and have no caller of their own
 * outside this directory — re-exporting them here would publish internals as
 * API and freeze them against the very churn this barrel exists to absorb.
 * Their own tests import them by path.
 */
export { refreshPrSessionComment, type RefreshPrSessionCommentParams } from "./refresh";

// `refreshEachByRepo` is deliberately NOT re-exported here. Callers import it
// from `./repo-pool` directly, so that a test which mocks this barrel to stub
// `refreshPrSessionComment` still runs the REAL per-repository
// serialization — the property those route tests exist to check. Routed
// through here it would be stubbed out with everything else and the
// rate-limit behaviour would silently go untested.
