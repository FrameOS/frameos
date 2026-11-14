# GitHub Actions runners on monster (ephemeral Incus VMs)

This directory is the source of truth for `/srv/gha-runners` on the Hetzner
host "monster" (EPYC 9454P, 48 cores / 96 threads, 251 GB, Ubuntu 24.04):
`tools/gha-runners/sync-to-host.sh` copies it there and reloads the pool.
The workflows pick these runners with the labels `epyc-32`, `epyc-16` and
`epyc-8` (`runs-on:` in `.github/workflows/*.yml`); fork pull requests stay
on GitHub-hosted runners.

Each enabled *slot* (`slots/<name>.env`) is a `gha-runner@<name>` systemd
service that loops: launch a fresh VM from the `gha-runner-noble` image,
register it as a single-job (JIT) runner, run one job, destroy the VM.

    sudo bin/gha-reload-slots.sh        # enable/restart/remove slots to match slots/
    journalctl -u gha-runner@big -f
    touch /srv/gha-runners/stop         # drain: finish current jobs, launch no more
    rm /srv/gha-runners/stop

Setup (once): put a token in `env/github.env` (`GITHUB_REPO=FrameOS/frameos`,
`GITHUB_TOKEN=` a fine-grained PAT with repository Administration: write —
it never enters a VM), then build the image:

    sudo bin/gha-image-build.sh

