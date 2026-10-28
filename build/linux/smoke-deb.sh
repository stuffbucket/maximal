#!/usr/bin/env bash
# Smoke-test the Linux packages in a clean container (Debian 13, Ubuntu 24.04,
# Ubuntu 26.04), as root:
#
#   docker run --rm -v "$PWD:/src:ro" -v "$DEBS:/debs:ro" debian:13 \
#     bash /src/build/linux/smoke-deb.sh <version> /debs
#
# <version> is the release version (0.5.0, 0.5.0-rc.1). /debs holds
# maximal_<version>_<arch>.deb and, unless MAXIMAL_SMOKE_SKIP_DESKTOP=1,
# maximal-desktop_<version>_<arch>.deb for this machine's architecture.
#
# Checks: both packages install with apt and pull in their dependencies;
# `maximal --version` prints the version; `maximal start` answers /status and
# /ui/settings/ on 127.0.0.1; an available update is logged with the apt command (the
# check reads a manifest served here, via the loopback-only test hook); the
# desktop package resolves its libraries and ships no copy of the binaries.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <version> <deb-dir>" >&2
  exit 2
fi
version="$1"
debs="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=build/linux/deb-common.sh
source "$here/deb-common.sh"

export DEBIAN_FRONTEND=noninteractive
arch="$(dpkg --print-architecture)"
debver="$(deb_version "$version")"
maximal_deb="$debs/maximal_${version}_${arch}.deb"
desktop_deb="$debs/maximal-desktop_${version}_${arch}.deb"
# shellcheck disable=SC1091
. /etc/os-release
step() { printf '\n== %s (%s %s, %s)\n' "$1" "$ID" "$VERSION_ID" "$arch"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The channel this build checks, as release.yml stamps it from the tag.
if [[ "$version" == *-* ]]; then
  channel="${version#*-}"
  channel="${channel%%.*}"
else
  channel="stable"
fi

work="$(mktemp -d)"
server_pid=""
manifest_pid=""
cleanup() {
  for pid in $server_pid $manifest_pid; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

step "Install maximal"
apt-get update -qq
# Copy out of a read-only mount: apt's sandbox user must be able to read it.
cp "$maximal_deb" "$work/"
apt-get install -y -qq "$work/$(basename "$maximal_deb")" curl python3 >/dev/null
[ "$(dpkg-query -W -f='${Version}' maximal)" = "$debver" ] ||
  fail "installed version is not $debver"
for path in /usr/bin/maximal /usr/bin/maximal-mcp-broker \
  /usr/lib/systemd/user/maximal.service /usr/lib/maximal/installed-by-apt; do
  [ -e "$path" ] || fail "missing $path"
done
[ -z "$(dpkg -L maximal | grep '^/etc/' || true)" ] || fail "maximal installs files under /etc"

step "maximal --version"
reported="$(maximal --version)"
echo "$reported"
[[ "$reported" == *"$version"* ]] || fail "maximal --version did not print $version"

step "Broker runs"
set +e
broker_out="$(maximal-mcp-broker 2>&1)"
broker_exit=$?
set -e
[ "$broker_exit" -eq 1 ] || fail "broker exited $broker_exit, expected 1"
[[ "$broker_out" == *BROKER_INTERNAL_ERROR* ]] || fail "broker printed no sanitized error"

# A manifest naming a newer version on this build's channel.
mkdir -p "$work/site/updates"
printf '{"schema":2,"channels":{"%s":{"version":"999.0.0","tag":"v999.0.0","notes":"x"}}}\n' \
  "$channel" > "$work/site/updates/manifest.json"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$work/site" \
  >"$work/manifest.log" 2>&1 &
manifest_pid=$!
export MAXIMAL_TEST_UPDATE_MANIFEST_URL="http://127.0.0.1:8765/updates/manifest.json"

# Start the proxy as a fresh user, wait for it, run the checks, stop it.
start_proxy() {
  local log="$1"
  HOME="$(mktemp -d)" HOST=127.0.0.1 maximal start --port 4141 >"$log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:4141/status >/dev/null 2>&1; then return 0; fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.5
  done
  cat "$log" >&2
  fail "maximal start did not answer /status"
}
wait_for_line() {
  local log="$1" line="$2"
  for _ in $(seq 1 40); do
    if grep -qF "$line" "$log"; then return 0; fi
    sleep 0.5
  done
  cat "$log" >&2
  fail "no log line: $line"
}
stop_proxy() {
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
}

step "maximal start"
start_proxy "$work/start.log"
curl -fsS http://127.0.0.1:4141/status | grep -q '"service":"maximal"' || fail "/status is not Maximal"
curl -fsSL http://127.0.0.1:4141/ui/settings/ | grep -qi "<html" || fail "/ui/settings/ served no page"
wait_for_line "$work/start.log" \
  "Maximal 999.0.0 is available: sudo apt update && sudo apt install --only-upgrade maximal"
curl -fsS http://127.0.0.1:4141/status | grep -q '"update_available":true' ||
  fail "/status does not report the update"
grep -F "is available" "$work/start.log"
stop_proxy

if [ "${MAXIMAL_SMOKE_SKIP_DESKTOP:-0}" = "1" ]; then
  echo "Skipping maximal-desktop (MAXIMAL_SMOKE_SKIP_DESKTOP=1)."
else
  step "Install maximal-desktop"
  cp "$desktop_deb" "$work/"
  apt-get install -y -qq "$work/$(basename "$desktop_deb")" >/dev/null
  dpkg-query -W -f='${Depends}\n' maximal-desktop | tee "$work/depends"
  grep -qF "maximal (= $debver)" "$work/depends" || fail "maximal-desktop does not depend on maximal (= $debver)"
  if dpkg -L maximal-desktop | grep -Ex '/usr/bin/maximal(-mcp-broker)?'; then
    fail "maximal-desktop ships its own copy of the binaries"
  fi
  [ -x /usr/bin/maximal-desktop ] || fail "missing /usr/bin/maximal-desktop"
  [ -e /usr/lib/maximal/desktop-installed-by-apt ] || fail "missing the desktop marker"
  missing="$(ldd /usr/bin/maximal-desktop | grep 'not found' || true)"
  [ -z "$missing" ] || fail "unresolved libraries: $missing"
  ls /usr/share/applications/*.desktop

  step "Update line names both packages"
  start_proxy "$work/start-desktop.log"
  wait_for_line "$work/start-desktop.log" \
    "Maximal 999.0.0 is available: sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop"
  stop_proxy
fi

step "Remove"
apt-get remove -y -qq maximal >/dev/null
[ ! -e /usr/bin/maximal ] || fail "/usr/bin/maximal remains after apt remove"
if dpkg-query -W -f='${Status}' maximal-desktop 2>/dev/null | grep -q '^install ok'; then
  fail "maximal-desktop stayed installed without maximal"
fi

echo
echo "OK: $ID $VERSION_ID $arch"
