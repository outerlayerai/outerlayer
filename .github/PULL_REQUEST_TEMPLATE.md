## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## How it was tested

<!--
What you ran, and what convinced you it works. If this fixes a bug, say how you
know it's fixed — ideally a test that fails without the change.
-->

## Checklist

- [ ] This PR is one concern. Unrelated fixes are separate PRs.
- [ ] I've read [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) — conventions, checks, and what makes a test worth having.
- [ ] Commits are signed off (`git commit -s`).
- [ ] Local gates pass; the `pre-push` hook was not bypassed.
- [ ] Schema changes edit `apps/tenant-dashboard/supabase/schemas/` and ship the derived migration in the same PR.
- [ ] Docs updated, if this changes behaviour someone reads about.
