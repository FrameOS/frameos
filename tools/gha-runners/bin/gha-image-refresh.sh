#!/usr/bin/env bash
# Keep the runner VM image current without anyone remembering to.
#
# GitHub refuses jobs to a runner more than ~30 days behind the latest
# actions/runner release (the job log warns for a month first: "Runner
# Version X will no longer be able to run jobs on <date>"). The slots launch
# every VM from the `gha-runner-noble` image, and that image carries the
# runner version it was built with, so staying current is a matter of
# rebuilding the image — which is what gha-image-refresh.timer runs this
# script for, nightly. It rebuilds when the latest release differs from the
# one in the image, or when the image is older than GHA_IMAGE_MAX_AGE_HOURS
# (20, so last night's build is due again tonight: the image carries main's
# dependencies and toolchains, gha-image-warm.sh, so it should track main).
# `--force` rebuilds anyway.
#
# The rebuild never touches the alias the slots launch from until the new
# image has proven itself: gha-image-build.sh publishes it under a staging
# alias, a VM is booted from that and asked for its runner version and a
# working docker daemon, and only then is `gha-runner-noble` pointed at the
# new fingerprint (the previous image is deleted; running VMs keep their
# own root volume). A failure anywhere leaves the old image in place, the
# staging image deleted, and a non-zero exit for systemd to record —
# `journalctl -u gha-image-refresh` has the story. Slots need no restart:
# each launch reads the alias afresh (a launch that hits the millisecond
# between alias delete and create fails `incus init` and the slot retries
# in 30 s).
#
#   sudo /srv/gha-runners/bin/gha-image-refresh.sh [--force]
set -euo pipefail

POOL=${GHA_POOL:-parallaize-lvm}
ALIAS=${GHA_IMAGE_ALIAS:-gha-runner-noble}
STAGING="${ALIAS}-next"
MAX_AGE_HOURS=${GHA_IMAGE_MAX_AGE_HOURS:-20}
BIN_DIR=$(cd "$(dirname "$0")" && pwd)
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { echo "$(date -u +%FT%TZ) $*"; }
# `incus image list <name>` filters by substring, and the staging alias
# contains the production one, so images are looked up by exact alias.
image_json() { incus image list --format json | jq -c --arg a "$1" '[.[] | select(any(.aliases[]?; .name == $a))]'; }
image_fingerprint() { image_json "$1" | jq -r '.[0].fingerprint // empty'; }

latest=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | jq -r '.tag_name | ltrimstr("v")')
[ -n "$latest" ] && [ "$latest" != null ] || { log "could not resolve the latest runner release"; exit 1; }

# A staging image a failed run left behind is not the current image.
incus image delete "$STAGING" >/dev/null 2>&1 || true
current_json=$(image_json "$ALIAS")
current=$(jq -r '.[0].properties.runner_version // empty' <<<"$current_json")
if [ -z "$current" ]; then
  # Images from before the property: the description reads "... runner X, date".
  current=$(jq -r '.[0].properties.description // ""' <<<"$current_json" \
    | sed -n 's/.*runner \([0-9][0-9.]*\).*/\1/p')
fi
uploaded=$(jq -r '.[0].uploaded_at // empty | sub("\\.[0-9]+"; "")' <<<"$current_json")
age_hours=""
if [ -n "$uploaded" ]; then
  age_hours=$(( ( $(date -u +%s) - $(date -u -d "$uploaded" +%s) ) / 3600 ))
fi

reason=""
if [ -z "$current" ]; then
  reason="no $ALIAS image"
elif [ "$current" != "$latest" ]; then
  reason="runner $current in the image, $latest released"
elif [ -n "$age_hours" ] && [ "$age_hours" -ge "$MAX_AGE_HOURS" ]; then
  reason="image is $age_hours hours old"
elif [ "$FORCE" = 1 ]; then
  reason="--force"
fi
if [ -z "$reason" ]; then
  log "up to date: runner $current, image ${age_hours:-?} hours old"
  exit 0
fi
log "rebuilding $ALIAS: $reason"

cleanup() {
  incus delete -f "$SMOKE" >/dev/null 2>&1 || true
  # A staging image left behind by a failed run must not be taken for a good one.
  incus image delete "$STAGING" >/dev/null 2>&1 || true
}
SMOKE="gha-image-smoke-$$"
trap cleanup EXIT

RUNNER_VERSION="$latest" GHA_IMAGE_ALIAS="$STAGING" GHA_POOL="$POOL" "$BIN_DIR/gha-image-build.sh"

log "smoke-testing $STAGING"
incus launch "$STAGING" "$SMOKE" --vm --ephemeral -s "$POOL" \
  -c limits.cpu=2 -c limits.memory=4GiB -c security.secureboot=false >/dev/null
ok=0
for _ in $(seq 1 90); do incus exec "$SMOKE" -- true 2>/dev/null && { ok=1; break; }; sleep 2; done
[ "$ok" = 1 ] || { log "smoke VM never answered"; exit 1; }
# Same readiness the slots wait for: docker is socket-activated and the root
# filesystem is still being grown when the agent first answers.
incus exec "$SMOKE" -- bash -c 'for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1' \
  || { log "docker did not come up in the smoke VM"; exit 1; }
incus exec "$SMOKE" -- test -f /opt/hostedtoolcache/frameos-ci/manifest.json \
  || { log "the smoke VM has no warm tool cache"; exit 1; }
built=$(incus exec "$SMOKE" -- cat /home/runner/actions-runner/.version | tr -d '[:space:]')
[ "$built" = "$latest" ] || { log "smoke VM carries runner '$built', expected $latest"; exit 1; }
incus exec "$SMOKE" -- sudo -u runner /home/runner/actions-runner/bin/Runner.Listener --version >/dev/null \
  || { log "Runner.Listener does not start in the smoke VM"; exit 1; }
incus delete -f "$SMOKE" >/dev/null 2>&1 || true
log "smoke test passed: runner $built, docker up"

new=$(image_fingerprint "$STAGING")
old=$(image_fingerprint "$ALIAS")
[ -n "$new" ] || { log "no fingerprint for $STAGING"; exit 1; }
incus image alias delete "$ALIAS" >/dev/null 2>&1 || true
incus image alias create "$ALIAS" "$new"
incus image alias delete "$STAGING"
if [ -n "$old" ] && [ "$old" != "$new" ]; then
  incus image delete "$old" || log "could not delete the previous image $old (left in place)"
fi
log "$ALIAS now ${new:0:12} (runner $latest); new VM launches use it"
image_json "$ALIAS" | jq -r '.[0] | "\(.fingerprint[0:12])  \(.properties.description)"'
