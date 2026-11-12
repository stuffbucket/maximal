#!/usr/bin/env bash
# Boot (or stop) an isolated `maximal start` instance for UI verification.
#
# Isolated on purpose: its own port + throwaway COPILOT_API_HOME /
# CLAUDE_CONFIG_DIR, so it never disturbs a running menu-bar app or the user's
# real config. Serves the same on-disk shell/dist/ui the app uses.
#
# Usage:
#   preview.sh [PORT]           # build UI + boot; prints the URL
#   preview.sh --stop [PORT]    # stop the instance started for PORT
set -euo pipefail

PORT="4199"
STOP=0
for arg in "$@"; do
  case "$arg" in
    --stop) STOP=1 ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        PORT="$arg"
      else
        echo "unknown argument: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

STATE_DIR="/tmp/maximal-preview-${PORT}"
PIDFILE="${STATE_DIR}/pid"
LAUNCHERFILE="${STATE_DIR}/launcher"
IDENTITYFILE="${STATE_DIR}/identity"
LOGFILE="${STATE_DIR}/preview.log"
HOME_DIR="${STATE_DIR}/home"
CLAUDE_DIR="${STATE_DIR}/claude"

owns_preview_process() {
  local pid="$1"
  local command expected_identity identity
  [[ -f "$IDENTITYFILE" ]] || return 1
  expected_identity="$(<"$IDENTITYFILE")"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  identity="$(ps -p "$pid" -o lstart= 2>/dev/null || true)"
  [[ -n "$expected_identity"
    && "$identity" == "$expected_identity"
    && "$command" == *"src/main.ts start --port ${PORT}"* ]]
}

cleanup_state() {
  rm -rf "$STATE_DIR"
}

if [[ "$STOP" == "1" ]]; then
  if [[ ! -f "$PIDFILE" ]]; then
    if [[ -f "$LAUNCHERFILE" ]]; then
      LAUNCHER_PID="$(<"$LAUNCHERFILE")"
      if kill -0 "$LAUNCHER_PID" 2>/dev/null; then
        echo "preview startup is still in progress for port ${PORT}" >&2
        exit 1
      fi
    fi
    if [[ -d "$STATE_DIR" ]]; then
      cleanup_state
      echo "removed incomplete preview state for port ${PORT}; left the port untouched"
    else
      echo "no preview state for port ${PORT}; leaving the port untouched"
    fi
    exit 0
  fi

  PID="$(<"$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    if ! owns_preview_process "$PID"; then
      echo "refusing to stop pid ${PID}: it is not the preview for port ${PORT}" >&2
      exit 1
    fi
    kill "$PID"
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "preview did not stop; state retained at ${STATE_DIR}" >&2
      exit 1
    fi
  fi
  cleanup_state
  echo "stopped preview on port ${PORT}"
  exit 0
fi

# Claim the per-port state atomically before probing or building. Concurrent
# invocations cannot both proceed and mistake one preview for the other's.
if ! mkdir "$STATE_DIR" 2>/dev/null; then
  echo "preview state already exists for port ${PORT}; stop it before starting another" >&2
  exit 1
fi
chmod 700 "$STATE_DIR"
printf '%s\n' "$$" >"$LAUNCHERFILE"

# Refuse an occupied port before starting. This probes ownership without killing
# or otherwise disturbing the existing listener.
if ! node --input-type=module - "$PORT" <<'NODE'
import net from "node:net"

const port = Number(process.argv[2])
const server = net.createServer()
server.once("error", (error) => {
  console.error(`port ${port} is unavailable: ${error.message}`)
  process.exitCode = 1
})
server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close())
NODE
then
  cleanup_state
  exit 1
fi

mkdir -p "$HOME_DIR" "$CLAUDE_DIR"
chmod 700 "$HOME_DIR" "$CLAUDE_DIR"

ROOT="$(git rev-parse --show-toplevel)"
export HOME="$HOME_DIR"
export COPILOT_API_HOME="$HOME_DIR"
export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

# Build the UI from the current checkout so the preview reflects your edits.
( cd "$ROOT" && bun run build:ui >/dev/null )

# Detach the server and record only the process this script launched. `exec`
# replaces the background subshell, so the recorded PID belongs to Bun rather
# than to a shell wrapper whose command cannot prove preview ownership.
(
  cd "$ROOT"
  exec nohup bun run ./src/main.ts start --port "$PORT"
) </dev/null >"$LOGFILE" 2>&1 &
PID="$!"
IDENTITY="$(ps -p "$PID" -o lstart= 2>/dev/null || true)"
if [[ -z "$IDENTITY" ]]; then
  kill "$PID" 2>/dev/null || true
  echo "preview process identity could not be recorded; state retained at ${STATE_DIR}" >&2
  exit 1
fi
printf '%s\n' "$IDENTITY" >"$IDENTITYFILE"
printf '%s\n' "$PID" >"$PIDFILE"

# Wait for this process to serve Maximal's identity-bearing status payload.
for _ in $(seq 1 40); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  STATUS="$(curl -sS --fail --max-time 2 "http://127.0.0.1:${PORT}/status" 2>/dev/null || true)"
  if [[ "$STATUS" == *'"service":"maximal"'* ]]; then
    echo "preview ready: http://127.0.0.1:${PORT}/ui/settings/  (pid ${PID})"
    echo "  sections:  #account #general #apps #endpoint #api-clients #models #logs #diagnostics"
    echo "  stop with: $0 --stop ${PORT}"
    exit 0
  fi
  sleep 0.5
done

if kill -0 "$PID" 2>/dev/null && owns_preview_process "$PID"; then
  kill "$PID" 2>/dev/null || true
fi
echo "preview failed to start; see ${LOGFILE}" >&2
echo "preview state retained at ${STATE_DIR} for diagnostics" >&2
exit 1
