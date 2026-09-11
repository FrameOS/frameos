# GitHub Actions runners on monster (ephemeral Incus VMs)

This directory is the source of truth for `/srv/gha-runners` on the Hetzner
host "monster" (EPYC 9454P, 48 cores / 96 threads, 251 GB, Ubuntu 24.04):
`tools/gha-runners/sync-to-host.sh` copies it there and reloads the pool.
The workflows pick these runners with the labels `epyc-32`, `epyc-8` and
`epyc-4` (`runs-on:` in `.github/workflows/*.yml`); fork pull requests stay
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

Rebuild the image whenever you want a newer actions-runner / toolchain.
`/srv/gha-runners/cache` is mounted into every VM at `/mnt/cache` — point
BR2_DL_DIR / ccache / buildx `type=local` caches there from the workflows.
Runners carry labels `self-hosted,monster,epyc-32|epyc-8|epyc-4,linux,x64`.

## Pool (since 2026-09-11)

| slots | label | shape | who uses it |
| --- | --- | --- | --- |
| big, big-b..d (4) | epyc-32 | 32 vCPU, 32 G, 120 G disk | Buildroot base images ("all" = 3 legs at once), release SD image |
| mid-a..j (10) | epyc-8 | 8 vCPU, 16 G, 60 G disk | 6 cross legs per frameos/** push and per release, ESP32 firmware, Deploy E2E SSH |
| small-a..ab (28) | epyc-4 | 4 vCPU, 8 G, 40 G disk | the 18 per-PR jobs: 8 Nim shards, 2 pixie visual shards, 8 Playwright shards |

42 slots, 336 vCPU nominal on 96 threads, 512 G nominal memory on 251 G.
One pull request fans out 18 epyc-4 + 1 epyc-8 and runs fully parallel; a
second run overlapping it queues only its tail. vCPUs are overcommitted on
purpose (most slots idle most of the time); memory is the budget, and the
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

## Changing the pool

- Add/remove/resize a slot: edit `slots/`, run `sync-to-host.sh` (or copy and
  `sudo bin/gha-reload-slots.sh` on the host). A slot reads its env file
  only when its service starts, so idle slots are restarted for you; busy
  ones are listed — run it again when they are done.
- Keep the three shapes: the workflows only know the labels.
- Sizing rules: total epyc-4 ≥ 18 (one PR), epyc-8 ≥ 8 (6 cross legs + a
  Deploy E2E + the ESP32 job), epyc-32 ≥ 3 (a Buildroot "all"). Before
  adding, check what the pool's peaks were (`journalctl -u 'gha-runner@*' |
  grep 'guest peak'`) against `free -g`.

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
workflows because every VM shares the writable `/mnt/cache`.
