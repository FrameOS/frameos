#!/usr/bin/env bash
# Runs as root INSIDE the image-build VM (gha-image-build.sh pushes it in), so
# every VM launched from the image starts with what a job would otherwise spend
# its first minute or two downloading. GitHub's cache answers the pool at
# 11-20 MB/s, so a pnpm store restore alone was 30-40 s of every job that
# installed node packages (measured 2026-11-14, PR #745's run).
#
# What lands here is a head start, never the truth: every workflow still runs
# its own `pnpm install`, `nimble install -d` and `uv pip install` against the
# checkout it is testing, which only fetch what this snapshot of main lacks. A
# stale image is a slower job, not a wrong one. The image is rebuilt nightly
# (gha-image-refresh.timer), so the gap is a day of main.
#
#   /opt/hostedtoolcache              RUNNER_TOOL_CACHE (the runner's .env); the
#                                     runner mounts it into container jobs at /__t
#     node/<22.x,24.x>/x64            found by actions/setup-node without a download
#     Python/3.12.x/x64               found by actions/setup-python (+ uv in it)
#     frameos-ci/pnpm-store           `pnpm fetch` of main's lockfile
#     frameos-ci/uv-cache             the backend requirements, as uv's wheels
#     frameos-ci/manifest.json        what was warmed, from which commit
#   ~runner/.choosenim/toolchains/nim-2.2.4 + ~runner/.nimble/{bin,pkgs2}
#                                     the layout jiro4989/setup-nim-action leaves,
#                                     so nimcache paths match GitHub-hosted runs
#   docker images                     the workflows' container/service images,
#                                     the deploy E2E's SSH target and the ESP32
#                                     legs' ESP-IDF toolchain
#
# .github/actions/frameos-ci-warm is the workflow side: it decides per job
# whether this is here and skips the GitHub cache steps when it is.
set -euxo pipefail

