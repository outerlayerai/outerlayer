#!/usr/bin/env bash
# Vercel Ignored Build Step.
#
# Usage in vercel.json:
#   "ignoreCommand": "cd ../.. && bash scripts/should-deploy.sh tenant-dashboard"
#
# Exit 0 = skip build, Exit 1 = proceed with build.
#
# Policy:
#   - Non-production (preview/staging): always skip. Previews are triggered
#     explicitly via the /deploy-preview comment workflow, which calls
#     `vercel deploy` directly and bypasses this script entirely.
#   - Production (merge to main): build only if files in this app or shared
#     packages changed. Skips the build when only another app changed
#     (e.g. a dashboard-only merge shouldn't rebuild outerlayer-site).

set -euo pipefail

APP_NAME="${1:?Usage: should-deploy.sh <app-name>}"

ENV="${VERCEL_ENV:-}"
BRANCH="${VERCEL_GIT_COMMIT_REF:-}"

if [ "$ENV" != "production" ] && [ "$BRANCH" != "main" ]; then
  echo ":: Non-production (VERCEL_ENV=${VERCEL_ENV:-unset}) for ${APP_NAME} — skipping (use /deploy-preview)."
  exit 0
fi

# Determine which files changed vs the previous commit.
CHANGED=$(git diff HEAD^ HEAD --name-only 2>/dev/null || echo "")

if [ -z "$CHANGED" ]; then
  # Can't determine changed files (initial commit or git error) — build to be safe.
  echo ":: Cannot determine changed files — proceeding with build."
  exit 1
fi

if echo "$CHANGED" | grep -qE "^(apps/${APP_NAME}|packages)/"; then
  echo ":: Relevant files changed for ${APP_NAME} — proceeding with build."
  exit 1
fi

echo ":: No relevant files changed for ${APP_NAME} — skipping production build."
exit 0
