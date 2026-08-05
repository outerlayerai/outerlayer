# MSW and Supabase Test Standard

This repo treats Supabase as an HTTP boundary in app and route tests.

## Default rule

- Use MSW for tests that exercise code crossing into Supabase HTTP APIs.
- Do not add new module-level Supabase mocks like `vi.mock('@supabase/supabase-js')`,
  `vi.mock('@supabase/ssr')`, `vi.mock('@/supabaseServerClient')`, or
  `vi.mock('@/supabaseAdminClient')` in app test suites.
- Keep `onUnhandledRequest: 'error'` enabled in shared MSW setup so missing handlers
  fail fast.

## Allowed exceptions

- Narrow service-layer unit tests may still use spies or injected fake clients when the
  test is explicitly about client construction or query-shape plumbing, not about the
  HTTP boundary itself.

Exceptions must stay explicit and scoped. The repo-level guard blocks module-level
Supabase mocks in the currently enrolled workspaces.

## Shared pattern

1. Add a shared `msw-server.ts` using `setupServer(...handlers)`.
2. Start it in the workspace test setup file with `beforeAll(server.listen({ onUnhandledRequest: 'error' }))`.
3. Put Supabase handlers under `src/test-helpers/msw-handlers/`.
4. Expose explicit `seed*State()` and `reset*State()` helpers so tests declare input
   data instead of mocking fluent query-builder chains.
5. Use narrower seams for lower-level unit tests:
   import a wrapper module and `vi.spyOn(...)` it, or inject a fake client directly.

## Rollout status

- `apps/tenant-dashboard`: route/action/component Supabase-boundary tests migrated and enforced.
- `apps/gateway`: boundary tests and OpenAPI/spec tests migrated off module-level Supabase mocks and enforced.
