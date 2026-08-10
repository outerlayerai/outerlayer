---
name: writing-tests
description: Assertion-strength standards, the MSW-only Supabase mocking rule, and the test-related CI gates (weak-assertion check, mutation floors, patch mutation, coverage floors). Use when writing or modifying ANY test in the monorepo, when a test-related gate goes red in CI or pre-push (weak-test-assertions, patch-mutation, the Coverage Gate — including a coverage floor failing after code was deleted or moved, which needs a floor rebaseline), or when deciding how to mock a dependency in apps/tenant-dashboard.
license: Apache-2.0
---

# Writing Tests

Every new test must catch a specific bug class. Before merging a test, ask: **"What's the smallest change to production code that would still pass this test?"** If the answer is "almost anything," the test is testing wiring, not behavior — strengthen or delete. If the production code body could be replaced with `return {}` (or `return null`) and the test still passes, the test is weak.

## Assertion strength

`scripts/check-weak-test-assertions.mjs` enforces the floor mechanically (it runs in pre-push and CI); these are the patterns behind it.

**Avoid as the only assertion in a test:**

- `expect(x).toBeDefined()` — passes for almost anything; use `toEqual` / `toBe` with a concrete value
- `expect(mockFn).toHaveBeenCalled()` without `.toHaveBeenCalledWith(...)` — proves it ran, not what it ran with
- `toBeTruthy()` / `toBeFalsy()` — usually a precise `===` check would be stronger
- `toMatchObject` when `toEqual` would work — silently allows extra fields through
- `.not.toThrow()` alone — too loose; assert on the return value too

**Strong assertions:**

- `toEqual` / `toStrictEqual` for exact-shape match of return values
- `toHaveBeenCalledWith(...)` with parametric arg matchers (`expect.objectContaining`, `expect.any(Type)`)
- Positional `toEqual` on arrays/sequences (catches reorder, off-by-one, drops)
- Negative assertions that pin out injection vectors (e.g., `expect(query).not.toContain(rawValue)` for parameterized SQL)

**Rules of thumb:**

- Composite tests are fine when one positional `toEqual` covers multiple bug classes with one setup. Don't fragment for the sake of test count.
- Don't pin brittle implementation details (exact log message strings, internal call counts beyond what proves the contract). The behavior assertion is what matters; the brittle assertion just makes refactors painful.
- Naming: `should [outcome] when [condition]`.

## Mocking — tenant-dashboard (enforced)

`scripts/check-no-supabase-test-mocks.mjs` blocks violations in pre-push and CI.

- **MSW is the only sanctioned way** to fake Supabase (and any other HTTP boundary) in `apps/tenant-dashboard` unit/action tests.
- **DO NOT** add `vi.mock('@supabase/...')`, `createSupabaseServerClient()`/`createSupabaseAdminClient()` factory mocks, or hand-rolled fake clients with `from().select().eq().single()` chains.
- Add or extend a feature handler under `apps/tenant-dashboard/src/test-helpers/msw-handlers/<feature>.ts`. Each handler exposes `seedXMswState(...)` + `getXMswState()` (or equivalent) so tests **declare data**, not call sequences.
- Reuse the shared layer first: `seedSupabaseAuth()` for SSR sessions + `/auth/v1/user`; `seedSupabaseMswState()` for `app`, `billing`, `tenant_entitlement_override`, and the platform-admin tables.
- Permission gates, billing services, and other true seams ARE allowed to mock with `vi.mock`. Supabase clients are not a true seam — they are an HTTP boundary, and MSW is what we use for HTTP boundaries.
- The exemplar to copy from is `apps/tenant-dashboard/src/features/api-keys/actions.test.ts` (uses `seedApiKeysMswState` / `getInsertedApiKeys`).
- External services (e.g. Stripe) are faked through their interfaces, not by mocking the SDK module.
- Supabase-behavior questions (RLS, triggers, functions): prefer integration tests against the real local DB over mocking.

## Test-related CI gates (these run only in CI — a local-green push can still go red)

- **Coverage floors** (`scripts/ci/check-coverage-floors.mjs`, floors in `scripts/ci/coverage-floors.json`): per-workspace statement/branch/function/line floors, ratchet-managed. Deleting well-tested code can drop a workspace below its floor — if coverage legitimately falls (e.g. a removal), rebaseline the floor in the same PR.
- **Patch mutation** (`scripts/ci/patch-mutation.mjs`): Stryker runs on the code *changed in the PR*; the changed-code mutation score must clear its threshold. New logic needs tests that actually kill mutants, not just execute lines. Run locally with `PREPUSH_RUN_MUTATION=1` on the pre-push gate, or `yarn test:mutate` per package.
- **Mutation-score floors** (`scripts/ci/mutation-score-floors.json`): per-package floors, ratchet-managed — when you improve a package's score, bump its floor.
- **Acceptance coverage** (`scripts/ci/check-acceptance-coverage.mjs`): each acceptance criterion id (`AC-…`) must appear in the test file that proves it — in a **comment above the test** (`// proves AC-056-05`), never in the test title.

Mutation testing produces a per-line survivor report (`yarn test:mutate` from a package directory) — surviving mutants are direct evidence of weak tests. The `mutation-testing` skill covers reading and acting on the report.
