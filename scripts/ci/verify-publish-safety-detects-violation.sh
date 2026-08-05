#!/usr/bin/env bash
# verify-publish-safety-detects-violation.sh — Regression self-test for
# scripts/ci/check-publish-safety.mjs.
#
# Why: check-publish-safety.mjs only earns its place in the CI gate if it
# actually catches the bug class it exists for (a published package quietly
# depending on a never-published private one). This script proves it does,
# so a future edit to the check (or its allowlist logic) can't silently
# regress it back to "no violations found".
#
# Builds a minimal throwaway workspace (two packages, no install or yarn
# needed — check-publish-safety.mjs reads the root package.json's
# `workspaces` globs and each package.json directly) and runs the REAL
# check-publish-safety.mjs against it via the PUBLISH_SAFETY_CWD override,
# asserting three things:
#   1. POSITIVE — a published package depending on a private one via
#      `dependencies` with no allowlist entry IS caught (exit 1).
#   2. ALLOWLISTED — the same edge, moved to devDependencies + vendored via
#      tsup noExternal + listed in the allowlist, is NOT caught (exit 0).
#   3. STALE ALLOWLIST — an allowlist entry whose noExternal vendoring has
#      been removed IS caught (exit 1) — proves the allowlist can't rot.
#
# Usage: scripts/ci/verify-publish-safety-detects-violation.sh (run from repo root)

set -euo pipefail

