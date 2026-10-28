#!/usr/bin/env bash
# Build the signed apt repository served at https://mxml.sh/apt from the plan
# scripts/apt-repo-plan.ts writes (one suite per manifest channel).
#
#   build/linux/apt-repo.sh fetch <plan.json> <apt-root>   # needs GH_TOKEN, gh
#   build/linux/apt-repo.sh index <plan.json> <apt-root>   # needs apt-ftparchive
#   build/linux/apt-repo.sh sign  <apt-root> <public-key.asc>
#
# Layout (static files, GitHub Pages):
#   pool/main/<tag>/maximal_<ver>_<arch>.deb, maximal-desktop_<ver>_<arch>.deb
#   dists/<suite>/main/binary-{amd64,arm64}/Packages, Packages.gz, by-hash/
#   dists/<suite>/Release, InRelease, Release.gpg
#
# deploy-pages.yml runs fetch and index in its build job, without secrets, and
# sign in a separate job that alone can read them.
#
# `sign` reads the private key and its passphrase from APT_SIGNING_KEY and
# APT_SIGNING_KEY_PASSWORD, and refuses a key whose fingerprint isn't
# APT_SIGNING_KEY_FINGERPRINT or the committed public key's. Neither secret is
# echoed or passed on a command line; the key lives in a temporary GNUPGHOME.
set -euo pipefail

ARCHES=(amd64 arm64)
# GitHub Pages refuses files over 100 MB; stay clear of it.
MAX_DEB_BYTES=$((95 * 1024 * 1024))

die() {
  echo "::error::$*" >&2
  exit 1
}

suites() { jq -r '.suites[] | "\(.suite) \(.tag)"' "$1"; }

fetch() {
  local plan="$1" root="$2" suite tag deb dir size
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  while read -r suite tag; do
    dir="$root/pool/main/$tag"
    mkdir -p "$dir"
    while read -r deb; do
      [ -f "$dir/$deb" ] && continue
      gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$dir" \
        --pattern "$deb" --pattern "$deb.sha256"
      (cd "$dir" && sha256sum -c "$deb.sha256" >/dev/null) ||
        die "$deb from $tag doesn't match its .sha256"
      rm "$dir/$deb.sha256"
      size="$(stat -c %s "$dir/$deb")"
      if [ "$size" -gt "$MAX_DEB_BYTES" ]; then
        die "$deb is $((size / 1024 / 1024)) MB; GitHub Pages serves files up to 100 MB, and the apt repository allows 95 MB. Shrink the package before publishing it."
      fi
      echo "$suite: $deb ($((size / 1024 / 1024)) MB)"
    done < <(jq -r --arg tag "$tag" '.suites[] | select(.tag == $tag) | .debs[]' "$plan")
  done < <(suites "$plan")
}

index() {
  local plan="$1" root="$2" suite tag arch dist
  command -v apt-ftparchive >/dev/null || die "apt-ftparchive is missing (apt-utils)"
  while read -r suite tag; do
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
    # sets "Acquire-By-Hash: yes", so apt fetches indexes by immutable name and
    # a CDN serving a newer Packages beside an older Release can't cause a
    # "Hash Sum mismatch".
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
  done < <(suites "$plan")
}

primary_fingerprint() {
  gpg --batch --with-colons "$@" | awk -F: '$1 == "fpr" { print $10; exit }'
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
    gpg --batch --dearmor < "$pubkey" > "$GNUPGHOME/published.gpg"
    gpgv --quiet --keyring "$GNUPGHOME/published.gpg" "$dir/InRelease" 2>/dev/null ||
      die "$dir/InRelease doesn't verify against $pubkey"
    gpgv --quiet --keyring "$GNUPGHOME/published.gpg" "$dir/Release.gpg" "$release" 2>/dev/null ||
      die "$dir/Release.gpg doesn't verify against $pubkey"
    echo "signed $(basename "$dir")"
  done
}

command="${1:-}"
shift || true
case "$command" in
  fetch) fetch "$@" ;;
  index) index "$@" ;;
  sign) sign "$@" ;;
  *)
    echo "usage: $0 fetch|index <plan.json> <apt-root> | sign <apt-root> <public-key.asc>" >&2
    exit 2
    ;;
esac
