# gateway-node

Self-host Node entrypoint for the OuterLayer gateway.

## Overview

For the turnkey path — one script that brings this gateway up alongside
ClickHouse, MinIO, Supabase, and the dashboard — see `docker/README.md` and
`docker/compose.yml`. This README is the runtime reference underneath it: every
variable the process reads, and every caveat that survives however it is
started.

`gateway-node` runs the exact same gateway as the hosted Cloudflare Worker —
the `@repo/gateway-core` Hono app — but on a plain Node.js process instead of
Workers. It serves HTTP via [`@hono/node-server`](https://github.com/honojs/node-server)
and runs the gateway's scheduled jobs with a `node-cron` scheduler. Request and
cron serving are stateless; all state lives in Postgres, ClickHouse, and object
storage. Each entrypoint injects its own runtime adapters, so no Cloudflare
account, Unkey, or Stripe is involved.

## Prerequisites

- **Node.js 22 or later** — the repo's engine floor (Node 20 reached
  end-of-life in April 2026); the bundle is emitted with a `node22` syntax
  target.
- **Postgres** — provided by Supabase (the gateway talks to it via the Supabase
  service-role client).
- **ClickHouse** — trace + score analytics store.
- **S3-compatible object storage** — for oversized span payloads (the blob
  offload the hosted runtime does with Cloudflare R2). A local MinIO is bundled:

  ```sh
  cd apps/gateway-node/minio && docker compose up -d
  ```

  It listens on `http://127.0.0.1:9300` (S3 API) and auto-creates the
  `trace-blobs` bucket.

## Required environment variables

The boot gate (`src/env.ts`) refuses to start unless these are set. Hosted-only
secrets (Unkey, Stripe, Cloudflare, GitHub/GitLab/Fly) are **not** required.

- `BLOB_STORAGE_BACKEND` — **must be `s3`** (the Node runtime has no R2).
- `BLOB_S3_ENDPOINT`, `BLOB_S3_ACCESS_KEY_ID`, `BLOB_S3_SECRET_ACCESS_KEY`,
  `BLOB_S3_BUCKET` — S3 connection (all non-empty).
