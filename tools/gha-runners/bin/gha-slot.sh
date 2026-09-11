#!/usr/bin/env bash
# One runner "slot": forever, launch a fresh ephemeral VM from the runner
# image, hand it a just-in-time (single job) runner registration, wait for
# that job to finish, destroy the VM, repeat. Nothing a job does survives the
# job, and the host never executes job code.
#
# Env (from /srv/gha-runners/env/github.env + slots/<name>.env):
#   GITHUB_REPO   owner/repo to register against (e.g. FrameOS/frameos)
#   GITHUB_TOKEN  fine-grained PAT with repository "Administration: write"
#                 (or classic `repo` scope) — used ONLY on the host, never
#                 passed into the VM; the VM only ever sees the JIT config.
#   CPUS, MEMORY, DISK, LABELS  sizing + runner labels for this slot
#   GHA_IMAGE_ALIAS (gha-runner-noble), GHA_POOL (parallaize-lvm)
#   GHA_CACHE_DIR   host dir shared read-write into every VM at /mnt/cache
set -uo pipefail

SLOT=${1:?slot name}
: "${GITHUB_REPO:?}" "${GITHUB_TOKEN:?}"
CPUS=${CPUS:-8}; MEMORY=${MEMORY:-16GiB}; DISK=${DISK:-60GiB}
LABELS=${LABELS:-self-hosted,monster}
POOL=${GHA_POOL:-parallaize-lvm}; ALIAS=${GHA_IMAGE_ALIAS:-gha-runner-noble}
CACHE_DIR=${GHA_CACHE_DIR:-/srv/gha-runners/cache}
STOP_FLAG=/srv/gha-runners/stop
API=https://api.github.com/repos/${GITHUB_REPO}
BIN_DIR=$(cd "$(dirname "$0")" && pwd)

# Incus backs VM memory with a shared memfd (virtiofs needs it), and a page
# the guest has touched once stays resident on the host until the VM is
# destroyed — freeing it in the guest changes nothing on its own. With
# virtio-balloon free page reporting the guest hands freed pages back, so
# host usage follows what the guest holds now instead of its high-water
# mark. Measured 2026-09-11: a 4 G file written and deleted inside the guest
# left 5.0 G of host shmem pinned without this and 0.9 G with it. The guest
# side of the same problem (page cache is never freed) is gha-guest-trim.sh.
BALLOON_CONF=$'[device "qemu_balloon"]\nfree-page-reporting = "on"\n'

log() { echo "[$SLOT] $(date -u +%FT%TZ) $*"; }

jit_config() {
  # The runner name is the VM name, so a stuck runner in the GitHub UI maps
  # straight onto something `incus list` can show.
  local name=$1
  curl -fsS -X POST "$API/actions/runners/generate-jitconfig" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -d "$(jq -nc --arg n "$name" --arg l "$LABELS" \
          '{name:$n, runner_group_id:1, labels:($l|split(",")), work_folder:"/home/runner/work"}')" \
    | jq -r '.encoded_jit_config // empty'
}

while true; do
  if [ -e "$STOP_FLAG" ]; then log "stop flag present, idling"; sleep 30; continue; fi
  VM="gha-${SLOT}-$(date +%s | tail -c 6)$(tr -dc a-z0-9 </dev/urandom 2>/dev/null | head -c 3)"

  JIT=$(jit_config "$VM")
  if [ -z "$JIT" ]; then log "could not get a JIT runner config (token? repo?); retry in 60s"; sleep 60; continue; fi

  log "launching $VM (${CPUS} cpu, ${MEMORY}, labels ${LABELS})"
  # init → add devices → start: the shared cache (buildroot dl dir, ccache,
  # buildx cache — a plain host directory, so it survives every VM and never
  # touches the GitHub cache quota) is virtiofs, which cannot be hot-plugged
  # into a running VM.
  if ! incus init "$ALIAS" "$VM" --vm --ephemeral -s "$POOL" \
        -d root,size="$DISK" \
        -c limits.cpu="$CPUS" -c limits.memory="$MEMORY" \
        -c security.secureboot=false \
        -c raw.qemu.conf="$BALLOON_CONF" \
        -c user.gha-slot="$SLOT" >/dev/null; then
    log "init failed; retry in 30s"; sleep 30; continue
  fi
  [ -d "$CACHE_DIR" ] && incus config device add "$VM" cache disk source="$CACHE_DIR" path=/mnt/cache >/dev/null
  if ! incus start "$VM"; then
    log "start failed; destroying $VM"; incus delete -f "$VM" >/dev/null 2>&1; sleep 30; continue
  fi

  ok=0
  for _ in $(seq 1 90); do incus exec "$VM" -- true 2>/dev/null && { ok=1; break; }; sleep 2; done
  if [ "$ok" != 1 ]; then log "agent never came up; destroying $VM"; incus delete -f "$VM" >/dev/null 2>&1; sleep 10; continue; fi

  # The agent answers before the guest is actually ready: cloud-init still
  # has to grow the root filesystem to $DISK and docker is socket-activated.
  # A job that starts first would see a 40G disk and a missing docker.sock.
  incus exec "$VM" -- bash -c 'cloud-init status --wait >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done
    echo "docker did not come up" >&2; exit 1' \
    || { log "guest never became ready; destroying $VM"; incus delete -f "$VM" >/dev/null 2>&1; sleep 10; continue; }

  # Page-cache trimmer for the VM's lifetime (see the BALLOON_CONF comment);
  # it dies with the VM. Its stats are logged after the job.
  incus file push --mode 0755 "$BIN_DIR/gha-guest-trim.sh" "$VM/usr/local/bin/gha-guest-trim" >/dev/null 2>&1 \
    && incus exec "$VM" -- /usr/local/bin/gha-guest-trim 2>&1 | sed -u "s/^/[$SLOT:$VM trim] /" &

  # Run the runner for exactly one job, as the `runner` user via runuser so
  # it gets its real group list (docker!). The JIT config is passed over the
  # exec channel as an env var, not on a command line, so it is not visible
  # in the VM's process list either.
  log "guest ready, runner waiting for a job"
  incus exec "$VM" --env GHA_JIT="$JIT" -- \
    runuser -u runner --preserve-environment -- \
      env HOME=/home/runner USER=runner LOGNAME=runner \
      bash -c 'cd /home/runner/actions-runner && exec ./run.sh --jitconfig "$GHA_JIT"' \
    | sed -u "s/^/[$SLOT:$VM] /"
  log "job finished (runner exit ${PIPESTATUS[0]}); guest $(incus exec "$VM" -- cat /run/gha-trim.stats 2>/dev/null || echo 'trim stats unavailable'); destroying $VM"
  # --ephemeral deletes on stop; force in case the guest hung.
  incus delete -f "$VM" >/dev/null 2>&1 || true
  sleep 2
done
