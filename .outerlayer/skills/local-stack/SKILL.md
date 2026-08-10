---
name: local-stack
description: Boot and run the full local stack — Supabase, ClickHouse, gateway, and tenant-dashboard — with the exact ports, env vars, and startup order the apps and e2e suites expect. Use when running or debugging the app locally, running or setting up any Playwright e2e spec (apps/e2e — including the playground/experiments dispatch specs and the billing spec, which need specific env vars), manually testing a flow in a browser, or when a local service (Supabase :54421, ClickHouse :8123, gateway :9101, dashboard :3002) is down, unreachable, or misconfigured.
license: Apache-2.0
compatibility: Requires Docker and a Unix-like dev environment (macOS or Linux).
---

# Running the Local Stack

The browser e2e (`apps/e2e`, e.g. `tests/traces/*`), manual testing, and full-stack local dev need four services. Ports and env vars below are what the specs and configs expect — deviating from them is the most common cause of "works locally, spec can't connect."

**Docker**: if `docker ps`/`docker info` fails, the daemon is usually booting or stopped — start Docker Desktop (`open -a Docker` on macOS) and poll `docker info` until it answers. Never conclude "Docker isn't set up" and skip a live run.

## Check what's already running (always do this first)

```bash
cd apps/tenant-dashboard && npx supabase status          # Supabase
docker ps --filter name=clickhouse --format '{{.Status}}' # ClickHouse
curl -s -o /dev/null -w '%{http_code}' http://localhost:3002  # dashboard
curl -s -o /dev/null -w '%{http_code}' http://localhost:9101  # gateway
```

Starting Supabase when it's already up wastes minutes. Startup order when cold: **Supabase → ClickHouse → gateway → dashboard**; verify each is healthy before the next.

## 1. Supabase (`:54421`)

```bash
cd apps/tenant-dashboard && npx supabase start   # do NOT use --workdir (breaks project_id resolution)
npx supabase migration up                        # must be migrated to date
```

The e2e `global-setup.ts` auto-resolves `SUPABASE_SERVICE_ROLE_KEY` via `supabase status -o json` — don't set it by hand. An out-of-date DB fails subtly: the gateway DO's machine-state load selects `environment.machine_cleaned_at` and silently bails (→ `app_not_connected`) if that column is missing.

## 2. ClickHouse (`:8123`, user `default` / password `dev_password`)

```bash
cd apps/tenant-dashboard/clickhouse && docker compose up -d
cd apps/tenant-dashboard && yarn clickhouse:migration:dev
```

Verify: `curl 'http://127.0.0.1:8123/?password=dev_password' --data-binary 'SHOW TABLES'` lists `otel_traces`.

## 3. Gateway (must be `:9101` for the e2e; its `dev` script defaults to `:9001`)

Needs `apps/gateway/.dev.vars` (gitignored). Generate it from the committed `apps/gateway/.dev.vars.ci`, overriding:

- `SUPABASE_API_BASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` / `SUPABASE_JWT_SECRET` from `supabase status -o json` (fields `PUBLISHABLE_KEY` / `SECRET_KEY`)
- `CLICKHOUSE_HOST=http://localhost:8123`, `CLICKHOUSE_PASSWORD=dev_password`, `NODE_ENV=development`

(`.dev.vars.ci` points at the integration-tests ClickHouse on `:18123` — the e2e uses tenant-dashboard's `:8123`, hence the override.)

```bash
cd apps/gateway && GATEWAY_PORT=9101 yarn dev
```

**API keys**: there is no auth bypass. The gateway verifies API keys against the Postgres key-store using `API_KEY_PEPPER` (committed in `.dev.vars.ci` as `am-ci-pepper-not-a-secret`). Any key the dashboard/CLI mints must be hashed with the SAME pepper — start the dashboard with that same `API_KEY_PEPPER` or its minted keys won't verify. (The e2e specs authenticate through the session bearer-JWT path, so most don't need a minted key.)

## 4. Dashboard (`:3002`)

