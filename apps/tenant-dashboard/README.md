## Getting Started

### Dev Profiles

| Command | What it starts | When to use |
|---------|---------------|-------------|
| `yarn dev` | App + Supabase (minimal) | Day-to-day development |
| `yarn dev:analytics` | App + Supabase + ClickHouse | Working on analytics features |
| `yarn dev:full` | App + Supabase + ClickHouse + Studio + Inbucket | Debugging database or testing emails |

### Cache Cleanup

```bash
yarn clean:cache  # Remove Turbo + Next.js build caches
yarn clean:all    # Remove all caches, .next dirs, and tsbuildinfo files
```

### Basic Usage

Run the development server: 

```bash
yarn dev
```

or from the project root
```bash
yarn workspace tenant-dashboard dev
```

Generating typescript types from db
NOTE: You MAY need to delete some pre-pended/appended text in the file
```
yarn workspace tenant-dashboard codegen:db
```

Re-run all migrations
```
yarn workspace tenant-dashboard migration:reset
```

Run pending migrations
```
yarn workspace tenant-dashboard migration:up
```

## Unit Tests

Use MSW for tenant-dashboard component and action tests whenever the code under test talks to Supabase or another HTTP boundary.

- Put shared server setup in `src/test-helpers/msw-server.ts`. `unit-test-setup.ts` starts the server with `onUnhandledRequest: 'error'`, resets handlers after each test, and resets feature state before each test.
- Add feature-scoped handlers under `src/test-helpers/msw-handlers/`. Keep them small and expose explicit seed/reset helpers so tests declare the data they need instead of mocking query-builder chains.
- Reuse the shared Supabase handler layer for auth and common REST tables. `seedSupabaseAuth()` seeds both the SSR session cookie and the `/auth/v1/user` response, while `seedSupabaseMswState()` covers tables like `app`, `billing`, and `tenant_entitlement_override`.
- Extend the shared Supabase state before reaching for one-off query mocks. Current shared handlers also cover platform-admin tables such as `platform_user_role`, `platform_role_permissions`, and `temp_access_grant`.
- Use dedicated feature handlers when the code crosses into Supabase Storage. `src/test-helpers/msw-handlers/templates.ts` seeds both `rest/v1/template` rows and `storage/v1/object/...` downloads for experiment and template-content tests.
- Prefer mocking permission gates, billing services, or other true seams over mocking `createSupabaseServerClient()` / `createSupabaseAdminClient()`.
- Do not add new `vi.mock('@supabase/...')` or Supabase client factory mocks in unit tests. If a test needs a new Supabase interaction, add or extend an MSW handler instead.
- The old `src/test-helpers/mocks/*` Supabase compatibility layer has been removed. Shared test setup now goes through `unit-test-setup.ts` plus the MSW server/handler modules.

Examples:
- `src/features/api-keys/actions.test.ts` seeds Supabase REST responses through `src/test-helpers/msw-handlers/api-keys.ts` instead of mocking `from().select().eq().single()` chains.
- `src/app/api/analytics/__tests__/with-auth.test.ts` and `src/app/api/analytics/span-usage/route.test.ts` seed authenticated SSR sessions and entitlement data through shared MSW helpers instead of mocking Supabase clients.
- `src/app/api/platform-admin/score-coverage/__tests__/route.test.ts` seeds platform-admin auth through the shared MSW helpers instead of mocking Supabase admin and server clients.
- `src/lib/analytics/__tests__/experiments.test.ts` seeds template rows plus storage objects through `src/test-helpers/msw-handlers/templates.ts` instead of constructing an in-memory Supabase client fake.

## Git Provider Configuration

The tenant dashboard connects to GitHub for repository integration.

### GitHub Setup

1. Create a GitHub App at https://github.com/settings/apps/new
2. Configure the app with the required permissions (repository contents, webhooks)
3. Generate a private key and set the following environment variables:
   - `GITHUB_APP_ID` - Your GitHub App ID
   - `GITHUB_APP_PRIVATE_KEY` - The private key (PEM format)
   - `GITHUB_APP_WEBHOOK_SECRET` - Secret for webhook verification

## Clickhouse
[Clickhouse](https://clickhouse.com/) is our technology of choice for powering our online analytical processing (OLAP) workloads. It is fast and easy to set up! For local development, a `/clickhouse` directory is provided with some tools to get you started

<u>docker-compose.yml</u> - a simple file for standing up a single node clickhouse server. Simply navigate to the `/clickhouse` directory and run
```bash
docker-compose up
```
This will start a clickhouse server and make it available at `http://localhost:8123`.

<u>seed.mjs</u> - a very simple node script for connecting to the clickhouse server and creating a basic table and putting in some seed data. It can be run with
```bash
node ./seed.mjs
```
It will create a table called `prompt_requests` and populate the table with ~20 dummy records. It can be run multiple times to increase the amount of data in the table.

<u>teardown.mjs</u> - a simple node script that will reset the clickhouse server. It will remove the `prompt_requests` table and it's data.
