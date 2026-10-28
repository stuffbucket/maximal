#!/usr/bin/env bash
# Build the signed apt repository served at https://mxml.sh/apt (one suite per
# updates-manifest channel; scripts/apt-repo-plan.ts decides which).
#
#   build/linux/apt-repo.sh fetch  <apt-root> <manifest.json> <suite=tag>...
#   build/linux/apt-repo.sh index  <apt-root> <suite=tag>...
#   build/linux/apt-repo.sh sign   <apt-root> <public-key.asc>
#   build/linux/apt-repo.sh verify <apt-root> <public-key.asc>
#
# Layout (static files, GitHub Pages):
#   pool/main/<tag>/maximal_<ver>_<arch>.deb, maximal-desktop_<ver>_<arch>.deb
#   dists/<suite>/main/binary-{amd64,arm64}/Packages, Packages.gz, by-hash/
#   dists/<suite>/Release, InRelease, Release.gpg
#
# deploy-pages.yml runs fetch, index and sign in its sign-apt job, which runs
# no project dependencies, so nothing but this script and GitHub's release
# assets shapes what gets signed; deploy runs verify before publishing.
#
# fetch re-checks every suite=tag against the manifest, so a plan can only
# name the releases the manifest names, then downloads that release's four
# packages and checks each against the release's own .sha256 asset.
#
# sign reads the private key and its passphrase from APT_SIGNING_KEY and
# APT_SIGNING_KEY_PASSWORD, and refuses a key whose fingerprint isn't
# APT_SIGNING_KEY_FINGERPRINT or the committed public key's. Neither secret is
# echoed or passed on a command line; the key lives in a temporary GNUPGHOME.
set -euo pipefail

ARCHES=(amd64 arm64)
PACKAGES=(maximal maximal-desktop)
SUITES=(stable rc)
TAG_RE='^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$'
# GitHub Pages refuses files over 100 MB; stay clear of it.
MAX_DEB_BYTES=$((95 * 1024 * 1024))

die() {
  echo "::error::$*" >&2
  exit 1
}

# Split "suite=tag", check both, and set $suite, $tag and $version.
parse_suite() {
  suite="${1%%=*}"
  tag="${1#*=}"
  [[ " ${SUITES[*]} " == *" $suite "* ]] || die "unknown suite '$suite' (stable or rc)"
  [[ "$tag" =~ $TAG_RE ]] || die "'$tag' isn't a release tag"
  version="${BASH_REMATCH[1]}"
}

# The package files a release built from $version carries.
debs_for() {
  local pkg arch
  for pkg in "${PACKAGES[@]}"; do
    for arch in "${ARCHES[@]}"; do
      printf '%s_%s_%s.deb\n' "$pkg" "$1" "$arch"
    done
  done
}

fetch() {
  local root="$1" manifest="$2" spec suite tag version listed deb dir size
  shift 2
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  [ "$#" -gt 0 ] || die "fetch needs at least one suite=tag"
  for spec in "$@"; do
    parse_suite "$spec"
    listed="$(jq -r --arg s "$suite" '.channels[$s].tag // ""' "$manifest")"
    [ "$listed" = "$tag" ] ||
      die "The manifest's $suite channel names '$listed', not $tag; refusing to build $suite from it."
    dir="$root/pool/main/$tag"
    mkdir -p "$dir"
    while read -r deb; do
      [ -f "$dir/$deb" ] && continue
      gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$dir" \
        --pattern "$deb" --pattern "$deb.sha256"
      (cd "$dir" && sha256sum -c --strict "$deb.sha256" >/dev/null) ||
        die "$deb from $tag doesn't match its .sha256"
      rm "$dir/$deb.sha256"
      size="$(stat -c %s "$dir/$deb")"
      if [ "$size" -gt "$MAX_DEB_BYTES" ]; then
        die "$deb is $((size / 1024 / 1024)) MB; GitHub Pages serves files up to 100 MB, and the apt repository allows 95 MB. Shrink the package before publishing it."
      fi
      echo "$suite: $deb ($((size / 1024 / 1024)) MB)"
    done < <(debs_for "$version")
  done
}

