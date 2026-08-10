# OuterLayer — Agent Instructions

Rules for coding agents working in this repo. Human-facing docs live in
[README.md](README.md) (what this is) and [CONTRIBUTING.md](CONTRIBUTING.md)
(environment setup, PR process) — read those for anything not covered here.
This file carries only the conventions an agent can't derive from the code.

## Repo shape

Yarn 4 workspaces + Turborepo: `apps/*` + `packages/*`. The big app is
`apps/tenant-dashboard` (Next.js dashboard) — see its architecture contract
below before editing anything there.

- `apps/gateway` / `apps/gateway-node` — Hono gateway (Cloudflare Worker + Node entrypoints)
- `apps/worker` — machine-side runner; deliberately has no `@repo/*` runtime deps — keep it that way
- `packages/*` — shared cores, contracts (`api-schemas`, `api-types`, `db-types`), tooling.
  Apps consume packages; packages never import from apps.
- `apps/tenant-dashboard/supabase/schemas/` — declarative DB source of truth (migrations derive from it)
- `acceptance/` — acceptance criteria bound to tests by CI

## Commands

- `yarn ci:unit` / `yarn ci:lint` — canonical test + lint entry points (Turborepo-cached)
- `scripts/git/pre-push-checks.mjs` — the pre-push hook; runs the full local
  gate suite (typecheck, lint, knip, ratchets, codegen drift, unit tests)

**Never bypass git hooks.** No `--no-verify`, `-n`, `HUSKY=0`, or deleting
hook files — even when a hook fails. A failing hook means the code has a
problem; fix the typecheck/lint/test error it reports. Bypassing it just
moves the failure to CI and makes the PR red.

## CI-only gates

The pre-push hook covers typecheck, lint, knip, unit tests, and codegen
drift. The gates below run **only in CI** — a locally-green push can still
fail them. When your change touches their domain, run the local check before
pushing:

- **Coverage floors** — `node scripts/ci/check-coverage-floors.mjs` (after a
  coverage run). Per-workspace ratcheted floors in
  `scripts/ci/coverage-floors.json`. Deleting well-tested code can sink a
  workspace below its floor — rebaseline the floor in the same PR.
- **Patch mutation** — the mutation score of changed code must clear its
  threshold; opt in locally with `PREPUSH_RUN_MUTATION=1` on the pre-push
  gate.
- **Type-suppression floors** —
  `node scripts/ci/check-type-suppression-floors.mjs`; per-workspace counts
  of `as any` / `as unknown as` / `@ts-ignore` / `@ts-expect-error` may not
  exceed `scripts/ci/type-suppression-floors.json`.
- **Unused-exports floor** —
  `node scripts/ci/check-unused-exports-floor.mjs`. The floor is
  **two-way**: removing exports without updating
  `scripts/ci/unused-exports-floors.json` fails CI just like adding them.
- **Acceptance coverage** —
  `node scripts/ci/check-acceptance-coverage.mjs`; every `AC-…` id needs a
  proving test, with the id in a comment above the test (see Code comments).
- **Migration lint (Squawk)** —
  `npx squawk-cli@2.58.0 <changed .sql files>`; warnings fail the job
  (`ban-drop-table`, `changing-column-type`, NOT NULL without default).
  Structure migrations to avoid the flagged patterns rather than expecting
  warnings to pass.
- **Migration versions** — `node scripts/ci/check-migration-versions.mjs`
  (timestamp collisions and ordering).
- **License map** — `node scripts/ci/check-license-map.mjs`; every
  directory's license must match `LICENSING.md` — don't vendor
  differently-licensed files without updating it.
- **Secret scan + quarantine staleness** — gitleaks, and
  `node scripts/ci/check-quarantine-staleness.mjs` for stale quarantined
  tests.

## tenant-dashboard architecture

The machine-checked source of truth is
`apps/tenant-dashboard/eslint.config.mjs` — when in doubt, the lint rules
win. Stack: TypeScript (strict), Next.js App Router, React 19, MUI 9,
Supabase (auth + Postgres with RLS), ClickHouse (analytics/traces), Zod,
SWR, react-hook-form. MUI 9 note: on `Stack`, only `direction`/`spacing`
are first-class props — put `justifyContent`/`alignItems`/etc. in `sx`.

Where code goes (paths relative to `apps/tenant-dashboard/`):

- New code goes in `src/features/<domain>/` slices or the `src/lib` tiers
  (`action-kit`, `system`, `adapters`, `app-shell`, `analytics`, `api`,
  `tenant`). Enterprise slices live in `ee/features/` (`@ee/features/*`).
- `src/sections`, `src/auth`, and the root `supabase*Client.ts` wrappers
  (`src/supabaseAdminClient.ts` etc.) are **legacy and shrinking** — do not
  extend them. New-world imports of them are lint-banned except through
  `src/lib/adapters/` (server) / `src/lib/app-shell/` (client).

