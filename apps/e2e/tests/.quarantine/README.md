# Flake quarantine

Tests in this directory are **excluded from every Playwright project** (PR, Full, Smoke, Staging) via `playwright.config.ts` `testIgnore`. Use this when a test is flaking and you need to unblock CI fast, without losing the test.

## Rules

1. **Every quarantined file must have a header comment** with three fields:
   ```ts
   // quarantined: 2026-04-23
   // quarantine-issue: https://github.com/<org>/<repo>/issues/123
   // quarantine-reason: Flakes on Supabase cold-start in CI when parallelized
   ```
   `quarantined:` is the date you moved the file here (YYYY-MM-DD).
   `quarantine-issue:` is a tracking issue that must exist.
   `quarantine-reason:` is one sentence on why it was quarantined.

2. `scripts/ci/check-quarantine-staleness.mjs` runs on every PR and fails when:
   - A file in `.quarantine/` is missing any of the three headers.
   - A file has been quarantined beyond the staleness threshold defined in the script's policy function.

3. **A quarantined test is not dead code.** Either fix and move back, or delete and file a follow-up to restore coverage a different way.

## How to quarantine a flaking test

```bash
cd apps/e2e
mkdir -p tests/.quarantine/<area>
git mv tests/<area>/flaky.spec.ts tests/.quarantine/<area>/flaky.spec.ts
# Add the three required headers at the top of the file, commit, open PR.
```

## How to un-quarantine

When the flake is fixed:

```bash
git mv tests/.quarantine/<area>/flaky.spec.ts tests/<area>/flaky.spec.ts
# Remove the three quarantine-* headers. Commit. Open PR.
```