CHECK_SCRIPT="scripts/ci/check-publish-safety.mjs"
[ -f "$CHECK_SCRIPT" ] || { echo "::error::$CHECK_SCRIPT not found — run from repo root"; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/packages/pub-pkg" "$WORKDIR/packages/priv-pkg" "$WORKDIR/scripts/ci"

cat > "$WORKDIR/package.json" <<'EOF'
{
  "name": "fixture-root",
  "private": true,
  "packageManager": "yarn@4.9.1",
  "workspaces": ["packages/*"]
}
EOF

cat > "$WORKDIR/packages/priv-pkg/package.json" <<'EOF'
{
  "name": "@fixture/priv-pkg",
  "version": "0.0.0",
  "private": true
}
EOF

# --- Case 1: POSITIVE — undeclared edge via `dependencies`, no allowlist.
cat > "$WORKDIR/packages/pub-pkg/package.json" <<'EOF'
{
  "name": "@fixture/pub-pkg",
  "version": "0.0.0",
  "dependencies": { "@fixture/priv-pkg": "workspace:*" }
}
EOF

set +e
PUBLISH_SAFETY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >/tmp/publish-safety-selftest-1.log 2>&1
CASE1_EXIT=$?
set -e

if [ "$CASE1_EXIT" -ne 1 ]; then
  echo "::error::Case 1 (undeclared violation): expected exit 1, got $CASE1_EXIT"
  cat /tmp/publish-safety-selftest-1.log
  exit 1
fi
grep -q "@fixture/pub-pkg depends on private workspace @fixture/priv-pkg" /tmp/publish-safety-selftest-1.log || {
  echo "::error::Case 1: violation was not reported by name"
  cat /tmp/publish-safety-selftest-1.log
  exit 1
}

# --- Case 2: ALLOWLISTED — same edge, moved to devDependencies + vendored
# via noExternal + on the allowlist. Must pass.
cat > "$WORKDIR/packages/pub-pkg/package.json" <<'EOF'
{
  "name": "@fixture/pub-pkg",
  "version": "0.0.0",
  "devDependencies": { "@fixture/priv-pkg": "workspace:*" }
}
EOF
cat > "$WORKDIR/packages/pub-pkg/tsup.config.ts" <<'EOF'
export default { noExternal: ["@fixture/priv-pkg"], sourcemap: false };
EOF
cat > "$WORKDIR/scripts/ci/publish-safety-allowlist.json" <<'EOF'
{ "allow": { "@fixture/pub-pkg": ["@fixture/priv-pkg"] } }
EOF

set +e
PUBLISH_SAFETY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >/tmp/publish-safety-selftest-2.log 2>&1
CASE2_EXIT=$?
set -e

if [ "$CASE2_EXIT" -ne 0 ]; then
  echo "::error::Case 2 (allowlisted + vendored edge): expected exit 0, got $CASE2_EXIT"
  cat /tmp/publish-safety-selftest-2.log
  exit 1
fi

# --- Case 3: STALE ALLOWLIST — allowlist entry present but the noExternal
# vendoring has been removed. Must fail (the allowlist can't rot silently).
cat > "$WORKDIR/packages/pub-pkg/tsup.config.ts" <<'EOF'
export default { noExternal: [], sourcemap: false };
EOF

set +e
PUBLISH_SAFETY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >/tmp/publish-safety-selftest-3.log 2>&1
CASE3_EXIT=$?
set -e

if [ "$CASE3_EXIT" -ne 1 ]; then
  echo "::error::Case 3 (stale allowlist entry): expected exit 1, got $CASE3_EXIT"
  cat /tmp/publish-safety-selftest-3.log
  exit 1
fi
grep -q "allowlist entry has rotted" /tmp/publish-safety-selftest-3.log || {
  echo "::error::Case 3: stale-allowlist reason was not reported"
  cat /tmp/publish-safety-selftest-3.log
  exit 1
}

# --- Case 4: SOURCEMAP — the dependency edge is clean, but the published
# package emits a tsup sourcemap. tsup inlines `sourcesContent`, so the map
# carries the readable source of every vendored package, where the allowlist
# covers the compiled output only. Must fail.
cat > "$WORKDIR/packages/pub-pkg/tsup.config.ts" <<'EOF'
export default { noExternal: ["@fixture/priv-pkg"], sourcemap: true };
EOF
cat > "$WORKDIR/packages/pub-pkg/package.json" <<'EOF'
{
  "name": "@fixture/pub-pkg",
  "version": "0.0.0",
  "files": ["dist", "!dist/**/*.map"],
  "devDependencies": { "@fixture/priv-pkg": "workspace:*" }
}
EOF

set +e
PUBLISH_SAFETY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >/tmp/publish-safety-selftest-4.log 2>&1
CASE4_EXIT=$?
set -e

if [ "$CASE4_EXIT" -ne 1 ]; then
  echo "::error::Case 4 (sourcemap emitted): expected exit 1, got $CASE4_EXIT"
  cat /tmp/publish-safety-selftest-4.log
  exit 1
fi
grep -q "must set .sourcemap: false" /tmp/publish-safety-selftest-4.log || {
  echo "::error::Case 4: sourcemap reason was not reported"
  cat /tmp/publish-safety-selftest-4.log
  exit 1
}

# --- Case 5: SOURCEMAP VIA files — the build is clean but `files` would
# publish any map that appeared. Must fail; the two conditions guard each
# other.
cat > "$WORKDIR/packages/pub-pkg/tsup.config.ts" <<'EOF'
export default { noExternal: ["@fixture/priv-pkg"], sourcemap: false };
EOF
cat > "$WORKDIR/packages/pub-pkg/package.json" <<'EOF'
{
  "name": "@fixture/pub-pkg",
  "version": "0.0.0",
  "files": ["dist"],
  "devDependencies": { "@fixture/priv-pkg": "workspace:*" }
}
EOF

set +e
PUBLISH_SAFETY_CWD="$WORKDIR" node "$CHECK_SCRIPT" >/tmp/publish-safety-selftest-5.log 2>&1
CASE5_EXIT=$?
set -e

if [ "$CASE5_EXIT" -ne 1 ]; then
  echo "::error::Case 5 (files would ship maps): expected exit 1, got $CASE5_EXIT"
  cat /tmp/publish-safety-selftest-5.log
  exit 1
fi
grep -q 'must exclude "!dist/\*\*/\*.map"' /tmp/publish-safety-selftest-5.log || {
  echo "::error::Case 5: files-exclusion reason was not reported"
  cat /tmp/publish-safety-selftest-5.log
  exit 1
}

echo "publish-safety self-test passed: undeclared violation caught, allowlisted+vendored edge passed, stale allowlist entry caught, sourcemap conditions caught."
