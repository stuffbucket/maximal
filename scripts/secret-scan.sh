#!/usr/bin/env bash
# Pre-commit secret scan. Called from lint-staged with the list of
# staged file paths as positional args.
#
# Behavior:
#  - If trufflehog is missing, warn once and exit 0 (don't block work
#    for contributors who haven't installed it yet).
#  - Otherwise run filesystem scan with --no-verification (regex/entropy
#    only, no network). Fail-closed: any finding blocks the commit.
#  - Override with SKIP_SECRET_SCAN=1 for the rare commit where you
#    know the hit is a fixture (better: add a path-based allowlist
#    rather than skipping the whole hook).
#
# CI runs the verified variant via .github/workflows/secret-scan.yml.

set -euo pipefail

if [ "${SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "[secret-scan] SKIP_SECRET_SCAN=1 — bypassed"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! command -v trufflehog >/dev/null 2>&1; then
  cat >&2 <<EOF
[secret-scan] trufflehog not installed — skipping pre-commit scan.
              Install with: brew install trufflehog
              CI will still scan this PR.
EOF
  exit 0
fi

# Filter to regular existing files; lint-staged may pass deleted paths
# during rename-style commits, and trufflehog filesystem dislikes them.
paths=()
for p in "$@"; do
  [ -f "$p" ] && paths+=("$p")
done

if [ "${#paths[@]}" -eq 0 ]; then
  exit 0
fi

# --no-verification: regex/entropy only, no network round-trip.
# --results: trufflehog defaults to reporting only `verified` findings,
#            which `--no-verification` then suppresses entirely. Include
#            unverified + unknown so pre-commit fails on plausible
#            secrets without phoning home.
# --no-update: don't phone home to check for a new trufflehog release.
#
# We don't use --fail because in this trufflehog version it only
# exits non-zero on *verified* findings, which contradicts
# --no-verification. Instead, capture output and fail if any
# 'Found …result' line appears.
output=$(trufflehog filesystem "${paths[@]}" \
  --no-verification \
  --results=verified,unknown,unverified \
  --no-update 2>&1)
status=$?
echo "$output"
if [ "$status" -ne 0 ]; then
  exit "$status"
fi
if printf '%s\n' "$output" | grep -qE '^Found (verified|unverified|unknown) result'; then
  echo "[secret-scan] ✖ blocked: secrets detected in staged changes" >&2
  echo "[secret-scan]   if this is a false positive, add the path to" >&2
  echo "[secret-scan]   .trufflehog-exclude or set SKIP_SECRET_SCAN=1" >&2
  exit 1
fi
exit 0
