#!/bin/bash
# The Pico firmware's apt packages, for action.yml. `plan` refreshes the package
# lists and names the cache for what they ask for; `install` installs from the
# restored .debs and downloads only what is missing.
#
# apt only compares the size of a .deb it finds in its folder, so a same-size
# tampered file would be installed, and the release job builds with this. `verify`
# below checks each one against the hashes in the archive's signed lists first.
set -euo pipefail

PACKAGES=(
  cmake
  ninja-build
  gcc-arm-none-eabi
  libnewlib-arm-none-eabi
  libstdc++-arm-none-eabi-newlib
)
ARCHIVES="${PICO_APT_ARCHIVES:-$HOME/pico-apt}"
ATTEMPTS=3
UPDATE_SECONDS="${PICO_APT_UPDATE_SECONDS:-120}"
# A mirror has held this download for over 50 minutes. apt keeps what it has, so
# the next attempt resumes it, on a new connection.
DOWNLOAD_SECONDS="${PICO_APT_DOWNLOAD_SECONDS:-420}"

APT_OPTIONS=(
  -o Acquire::http::Timeout=30
  -o Acquire::Retries=3
  # The folder belongs to the runner's user, and _apt can't reach into its home.
  -o APT::Sandbox::User=root
  -o "Dir::Cache::archives=$ARCHIVES"
)

apt_get() {
  sudo env DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTIONS[@]}" "$@"
}

# Only for steps that are safe to kill: never around unpacking.
with_retries() {
  local seconds=$1
  shift
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if sudo env DEBIAN_FRONTEND=noninteractive timeout "$seconds" \
      apt-get "${APT_OPTIONS[@]}" "$@"; then
      return 0
    fi
    echo "apt-get $1: attempt $attempt of $ATTEMPTS did not finish within ${seconds}s" >&2
  done
  echo "::error::apt-get $1 did not finish after $ATTEMPTS attempts of ${seconds}s. The Ubuntu mirror is probably slow: re-run the job." >&2
  return 1
}

plan() {
  mkdir -p "$ARCHIVES"
  with_retries "$UPDATE_SECONDS" update
  local release wanted
  release=$(. /etc/os-release && echo "$VERSION_ID")
  wanted=$(apt_get install -s --no-install-recommends "${PACKAGES[@]}" | grep '^Inst ' | sort | sha256sum | cut -c1-16)
  echo "key=pico-apt-$release-$wanted" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "restore-key=pico-apt-$release-" >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

# Keeps the cached .debs that match the signed lists, and drops all others:
# a bad file, or a version nothing asks for any more.
verify() {
  local empty name package version digest wanted=" " file
  empty=$(mktemp -d)
  mkdir "$empty/partial"
  # --print-uris names the files; its hash is only an MD5, so the SHA256 comes
  # from apt-cache. A name is package_version_arch, with the epoch's : as %3a.
  while read -r _ name _; do
    wanted+="$name "
    file="$ARCHIVES/$name"
    [ -f "$file" ] || continue
    package=${name%%_*}
    version=${name#*_}
    version=${version%_*}
    digest=$(apt-cache show "$package=${version//%3a/:}" | awk '$1 == "SHA256:" { print $2; exit }')
    if [ -z "$digest" ] || ! echo "$digest  $file" | sha256sum --check --status; then
      echo "Dropping $name from the cache: it does not match the archive's hash"
      rm -f "$file"
    fi
  done < <(apt_get -o "Dir::Cache::archives=$empty" install -y -qq --print-uris --no-install-recommends "${PACKAGES[@]}")
  sudo rm -rf "$empty"
  for file in "$ARCHIVES"/*.deb; do
    [ -f "$file" ] || continue
    case "$wanted" in
      *" ${file##*/} "*) ;;
      *) rm -f "$file" ;;
    esac
  done
}

install() {
  mkdir -p "$ARCHIVES/partial"
  verify
  echo "Usable from the cache: $(du -sh "$ARCHIVES" | cut -f1)"
  with_retries "$DOWNLOAD_SECONDS" install -y --download-only --no-install-recommends "${PACKAGES[@]}"
  apt_get install -y --no-install-recommends "${PACKAGES[@]}"
  # What goes back in the cache has to be readable by the runner's user.
  sudo rm -rf "$ARCHIVES/partial" "$ARCHIVES/lock"
  sudo chown -R "$(id -u):$(id -g)" "$ARCHIVES"
}

case "${1:-}" in
  plan) plan ;;
  install) install ;;
  *)
    echo "usage: $0 plan|install" >&2
    exit 2
    ;;
esac
