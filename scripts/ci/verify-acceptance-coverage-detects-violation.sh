#!/usr/bin/env bash
# verify-acceptance-coverage-detects-violation.sh — Regression self-test for
# scripts/ci/check-acceptance-coverage.mjs.
#
# Why: the acceptance-coverage gate only earns its place in CI if it actually
# catches the bug class it exists for — a criterion that no test proves,
# and a test that claims to prove a criterion which no longer exists. A gate
# that reports "all criteria bound" because its parser silently stopped
# matching is worse than no gate, because it reads as evidence. This proves
# each failure mode is detected, so a future edit can't regress it to a
# permanent green.
#
# Builds a throwaway fixture repo (the check reads acceptance/ and test files
# directly — no install needed) and runs the REAL check against it via the
# ACCEPTANCE_COVERAGE_CWD override, asserting:
#   1. BOUND     — a labeled criterion cited by a test passes (exit 0).
#   2. UNBOUND   — a labeled criterion no test cites is caught (exit 1).
#   3. ORPHAN    — a test citing an undeclared criterion is caught (exit 1).
#   4. DUPLICATE — the same id on two scenarios is caught (exit 1).
#   5. MISMATCH  — an id whose feature number differs from its file (exit 1).
#   6. FLOOR     — unlabeled criteria growing past the floor is caught (exit 1).
#   7. STALE     — a floors entry whose criteria file is gone is caught (exit 1),
#                  so a deleted file can't leave an unenforceable floor behind.
#
# Usage: scripts/ci/verify-acceptance-coverage-detects-violation.sh (from repo root)

set -euo pipefail

CHECK_SCRIPT="scripts/ci/check-acceptance-coverage.mjs"
[ -f "$CHECK_SCRIPT" ] || { echo "::error::$CHECK_SCRIPT not found — run from repo root"; exit 1; }
CHECK_SCRIPT="$(pwd)/$CHECK_SCRIPT"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/acceptance" "$WORKDIR/scripts/ci" "$WORKDIR/pkg"

# Runs the real check against the fixture. $1 = case label, $2 = expected exit,
# $3 = optional substring that must appear in the output.
run_case() {
  local label="$1" expected="$2" needle="${3:-}" actual=0
  local log="$WORKDIR/$label.log"
  set +e
  ACCEPTANCE_COVERAGE_CWD="$WORKDIR" node "$CHECK_SCRIPT" >"$log" 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "::error::Case $label: expected exit $expected, got $actual"
    cat "$log"
    exit 1
  fi
  if [ -n "$needle" ] && ! grep -qF "$needle" "$log"; then
    echo "::error::Case $label: expected output to mention '$needle'"
    cat "$log"
    exit 1
  fi
}

write_criteria() {
  cat > "$WORKDIR/acceptance/056-fixture.md"
}

write_test() {
  cat > "$WORKDIR/pkg/thing.test.ts"
}

echo '{ "056-fixture": 0 }' > "$WORKDIR/scripts/ci/acceptance-coverage-floors.json"

# --- Case 1: BOUND — labeled criterion, cited by a test. Must pass.
write_criteria <<'EOF'
# Fixture

**Acceptance Scenarios**:

1. `AC-056-01` **Given** a thing, **When** it runs, **Then** it works.
EOF
write_test <<'EOF'
describe('AC-056-01: the thing works', () => {});
EOF
run_case bound 0 "1/1 criteria bound"

# --- Case 2: UNBOUND — the test no longer cites the criterion. Must fail.
write_test <<'EOF'
describe('the thing works', () => {});
EOF
run_case unbound 1 "AC-056-01"

# --- Case 3: ORPHAN — test cites an id no criteria file declares. Must fail.
write_test <<'EOF'
describe('AC-056-01: the thing works', () => {});
describe('AC-056-99: a criterion that was deleted', () => {});
EOF
run_case orphan 1 "AC-056-99"

# --- Case 4: DUPLICATE — the same id on two scenarios. Must fail.
write_criteria <<'EOF'
# Fixture

**Acceptance Scenarios**:

1. `AC-056-01` **Given** a thing, **When** it runs, **Then** it works.
2. `AC-056-01` **Given** another thing, **When** it runs, **Then** it also works.
EOF
write_test <<'EOF'
describe('AC-056-01: the thing works', () => {});
EOF
run_case duplicate 1 "declared twice"

# --- Case 5: MISMATCH — an id belonging to a different feature. Must fail.
write_criteria <<'EOF'
# Fixture

**Acceptance Scenarios**:

1. `AC-044-01` **Given** a thing, **When** it runs, **Then** it works.
EOF
write_test <<'EOF'
describe('AC-044-01: the thing works', () => {});
EOF
run_case mismatch 1 "but this file is 056"

# --- Case 6: FLOOR — an unlabeled criterion appears where the floor is 0.
# Must fail: new criteria may not be added without binding them.
write_criteria <<'EOF'
# Fixture

**Acceptance Scenarios**:

1. `AC-056-01` **Given** a thing, **When** it runs, **Then** it works.
2. **Given** an unlabeled thing, **When** it runs, **Then** nobody proves it.
EOF
write_test <<'EOF'
describe('AC-056-01: the thing works', () => {});
EOF
run_case floor 1 "exceeds floor 0"

# --- Case 7: STALE — a floors entry whose criteria file no longer exists. Must
# fail, otherwise a deleted file leaves a floor that can never be violated.
rm -f "$WORKDIR/acceptance/056-fixture.md"
run_case stale 1 "is missing"

echo "acceptance-coverage self-test passed: bound criterion accepted; unbound, orphan, duplicate, mismatched, floor-breaking, and stale-entry cases all caught."