REPO_URL=${FRAMEOS_REPO_URL:-https://github.com/FrameOS/frameos.git}
REPO_REF=${FRAMEOS_REPO_REF:-main}
TC=/opt/hostedtoolcache
WARM=$TC/frameos-ci
SRC=/tmp/frameos-warm
export DEBIAN_FRONTEND=noninteractive

as_runner() {
  runuser -u runner -- env HOME=/home/runner USER=runner \
    RUNNER_TOOL_CACHE="$TC" AGENT_TOOLSDIRECTORY="$TC" PATH="$RUNNER_PATH" "$@"
}
RUNNER_PATH=/home/runner/.nimble/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

install -d -o runner -g runner "$TC" "$WARM"
# Anonymous git over HTTP/2 from the pool's address gets 401s from GitHub
# (the workflows set the same thing first).
as_runner git config --global http.https://github.com/.version HTTP/1.1
rm -rf "$SRC"
as_runner git clone -q --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC"
COMMIT=$(as_runner git -C "$SRC" rev-parse HEAD)

# --- node: the majors the workflows ask for ----------------------------------
NODE_INDEX=$(curl -fsSL https://nodejs.org/dist/index.json)
node_versions=()
for major in 22 24; do
  ver=$(jq -r --arg m "v$major." '[.[] | select(.version | startswith($m))][0].version' <<<"$NODE_INDEX")
  [ -n "$ver" ] && [ "$ver" != null ]
  dir="$TC/node/${ver#v}/x64"
  curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-linux-x64.tar.xz" -o /tmp/node.tar.xz
  curl -fsSL "https://nodejs.org/dist/$ver/SHASUMS256.txt" \
    | awk -v f="node-$ver-linux-x64.tar.xz" '$2 == f {print $1 "  /tmp/node.tar.xz"}' | sha256sum -c -
  as_runner mkdir -p "$dir"
  as_runner tar -xJf /tmp/node.tar.xz -C "$dir" --strip-components 1
  as_runner touch "$TC/node/${ver#v}/x64.complete"
  rm -f /tmp/node.tar.xz
  node_versions+=("${ver#v}")
done
NODE="$TC/node/${node_versions[0]}/x64/bin"

# --- Python 3.12, the way actions/setup-python installs it -------------------
read -r PY_VERSION PY_URL < <(curl -fsSL https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json \
  | jq -r '[.[] | select(.stable and (.version | startswith("3.12.")))][0]
           | .version as $v | .files[]
           | select(.platform == "linux" and .platform_version == "24.04" and .arch == "x64")
           | "\($v) \(.download_url)"')
rm -rf /tmp/python-dist && mkdir /tmp/python-dist && chown runner:runner /tmp/python-dist
curl -fsSL "$PY_URL" | as_runner tar -xz -C /tmp/python-dist
(cd /tmp/python-dist && as_runner bash ./setup.sh)
rm -rf /tmp/python-dist
PY="$TC/Python/$PY_VERSION/x64/bin"
as_runner "$PY/python" -m pip install -q --upgrade uv

# --- Nim, laid out like choosenim's toolchain dir ------------------------------
NIM_VERSION=2.2.4
NIM_DIR=/home/runner/.choosenim/toolchains/nim-$NIM_VERSION
nim_archive="ubuntu-24.04-amd64/nim-$NIM_VERSION.tar.gz"
nim_sha=$(awk -v p="$nim_archive" '$2 == p {print $1}' "$SRC/.github/nim-prebuilt.sha256")
[ -n "$nim_sha" ]
curl -fsSL "https://archive.frameos.net/prebuilt-deps/$nim_archive" -o /tmp/nim.tar.gz
echo "$nim_sha  /tmp/nim.tar.gz" | sha256sum -c -
rm -rf /tmp/nim-dist && mkdir /tmp/nim-dist && tar -xzf /tmp/nim.tar.gz -C /tmp/nim-dist
rm -rf "/tmp/nim-dist/nim-$NIM_VERSION/nim/bin"
as_runner mkdir -p "$NIM_DIR" /home/runner/.nimble/bin
cp -a "/tmp/nim-dist/nim-$NIM_VERSION/bin" "$NIM_DIR/bin"
cp -a "/tmp/nim-dist/nim-$NIM_VERSION/nim/." "$NIM_DIR/"
chown -R runner:runner /home/runner/.choosenim
for tool in "$NIM_DIR"/bin/*; do as_runner ln -sf "$tool" /home/runner/.nimble/bin/; done
rm -rf /tmp/nim-dist /tmp/nim.tar.gz
as_runner nim --version | head -1

# --- nimble packages of main's lock (frameos and the Remote) -------------------
(cd "$SRC/frameos" && as_runner nimble install -d -y >/dev/null)
(cd "$SRC/frameos/remote" && as_runner nimble install -d -y >/dev/null)

# --- the pnpm store of main's lockfile ------------------------------------------
PNPM_VERSION=$(jq -r '.packageManager | sub("^pnpm@"; "") | sub("\\+.*$"; "")' "$SRC/package.json")
as_runner env PATH="$NODE:$RUNNER_PATH" npm install -g -q --prefix /tmp/pnpm-tool "pnpm@$PNPM_VERSION"
(cd "$SRC" && as_runner env PATH="$NODE:$RUNNER_PATH" /tmp/pnpm-tool/bin/pnpm fetch \
  --store-dir "$WARM/pnpm-store" >/dev/null)
rm -rf /tmp/pnpm-tool

# --- backend requirements into uv's cache ---------------------------------------
# Under the tool cache, not ~/.cache/uv: container jobs have another HOME but
# get the tool cache mounted (setup-backend-python sets UV_CACHE_DIR to it).
as_runner "$PY/uv" venv -q --python "$PY/python" /tmp/warm-venv
(cd "$SRC/backend" && as_runner env UV_CACHE_DIR="$WARM/uv-cache" "$PY/uv" pip install -q \
  --python /tmp/warm-venv/bin/python --require-hashes -r requirements.txt)
rm -rf /tmp/warm-venv

# --- container images the workflows start ---------------------------------------
# The Playwright tag is whatever the frontend job names on main (bumped with
# @playwright/test); the rest are the services and the Dockerfile's base.
images=(postgres:17 redis:7-alpine python:3.12-slim-bookworm
        docker.io/tonistiigi/binfmt:latest moby/buildkit:buildx-stable-1)
while IFS= read -r image; do images+=("$image"); done < <(
  grep -ohE 'mcr\.microsoft\.com/playwright:v[0-9.]+-[a-z]+' "$SRC"/.github/workflows/*.yml | sort -u)
for image in "${images[@]}"; do docker pull -q "$image"; done
# The deploy E2E's SSH target, under the content tag its test computes.
ssh_target_tag=$(python3 "$SRC/backend/app/tasks/tests/deploy_ssh_target/context_tag.py")
docker build -q -t "$ssh_target_tag" "$SRC/backend/app/tasks/tests/deploy_ssh_target" >/dev/null
# The ESP32 legs' toolchain (ESP-IDF + QEMU, the Dockerfile's
# esp-idf-toolchain stage), under the tag the job computes from those lines.
# Built cold: the registry layer cache is a private package, and the image
# build has no token. Some minutes of a nightly build.
esp32_toolchain_tag=""
if [ -f "$SRC/embedded/esp32/ci_toolchain_image.sh" ]; then
  esp32_toolchain_tag=$(bash "$SRC/embedded/esp32/ci_toolchain_image.sh")
  docker build -q --target esp-idf-toolchain -t "$esp32_toolchain_tag" "$SRC" >/dev/null
fi

jq -n --arg commit "$COMMIT" --arg date "$(date -u +%FT%TZ)" --arg py "$PY_VERSION" \
  --arg pnpm "$PNPM_VERSION" --arg nim "$NIM_VERSION" --arg ssh "$ssh_target_tag" \
  --arg esp32 "$esp32_toolchain_tag" \
  --argjson node "$(printf '%s\n' "${node_versions[@]}" | jq -R . | jq -s .)" \
  --argjson images "$(printf '%s\n' "${images[@]}" | jq -R . | jq -s .)" \
  '{commit: $commit, built: $date, node: $node, python: $py, pnpm: $pnpm, nim: $nim,
    sshTarget: $ssh, esp32Toolchain: $esp32, images: $images}' > "$WARM/manifest.json"
chown runner:runner "$WARM/manifest.json"
rm -rf "$SRC"
cat "$WARM/manifest.json"
