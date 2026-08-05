# Self-hosting OuterLayer

OuterLayer runs on your own machines. This page covers the hobby-grade path: one script that brings up the gateway, the analytics store, the blob store, and the database, so you can evaluate OuterLayer against your own traces without sending them anywhere.

> **Warning:** **This is a hobby-grade deployment, not a production one.** Everything runs on a single host. There's no high availability, no backup or restore procedure, no rate limiting, and no per-consumer API keys. It suits evaluation and small internal use. Read [What you don't get](#what-you-dont-get) before you point production traffic at it.

## What you get

| Service | Runs as | Purpose |
|---|---|---|
| Gateway | Docker | Trace ingest, prompt dispatch, the OpenAPI surface your SDKs call |
| ClickHouse | Docker | Trace and score analytics |
| MinIO | Docker | S3-compatible store for span payloads too large to inline |
| Postgres + Auth | Supabase CLI, on the host | Tenants, apps, users, RBAC, RLS |
| Dashboard | Node, on the host | The web UI |

Traces, prompts, evals, dashboards, alerts, and the full API surface all work. Nothing caps your usage: the gateway resolves entitlements in self-host mode rather than against the hosted tier matrix, so no monthly span limit applies and no billing sits in the request path.

## What you don't get

- **No high availability.** Single host, single gateway process. The gateway's connection broker keeps observer subscriptions and job-replay buffers in process memory, so a second replica isn't a matter of scaling the service. It needs sticky routing that doesn't exist yet.
- **No per-consumer API keys.** Programmatic callers share one secret. Rotating it restarts the gateway, and you can't revoke one consumer without revoking all of them. If you need independently revocable keys per consumer, that's the clearest reason to use the hosted service.
- **No rate limiting.** The self-host runtime doesn't enforce request rate limits.
- **No backups.** Nothing snapshots the Postgres, ClickHouse, or MinIO volumes. That's yours to arrange.
- **No managed upgrades.** See [Upgrading](#upgrading).
- **No agent builds.** Nothing on self-host can start a build, so an environment only dispatches to a machine it already has.

## Prerequisites

- **Docker**, either Docker Desktop or Docker Engine, running.
- **Node.js 22 or later**, and the repository cloned. The Supabase CLI, the database migrations, and the ClickHouse migrations all come from the checkout, so self-hosting starts from a clone rather than a standalone compose file.
- **`openssl`**, which generates the secrets for your install.
- Roughly **8 GB of free RAM**. Supabase alone runs about eight containers.

## Quick start

Clone the repository, then from its root run:

```sh
./docker/selfhost-up.sh
```

The script starts Supabase, applies the database migrations, generates `docker/.env.selfhost` with secrets unique to your install, builds and starts the Docker services, migrates ClickHouse, waits for the gateway to answer `/health`, and prints the command that starts the dashboard.

> **Note:** The first run builds the gateway image from source, which installs the whole workspace and takes several minutes. Later runs reuse the Docker layer cache and finish in seconds.

Re-running the script is safe. It writes the generated secrets once and keeps them, then refreshes the Supabase values from the running instance every time so they can't drift.

### Start the dashboard

The dashboard runs on the host, not in the compose file. The script prints the exact commands with your values filled in. They look like this:

```sh
cd apps/tenant-dashboard

# Load the stack's config, then add what only the dashboard needs.
set -a; . ../../docker/.env.selfhost; set +a
export DATABASE_URL="$SUPABASE_DB_URL"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_API_URL_FROM_HOST"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY"
export NEXT_PUBLIC_APP_URL="http://localhost:3002"
export NEXT_PUBLIC_GATEWAY_URL="http://localhost:$GATEWAY_PORT"
export NEXT_PUBLIC_API_URL="http://localhost:$GATEWAY_PORT"
export CLICKHOUSE_HOST="http://localhost:$CLICKHOUSE_PORT"
export OUTERLAYER_SELF_HOSTED=true BILLING_ENABLED=false
export EMAIL_PROVIDER=smtp SMTP_HOST=localhost SMTP_PORT=2500 EMAIL_ENABLED=false
export UNKEY_API_KEY=unused-on-self-host CRON_SECRET=unused-on-self-host
export GITHUB_APP_ID=0 GITHUB_APP_PRIVATE_KEY=unused GITHUB_APP_WEBHOOK_SECRET=unused
export PORT=3002

npx next build
npx next start
```

Then open `http://localhost:3002` and sign up. The first account you create owns its own organization.

> **Warning:** Export the environment before `next build`, not just before `next start`. Next.js bakes every `NEXT_PUBLIC_*` value into the client bundle at build time, so a dashboard built without `NEXT_PUBLIC_GATEWAY_URL` points its browser traffic at the hosted gateway no matter what you set when you start it. Re-run `next build` after you change any `NEXT_PUBLIC_*` value.

Several of those values exist only to satisfy the dashboard's startup validation. `UNKEY_API_KEY`, `CRON_SECRET`, and the three `GITHUB_APP_*` variables gate hosted-only features that a self-host install never reaches, but the schema still demands them, so any placeholder works. `BILLING_ENABLED=false` is what makes the whole `STRIPE_*` block optional, and `EMAIL_PROVIDER=smtp` is what makes the Resend keys optional.

> **Note:** Set `NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN` in `docker/.env.selfhost` to your own email domain (with the leading `@`) before you sign up, if you want platform-admin access. Every entry needs that leading `@`, otherwise a lookalike domain like `notexample.com` would satisfy a bare `example.com`.

### Why the dashboard isn't in the compose file

The Next.js app reads a single `NEXT_PUBLIC_SUPABASE_URL` that serves both the browser and the server. On a localhost install those two need different host names from inside a container. The browser needs `127.0.0.1`, and inside a container `127.0.0.1` means the container itself, so no single value satisfies both.

On a real deployment, where Supabase answers on a DNS name that both the browser and the container resolve, that constraint disappears and the dashboard containerizes normally. The localhost path sidesteps it by keeping the dashboard on the host, where Supabase already runs.

## Configuration

`docker/selfhost-up.sh` generates `docker/.env.selfhost` for you, and `docker/.env.selfhost.example` documents every variable with placeholders. If you'd rather write it by hand:

```sh
cp docker/.env.selfhost.example docker/.env.selfhost
# fill in the values, then:
docker compose -f docker/compose.yml --env-file docker/.env.selfhost up -d
```

The values you set yourself:

```sh
# From `supabase status -o json` in apps/tenant-dashboard. Note the host name:
# the gateway crosses the container boundary to reach Supabase on the host.
SUPABASE_API_BASE_URL=http://host.docker.internal:55501
SUPABASE_SECRET_KEY=sb_secret_…
SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
SUPABASE_JWT_SECRET=…

# The same instance as seen from the HOST — the dashboard start commands below
# source these two (DB_URL from `supabase status`; the API url is the same as
# above with 127.0.0.1 in place of host.docker.internal).
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55502/postgres
SUPABASE_API_URL_FROM_HOST=http://127.0.0.1:55501

# Generate each of these: openssl rand -base64 32
CLICKHOUSE_PASSWORD=…
CLICKHOUSE_READ_PASSWORD=…
BLOB_S3_SECRET_ACCESS_KEY=…
SELF_HOST_GATEWAY_SECRET=…
API_KEY_PEPPER=…
TOKEN_ENCRYPTION_KEY=…
OAUTH_STATE_SECRET=…

CLICKHOUSE_READ_USER=analytics_reader
BLOB_S3_ACCESS_KEY_ID=minioadmin
BLOB_S3_BUCKET=trace-blobs
GATEWAY_PORT=9001
CLICKHOUSE_PORT=8123
MINIO_API_PORT=9300
MINIO_CONSOLE_PORT=9301
NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN=@example.com
FROM_EMAIL=outerlayer@example.com
```

Two of these have to match across services, and a mismatch fails in ways that are hard to read:

- **`API_KEY_PEPPER`** needs to be byte-identical in the dashboard and the gateway. The dashboard mints API keys by hashing them with this pepper and the gateway verifies against it, so a mismatch rejects every key the UI hands out.
- **`CLICKHOUSE_READ_USER`** and **`CLICKHOUSE_READ_PASSWORD`** are the row-policy read identity. Tenant-scoped reads authenticate as this user, and the row policies that isolate one tenant's traces from those of another attach to its role. Without it, reads run as the writer identity, which no row policy covers, leaving app-layer `WHERE` clauses as the only isolation.

### Choose an API-key posture

The self-host gateway has no key store, so you tell it how programmatic callers prove they may act as a tenant. It refuses to boot until you pick one:

#### Shared secret (recommended)

```sh
SELF_HOST_GATEWAY_SECRET=$(openssl rand -base64 32)
```

Clients send this value as their API key in `Authorization: Bearer <secret>`, so the SDKs and CLI work unchanged. The comparison runs in constant time, and the gateway rejects a wrong secret before it looks up the app. Use at least 32 characters, since a reachable service accepts this as a bearer token and a short one is guessable online.
#### Perimeter trust

```sh
SELF_HOST_TRUST_PERIMETER=true
```

The gateway verifies nothing on programmatic requests. Choose this **only** when the gateway sits on a private network, behind a VPN, or behind ingress that authenticates callers itself. Anyone who reaches the port and knows an app id has full access to that tenant, including spending your LLM provider credits. The gateway prints a warning on every boot in this mode.

Dashboard and human access uses a signed Supabase JWT, and both modes validate it fully: signature, algorithm allowlist, active membership, and app-to-tenant ownership. Neither variable affects it.

## Point your SDKs at your instance

Set the base URL to your gateway and use your gateway secret as the API key:

```sh
OUTERLAYER_URL=http://localhost:9001
OUTERLAYER_API_KEY=<your SELF_HOST_GATEWAY_SECRET>
OUTERLAYER_APP_ID=<the app id from the dashboard>
```

Those three variables (`OUTERLAYER_URL`, `OUTERLAYER_API_KEY`, `OUTERLAYER_APP_ID`) are everything the CLI needs.

## Operating the stack

```sh
# logs
docker compose -f docker/compose.yml --env-file docker/.env.selfhost logs -f gateway

# stop, keeping data
docker compose -f docker/compose.yml --env-file docker/.env.selfhost down

# stop and delete the ClickHouse and MinIO volumes
docker compose -f docker/compose.yml --env-file docker/.env.selfhost down -v

# stop the host-side services
cd apps/tenant-dashboard && npx supabase stop
```

The gateway's health endpoint is `http://localhost:9001/health`, and MinIO's console is at `http://localhost:9301`.

## Upgrading

There's no upgrade automation. Pull, rebuild, and re-run the migrations:

```sh
git pull
./docker/selfhost-up.sh
```

The script re-applies both the Postgres and the ClickHouse migrations and rebuilds the gateway image. Migrations run forward only, with no down path, so **snapshot your Postgres and ClickHouse volumes before you upgrade** if the data matters.

## How the hosted service differs

The hosted service runs the same gateway and the same dashboard, so prompts, evals, and traces behave identically. The differences are operational:

- **API keys** are per-consumer and independently revocable, rather than one shared secret.
- **Rate limiting, high availability, and backups** come managed.
- **Builds and managed deployments** work. Self-host has no build path.
- **Enterprise features** (custom roles, app-level roles, SSO, audit log) stay license-gated on self-host. Non-enterprise features like alerts and GitLab linking turn on once `OUTERLAYER_SELF_HOSTED=true` is present, which the stack does for you.
- **Billing** is absent entirely on self-host, and no quota applies.

## Troubleshooting

**The gateway exits immediately on boot.** It validates its whole environment at start and prints every problem at once. Run `docker compose -f docker/compose.yml --env-file docker/.env.selfhost logs gateway` to see the list. The most common cause is that neither `SELF_HOST_GATEWAY_SECRET` nor `SELF_HOST_TRUST_PERIMETER` is present.

**The gateway can't reach Supabase.** `SUPABASE_API_BASE_URL` needs `host.docker.internal`, not `127.0.0.1`. Inside the container, the local address points at the container.

**A container fails to bind its port.** ClickHouse (`8123`), MinIO (`9300` and `9301`), and the gateway (`9001`) all publish to the host. If you already run something on one of them, and a ClickHouse from another project is the common case, change `CLICKHOUSE_PORT`, `MINIO_API_PORT`, `MINIO_CONSOLE_PORT`, or `GATEWAY_PORT` in `docker/.env.selfhost`. Only the published side moves, and the compose network keeps talking on the internal ports.

**The first trace query takes 30 seconds.** ClickHouse compiles and caches query pipelines on first use against fresh tables. Later queries settle to a few seconds. That's a cold-start cost rather than a broken setting.

**The dashboard rejects every API key it mints.** `API_KEY_PEPPER` differs between the dashboard and the gateway. Both read it from `docker/.env.selfhost`, so this usually means the dashboard started without sourcing that file.

**Traces reach the gateway but never appear in the dashboard.** Either the ClickHouse migrations didn't run, or the dashboard's `CLICKHOUSE_HOST` points somewhere else. Re-run `./docker/selfhost-up.sh`.

For the gateway runtime's own reference, covering every variable it reads, the connection-broker model, and the full caveat list, see `apps/gateway-node/README.md` in the repository.
