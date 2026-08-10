# PR session comment: `issues: write` permission rollout

How to safely add the `issues: write` permission the pull-request session
comment feature needs to the existing GitHub App, what happens to every
installed org when you do, and how to tell whether an install is silently
waiting on that approval versus something else going on.

## Why a permission change is required

The GitHub App (`apps/tenant-dashboard/src/app/api/webhooks/github/route.ts`)
already exists and already posts check runs. It has never written an issue
comment. A pull-request comment IS an issue comment in the GitHub API — PRs
and issues share the same comments endpoint — so the client methods added for
this feature (`createIssueComment` / `updateIssueComment` / `getIssueComment`
in `apps/tenant-dashboard/src/lib/system/git/github/client.ts`) need the
**`issues: write`** permission on the app's manifest. The app does not
currently hold it.

This feature deliberately extends the existing GitHub App rather than
registering a second one: **one app, one identity, no second GitHub App** —
accepting that the permission grant itself has a real cost to every existing
installation.

## What changing the permission actually does

GitHub does not silently widen a live installation's grant. The moment the
app's manifest requests a new permission:

- **Every org that has already installed the app** is placed into a
  **pending-approval** state for that specific permission. GitHub does not
  auto-approve; nothing the app does with its *existing* permissions is
  affected, and no other webhook, check run, or read stops working.
- The org's admin sees a banner the next time they visit their GitHub App
  installation settings page
  (`https://github.com/organizations/<org>/settings/installations`, or the
  personal equivalent for a user install): *"This app is requesting
  additional permissions"*, followed by a diff naming `issues: write` and a
  button to review and accept (or the option to ignore it indefinitely).
  GitHub does not email or otherwise push-notify the admin — they only see
  this by opening that settings page, or by GitHub surfacing it inline the
  next time they view the installation from a repo they own.
- Until the admin clicks accept, `issues: write` calls against that
  installation's token return **403**. Every other scope the app already
  held keeps working exactly as before.

This is **not per-repo**. It is one property of the installation (which is
itself per-org, or per-user for personal accounts). An org with ten connected
repos approves once and every repo unblocks together.

### Why this must be a manual UI action, done last

Requesting the new permission is a change to the GitHub App's own manifest in
the GitHub App settings UI (`https://github.com/settings/apps/<app-slug>` →
Permissions & events), not a code change and not something `octo-kit.ts`'s
manifest-as-code path drives automatically. There is nothing to merge,
migrate, or deploy for this step.

Do it **last** — after every other PR in this stack has merged and the
comment feature is otherwise complete — because flipping it is the trigger
that puts every existing installation into pending-approval. Flipping it
early, before the feature can post anything useful, buys nothing and starts
the clock on org admins seeing a stale "additional permissions requested"
banner for a feature that isn't live yet.

## The feature degrades silently while pending

This is the load-bearing design choice that makes the rollout safe to ship
ahead of admin approval: a 403 from GitHub is never allowed to become a
user-visible error.

- `GitHubProvider.createIssueComment` / `.updateIssueComment` /
  `.getIssueComment` (`apps/tenant-dashboard/src/lib/system/git/github/client.ts`)
  catch a 403 and return a typed `{ status: 'not_permitted' }` result. They
  never throw for this case.
- `refreshPrSessionComment` (`apps/tenant-dashboard/src/lib/system/pr-session-comment/refresh.ts`)
  treats `not_permitted` as a normal outcome: it logs the structured event
  described below and returns `{ status: "not-permitted" }` to its caller. It
  never throws.
- Every trigger path that calls it — the `pull_request` webhook handler, the
  queue consumer's internal endpoint, and the hourly cron sweep — is itself
  wrapped so a failed comment refresh can never fail the webhook, the queue
  message, or the cron run. Reconciliation, check runs, and every other
  webhook side effect proceed normally.

Net effect for a pending org: nothing breaks, and nothing about the comment
feature appears anywhere in their repo. No comment, no error, no partial
state. The feature is invisible until they approve — which is exactly why
the visibility surface below exists for operators, since the org's own admin
has no reason to look for it unless they already know to check their GitHub
App settings.

## Telling apart the three reasons a comment is missing or empty

