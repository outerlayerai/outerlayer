#!/bin/bash
#
# validate-supabase.sh
# Full Supabase validation: db reset -> db diff (zero drift) -> gen types -> splinter
# Mirrors the supabase-checks job in .github/workflows/ci.yml
#
# Usage: bash scripts/validate-supabase.sh
# Run from: apps/tenant-dashboard/
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Supabase Validation ==="
echo ""

# Step 1: Auto-start Supabase if not running
echo "--- Step 1: Checking Supabase status ---"
if ! npx supabase status 2>&1 | grep -q "127.0.0.1"; then
  echo "Supabase not running. Starting..."
  npx supabase start
  echo "Supabase started."
else
  echo "✓ Supabase is already running."
fi
echo ""

# Step 2: supabase db reset (rebuilds from scratch — catches schema ordering issues)
echo "--- Step 2: Resetting database (db reset) ---"
npx supabase db reset
echo "✓ Database reset complete."
echo ""

# Step 3: gen types (verifies types can be generated without error)
echo "--- Step 3: Verifying generated types (gen types) ---"
export GITHUB_CLIENT_ID=client_id
export GITHUB_CLIENT_SECRET=client_secret
export GOOGLE_CLIENT_ID=client_id
export GOOGLE_CLIENT_SECRET=client_secret
export SUPABASE_AUTH_REDIRECT_URI=http://localhost:3000/auth/callback

npx supabase gen types typescript --local > types.gen.ts
# Compare against the committed canonical file at packages/db-types/index.ts
# (consumed by both apps via `@repo/db-types`). Drift here means someone
# changed migrations/schema without running `yarn codegen:db`.
if ! diff --strip-trailing-cr -q types.gen.ts ../../packages/db-types/index.ts > /dev/null 2>&1; then
  echo "❌ Committed packages/db-types/index.ts is stale:"
  diff -u --strip-trailing-cr ../../packages/db-types/index.ts types.gen.ts | head -120
  echo ""
  echo "To fix: run 'yarn codegen:db' and commit the result."
  rm -f types.gen.ts
  exit 1
fi
rm -f types.gen.ts
echo "✓ Generated types match committed @repo/db-types."
echo ""

# Step 4: supabase db diff --local (verifies zero drift between migrations and schemas)
echo "--- Step 4: Verifying zero schema drift (db diff) ---"
DIFF_OUTPUT=$(npx supabase db diff --local 2>&1) || true
if echo "$DIFF_OUTPUT" | grep -qiE "^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|set )"; then
  echo "❌ Schema drift detected between migrations and schema files:"
  echo ""
  echo "$DIFF_OUTPUT"
  echo ""
  echo "To fix: Update schema files or regenerate migration with 'npx supabase db diff -f <name>'"
  exit 1
fi
echo "✓ No schema drift detected."
echo ""

# Step 5: run-splinter.sh (security & performance linter)
echo "--- Step 5: Running Supabase splinter linter ---"
bash "$SCRIPT_DIR/run-splinter.sh"
echo ""

echo "=== ✅ All Supabase validations passed ==="
