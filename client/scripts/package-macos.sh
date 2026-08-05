#!/usr/bin/env bash
set -euo pipefail

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  # GitHub Actions always ships a Node runtime for JavaScript actions, even when
  # the self-hosted runner has no npm/node on PATH. RUNNER_WORKSPACE is
  # <runner-root>/_work, so its sibling `externals/node24` is the runtime selected
  # by FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 in macos-builder/build.yml.
  RUNNER_ROOT="$(dirname "${RUNNER_WORKSPACE:-/nonexistent/_work}")"
  NODE_BIN="$RUNNER_ROOT/externals/node24/bin/node"
fi

if [ ! -x "$NODE_BIN" ]; then
  echo "::error::Node runtime not found. Checked PATH and ${NODE_BIN}." >&2
  exit 1
fi

exec "$NODE_BIN" scripts/package.cjs "$@"
