#!/usr/bin/env bash
# Turn the Debian package `tauri build --bundles deb` writes into
# maximal-desktop_<version>_<arch>.deb.
#
#   build/linux/repack-desktop-deb.sh <version> <arch> <tauri-deb> <out-dir>
#
# shell/src-tauri/tauri.linux.conf.json already names the binary
# /usr/bin/maximal-desktop, adds the tray library and installs the apt marker;
# the release build passes `bundle.externalBin: []` so no sidecar is bundled.
# This script sets what Tauri can't: the package name, the Debian version
# (0.5.0-rc.1 becomes 0.5.0~rc.1 so it sorts before 0.5.0), and the exact
# dependency on the `maximal` package whose /usr/bin/maximal the app runs as
# its sidecar (it looks next to its own executable). It fails if the package
# would ship its own copy of either binary.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <version> <arch> <tauri-deb> <out-dir>" >&2
  exit 2
fi
version="$1"
arch="$2"
input="$3"
outdir="$4"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=build/linux/deb-common.sh
source "$here/deb-common.sh"

check_arch "$arch"
debver="$(deb_version "$version")"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
root="$stage/maximal-desktop"
dpkg-deb -R "$input" "$root"

for path in usr/bin/maximal usr/bin/maximal-mcp-broker; do
  if [ -e "$root/$path" ]; then
    echo "$input ships /$path; build it with bundle.externalBin set to []" >&2
    exit 1
  fi
done
[ -x "$root/usr/bin/maximal-desktop" ] || {
  echo "$input has no /usr/bin/maximal-desktop (mainBinaryName)" >&2
  exit 1
}
[ -f "$root/usr/lib/maximal/desktop-installed-by-apt" ] || {
  echo "$input has no /usr/lib/maximal/desktop-installed-by-apt" >&2
  exit 1
}
check_elf_arch "$root/usr/bin/maximal-desktop" "$arch"
built_arch="$(sed -n 's/^Architecture: //p' "$root/DEBIAN/control")"
[ "$built_arch" = "$arch" ] || {
  echo "$input is for $built_arch, not $arch" >&2
  exit 1
}

control="$root/DEBIAN/control"
awk -v debver="$debver" -v size="$(installed_size "$root")" '
  /^Package:/ { print "Package: maximal-desktop"; next }
  /^Version:/ { print "Version: " debver; next }
  /^Installed-Size:/ { print "Installed-Size: " size; next }
  /^Depends:/ { print $0 ", maximal (= " debver ")"; depends = 1; next }
  { print }
  END { if (!depends) exit 3 }
' "$control" > "$stage/control"
mv "$stage/control" "$control"
chmod 0644 "$control"
if ! grep -q '^Installed-Size:' "$control"; then
  sed -i "/^Architecture:/a Installed-Size: $(installed_size "$root")" "$control"
fi

# File list changed from Tauri's; keep md5sums accurate.
(cd "$root" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' |
  sort -z | xargs -0 md5sum) > "$root/DEBIAN/md5sums"
chmod 0644 "$root/DEBIAN/md5sums"

mkdir -p "$outdir"
out="$outdir/maximal-desktop_${version}_${arch}.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$out" >/dev/null
echo "built $out ($debver)"
dpkg-deb -f "$out" Package Version Architecture Depends
