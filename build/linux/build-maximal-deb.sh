#!/usr/bin/env bash
# Build the `maximal` Debian package (CLI, proxy, MCP broker) from the release
# binaries.
#
#   build/linux/build-maximal-deb.sh <version> <arch> <bin-dir> <out-dir>
#
# <version> is the release version without the leading v (0.5.0, 0.5.0-rc.1);
# <arch> is amd64 or arm64; <bin-dir> holds the compiled `maximal` and
# `maximal-mcp-broker`. Writes <out-dir>/maximal_<version>_<arch>.deb.
#
# The package installs:
#   /usr/bin/maximal, /usr/bin/maximal-mcp-broker
#   /usr/lib/systemd/user/maximal.service   (not enabled)
#   /usr/lib/maximal/installed-by-apt       (tells maximal to offer apt updates)
#   /usr/share/doc/maximal/                 (copyright)
# and nothing under /etc. maximal-desktop's tray app runs /usr/bin/maximal as
# its sidecar, so this package is the only one that ships the binaries.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <version> <arch> <bin-dir> <out-dir>" >&2
  exit 2
fi
version="$1"
arch="$2"
bindir="$3"
outdir="$4"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=build/linux/deb-common.sh
source "$here/deb-common.sh"

check_arch "$arch"
debver="$(deb_version "$version")"
for binary in maximal maximal-mcp-broker; do
  if [ ! -f "$bindir/$binary" ]; then
    echo "missing $bindir/$binary" >&2
    exit 1
  fi
  check_elf_arch "$bindir/$binary" "$arch"
done

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
root="$stage/maximal"
install -d -m 0755 \
  "$root/DEBIAN" \
  "$root/usr/bin" \
  "$root/usr/lib/systemd/user" \
  "$root/usr/lib/maximal" \
  "$root/usr/share/doc/maximal"
install -m 0755 "$bindir/maximal" "$root/usr/bin/maximal"
install -m 0755 "$bindir/maximal-mcp-broker" "$root/usr/bin/maximal-mcp-broker"
install -m 0644 "$here/maximal.service" "$root/usr/lib/systemd/user/maximal.service"
printf 'maximal\n' > "$root/usr/lib/maximal/installed-by-apt"
chmod 0644 "$root/usr/lib/maximal/installed-by-apt"

{
  printf 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n'
  printf 'Upstream-Name: maximal\n'
  printf 'Source: https://github.com/stuffbucket/maximal\n\n'
  printf 'Files: *\n'
  printf 'Copyright: see below\n'
  printf 'License: MIT\n'
  # DEP-5 continuation lines: indent, and "." for blank lines.
  sed -e 's/^$/./' -e 's/^/ /' "$repo/LICENSE"
  printf '\nComment: third-party notices follow.\n'
  sed -e 's/^$/./' -e 's/^/ /' "$repo/THIRD-PARTY-LICENSE"
} > "$root/usr/share/doc/maximal/copyright"
chmod 0644 "$root/usr/share/doc/maximal/copyright"

cat > "$root/DEBIAN/control" <<EOF
Package: maximal
Version: $debver
Architecture: $arch
Maintainer: stuffbucket <apt@mxml.sh>
Installed-Size: $(installed_size "$root")
Depends: libc6 (>= 2.39)
Section: utils
Priority: optional
Homepage: https://mxml.sh
Description: local proxy to the models in GitHub Copilot
 Maximal connects AI tools such as Claude Code, Codex and opencode to the
 models in your GitHub Copilot subscription. This package has the command
 line, the proxy and the MCP broker. Run it as a user service with
 "systemctl --user enable --now maximal", or install maximal-desktop for
 the tray app.
EOF

mkdir -p "$outdir"
out="$outdir/maximal_${version}_${arch}.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$out" >/dev/null
echo "built $out ($debver, $(du -h "$out" | cut -f1))"
