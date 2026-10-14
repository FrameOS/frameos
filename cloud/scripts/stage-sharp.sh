#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/stage-sharp.sh <stage dir>
#
# Called by deploy.sh on the assembled release bundle. sharp makes the photo
# thumbnails (apps/auth-web/src/lib/photos/thumbnail.ts) and is native: the
# box needs its linux-x64 (glibc) addon AND the libvips the addon loads
# through its rpath ($ORIGIN/../../sharp-libvips-linux-x64/lib).
#
# A bundle built on linux-x64 (the CI deploy) has both: pnpm installed them
# and next.config.ts traces libvips in. One built anywhere else (a laptop)
# has its own platform's, so the box's two packages are added here, at the
# versions this sharp names, next to sharp where its loader looks. Then the
# bundle is checked, and loaded for real when this host can run it. A bundle
# without them stores photos with no thumbnails, so it is refused.

stage="${1:?usage: stage-sharp.sh <stage dir>}"

sharp_modules=""
for candidate in "$stage"/node_modules/.pnpm/sharp@*/node_modules; do
  if [ -f "$candidate/sharp/package.json" ]; then
    sharp_modules="$candidate"
    break
  fi
done
if [ -z "$sharp_modules" ]; then
  echo "stage-sharp: sharp is not in the release bundle (photo thumbnails need it)" >&2
  exit 1
fi
sharp_package="$sharp_modules/sharp/package.json"
sharp_version="$(node -p 'require(process.argv[1]).version' "$sharp_package")"
libvips_version="$(node -p 'require(process.argv[1]).optionalDependencies["@img/sharp-libvips-linux-x64"]' "$sharp_package")"
addon="$sharp_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-$sharp_version.node"

if [ ! -e "$addon" ]; then
  echo "Adding sharp's linux-x64 build to the bundle (built on $(uname -sm))"
  fetch="$(mktemp -d)"
  (cd "$fetch" && npm pack --silent \
    "@img/sharp-linux-x64@$sharp_version" \
    "@img/sharp-libvips-linux-x64@$libvips_version" >/dev/null)
  for package in "sharp-linux-x64@$sharp_version" "sharp-libvips-linux-x64@$libvips_version"; do
    name="${package%@*}"
    rm -rf "${sharp_modules:?}/@img/$name"
    mkdir -p "$sharp_modules/@img/$name"
    tar -xzf "$fetch/img-$name-${package#*@}.tgz" -C "$sharp_modules/@img/$name" --strip-components=1
  done
  rm -rf "$fetch"
fi

if [ ! -f "$addon" ]; then
  echo "stage-sharp: sharp's linux-x64 addon is missing from the release bundle" >&2
  exit 1
fi
addon_dir="$(cd "$(dirname "$addon")" && pwd -P)"
if ! ls "$addon_dir"/../../sharp-libvips-linux-x64/lib/libvips-cpp.so.* >/dev/null 2>&1; then
  echo "stage-sharp: the release bundle has sharp's linux-x64 addon but not its libvips" >&2
  echo "  (apps/auth-web/next.config.ts outputFileTracingIncludes); photos would get no thumbnails" >&2
  exit 1
fi

if [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ]; then
  node -e '
    require(process.argv[1])({ create: { background: "#fff", channels: 3, height: 8, width: 8 } })
      .jpeg()
      .toBuffer()
      .catch((error) => { console.error(error.message); process.exit(1); });
  ' "$sharp_modules/sharp" || {
    echo "stage-sharp: sharp does not load from the release bundle; photos would get no thumbnails" >&2
    exit 1
  }
fi
