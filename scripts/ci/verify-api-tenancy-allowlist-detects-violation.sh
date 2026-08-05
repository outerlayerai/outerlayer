#!/usr/bin/env bash
# verify-api-tenancy-allowlist-detects-violation.sh — Regression self-test for
# scripts/ci/check-api-tenancy-allowlist.mjs.
#
# Why: the allowlist gate only earns its place if it actually catches the bug
# class it exists for (a NEW tenant-scoped route added to the legacy /api/**
# surface instead of being born under /api/orgs/<org>/…). This proves it does,
# so a future edit to the check can't silently regress it to "no violations".
#
# Builds a minimal throwaway api tree + allowlist and runs the REAL check
# against it via the API_TENANCY_CWD override, asserting four things:
#   1. POSITIVE — a legacy route not on the allowlist IS caught (exit 1).
#   2. ALLOWLISTED — the same route, listed, is NOT caught (exit 0).
#   3. STALE — an allowlist entry with no matching route IS caught (exit 1).
#   4. BORN-CANONICAL — a route under api/orgs/** never needs allowlisting (exit 0).
#
# Usage: scripts/ci/verify-api-tenancy-allowlist-detects-violation.sh (run from repo root)

set -euo pipefail

CHECK_SCRIPT="scripts/ci/check-api-tenancy-allowlist.mjs"
[ -f "$CHECK_SCRIPT" ] || { echo "::error::$CHECK_SCRIPT not found — run from repo root"; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

API="$WORKDIR/apps/tenant-dashboard/src/app/api"
mkdir -p "$API/health" "$API/cli/foo" "$API/foo/bar" "$WORKDIR/scripts/ci"
# Two stay-put routes (a tenant-agnostic probe + a self-authenticated cli route,
# exempt by exact and by prefix) and one legacy tenant-scoped route.
echo 'export async function GET() {}' > "$API/health/route.ts"
echo 'export async function GET() {}' > "$API/cli/foo/route.ts"
echo 'export async function GET() {}' > "$API/foo/bar/route.ts"

run_check() {
  set +e
  API_TENANCY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >"$1" 2>&1
  local code=$?
  set -e
  echo "$code"
}

# --- Case 1: POSITIVE — legacy route, empty allowlist. Must fail by name.
echo '{ "routes": [] }' > "$WORKDIR/scripts/ci/api-tenancy-allowlist.json"
CASE1_EXIT="$(run_check /tmp/api-tenancy-selftest-1.log)"
if [ "$CASE1_EXIT" -ne 1 ]; then
  echo "::error::Case 1 (unlisted legacy route): expected exit 1, got $CASE1_EXIT"
  cat /tmp/api-tenancy-selftest-1.log; exit 1
fi
grep -q "api/foo/bar" /tmp/api-tenancy-selftest-1.log || {
  echo "::error::Case 1: violation was not reported by name"
  cat /tmp/api-tenancy-selftest-1.log; exit 1
}
# Stay-put routes must never appear in the violation output — an exact probe and
# a prefix-exempt route are both invisible to the gate.
for stayput in "api/health" "api/cli/foo"; do
  if grep -q "$stayput" /tmp/api-tenancy-selftest-1.log; then
    echo "::error::Case 1: stay-put route $stayput was wrongly flagged"
    cat /tmp/api-tenancy-selftest-1.log; exit 1
  fi
done

# --- Case 2: ALLOWLISTED — the one legacy route listed; the two stay-put routes
# (health exact, cli/foo prefix) remain exempt with no entry. Must pass.
echo '{ "routes": ["foo/bar"] }' > "$WORKDIR/scripts/ci/api-tenancy-allowlist.json"
CASE2_EXIT="$(run_check /tmp/api-tenancy-selftest-2.log)"
if [ "$CASE2_EXIT" -ne 0 ]; then
  echo "::error::Case 2 (allowlisted legacy route): expected exit 0, got $CASE2_EXIT"
  cat /tmp/api-tenancy-selftest-2.log; exit 1
fi

# --- Case 3: STALE — allowlist entry with no matching route. Must fail.
echo '{ "routes": ["foo/bar", "gone/route"] }' > "$WORKDIR/scripts/ci/api-tenancy-allowlist.json"
CASE3_EXIT="$(run_check /tmp/api-tenancy-selftest-3.log)"
if [ "$CASE3_EXIT" -ne 1 ]; then
  echo "::error::Case 3 (stale allowlist entry): expected exit 1, got $CASE3_EXIT"
  cat /tmp/api-tenancy-selftest-3.log; exit 1
fi
grep -qi "allowlist entry has rotted" /tmp/api-tenancy-selftest-3.log || {
  echo "::error::Case 3: stale-allowlist reason was not reported"
  cat /tmp/api-tenancy-selftest-3.log; exit 1
}

# --- Case 4: BORN-CANONICAL — a route under api/orgs/** never needs allowlisting.
mkdir -p "$API/orgs/[orgName]/apps/[appId]/thing"
echo 'export async function GET() {}' > "$API/orgs/[orgName]/apps/[appId]/thing/route.ts"
echo '{ "routes": ["foo/bar"] }' > "$WORKDIR/scripts/ci/api-tenancy-allowlist.json"
CASE4_EXIT="$(run_check /tmp/api-tenancy-selftest-4.log)"
if [ "$CASE4_EXIT" -ne 0 ]; then
  echo "::error::Case 4 (born-canonical route): expected exit 0, got $CASE4_EXIT"
  cat /tmp/api-tenancy-selftest-4.log; exit 1
fi

echo "api-tenancy self-test passed: unlisted legacy caught, stay-put routes exempt, allowlisted passed, stale entry caught, born-canonical exempt."