- `SUPABASE_API_BASE_URL`, `SUPABASE_SECRET_KEY` (`sb_secret_…`),
  `SUPABASE_JWT_SECRET`, `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) —
  Postgres + auth. `SUPABASE_JWT_SECRET` stays required — the gateway mints
  short-lived tenant-scoped JWTs with it. Legacy-named `SUPABASE_SERVICE_ROLE_KEY`
  / `SUPABASE_ANON_KEY` secrets are still accepted during the key migration.
- `CLICKHOUSE_HOST`, `CLICKHOUSE_PASSWORD` — analytics store (password may be an
  empty string for a no-auth ClickHouse, but the variable must be present).
- **One of** `SELF_HOST_GATEWAY_SECRET` or `SELF_HOST_TRUST_PERIMETER=true` — how
  programmatic callers are authenticated. See below; there is no default.

### API-key auth: pick a posture

This runtime has no key store. Programmatic (API-key) requests resolve their
tenant from the app id in your Supabase, so **something** has to establish that
the caller is allowed to act as that tenant. The boot gate refuses to start until
you say which:

```sh
# Option A (recommended) — the gateway verifies a shared secret.
SELF_HOST_GATEWAY_SECRET=$(openssl rand -base64 32)
```

Clients send that value as their API key — `Authorization: Bearer <secret>` —
so the SDKs and CLI work unchanged with no client-side configuration beyond the
key they already set. The comparison is constant-time, and a wrong secret is
rejected before the app is looked up. Minimum 32 characters: this value is
accepted as an API key by a reachable service, so a short one is
online-guessable.

```sh
# Option B — you authenticate callers at the network layer, so the gateway doesn't.
SELF_HOST_TRUST_PERIMETER=true
```

Choose B **only** if the gateway is on a private network, behind a VPN, or behind
ingress that authenticates callers itself. With B, anyone who can reach the port
and knows an app id has full access to that tenant — including running prompts
that spend your LLM provider credits. The gateway prints a warning on every boot
in this mode.

Human/dashboard access (`Authorization: Bearer <supabase-jwt>`) is fully
tenant-validated in both modes: signature, algorithm allowlist, active
membership, and app→tenant ownership. Neither variable affects it.

Rotating the secret restarts the gateway (it is read from the environment); there
is no per-client revocation, which is the main reason to prefer Cloud if you need
independently revocable keys per consumer.

### Entitlements: set `OUTERLAYER_SELF_HOSTED=true`

Not enforced by the boot gate (the gateway starts without it), but a self-host
deploy should always set it — the exact lowercase string `true`; `1`/`TRUE`
deliberately don't count, so a typo can never flip a Cloud worker. It switches
every gateway entitlement surface to self-host resolution: numeric quotas
(API keys, apps, environments per app, monthly span ingest) become unlimited
and non-EE product features (alerts, GitLab linking) are on, without ever
reading billing. Left unset, the gateway resolves tenants against the Cloud
tier matrix — and since a self-host database has no billing rows, every tenant
falls back to hobby (20k spans/month ingest cap, alerts/GitLab denied with
402s). The Cloud worker never sets this variable. EE surfaces (custom roles,
app-level roles, SSO, audit log) are separate: they stay license-gated in the
dashboard — see `ee/README.md`.

Example `.env`, using the bundled MinIO (`./minio/docker-compose.yml`):

```sh
BLOB_STORAGE_BACKEND=s3
BLOB_S3_ENDPOINT=http://127.0.0.1:9300
BLOB_S3_ACCESS_KEY_ID=minioadmin
BLOB_S3_SECRET_ACCESS_KEY=minioadmin
BLOB_S3_BUCKET=trace-blobs

SUPABASE_API_BASE_URL=http://127.0.0.1:54421
SUPABASE_SECRET_KEY=<sb_secret_…>
SUPABASE_JWT_SECRET=<jwt-secret>
SUPABASE_PUBLISHABLE_KEY=<sb_publishable_…>

CLICKHOUSE_HOST=http://127.0.0.1:8123
CLICKHOUSE_PASSWORD=dev_password

OUTERLAYER_SELF_HOSTED=true
```

## Running

The app is bundled into a single ESM file with esbuild (like the Worker's
wrangler build) rather than run from the TS graph directly: several workspace
dependencies are published as CommonJS with dynamic exports that Node's ESM
loader can't resolve unbundled. **Build the workspace packages first** (they
ship `dist/`, consumed here as CJS):

```sh
# once, from the repo root
turbo build --filter='{./packages/*}'
```

Then, with the environment above exported (or in a `.env` your shell sources):

```sh
# development (esbuild watch)
yarn workspace gateway-node dev

# production build + run (listens on $PORT, default 9001)
yarn workspace gateway-node build      # → dist/index.mjs
PORT=9001 yarn workspace gateway-node start
```

Verify it's up: `curl http://127.0.0.1:9001/health` → `{"status":"healthy",…}`.

### In Docker

`Dockerfile` here builds the same bundle in a container. The build context is the
**repo root**, not this directory, because the bundle pulls the `dist/` of a dozen
workspace packages:

```sh
# from the repo root
docker build -f apps/gateway-node/Dockerfile -t outerlayer/gateway-node .
```

The build stage installs the whole workspace; the runtime stage carries only
`dist/index.mjs` on a bare Node image, since esbuild inlines the entire graph.
`docker/compose.yml` builds this image and supplies the environment above.

On `SIGTERM`/`SIGINT` the process stops the cron, closes broker WebSockets, stops
accepting connections, and drains in-flight requests within a 10s budget before
exiting.

## MCP server