index() {
  local root="$1" spec suite tag version arch dist
  shift
  command -v apt-ftparchive >/dev/null || die "apt-ftparchive is missing (apt-utils)"
  [ "$#" -gt 0 ] || die "index needs at least one suite=tag"
  for spec in "$@"; do
    parse_suite "$spec"
    dist="$root/dists/$suite"
    rm -rf "$dist"
    for arch in "${ARCHES[@]}"; do
      mkdir -p "$dist/main/binary-$arch"
      # Filename: is relative to the repository root, so run from there.
      (cd "$root" && apt-ftparchive --arch "$arch" packages "pool/main/$tag") \
        > "$dist/main/binary-$arch/Packages"
      grep -q '^Package: maximal$' "$dist/main/binary-$arch/Packages" ||
        die "$suite has no maximal package for $arch"
      gzip -9nk "$dist/main/binary-$arch/Packages"
    done
    # Written beside, then moved in, so Release doesn't list itself.
    # DoByHash also writes each index under by-hash/<algorithm>/<digest> and
    # sets "Acquire-By-Hash: yes". Each deploy replaces the whole site, so the
    # previous deploy's by-hash files are gone; what this guards against is a
    # client fetching the new InRelease while a CDN edge still has the old
    # Packages: it asks for the by-hash name, which can only be the new file.
    apt-ftparchive \
      -o APT::FTPArchive::DoByHash=true \
      -o APT::FTPArchive::Release::Origin=Maximal \
      -o APT::FTPArchive::Release::Label=Maximal \
      -o "APT::FTPArchive::Release::Suite=$suite" \
      -o "APT::FTPArchive::Release::Codename=$suite" \
      -o "APT::FTPArchive::Release::Architectures=${ARCHES[*]}" \
      -o APT::FTPArchive::Release::Components=main \
      -o "APT::FTPArchive::Release::Description=Maximal ($suite)" \
      release "$dist" > "$root/Release.tmp"
    mv "$root/Release.tmp" "$dist/Release"
    grep -qx 'Acquire-By-Hash: yes' "$dist/Release" || die "$suite's Release lacks Acquire-By-Hash"
    for arch in "${ARCHES[@]}"; do
      [ -f "$dist/main/binary-$arch/by-hash/SHA256/$(sha256sum < "$dist/main/binary-$arch/Packages.gz" | cut -d' ' -f1)" ] ||
        die "$suite has no by-hash copy of its $arch Packages.gz"
    done
    echo "indexed $suite ($tag)"
  done
}

primary_fingerprint() {
  gpg --batch --with-colons "$@" | awk -F: '$1 == "fpr" { print $10; exit }'
}

# A keyring file with just the published public key, for gpgv.
published_keyring() {
  local pubkey="$1" keyring="$2"
  gpg --batch --dearmor < "$pubkey" > "$keyring"
}

