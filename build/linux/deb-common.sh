# shellcheck shell=bash
# Shared helpers for the Debian packaging scripts in build/linux/. Sourced.

# The Debian version for a release version: a prerelease's first "-" becomes
# "~", so 0.5.0-rc.1 (0.5.0~rc.1) sorts before 0.5.0. The asset file names
# keep the release version; only the control field changes.
deb_version() {
  local version="$1"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    echo "not a release version: $version" >&2
    return 1
  fi
  printf "%s\n" "$version" | sed "s/-/~/"
}

check_arch() {
  case "$1" in
    amd64 | arm64) ;;
    *)
      echo "unsupported architecture: $1 (amd64 or arm64)" >&2
      return 1
      ;;
  esac
}

# Fail unless an ELF executable is built for the Debian architecture.
check_elf_arch() {
  local file="$1" arch="$2" machine
  # e_machine: 2 bytes at offset 18 (little-endian on both targets).
  machine="$(od -An -tx1 -j18 -N2 "$file" | tr -d ' \n')"
  case "$arch:$machine" in
    amd64:3e00 | arm64:b700) ;;
    *)
      echo "$file is not an $arch executable (e_machine $machine)" >&2
      return 1
      ;;
  esac
}

# Installed-Size in KiB for a staged package root (excluding DEBIAN/).
installed_size() {
  local root="$1"
  du -sk --apparent-size --exclude=DEBIAN "$root" | cut -f1
}
