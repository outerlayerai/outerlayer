# AGENTS.md

## Mission

This repository builds a context layer for AI coding agents. Agents that operate here should read this file before touching anything else.

## Setup

Run the following to get a working environment:

```bash
npm install
npm run build
npm run test
```

Environment variables live in `.env.local`. Copy from the example:

```bash
cp .env.example .env.local
```

## Project layout

- `src/` — application source
  - `src/core/` — domain logic, no framework imports
  - `src/api/` — HTTP handlers
  - `src/ui/` — React components
- `tests/` — unit and integration tests
- `docs/` — long-form documentation

## Conventions

1. Prefer named exports over default exports.
2. Every public function needs a doc comment.
3. Tests live next to the code they cover, as `*.test.ts`.
4. Run `npm run lint` before committing.

## Database

The schema is the source of truth. Migrations are generated, never hand-written. Typical flow:

1. Edit `schema.sql`.
2. Run `npm run db:diff` to generate a migration.
3. Review the generated SQL.
4. Run `npm run db:migrate` to apply it locally.

## API surface

| Endpoint | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/api/context` | GET | session | Lists context files for the current app |
| `/api/context/:id` | GET | session | Returns raw content + metadata |
| `/api/context/:id` | PUT | session | Saves edited content, creates a commit |
| `/api/context/:id` | DELETE | session | Soft-deletes, keeps git history |
| `/api/context/sync` | POST | service | Triggers a mirror resync from git |

## Testing

Unit tests use Vitest. Integration tests spin up a local Supabase instance and a local git remote. Run everything with:

```bash
npm run test:unit
npm run test:integration
```

A regression test accompanies every bug fix, in the same commit as the fix.

## Error handling

Errors that cross a service boundary should be typed. Do not throw raw strings. Prefer a small result type over exceptions for expected failure modes, and reserve exceptions for truly unexpected conditions (a database connection dropping mid-transaction, for example).

## Deployment

Deployments are triggered by pushing to `main`. The pipeline:

1. Builds all packages with Turborepo.
2. Runs the full test suite.
3. Deploys the gateway to Cloudflare Workers.
4. Deploys the dashboard to Vercel.
5. Runs a smoke test against the deployed environment.

## Style notes

Keep functions short. If a function needs a comment to explain *what* it does, it probably needs to be split into smaller, better-named functions. Comments should explain *why*, not *what*.

## Getting help

Open an issue with a minimal reproduction. Include:

- Node version
- OS
- Exact command that failed
- Full error output

## Glossary

- **Mirror**: a read-only copy of a git repo's content, kept in sync via webhooks.
- **Context file**: any markdown file under a tracked directory (`AGENTS.md`, `SKILL.md`, etc.) that agents consume at runtime.
- **Demolition**: the process of tearing down and rebuilding a mirror from scratch when it drifts.