Invariants:

- **Features are leaves**: a feature never imports another feature.
  Composition happens above the feature layer.
- The service-role (RLS-bypassing) Supabase client is constructed **only** in
  `src/lib/system/`; the RLS-scoped request client only in
  `features/*/service.ts` + `lib/system`. Everything else receives `ctx.db`.
- Every export of a `"use server"` module in the new world is wrapped in
  `authorizedAction(...)` or `preTenantAction(...)` (`src/lib/action-kit/`).
- Tenancy comes from the resolved request tenant (the URL org segment via
  middleware) — **never** `app_metadata.tenant_id` or an unscoped server
  client.
- Slice `service.ts` is framework-free: no React, no `next/*`, no UI imports.
  Server actions and route handlers stay thin and delegate to services.
- Use path aliases (`@/…`) over deep relative imports.

## Database changes

- Operate on **local** Supabase only — never a linked cloud project.
- `apps/tenant-dashboard/supabase/schemas/` is the source of truth. Update the schema first, then
  derive the migration; keep both in sync in the same change.
- Permission enums are granular (`read`/`write`/`update`/`delete`) — never a
  catch-all `manage`. Follow the existing pattern in `01-types.sql`.
- To check local migration state, query the database directly
  (`docker exec -i supabase_db_tenant-dashboard psql -U postgres -c "…"`) —
  `supabase migration list`'s "Remote" column only tracks linked cloud
  projects, not local state.

Table standards (every new table):

- Audit columns `created_at`, `updated_at`, `created_by`, `updated_by`;
  tables with `updated_at` also get the `on_update_set_updated_columns`
  trigger.
- RLS policies go through `authorize()` (permission-based) — never direct
  role checks.
- Foreign keys to `profile.id` use `ON DELETE SET NULL`.

## Code comments

A comment earns its place by stating a present-tense fact the code can't
express — a **why**, a **constraint**, a **gotcha**, or an **invariant**.
Everything else is noise. Never put in comments, test titles, or user-facing
strings (e.g. OpenAPI descriptions):

- **Change-narration** — "previously…", "now uses…", "renamed from…". Git
  history holds what changed; comments state only why the current code is the
  way it is, in present tense.
- **Issue/PR/bug numbers** — restate the substance instead of linking to it.
- **Project-phase codenames or spec-section references** — describe the
  behavior instead. One exception: acceptance-criterion ids (`AC-…`) may
  appear in a **comment above a test** (never in the test title) because
  `ci:acceptance-coverage` binds criteria to tests by finding the id.
- **Teammate names or personal info.**

Keep (and don't weaken when editing nearby) comments documenting constraints,
invariants, footguns, security posture, and genuine rationale.

## Test quality

Before adding a test, ask: **"what's the smallest change to production code
that would still pass this test?"** If the answer is "almost anything", the
test checks wiring, not behavior — strengthen or delete it.

Avoid as the only assertion: `toBeDefined()`, `toHaveBeenCalled()` without
`.toHaveBeenCalledWith(...)`, `toBeTruthy()`/`toBeFalsy()`,
`toMatchObject` where `toEqual` would work, bare `.not.toThrow()`.

Prefer: `toEqual`/`toStrictEqual` on exact shapes, `toHaveBeenCalledWith`
with parametric matchers, positional `toEqual` on arrays (catches reorders
and drops), negative assertions that pin out injection vectors.

Don't pin brittle implementation details (exact log strings, internal call
counts) — assert the contract. Mutation testing runs per package
(`yarn test:mutate`, Stryker); score floors in
`scripts/ci/mutation-score-floors.json` are ratcheted in CI — bump the floor
when you improve a score.

## Removing a feature

Removing a feature means removing its whole footprint, not just its UI.
Grep the feature's identifiers with `rg --hidden` and sweep:

- env schema (tenant-dashboard `src/env.ts`, gateway `EnvSchema`),
  `apps/gateway/wrangler.toml`, `.env.example`, turbo `passThroughEnv`, CI
  placeholder env values
- i18n namespaces (`src/locales/langs/`), `src/routes/paths.ts` URL builders
  and their tests, `next.config.mjs` redirects
- workflow paths-filters, cache `hashFiles()` globs, schemathesis tags/paths
- `knip.json` entries, `scripts/ci/*-floors.json` buckets, eslint exemptions
- test fixtures and env mocks (plain object mocks don't type-error on removed
  keys), README/docs sections, `public/` assets

An env var that stays schema-required after its feature is deleted breaks
self-host boots for nothing — leftover *requirements* are bugs, not clutter.

## Commits and PRs

- Branch naming: `{chore|feature|bug}/{app|package|all}/description`.
- No AI co-author trailers (`Co-Authored-By: …`) or "generated with" lines in
  commit messages.
- Keep PRs scoped; new features and schema changes should reference an issue
  (see CONTRIBUTING.md).
