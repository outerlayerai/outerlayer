#!/usr/bin/env bash
# verify-gitleaks-credential-in-url.sh — Regression self-test for the
# `credential-in-url` rule in .gitleaks.toml.
#
# Why: the default gitleaks ruleset keys on token PREFIXES (AKIA, sk_live_,
# ghp_, ...), so a credential embedded in a URL's userinfo segment — e.g. a
# monitoring DSN of the form https://<opaque-key>@<host>/<project-id> — carries
# no keyword any built-in rule recognizes. `credential-in-url` closes that gap.
# This script proves it still does, so a future edit to .gitleaks.toml (e.g. a
# well-intentioned allowlist tweak) can't silently regress it back to
# "no leaks found".
#
# Asserts two things against a throwaway fixture file:
#   1. POSITIVE — a DSN-shaped credential (scheme://<16+ char opaque
#      token>@host/path) IS caught by the credential-in-url rule.
#   2. NEGATIVE — a bare-host URL with no embedded userinfo is NOT caught
#      (proves the rule isn't over-broad and won't drown CI in noise).
#
# The DSN test vector is assembled from two shell variables at RUNTIME so the
# credential-shaped string never appears as a literal contiguous substring in
# this script's own source — this file is itself gitleaks-scanned pre-commit
# and in CI, and the assembled vector would otherwise trip the very rule
# being tested.
#
# Wired into .github/workflows/ci.yml as a step immediately after
# the "Secret Scan" job, reusing that job's already-installed gitleaks binary
# (no reinstall here).
#
# Usage: scripts/ci/verify-gitleaks-credential-in-url.sh (run from repo root)

set -euo pipefail

CONFIG=".gitleaks.toml"
[ -f "$CONFIG" ] || { echo "::error::$CONFIG not found — run scripts/ci/verify-gitleaks-credential-in-url.sh from repo root"; exit 1; }

command -v gitleaks >/dev/null 2>&1 || { echo "::error::gitleaks not on PATH"; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# 32 chars, well clear of the rule's 16-char opaque-token floor. Fake by
# construction (sequential fixture label, .invalid host — RFC 2606 reserved,
# can never resolve to a real credentialed service).
FAKE_TOKEN="selftest00000000000000000fixture"
FAKE_HOST="dsn-selftest.invalid"

cat > "$WORKDIR/fixture.env" <<EOF
# Positive case: DSN-shaped credential-in-url — MUST be caught.
DSN_TEST_VECTOR=https://${FAKE_TOKEN}@${FAKE_HOST}/99999
# Negative case: bare-host URL, no userinfo — MUST NOT be caught.
BARE_HOST_TEST_URL=https://ingest.example.invalid/v1/traces
EOF

REPORT="$WORKDIR/report.json"
set +e
gitleaks detect --no-git --source "$WORKDIR" --config "$CONFIG" \
  --no-banner --redact --report-path "$REPORT" >/dev/null 2>&1
GITLEAKS_EXIT=$?
set -e

# gitleaks exits 1 when it finds a leak — expected here (the positive case
# must fire). Any other non-zero exit is a real tool error, not "found a leak".
if [ "$GITLEAKS_EXIT" -ne 1 ]; then
  echo "::error::expected gitleaks to exit 1 (leak found) on the DSN test vector, got exit code $GITLEAKS_EXIT"
  exit 1
fi

[ -s "$REPORT" ] || { echo "::error::gitleaks reported leaks (exit 1) but wrote no/empty report to $REPORT"; exit 1; }

DSN_HITS=$(grep -c '"RuleID": *"credential-in-url"' "$REPORT" || true)
if [ "$DSN_HITS" -lt 1 ]; then
  echo "::error::credential-in-url rule did NOT fire on the DSN test vector — the rule has regressed. Check .gitleaks.toml [[rules]] id = \"credential-in-url\" and its allowlist entries."
  exit 1
fi

if grep -q "BARE_HOST_TEST_URL" "$REPORT"; then
  echo "::error::credential-in-url rule fired on a bare-host URL with no embedded credential — the rule has become over-broad."
  exit 1
fi

echo "credential-in-url self-test passed: DSN test vector caught (${DSN_HITS} finding(s)); bare-host URL correctly ignored."
