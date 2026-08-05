# Integration Tests

Integration tests that exercise the system against real infrastructure: a local
Supabase instance, a local ClickHouse instance, and (for the gateway suites) a
locally running gateway. Nothing here is mocked at the database boundary, so
these tests catch what unit tests structurally cannot — RLS policies, database
triggers, cross-tenant isolation, and schema drift.

## Setup requirements

- **Docker** — runs the local Supabase and ClickHouse containers
- **Supabase CLI** — installed automatically in CI
- **Node.js 22+** — matches the repo's `engines.node`

## Usage

```bash
# Full run: set up the database, run every suite, tear the database down
yarn test

# Acceptance suites only
yarn test:acceptance

# With coverage
yarn test:coverage

# Verbose reporter
yarn test:debug

# Manage the database by hand (useful when iterating on one suite)
yarn db:setup
yarn db:start
yarn db:stop
yarn db:teardown
```

To run a single suite against an already-running database:

```bash
npx vitest run src/tests/rbac/rbac-matrix.test.ts
```

## Where these run

Integration tests run in **CI, on pull requests**, split across two shards
(`Integration Tests (1/2)` and `(2/2)` in `.github/workflows/ci.yml`).
The gateway HTTP suites run alongside them as a separate job. They are a
merge gate, not a post-merge check.

## Database schema

### Supabase (PostgreSQL)

Migrations have a single source of truth:

- **Source**: `apps/tenant-dashboard/supabase/migrations/`
- **Symlink**: `apps/integration-tests/supabase/migrations/` points there
- No duplicated migration files, so the test schema cannot drift from the app's

### ClickHouse (analytics)

ClickHouse suites run the real migration files rather than a hand-maintained
test schema:

- **Source**: `apps/tenant-dashboard/clickhouse/migrations/`
- **Runner**: `clickhouse/setup-clickhouse.ts` executes every `.sql` file in
  numeric order
- **Container**: a dedicated ClickHouse on port `18123` (see
  `clickhouse/docker-compose.yml`)
- **Lifecycle**: global setup starts the container and migrates it; global
  teardown removes it
- **Isolation**: each suite uses a unique `TEST_RUN_ID` so concurrent suites
  cannot collide

The runner splits each file into statements and skips `MATERIALIZE PROJECTION`
and `MATERIALIZE INDEX` — test data is inserted after schema creation, so
materializing is unnecessary. Because the schema comes from the same files
production uses, a migration that adds a table or drops a view is picked up
automatically.

```bash
# ClickHouse suites only
npx vitest run --project clickhouse
```

## What these tests cover

The suites are organized by area under `src/tests/`. The security-relevant ones
carry most of the value:

- **Row Level Security** — policies actually deny what they claim to
- **Multi-tenant isolation** — one tenant cannot read or write another's rows
- **Role-based permissions** — each role resolves to the access it should
- **Service-role boundaries** — admin paths bypass RLS only where intended

## Conventions

- Tests run against a real database; there is no query-builder mock
- Each test seeds the rows it needs and deletes them in the same block, so
  suites are order-independent and safe to run in parallel
- Assert the outcome, not the absence of an error

## Debugging

When a test fails:

1. Confirm migrations applied — `yarn db:setup` re-runs them
2. Check the Supabase container logs
3. Verify the migration symlink resolves in your environment
4. Re-run with `yarn test:debug` for a verbose reporter
