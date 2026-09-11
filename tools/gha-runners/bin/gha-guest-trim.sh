#!/usr/bin/env bash
# Runs as root inside a runner VM for the VM's whole life (gha-slot.sh pushes
# it in and starts it before the runner). Keeps the guest's page cache small
# and records what the job really needed.
#
# Why: the host backs VM memory with shared memfd (virtiofs needs that), and
# a page the guest has touched stays resident on the host until the guest
# reports it free (virtio-balloon free page reporting, enabled by
# gha-slot.sh). The guest kernel frees anonymous memory when a process exits
# but keeps clean page cache forever — so a job's checkout, pnpm store and
# nimcache would still grow the VM to its cap on the host, exactly the
# high-water mark this is meant to remove. Dropping clean cache past a
# threshold keeps the host cost at the working set plus the threshold; the
# guest re-reads from NVMe, which a minutes-long job never notices.
set -u
THRESHOLD_MB=${GHA_TRIM_THRESHOLD_MB:-2048}
INTERVAL=${GHA_TRIM_INTERVAL:-15}
STATS=/run/gha-trim.stats

drop() { sync; echo 1 > /proc/sys/vm/drop_caches; }

peak_used=0 peak_cache=0 drops=0
# Boot leaves a few hundred MB of cache behind that no job will read again.
drop
while true; do
  # Cached counts tmpfs/shm too (Chromium's /dev/shm), which drop_caches
  # cannot free — leave it out or a busy browser would trigger a drop every
  # tick for nothing.
  read -r used cache < <(awk '
    /^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} /^Cached:/ {c=$2} /^Shmem:/ {s=$2}
    END {printf "%d %d", (t-a)/1024, (c-s)/1024}' /proc/meminfo)
  [ "$used" -gt "$peak_used" ] && peak_used=$used
  [ "$cache" -gt "$peak_cache" ] && peak_cache=$cache
  if [ "$cache" -gt "$THRESHOLD_MB" ]; then drop; drops=$((drops + 1)); fi
  printf 'peak used %d MB excl. cache, peak cache %d MB, %d cache drops\n' \
    "$peak_used" "$peak_cache" "$drops" > "$STATS"
  sleep "$INTERVAL"
done