`POST /v1/mcp` serves the same JSON-RPC 2.0 MCP endpoint as the hosted
gateway — `@repo/gateway-core`'s dispatcher (`packages/gateway-core/src/openapi/mcp/`)
is runtime-agnostic, so this Node entrypoint mounts it identically: the full
ten-tool catalog (`list_topics`, `list_sessions`, `get_session`,
`get_model_costs`, `get_fleet_overview`, `list_context_changes`,
`compare_windows`, `get_breakdown`, `get_trends`, `get_pr_outcomes`) plus the
`outerlayer://guide` resource; `GET`/`DELETE` answer `405`.

`SelfHostAuthResolver` (the auth adapter this runtime composes) resolves the
tenant from an app id there is no key store to carry, so every `/v1/mcp`
request needs `X-Outerlayer-App-Id` alongside the bearer token — omitting it
401s with "Missing app id" regardless of which posture below secures the
bearer side.

Point a client at it with the CLI:

```sh
npx outerlayer mcp install --url http://127.0.0.1:9001/v1/mcp --app-id <your-app-id>
```

This writes an `mcpServers` entry to `.mcp.json` referencing
`${OUTERLAYER_API_KEY}` and the app id you passed as `X-Outerlayer-App-Id` —
set `OUTERLAYER_API_KEY` to whichever key your posture above authenticates
with (`SELF_HOST_GATEWAY_SECRET`'s value under Option A, or any non-empty
bearer value under Option B's trust-perimeter mode; either way the value
goes in your shell/client environment, never into `.mcp.json`).

Endpoints/tools behave identically to hosted, with two differences documented
here rather than surfaced as a runtime quirk: rate limiting is a no-op (see
"Known limitations" below — the self-host runtime enforces no request rate
limits, MCP included), and the OAuth 2.1 connector flow (dynamic client
registration, `/oauth/consent`) requires Supabase-backed auth and is
unavailable when `SELF_HOST_TRUST_PERIMETER=true` — that mode has no user
session to bind a grant to. Use `SELF_HOST_GATEWAY_SECRET` (or a hosted key)
with a client that supports a static bearer token instead.

## Connection broker (dispatch / observe)

The gateway's stateful connection broker — job dispatch to a deployed agent and
observe-stream fan-out — runs **in-process** on Node. On Cloudflare each
`(app, env)` connection is a Durable Object; here an in-memory registry keeps
the same broker actor alive, one per `(app, env)`, and the HTTP server's
`upgrade` event completes plain `ws` handshakes (see `src/connections.ts`). The
`/internal/dispatch/:appId` and `/internal/observe/:appId` routes are therefore
live on self-host.

- **Dispatch needs a deployed machine.** A dispatch reaches the agent over HTTP
  using the env's `environment.fly_machine_url` and the Vault secret
  `dispatch_secret_<envId>` (sent as `X-Outerlayer-Dispatch-Secret`). Until
  something writes those, dispatch returns `503 app_not_connected`. No
  git-triggered or self-host build path produces them: nothing can start a
  build, so an env dispatches only if it already carries a machine from an
  earlier deployment.
- **Single process only.** Observer subscriptions and job-replay buffers live in
  this process's memory. Running multiple replicas requires sticky routing so a
  job's dispatch and its observers land on the same instance; there is no shared
  broker state across replicas.

## Known limitations / caveats

1. **API-key auth is one shared secret, or none.** There is no key store, so
   every programmatic caller presents the same `SELF_HOST_GATEWAY_SECRET` — there
   are no per-consumer keys and no per-consumer revocation; rotating means
   restarting the gateway. With `SELF_HOST_TRUST_PERIMETER=true` instead, no
   secret is validated at all and the network perimeter is the only boundary.
   See "API-key auth: pick a posture" above. Human/dashboard (JWT) access is
   fully tenant-validated either way.
2. **No rate limiting.** The self-host runtime does not enforce request rate
   limits.
3. **No build path.** Nothing on self-host (or hosted) can start a build. An
   env dispatches only if `environment.fly_machine_url` is already set from an
   earlier deployment; otherwise dispatch returns `503 app_not_connected`.
