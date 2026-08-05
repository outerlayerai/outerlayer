# CI setup for integration tests

How the `Integration Tests` job in `.github/workflows/ci.yml` runs
these suites, and what a local run needs to match it.

## What the job does

1. Installs the Supabase CLI via the `setup-supabase-cli` composite action,
   pinned to the `SUPABASE_CLI_VERSION` set at the top of the workflow.
2. Restores a cache of the Supabase Docker images, keyed on that same version,
   so a cold boot does not re-pull them.
3. Starts Supabase and applies migrations through the symlink described below.
4. Runs the suites sharded two ways: `npx vitest run --shard=1/2` and `2/2`.
5. Stops the containers.

The job runs on a 4-vCPU runner with a 30-minute timeout. Two shards rather
than four: each shard pays a fixed setup cost (Supabase boot, image load, DB
setup) before any test runs, so more shards spend more billable minutes without
shortening the critical path.

## Requirements

- **Docker** — Supabase runs as containers; available by default on the CI
  runners and provided by Docker Desktop locally.
- **Supabase CLI** — pinned in the workflow; install locally with the same
  version to reproduce CI behaviour.
- **Ports** — the local stack binds 54329–54334 (see `supabase/config.toml`).
  A stale container from a previous run is the usual cause of a port conflict.

## Environment variables

The job sets these for the test step:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the local API URL (`http://127.0.0.1:54331`) |
| `SUPABASE_SERVICE_ROLE_KEY` | the Supabase local-dev demo key — identical on every install, worthless against a real project |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | placeholders; no OAuth call is made |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | placeholders |
| `SUPABASE_AUTH_REDIRECT_URI` | the local dashboard callback URL |

## Migrations

`apps/integration-tests/supabase/migrations` is a symlink to
`apps/tenant-dashboard/supabase/migrations`. Symlinks survive checkout on the
CI runners, so no extra step is needed and the test schema cannot drift from the
app's. If a run reports a missing migration, check that the symlink resolved.

## Timing

Database setup dominates a run: roughly 30–60 seconds to boot and migrate,
against seconds of actual test execution for most suites. That fixed cost is
why the shard count is deliberately low.

## Debugging

```bash
docker info                 # is the daemon up?
supabase --version          # does the CLI match the pinned version?
supabase status             # are the services listening?
ls -la supabase/migrations  # does the symlink resolve?
```

Locally, `yarn db:setup` re-applies migrations without a full teardown, which is
usually enough to clear a schema-related failure.
