# tenant-dashboard — Agent Instructions

Architecture contract for the Next.js dashboard. The machine-checked source
of truth is `eslint.config.mjs` in this directory — when in doubt, the lint
rules win. Repo-wide rules live in the root `AGENTS.md`.

## Stack notes

TypeScript (strict), Next.js App Router, React 19, MUI 9, Supabase (auth +
Postgres with RLS), ClickHouse (analytics/traces), Zod, SWR, react-hook-form.

MUI 9: on `Stack`, only `direction`/`spacing` are first-class props — put
`justifyContent`/`alignItems`/etc. in `sx`.

## Where code goes

- New code goes in `src/features/<domain>/` slices or the `src/lib` tiers
  (`action-kit`, `system`, `adapters`, `app-shell`, `analytics`, `api`,
  `tenant`). Enterprise slices live in `ee/features/` (`@ee/features/*`).
- `src/sections`, `src/services`, `src/auth`, and the root
  `supabase*Client.ts` wrappers are **legacy and shrinking** — do not extend
  them. New-world imports of them are lint-banned except through
  `src/lib/adapters/` (server) / `src/lib/app-shell/` (client).

## Invariants

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
