#!/usr/bin/env bash
# check-migration-ordering.sh
#
# Ensures new Supabase migrations on a PR branch have timestamps AFTER
# the latest migration on main. Out-of-order timestamps cause
# `supabase db push` to fail during deployment.
#
# Usage: .github/scripts/check-migration-ordering.sh
#
# Expects `origin/main` to be fetched (fetch-depth: 0 in checkout).

set -euo pipefail

MIGRATIONS_PATH="apps/tenant-dashboard/supabase/migrations"

echo "Checking migration timestamps against main..."

# Get the latest Supabase migration timestamp on main
LAST_MAIN_TS=$(git show "origin/main:${MIGRATIONS_PATH}/" 2>/dev/null \
  | grep '\.sql$' | sort | tail -1 | cut -c1-14)

if [ -z "$LAST_MAIN_TS" ]; then
  echo "No migrations found on main - skipping ordering check"
  exit 0
fi

echo "Latest migration on main: $LAST_MAIN_TS"

# Find new migrations on this branch that don't exist on main
ERRORS=0
for file in $(git diff --name-only --diff-filter=A origin/main...HEAD -- "${MIGRATIONS_PATH}/*.sql"); do
  TS=$(basename "$file" | cut -c1-14)
  if [ "$TS" \< "$LAST_MAIN_TS" ]; then
    echo "ERROR: $(basename "$file") has timestamp $TS which is before main's latest ($LAST_MAIN_TS)"
    echo "  Fix: rename to a timestamp after $LAST_MAIN_TS"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "Out-of-order migrations will fail during deployment (supabase db push)."
  echo "Rename the file(s) above with a later timestamp."
  exit 1
fi

echo "All new migrations have valid timestamp ordering"
