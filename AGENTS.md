# OuterLayer — Agent Instructions

Rules for coding agents working in this repo. Human-facing docs live in
[README.md](README.md) (what this is) and [CONTRIBUTING.md](CONTRIBUTING.md)
(environment setup, PR process) — read those for anything not covered here.
This file carries only the conventions an agent can't derive from the code.

## Repo shape

Yarn 4 workspaces + Turborepo: `apps/*` + `packages/*`. The big app is
`apps/tenant-dashboard` (Next.js dashboard) — it has its own `AGENTS.md` with
the architecture contract; read it before editing anything there.

- `apps/gateway` / `apps/gateway-node` — Hono gateway (Cloudflare Worker + Node entrypoints)
- `apps/worker` — machine-side runner; deliberately has no `@repo/*` runtime deps — keep it that way
- `packages/*` — shared cores, contracts (`api-schemas`, `api-types`, `db-types`), tooling
- `supabase/schemas/` — declarative DB source of truth (migrations derive from it)
- `acceptance/` — acceptance criteria bound to tests by CI

## Commands

- `yarn ci:unit` / `yarn ci:lint` — canonical test + lint entry points (Turborepo-cached)
- `scripts/git/pre-push-checks.mjs` — the pre-push hook; runs the full local
  gate suite (typecheck, lint, knip, ratchets, codegen drift, unit tests)

**Never bypass git hooks.** No `--no-verify`, `-n`, `HUSKY=0`, or deleting
hook files — even when a hook fails. A failing hook means the code has a
problem; fix the typecheck/lint/test error it reports. Bypassing it just
moves the failure to CI and makes the PR red.

## Database changes

- Operate on **local** Supabase only — never a linked cloud project.
- `supabase/schemas/` is the source of truth. Update the schema first, then
  derive the migration; keep both in sync in the same change.
- Permission enums are granular (`read`/`write`/`update`/`delete`) — never a
  catch-all `manage`. Follow the existing pattern in `01-types.sql`.
- To check local migration state, query the database directly
  (`docker exec -i supabase_db_tenant-dashboard psql -U postgres -c "…"`) —
  `supabase migration list`'s "Remote" column only tracks linked cloud
  projects, not local state.

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

- env schema (`env.ts`, gateway `EnvSchema`), `wrangler.toml`,
  `.env.example`, turbo `passThroughEnv`, CI placeholder env values
- i18n namespaces (`src/locales/langs/`), `paths.ts` URL builders and their
  tests, `next.config.mjs` redirects
- workflow paths-filters, cache `hashFiles()` globs, schemathesis tags/paths
- `knip.json` entries, `scripts/ci/*-floors.json` buckets, eslint exemptions
- test fixtures and env mocks (plain object mocks don't type-error on removed
  keys), README/docs sections, `public/` assets

An env var that stays schema-required after its feature is deleted breaks
self-host boots for nothing — leftover *requirements* are bugs, not clutter.

## Commits and PRs

- No AI co-author trailers (`Co-Authored-By: …`) or "generated with" lines in
  commit messages.
- Keep PRs scoped; new features and schema changes should reference an issue
  (see CONTRIBUTING.md).