From the outside, "there's no session comment on this PR" (or "the comment
says no sessions linked yet, but I know there are sessions") can mean three
very different things. Do not guess — check in this order:

1. **Pending permission approval.** Check for
   `pr_session_comment.not_permitted` events for the tenant/repository (see
   below). If present, the org's admin has not yet approved `issues: write`.
   This is an app-level, cross-repo state — if one repo shows it, every repo
   under that installation is in the same state.
2. **Toggle disabled by the customer.** `git_connection.pr_comments_enabled`
   is a per-app boolean, default `true`. If it's `false`, the
   customer turned the feature off for that app themselves; existing comments
   are left in place (never deleted) but no further writes happen.
   `readLinkedSessions` (`apps/tenant-dashboard/src/lib/system/pr-session-comment/read.ts`)
   treats "no app has `pr_comments_enabled` for this repo" as a clean no-op —
   `refreshPrSessionComment` returns `{ status: "skipped-disabled" }`, and no
   `not_permitted` event is logged, because GitHub was never called.
3. **No sessions linked yet.** The permission is approved, the toggle is on,
   and the comment exists and correctly says "No agent sessions linked yet."
   This is the everyday empty state for a freshly opened PR before any agent
   session has been reconciled onto it (`pull_request_session`,
   `verification = 'confirmed'`) — not a failure of anything.

In short: **missing entirely** and **not_permitted in the logs** point at (1);
**present but `skipped-disabled` / toggle off** points at (2); **present,
rendered, and empty** is (3) and needs no action.

## The visibility surface: querying `pr_session_comment.not_permitted`

Every call to `refreshPrSessionComment` that hits a 403 emits one structured
log line through the repo's server logger
(`apps/tenant-dashboard/src/lib/observability/server-logger.ts`), not a bare
`console.warn`:

```
serverLogger.info("[pr-session-comment] refresh blocked: issues:write not permitted", {
  event: "pr_session_comment.not_permitted",
  tenantId,
  repository,
  prNumber,
  timestamp,
})
```

`serverLogger.info` always writes to the console (so it's visible in local
dev and in any raw log tail), and in production it additionally ships to
Logtail — the same destination every other operational `serverLogger.info`
call in this codebase uses (see `handle-push-event.ts`,
`persist-agent-session.ts`, `worker-params/route.ts` for the existing
pattern this follows). It is deliberately `.info`, not `.error`: an
installation pending admin approval is expected steady-state, not an
incident, so it must not page anyone or land in Sentry.

**To check whether an org is pending approval**, query Logtail (or whatever
downstream log sink Logtail forwards to) for:

- `event:"pr_session_comment.not_permitted"` — every blocked refresh, across
  all tenants.
- add `tenantId:"<tenant-id>"` or `repository:"<owner/repo>"` to scope to one
  customer.

One other event is worth an alert, for a different reason:

- `event:"pr_session_comment.persist_failed"` — a comment was POSTed to
  GitHub and its id could not be written back after retries. The comment
  EXISTS and nothing of ours points at it; the id is in the log line
  (`githubCommentId`) because that is the only remaining handle on it. The
  next refresh that takes over the stranded claim will recognize the comment
  by its invisible marker and adopt it rather than posting a second one
  (`findPostedComment` in `refresh.ts`), so this is usually self-healing —
  but a run of it means writes to `pr_session_comment` are failing, which is
  an incident in its own right.

A tenant/repository appearing here at all, at any point after the permission
rollout, means that installation has not approved `issues: write` yet. Once
approved, refreshes for that repo succeed and the event stops appearing for
new activity (nothing retroactively clears — there is no "resolved" event,
only the absence of new `not_permitted` lines going forward).

This log-based query is the whole visibility surface for this rollout. A
dedicated admin page or a rolled-up metric was considered and deliberately
not built: the event already carries everything an operator needs
(`tenantId`, `repository`, `prNumber`, `timestamp`), it is emitted exactly
once per blocked attempt (not sampled or batched), and pending-approval is
expected to be transient — every existing org needs to clear it once, most
within days of the rollout, and new installs simply request `issues: write`
correctly from the start and never see it. If it turns out orgs commonly get
stuck (an admin who never revisits their GitHub App settings), the next step
should be an in-product banner on the git-connection settings page driven by
"has a `not_permitted` event fired for this repo in the last N days", not a
new standalone admin surface.
