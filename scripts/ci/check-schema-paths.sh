#!/usr/bin/env bash
# check-schema-paths.sh — fails if config.toml's declarative schema_paths list
# and apps/tenant-dashboard/supabase/schemas/ have drifted apart in either
# direction. A file listed but missing on disk makes `supabase db diff` abort
# instead of comparing schemas, which the drift gate can otherwise read as
# "no drift" if it doesn't check the exit code.
# Usage: scripts/ci/check-schema-paths.sh (from repo root)
set -euo pipefail

CONFIG="apps/tenant-dashboard/supabase/config.toml"
SCHEMAS_DIR="apps/tenant-dashboard/supabase/schemas"

LISTED=$(grep -oE '"\./schemas/[^"]+"' "$CONFIG" | tr -d '"' | sed 's#\./schemas/##' | sort)
ON_DISK=$(ls "$SCHEMAS_DIR" | sort)

MISSING=$(comm -23 <(echo "$LISTED") <(echo "$ON_DISK"))
UNLISTED=$(comm -13 <(echo "$LISTED") <(echo "$ON_DISK"))

if [ -n "$MISSING" ] || [ -n "$UNLISTED" ]; then
  echo "::error::$CONFIG's schema_paths is out of sync with $SCHEMAS_DIR"
  [ -n "$MISSING" ] && echo "Listed in config.toml but missing on disk: $MISSING"
  [ -n "$UNLISTED" ] && echo "On disk but missing from config.toml: $UNLISTED"
  exit 1
fi

echo "✓ config.toml schema_paths matches supabase/schemas/"
