#!/usr/bin/env bash
# Test harness for scripts/should-deploy.sh
#
# Current deploy policy: production deploys build, everything else skips.
# File/branch details are irrelevant — only VERCEL_ENV matters.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

run_test() {
  local test_name="$1"
  local expected_exit="$2"  # 0=skip, 1=build
  local app="$3"
  local vercel_env="${4:-preview}"

  local actual_exit=0
  VERCEL_ENV="$vercel_env" bash "$SCRIPT_DIR/should-deploy.sh" "$app" > /dev/null 2>&1 || actual_exit=$?

  if [ "$actual_exit" -eq "$expected_exit" ]; then
    echo "  PASS: $test_name (exit $actual_exit)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $test_name -- expected exit $expected_exit, got $actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== should-deploy.sh test suite ==="
echo ""
echo "Policy: VERCEL_ENV=production → BUILD (exit 1); all other envs → SKIP (exit 0)."
echo ""

for APP in tenant-dashboard outerlayer-site; do
  echo "$APP:"
  run_test "production → BUILD"           1 "$APP" "production"
  run_test "preview → SKIP"               0 "$APP" "preview"
  run_test "development → SKIP"           0 "$APP" "development"
  run_test "unset VERCEL_ENV → SKIP"      0 "$APP" ""
  echo ""
done

# Unknown app is still rejected up-front by the usage guard; in production we
# proceed (fail-open) so a bad config doesn't silently block main.
echo "Edge cases:"
run_test "unknown app + production → BUILD"  1 "unknown-app" "production"
run_test "unknown app + preview → SKIP"      0 "unknown-app" "preview"
echo ""

TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED: $FAIL tests"
  exit 1
fi
echo "All tests passed."
