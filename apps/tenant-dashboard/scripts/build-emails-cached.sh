#!/usr/bin/env bash
# Cached email template builder.
# Computes SHA-256 hash of all input files and skips the build if nothing changed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

CACHE_FILE="$SCRIPT_DIR/dist/.cache-hash"
TRANSACTIONAL_DIR="$REPO_ROOT/packages/transactional"

# Collect all input files that affect email template output
INPUT_FILES=(
  "$TRANSACTIONAL_DIR/emails/"*.tsx
  "$TRANSACTIONAL_DIR/index.ts"
  "$TRANSACTIONAL_DIR/package.json"
  "$SCRIPT_DIR/email-templs-gen.ts"
  "$SCRIPT_DIR/index.ts"
)

# Compute hash of all input files
CURRENT_HASH=""
for f in "${INPUT_FILES[@]}"; do
  if [ -f "$f" ]; then
    CURRENT_HASH="$CURRENT_HASH$(shasum -a 256 "$f")"
  fi
done
CURRENT_HASH=$(echo "$CURRENT_HASH" | shasum -a 256 | cut -d' ' -f1)

# Check if cached hash matches
if [ -f "$CACHE_FILE" ]; then
  CACHED_HASH=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
  if [ "$CURRENT_HASH" = "$CACHED_HASH" ]; then
    echo "✓ Email templates unchanged — skipping build"
    exit 0
  fi
fi

# Build templates
echo "Building email templates..."
# tsup with `--format esm,cjs` writes TWO bundles regardless of the package's
# `type` field: `dist/index.mjs` is ESM, `dist/index.js` is CJS. We execute the
# `.mjs` one — `scripts/package.json` has `"type": "module"`, so Node would
# refuse the CJS sibling (`require is not defined in ES module scope`). The
# dual-extension naming is tsup's own disambiguation; the package's `type`
# field only affects bare `.js` files we did NOT generate.
#
# --tsconfig scripts/tsconfig.json: the app's own tsconfig.json sets
# "jsx": "preserve" (Next.js transforms JSX itself via SWC), which esbuild
# can't bundle to runnable output — tsup falls back to its classic-transform
# default (`React.createElement`, no import in scope) and the templates
# (automatic-runtime source, no `import React`) throw `ReferenceError: React
# is not defined` at the `node` step below. scripts/tsconfig.json overrides
# just "jsx" to "react-jsx" so esbuild emits the automatic runtime's own
# import instead.
npx tsup "$SCRIPT_DIR/index.ts" --outDir "$SCRIPT_DIR/dist" --format esm,cjs --external react --tsconfig "$SCRIPT_DIR/tsconfig.json"
node "$SCRIPT_DIR/dist/index.mjs"

# Store hash for next run
mkdir -p "$SCRIPT_DIR/dist"
echo "$CURRENT_HASH" > "$CACHE_FILE"
echo "✓ Email templates built and cached"
