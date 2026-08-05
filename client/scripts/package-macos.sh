#!/usr/bin/env bash
set -euo pipefail

NODE_BIN=""

# GitHub Actions ships a real Node runtime for JavaScript actions even when the
# host has no Node/npm installation. Prefer it over PATH: Bun installs a `node`
# shim that resolves from `command -v node` but still has Bun's CommonJS interop,
# which breaks @electron-forge/plugin-vite's `require("vite").default` call.
if [ -n "${RUNNER_TEMP:-}" ]; then
  RUNNER_ROOT="$(cd "$RUNNER_TEMP/../.." && pwd)"
  for candidate in "$RUNNER_ROOT/externals/node24/bin/node" "$RUNNER_ROOT/externals/node20/bin/node"; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  candidate="$(command -v node)"
  if "$candidate" -e 'process.exit(process.versions.bun ? 1 : 0)' >/dev/null 2>&1; then
    NODE_BIN="$candidate"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "::error::A real Node runtime is required for Electron Forge (a Bun node shim is not sufficient)." >&2
  echo "RUNNER_TEMP=${RUNNER_TEMP:-} PATH=$PATH" >&2
  exit 1
fi

echo "Packaging with $NODE_BIN ($("$NODE_BIN" --version))"
exec "$NODE_BIN" scripts/package.cjs "$@"