Playwright's `webServer` auto-starts `yarn dev`, **but that uses Turbopack, which crash-loops** here (`FATAL: …directory_tree_to_loader_tree…` while compiling some app routes → its HMR client reloads the page → tests can never fill the login form). **Pre-start with the webpack compiler instead** so Playwright reuses it (`reuseExistingServer: !CI`):

```bash
cd apps/tenant-dashboard && SKIP_ENV_VALIDATION=true \
  NEXT_PUBLIC_GATEWAY_URL=http://localhost:9101 \
  API_KEY_PEPPER=am-ci-pepper-not-a-secret \
  PORT=3002 npx next dev --webpack
```

Webpack first-compiles each route on first visit (slow, ~15–40s) but is stable; routes stay warm after. (`SKIP_ENV_VALIDATION=true` lets the dashboard boot without `API_KEY_PEPPER`, but any key it mints then fails to verify — set both.)

**`NEXT_PUBLIC_GATEWAY_URL=http://localhost:9101` is required for the dispatch specs** (`tests/playground/run.spec.ts`, `tests/experiments/run.spec.ts`): the var is baked into the client bundle at dashboard start — without it the dashboard falls back to the production gateway (`config-global.ts`) and neither the dispatch nor the observer WebSocket reaches your local gateway. Those specs stand up a localhost `/execute` server via the connected-handler fixture (`tests/utils/connected-handler.ts`) and point the env's `fly_machine_url` at it, so the gateway routes the run to it exactly as it would a real Fly machine — no deployed agent or model needed. They're tagged `@local-stack` and run under `chromium-full` only (the deployed staging gateway can't reach a CI runner's localhost).

## Running e2e specs

```bash
cd apps/e2e && npx playwright install chromium   # once
npx playwright test tests/<area>/<spec>.spec.ts --project=chromium-full
```

Because each route first-compiles cold, give a new spec generous per-test budget and use first-compile-sized timeouts on cross-route navigations (App Router commits the URL only after the destination route compiles).

## Billing spec (`@billing-live`)

`tests/billing/plan-lifecycle.spec.ts` exercises real Stripe **test mode** + the real payment webhook (subscribe → upgrade → cancel). It deliberately does NOT drive Stripe's hosted Checkout/Portal DOM (Stripe owns + changes those pages → chronically flaky; their own guidance is to use the test API + webhooks). Prereqs beyond the four services:

1. Webhook forwarder: `cd apps/tenant-dashboard && yarn stripe:listen` (needs `stripe login`, test mode) — prints a `whsec_…`
2. Dashboard started with that secret AND the **real** test-mode flat price IDs (`.env.local` ships placeholders): `STRIPE_SECRET_WEBHOOK_KEY=<whsec> STRIPE_GROWTH_FLAT_PRICE_ID=<real> STRIPE_TEAM_FLAT_PRICE_ID=<real> … npx next dev --webpack`
3. The test run gets `STRIPE_SECRET_KEY` (sk_test_*) + `STRIPE_GROWTH_FLAT_PRICE_ID`

Excluded from `chromium-staging` (would churn the test Stripe account every deploy). The Growth→Team **upgrade** goes through our first-party dialog (`upgradeSubscription`), not Stripe's page; only the initial subscribe + cancel use the Stripe test API.

## Seeding test data

Seed via the helpers in `apps/e2e/tests/utils/test-helpers.ts`:

- `createTestUser(prefix)` — auth user + profile
- `createTestOwnerWithOrg(prefix)` — full owner with org, billing, terms
- `createTestPlatformAdmin(prefix)` — platform admin user
- `getSupabaseAdmin()` — service-role client for arbitrary queries

```bash
cd apps/e2e && npx tsx -e "
  const { createTestOwnerWithOrg } = require('./tests/utils/test-helpers');
  createTestOwnerWithOrg('manual-test').then(r => console.log(JSON.stringify(r)));
"
```

Always clean up seeded data afterward with the corresponding `cleanup*` helpers.

## App targets

| App | Default URL |
|---|---|
| tenant-dashboard | http://localhost:3002 |
| outerlayer-site | http://localhost:3000 |
