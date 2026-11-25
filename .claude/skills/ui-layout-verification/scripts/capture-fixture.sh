#!/usr/bin/env bash
# Capture a live maximal API response as a UI fixture.
#
# Settings APIs may require a configured API key. The Tauri shell obtains its
# private per-launch key through getShellApiKey(); that key is deliberately not
# embedded in the served HTML. Set MAXIMAL_API_KEY to one of the API keys
# configured in Maximal when the target instance enforces authentication.
#
# Usage:
#   MAXIMAL_API_KEY=... bash capture-fixture.sh [--port 4141] \
#     [--path /settings/api/models] --out <file>
#   bash capture-fixture.sh --out shell/tests/fixtures/models.json
set -euo pipefail

PORT=4141
API_PATH=/settings/api/models
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --path) API_PATH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$OUT" ]] && { echo "error: --out <file> is required" >&2; exit 2; }

BASE="http://127.0.0.1:${PORT}"
STATUS="$(curl -sS --fail -m 3 "$BASE/status" 2>/dev/null || true)"
if [[ "$STATUS" != *'"service":"maximal"'* ]]; then
  echo "no maximal on :${PORT}" >&2
  exit 1
fi

TMP="$(mktemp /tmp/maximal-capture.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
if [[ -n "${MAXIMAL_API_KEY:-}" ]]; then
  CODE=$(printf 'x-api-key: %s\n' "$MAXIMAL_API_KEY" \
    | curl -sS -m 5 --header @- "$BASE$API_PATH" -o "$TMP" -w "%{http_code}")
else
  CODE=$(curl -sS -m 5 "$BASE$API_PATH" -o "$TMP" -w "%{http_code}")
fi
if [[ "$CODE" != "200" ]]; then
  if [[ "$CODE" == "401" && -z "${MAXIMAL_API_KEY:-}" ]]; then
    echo "GET $API_PATH -> HTTP 401; set MAXIMAL_API_KEY to a configured Maximal API key" >&2
  else
    echo "GET $API_PATH -> HTTP $CODE" >&2
  fi
  exit 1
fi

# Pretty-print via Node ESM (stable, no jq dependency) and write the fixture.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
const data = JSON.parse(readFileSync(process.argv[1], "utf8"))
writeFileSync(process.argv[2], `${JSON.stringify(data, null, 2)}\n`)
' "$TMP" "$OUT"
echo "captured $API_PATH from :$PORT -> $OUT"
