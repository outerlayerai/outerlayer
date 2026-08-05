# Contributing

Thanks for considering a contribution. This is a Yarn 4 / Turborepo monorepo;
everything below runs from the repo root unless a step says otherwise.

## Before you start

- **Bug reports and small fixes** — open a PR directly.
- **New features, schema changes, or anything that alters an API contract** —
  open an issue first so we can agree on the shape before you build it.
- **Security vulnerabilities** — do *not* open an issue. See
  [SECURITY.md](SECURITY.md).

## Setup

You need Node 22 or newer and Docker running (local Supabase and ClickHouse are
containers). Yarn comes from the `packageManager` field — `corepack enable` is
enough.

### 1. Install

```bash
yarn                # Yarn 4, workspaces
```

### 2. Create the env files

Nothing is committed with real values, so every template has to be copied
before anything boots. Each destination is gitignored.

```bash
cp .env.example .env.local                                        # dev-server ports
cp apps/tenant-dashboard/.env.example apps/tenant-dashboard/.env.local
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars          # gateway (wrangler)
```

Two settings in `apps/tenant-dashboard/.env.local` are worth knowing about
before you start filling in the rest:

- **`BILLING_ENABLED=false`** — the sane default for contributors, and what the
  template ships. Billing is opt-*out*: leave it unset and it is on, which makes
  ten `STRIPE_*` variables required and fails validation until you have real
  Stripe credentials. With it off, Stripe customer provisioning is skipped and a
  mock billing service is wired in. The trade is that you cannot work on billing
  itself — plans, metering, and the checkout flow all run against the mock.
- **`SKIP_ENV_VALIDATION=true`** — the escape hatch. Env validation runs only in
  local development (it is already skipped in tests and on Vercel), so this turns
  off the one place that catches a bad config early. Useful when you are touching
  a slice that needs none of the missing variables. The trade is that a missing
  or malformed value stops being a startup error with a named variable and
  becomes a runtime failure somewhere inside a request.

The Supabase URL and keys in that file come from step 3.

### 3. Supabase — database and auth

```bash
cd apps/tenant-dashboard
npx supabase start
npx supabase status -o json     # copy API_URL, PUBLISHABLE_KEY, SECRET_KEY, JWT_SECRET
npx supabase migration up       # bring the local database up to date
```

Run `supabase start` from `apps/tenant-dashboard` — the project config lives
there. Paste the values it prints into `apps/tenant-dashboard/.env.local` and
`apps/gateway/.dev.vars`. See
[the Supabase local-development guide](https://supabase.com/docs/guides/cli/local-development#start-supabase-services)
for the container setup.

### 4. ClickHouse — analytics and traces

Only needed for the analytics, traces, and observability surfaces; the rest of
the dashboard runs without it.

```bash
cd apps/tenant-dashboard/clickhouse && docker compose up -d
cd .. && yarn clickhouse:migration:dev   # schema + the read/write role users
```

`yarn dev:analytics` starts the same container for you before running the apps.

### 5. Run

```bash
yarn dev            # the apps
yarn dev:analytics  # the apps + ClickHouse
yarn dev:full       # everything: ClickHouse, Supabase (incl. Studio and Inbucket), apps
```

**Work against local infrastructure only.** Never point a development branch at
a hosted Supabase or ClickHouse instance.

## Branches and commits

Branch names are `{type}/{short-description}` — e.g. `fix/gateway-mutation-shards`,
`feature/docker-clickhouse`.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
(`fix(gateway): …`, `refactor(db): …`). Nothing enforces this mechanically, so
match what `git log` shows.

## Checks

```bash
yarn ci:typecheck   # TypeScript, strict mode
yarn ci:lint        # ESLint
yarn ci:unit        # unit tests
yarn test           # full test run
```

The `pre-push` hook runs the same gates CI runs, so a clean push is usually a
green PR. **Do not bypass the hooks** (`--no-verify` and friends). If a gate
fails, fix the cause — a red gate locally is a red gate in CI, just later and
noisier.

Note for forks: most CI jobs run on paid runners scoped to this repository's
organization (`runs-on: blacksmith-*`), so workflows will sit queued forever
on a fork. Run the local gates above instead, and let CI run on the pull
request you open here.

## Database changes

`apps/tenant-dashboard/supabase/schemas/` is the source of truth. Change the schema file first, then
derive the migration from it — never hand-write a migration that the schemas
don't reflect. Both must land in the same PR.

Permission enums are granular (`read` / `write` / `update` / `delete`). There is
no `manage`.

## Tests

A test has to be able to fail for a reason. Before you open a PR, ask of each
new test: *what is the smallest change to production code that would still pass
this?* If the answer is "almost anything", the test is checking wiring rather
than behavior.

Prefer:

- `toEqual` / `toStrictEqual` on the actual return value over `toBeDefined()`
- `toHaveBeenCalledWith(...)` over `toHaveBeenCalled()`
- Positional `toEqual` on arrays — it catches reordering and off-by-one
- Negative assertions that pin an injection vector shut, e.g.
  `expect(query).not.toContain(rawUserValue)` for parameterized SQL

Don't pin brittle internals (exact log strings, incidental call counts). Those
break on refactors without catching bugs.

## Comments

A comment earns its place by stating something the code cannot: a *why*, a
constraint, a gotcha, an invariant. In the present tense.

Keep out: change narration ("previously…", "now uses…", "renamed from…") — git
history already holds that; issue or PR numbers, which are dead links to
readers outside the project; and internal codenames or spec references.

## Pull requests

- Keep a PR to one concern. Two unrelated fixes are two PRs.
- Describe what changes and why. If it fixes a bug, say how you know it's fixed.
- CI must be green. Reviewers will not chase a red build for you.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License


### Contribution grant

By submitting a contribution to this project, you grant Magu Studios, Inc. a
perpetual, irrevocable, worldwide, non-exclusive, royalty-free, transferable,
and sublicensable license under your copyright and any patent claims you own or
control that are necessarily infringed by your contribution, to use, reproduce,
modify, prepare derivative works of, publicly display, publicly perform,
distribute, and otherwise exploit your contribution, alone or as part of this
project.

That license expressly includes the right to distribute your contribution under
other license terms this project may adopt, including more permissive terms such
as the Apache License 2.0. You retain copyright in your contribution and remain
free to use it however you like elsewhere.

By submitting, you also represent that you wrote the contribution or otherwise
have the right to submit it under these terms.

If your contribution is to a directory named `ee`, the additional terms in
[`ee/LICENSE`](./ee/LICENSE) apply to it.

### What users receive

The grant above is what Outerlayer receives. What *users* of this repository
receive is set by the directory a contribution lands in, as mapped in
[LICENSING.md](LICENSING.md):

- Nearly all of the repository — the dashboard, gateway, apps, packages, and
  infra — is [Apache-2.0](LICENSE), so it is usable in open- and
  closed-source projects alike.
- Code under `ee/` is source-available under its own
  [enterprise license](ee/LICENSE), and contributions there are licensed under
  those terms.
