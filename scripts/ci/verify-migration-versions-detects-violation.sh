#!/usr/bin/env bash
# verify-migration-versions-detects-violation.sh — Regression self-test for
# scripts/ci/check-migration-versions.mjs.
#
# Why: this gate spends its whole life green, because the collision it guards
# against is rare and only appears in a merged tree. A green that means "the
# glob stopped matching" is indistinguishable from a green that means "no
# duplicates" — and the second one is what everybody will assume. This pins each
# failure mode so a future edit cannot quietly turn the gate into a no-op.
#
# Builds a throwaway fixture tree (the check only reads directory listings, so
# no install is needed) and runs the REAL check against it via the
# MIGRATION_VERSIONS_CWD override, asserting:
#   1. CLEAN      — unique, well-formed versions pass (exit 0).
#   2. DUPLICATE  — two Supabase files sharing a 14-digit prefix (exit 1).
#   3. MALFORMED  — a Supabase file with no version prefix (exit 1).
#   4. PADDING    — ClickHouse 07_ vs 7_, equal by value, is caught (exit 1).
#
# Usage: scripts/ci/verify-migration-versions-detects-violation.sh (from repo root)

set -euo pipefail

CHECK_SCRIPT="scripts/ci/check-migration-versions.mjs"
[ -f "$CHECK_SCRIPT" ] || { echo "::error::$CHECK_SCRIPT not found — run from repo root"; exit 1; }
CHECK_SCRIPT="$(pwd)/$CHECK_SCRIPT"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

SUPA="$WORKDIR/apps/tenant-dashboard/supabase/migrations"
CH="$WORKDIR/apps/tenant-dashboard/clickhouse/migrations"

# Resets the fixture to a known-good state before each case.
reset_fixture() {
  rm -rf "$SUPA" "$CH"
  mkdir -p "$SUPA" "$CH"
  touch "$SUPA/20260728163000_first_change.sql"
  touch "$SUPA/20260728163100_second_change.sql"
  touch "$CH/1_initial.sql"
  touch "$CH/2_add_column.sql"
}

# Runs the real check against the fixture. $1 = case label, $2 = expected exit,
# $3 = optional substring that must appear in the output.
run_case() {
  local label="$1" expected="$2" needle="${3:-}" actual=0
  local log="$WORKDIR/$label.log"
  set +e
  MIGRATION_VERSIONS_CWD="$WORKDIR" node "$CHECK_SCRIPT" >"$log" 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "::error::Case $label: expected exit $expected, got $actual"
    cat "$log"
    exit 1
  fi
  if [ -n "$needle" ] && ! grep -qF "$needle" "$log"; then
    echo "::error::Case $label: output did not mention '$needle'"
    cat "$log"
    exit 1
  fi
  echo "  ✓ $label"
}

echo "Verifying check-migration-versions.mjs detects each failure mode:"

# 1. CLEAN — the baseline must pass, or every case below proves nothing.
reset_fixture
run_case CLEAN 0

# 2. DUPLICATE — the collision this gate exists for.
reset_fixture
touch "$SUPA/20260728163000_a_second_file_same_version.sql"
run_case DUPLICATE 1 "20260728163000"

# 3. MALFORMED — an unparseable name must fail loudly, not be skipped silently.
reset_fixture
touch "$SUPA/not_a_timestamped_migration.sql"
run_case MALFORMED 1 "does not match"

# 4. PADDING — 07_ and 7_ are one version to a numeric runner.
reset_fixture
touch "$CH/07_zero_padded.sql"
touch "$CH/7_unpadded.sql"
run_case PADDING 1 "clickhouse/migrations"

echo "All failure modes detected."