The image is **warm** (`bin/gha-image-warm.sh`, run inside the build VM):
node 22 and 24 and Python 3.12 in the runner's tool cache
(`/opt/hostedtoolcache`, `RUNNER_TOOL_CACHE` in the runner's `.env`, mounted
into container jobs at `/__t`), Nim 2.2.4 in choosenim's layout with main's
nimble packages, main's pnpm store and the backend's uv wheels under
`/opt/hostedtoolcache/frameos-ci`, and the container images the workflows
start (Playwright, postgres, redis, the Dockerfile's base, the deploy E2E's
SSH target, the ESP32 legs' ESP-IDF toolchain). GitHub's cache answers the
pool at 11-20 MB/s, so before this every job spent its first minute
downloading. The workflows' `.github/actions/setup-{nim,node-pnpm,
backend-python}` find it and skip the GitHub cache; everything still runs
its own `pnpm install` / `nimble install -d` / `uv pip install` against the
commit it tests, so a stale image is slower, never wrong.

It is kept current by `gha-image-refresh.timer` (nightly 03:00 UTC,
installed and enabled by `sync-to-host.sh`): `bin/gha-image-refresh.sh`
rebuilds when actions/runner has a newer release than the one in the image
(GitHub refuses jobs to a runner a month behind — the job logs warn first)
or when the image is 20 hours old (it carries main's dependencies), under a
staging alias, boots a VM from it to check the runner version, docker and
the warm tool cache, and only then re-points `gha-runner-noble`. New VM
launches use it at once; nothing needs a restart. `journalctl -u
gha-image-refresh` says what it did; `sudo bin/gha-image-refresh.sh --force`
rebuilds now, and a bare `bin/gha-image-build.sh` still works but swaps the
live alias untested. To try a change to the warming itself, build under
another alias from a pushed branch: `sudo env GHA_IMAGE_ALIAS=gha-runner-noble-test
FRAMEOS_REPO_REF=<branch> bin/gha-image-build.sh`.
`/srv/gha-runners/cache` is mounted into every VM at `/mnt/cache` — point
BR2_DL_DIR / ccache / buildx `type=local` caches there from the workflows.
It is **read-only unless a slot's `GHA_CACHE_WRITABLE` says otherwise**
(`bin/gha-slot.sh`): `all` on the epyc-32 slots, which only
`workflow_dispatch` release builds reach (the Buildroot ccache and downloads
under `buildroot/`); `nimcache ccache` on the epyc-16 slots, writable over
the read-only rest, for the Nim test shards' and renderer's nimcache and the
ESP32 legs' ccache (the workflows save them on pushes to main only, and
nothing a release ships reads them); nothing on epyc-8. Incus's
`readonly=true` makes the host-side mount read-only, so root inside the
guest (the runner has passwordless sudo) cannot remount it writable. A new
workflow that wants a writable cache gets its own subdirectory on the slots
it runs on, never a slot-wide `all` on a label pull requests reach.
Concurrent jobs share it, so a cache whose files must agree with each other
(the Nim tests' nimcache, whose `.o` is trusted when its `.c` matches) goes
through one archive per shard, not one directory everyone copies into:
`frameos/tools/ci_nimcache.sh`, under `nimcache/frameos-tests-archives`. Many
small files are what is slow over virtiofs, about 2 ms each: keep a large
cache here as one file. The older `nimcache/frameos-tests-snapshots` and
`nimcache/frameos-tests/shard-{1..8}` dirs serve only branches from before
these changes and can be deleted.
Runners carry labels `self-hosted,monster,epyc-32|epyc-16|epyc-8,linux,x64`
(the epyc-16 slots also `epyc-4`, for branches cut before they existed).

## Pool (since 2026-11-14)

| slots | label | shape | who uses it |
| --- | --- | --- | --- |
| big, big-b..d (4) | epyc-32 | 32 vCPU, 32 G, 120 G disk | Buildroot base images ("all" = 3 legs at once), release SD image |
| c16-a..aj (36) | epyc-16 (+ epyc-4) | 16 vCPU, 24 G, 80 G disk | every per-change job: 4 Nim shards, pixie, 2 renderer + 4 Playwright shards, backend tests, 2 deploy E2Es, 3 ESP32 legs, the Docker image, Cloud CI's verify + 4 integration legs |
| mid-a..j (10) | epyc-8 | 8 vCPU, 16 G, 60 G disk | 6 cross legs per frameos/** push and per release, the release's ESP32 firmware and amd64 runtime image |

50 slots, 784 vCPU nominal on 96 threads. A wide pull request fans out ~23
epyc-16 jobs (fewer when `.github/ci/changed_areas.py` skips what it cannot
affect), so a pull request next to a push to main fits the pool at once.

Why 16 vCPUs: the jobs are compiles and test runners that use every core
they get. With 28 four-vCPU slots a whole PR run took 11-12 minutes while
the host averaged ~10% CPU (sar, 2026-11-13 23:45-23:58 UTC) and the busiest
ten minutes of that week reached 55%. A VM's vCPUs are threads on the host:
an idle one costs nothing, and under contention the host shares its cores
anyway, so a bigger shape only ever helps the job that has the host to
itself. vCPUs are overcommitted on purpose; memory is the budget, and the
nominal sum is not the real one — read on.

## Memory model (measured 2026-09-11)

Incus backs every VM's memory with a **shared memfd** (`memory-backend-memfd
share=on`, needed by virtiofs for `/mnt/cache`). That memory shows up as
`Shmem` on the host, and the host can only reclaim it by swapping it —
there was 4 G of disk swap, full. Two things made the doubled 50-slot pool
OOM (29 `qemu-system-x86` kills in six days, each one a job that "lost
communication with the server"; `sar -r` bottomed at 0.8 G available):

1. **Without free page reporting the host cost of a VM is its high-water
   mark.** A page the guest touched once stayed resident until the VM was
   destroyed, whatever the guest did with it afterwards. Test: 4 G file
   written and deleted inside a 12 G guest, `drop_caches` → host shmem
   5.0 G before and *after*; a 3 G allocation freed → still 5.0 G.
2. **Jobs are page cache, not working set.** A Playwright shard that
   `incus list` showed at 5.4 G had 180 MB of anonymous memory and 5 G of
   clean cache (checkout, pnpm store, container layers). Every busy VM
   grew to its 12/16/24/48 G cap this way, and 50 idle VMs held 1.2 G each
   (60 G) for the cache their own boot left behind.

The fix is in `bin/gha-slot.sh` + `bin/gha-guest-trim.sh`:

- `raw.qemu.conf` adds `free-page-reporting = "on"` to Incus's
  `virtio-balloon-pci` device. Same test with it: 4.9 G during the write,
  **0.9 G** after the delete; 3.8 G during the allocation, **1.0 G** after.
  Host usage now follows what the guest holds, in seconds.
- The guest never frees clean page cache by itself, so `gha-guest-trim`
  runs inside every VM: drops cache once after boot, then every 15 s
  whenever it exceeds 2 G (tmpfs excluded — Chromium's `/dev/shm` is not
  droppable). It records the peak working set; the slot logs
  `guest peak used N MB excl. cache, peak cache N MB, N cache drops` after
  each job — use those numbers, not `incus list`, to size caps.

Caps are now a ceiling for the working set, not what a job costs: epyc-4
12 → 8 G, big 48 → 32 G, mid-a..d 24 → 16 G. First measurements (51
epyc-4 jobs — Nim shards, pixie and Playwright shards — and 4 Deploy E2E
jobs on the day of the change): epyc-4 peaks 1.5–3.3 G used, epyc-8
2.2–2.4 G; two full PR fan-outs at once (41 busy VMs) left the host at
138 G available with the swap untouched. The remaining backstop is
`host/zram-generator.conf`: 64 G of lz4 zram swap, priority above the disk
swap (`apt install systemd-zram-generator`, copy the file to
`/etc/systemd/zram-generator.conf`, `systemctl daemon-reload && systemctl
start systemd-zram-setup@zram0`). KSM is on but cannot merge shmem, so it
does nothing for the VMs.

Watch it with `free -g` (the `shared` column is the VMs) and
`sar -r -s HH:MM:00 -e HH:MM:00`; the first sign of trouble is
`kbavail` under ~30 G, the second is `journalctl -k | grep oom-kill`.

## Disk (measured 2026-11-14)

The VMs' disks are thin LVs in `parallaize-lvm`, whose single PV is a loop
device over one file on the root filesystem
(`/var/lib/incus/disks/parallaize-lvm.img`, 1.45 T on a 1.8 T `/`). Two
consequences:

- **The pool and `/` share the disk.** The thin pool passes discards down
  (`lvs -o discards`: passdown), so deleted VMs punch holes in that file and
  `/` shows the space as free; new VMs fill the holes again. On 2026-11-14
  the first runs of the 36 epyc-16 slots, two PR runs at once and an
  uncompressed 23 GB image tarball took `/` from 539 G free to 0 (the file
  back to fully allocated). Keep what else lands on `/` small: the image is
  published zstd-compressed, and the dead nimcache directories were removed.
  If `/` ever fills while the file has holes, the pool cannot allocate and
  dm-thin fails writes: `lvchange --discards nopassdown` keeps the file
  allocated (and `/` stable), moving the pool off the loop file removes the
  coupling. Check `df -h /` and `ls -ls` of the image file first.
- **Small-file reads are slow in a guest.** The loop device runs with direct
  IO (`losetup -l`: DIO 1), so nothing is cached on the host: reading the
  warm image's 61.5k-file pnpm store cold took 35 s, writing it back 10 s.
  Buffered loop IO (`losetup --direct-io=off`) was far slower still
  (minutes; reverted at once) and `io.cache=unsafe` only halves synced
  writes. What helps is fewer files: one archive per cache
  (`frameos/tools/ci_nimcache.sh`), links instead of copies (the pnpm store
  and uv cache sit beside the workspace so container jobs hardlink from
  them), and a page-cache threshold large enough that a job's hot files stay
  read (`GHA_TRIM_THRESHOLD_MB`, 4 G on epyc-16).

## Changing the pool

- Add/remove/resize a slot: edit `slots/`, run `sync-to-host.sh` (or copy and
  `sudo bin/gha-reload-slots.sh` on the host). A slot reads its env file
  only when its service starts, so idle slots are restarted for you; busy
  ones are listed — run it again when they are done.
- Keep the three shapes: the workflows only know the labels.
- Sizing rules: epyc-16 ≥ 23 (one wide PR), epyc-8 ≥ 8 (6 cross legs +
  the release's ESP32 and runtime jobs), epyc-32 ≥ 3 (a Buildroot "all").
  Before adding, check what the pool's peaks were (`journalctl -u
  'gha-runner@*' | grep 'guest peak'`) against `free -g`.

## Cleanup recipes

- A host/incusd restart under jobs leaves that cohort of ephemeral `gha-*`
  VMs STOPPED, each holding a thin LV: `incus list -c ns -f csv | grep
  STOPPED | cut -d, -f1 | xargs -r -n1 incus delete -f`.
- Offline JIT runner registrations on GitHub are cosmetic; prune names
  absent from `incus list` with `gh api -X DELETE
  repos/FrameOS/frameos/actions/runners/<id>`.
- A job whose runner "lost communication with the server": `gh run rerun
  <run> --failed` (not `--job`, which copies the other failed jobs into the
  new attempt without running them).

Security notes: the host never runs job code; VMs are ephemeral; "Require
approval for all outside collaborators" is on in the repo's Actions
settings, and fork PRs are routed to GitHub-hosted runners by the
workflows, so code nobody has reviewed neither runs here nor seeds the
nimcache the epyc-4 slots share.