sign() {
  local root="$1" pubkey="$2" expected fpr pub_fpr release dir
  [ -n "${APT_SIGNING_KEY:-}" ] || die "APT_SIGNING_KEY is not set"
  [ -n "${APT_SIGNING_KEY_PASSWORD:-}" ] || die "APT_SIGNING_KEY_PASSWORD is not set"
  expected="${APT_SIGNING_KEY_FINGERPRINT:-}"
  [ -n "$expected" ] || die "APT_SIGNING_KEY_FINGERPRINT is not set"

  GNUPGHOME="$(mktemp -d)"
  export GNUPGHOME
  chmod 700 "$GNUPGHOME"
  trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT

  printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null ||
    die "APT_SIGNING_KEY isn't an importable private key"
  fpr="$(primary_fingerprint --list-secret-keys)"
  [ "$fpr" = "$expected" ] ||
    die "The signing key is $fpr, not APT_SIGNING_KEY_FINGERPRINT ($expected)."
  pub_fpr="$(primary_fingerprint --show-keys "$pubkey")"
  [ "$pub_fpr" = "$expected" ] ||
    die "$pubkey is $pub_fpr, not the signing key ($expected); users couldn't verify the repository."
  published_keyring "$pubkey" "$GNUPGHOME/published.gpg"

  for release in "$root"/dists/*/Release; do
    dir="$(dirname "$release")"
    rm -f "$dir/InRelease" "$dir/Release.gpg"
    gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --local-user "$expected!" --digest-algo SHA512 \
      --clearsign --output "$dir/InRelease" "$release" \
      3< <(printf '%s' "$APT_SIGNING_KEY_PASSWORD")
    gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --local-user "$expected!" --digest-algo SHA512 \
      --armor --detach-sign --output "$dir/Release.gpg" "$release" \
      3< <(printf '%s' "$APT_SIGNING_KEY_PASSWORD")
    # Verify the way apt will: against the published public key only.
    gpgv --quiet --keyring "$GNUPGHOME/published.gpg" "$dir/InRelease" 2>/dev/null ||
      die "$dir/InRelease doesn't verify against $pubkey"
    gpgv --quiet --keyring "$GNUPGHOME/published.gpg" "$dir/Release.gpg" "$release" 2>/dev/null ||
      die "$dir/Release.gpg doesn't verify against $pubkey"
    echo "signed $(basename "$dir")"
  done
}

# Before publishing: every suite is signed by the published key, and every
# package its indexes name is in the pool with the checksum they record.
verify() {
  local root="$1" pubkey="$2" release dir packages filename sha count=0
  # Global, not local: the EXIT trap runs after this function returns.
  VERIFY_HOME="$(mktemp -d)"
  local home="$VERIFY_HOME"
  chmod 700 "$home"
  trap 'rm -rf "$VERIFY_HOME"' EXIT
  GNUPGHOME="$home" published_keyring "$pubkey" "$home/published.gpg"

  shopt -s nullglob
  local releases=("$root"/dists/*/Release)
  [ "${#releases[@]}" -gt 0 ] || die "The apt repository has no suites."
  for release in "${releases[@]}"; do
    dir="$(dirname "$release")"
    for file in InRelease Release.gpg; do
      [ -s "$dir/$file" ] || die "$dir has no $file; not deploying an unsigned apt repository."
    done
    GNUPGHOME="$home" gpgv --quiet --keyring "$home/published.gpg" "$dir/InRelease" 2>/dev/null ||
      die "$dir/InRelease isn't signed by $pubkey"
    GNUPGHOME="$home" gpgv --quiet --keyring "$home/published.gpg" "$dir/Release.gpg" "$release" 2>/dev/null ||
      die "$dir/Release.gpg isn't a signature of its Release by $pubkey"
    for packages in "$dir"/main/binary-*/Packages; do
      while read -r filename sha; do
        [ -f "$root/$filename" ] || die "$packages names $filename, which isn't in the pool."
        [ "$(sha256sum < "$root/$filename" | cut -d' ' -f1)" = "$sha" ] ||
          die "$filename doesn't match the SHA256 in $packages."
        count=$((count + 1))
      done < <(awk '/^Filename: /{f=$2} /^SHA256: /{print f, $2}' "$packages")
    done
  done
  [ "$count" -gt 0 ] || die "The apt repository lists no packages."
  echo "verified ${#releases[@]} suite(s), $count package entries"
}

command="${1:-}"
shift || true
case "$command" in
  fetch) fetch "$@" ;;
  index) index "$@" ;;
  sign) sign "$@" ;;
  verify) verify "$@" ;;
  *)
    echo "usage: $0 fetch <apt-root> <manifest.json> <suite=tag>... | index <apt-root> <suite=tag>... | sign|verify <apt-root> <public-key.asc>" >&2
    exit 2
    ;;
esac
