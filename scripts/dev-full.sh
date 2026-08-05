#!/usr/bin/env bash
# Starts all optional services (ClickHouse + Supabase Studio + Inbucket) then runs turbo dev.
# Temporarily enables Studio/Inbucket in config.toml and restores on exit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/apps/tenant-dashboard/supabase/config.toml"
BACKUP="$CONFIG.dev-full-backup"

cleanup() {
  if [ -f "$BACKUP" ]; then
    mv "$BACKUP" "$CONFIG"
  fi
}
trap cleanup EXIT

# Start ClickHouse
cd "$REPO_ROOT/apps/tenant-dashboard/clickhouse" && docker compose up -d

# Back up and temporarily enable Studio and Inbucket
cd "$REPO_ROOT"
cp "$CONFIG" "$BACKUP"
sed -i.bak '/\[studio\]/{n;n;s/enabled = false/enabled = true/;}' "$CONFIG"
sed -i.bak '/\[inbucket\]/{n;n;s/enabled = false/enabled = true/;}' "$CONFIG"
rm -f "$CONFIG.bak"

# Restart Supabase to pick up config changes
npx supabase stop --workdir apps/tenant-dashboard || true
npx supabase start --workdir apps/tenant-dashboard

# Run dev — source the port config the same way `yarn dev` does
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env.local" 2>/dev/null || true
set +a
turbo dev
