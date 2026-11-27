---
name: frame-bench
description: Bench every FrameOS frame attached to this machine (ESP32 boards and Pico thin clients on USB, Raspberry Pi frames over SSH, attached to a local backend) — scenes, layouts and desktop windows, input, switch storms, memory soak, offline backend, reboots, server rendering — and report crashes, OOMs, slow paths and regressions. Use when asked to "bench the frames", check that a firmware change keeps working on real hardware, or compare against an earlier run.
---

# Frame bench

`tools/frame-bench/bench.py` drives every frame on this machine's USB through
its serial console, every Linux frame (a Raspberry Pi) listed for it over SSH,
and the backend they are attached to, and writes a report of
everything that crashed, failed, ran slow or took a slower path than before.

## Booking a board

The boards are shared by every Claude session on this machine, and one
session's console, flash or push breaks another's work on the same board (a
flash restarts it; on 2026-11-20 a session reflashed five boards two others
were testing on). So **book a board before you touch it, in any way**: open
its console (`usb_api`, `scene`, `event`), flash it, push to its backend frame,
bench it. The bookings are one file, `~/.frameos-bench/BOOKINGS.md` (Markdown:
read it as it is), written only through the helper, which locks it:

```
tools/frame-bench/boards.py                       # every board: free, booked (who, until, what for) or lapsed
tools/frame-bench/boards.py book sticky,e1003 --who "frameos-16 (desktop-consistency, PR #920)" --for "flash + desktop suite" --hours 2
tools/frame-bench/boards.py book all --who ... --for ... --partial   # the free ones; says who has the rest
tools/frame-bench/boards.py book e1004 --who ... --for ... --wait   # until its holder releases it or it lapses
tools/frame-bench/boards.py extend sticky --who ... --hours 1
tools/frame-bench/boards.py release sticky,e1003 --who ...
```

- Boards by their short name (`boards.json` `key`): `sensecap`, `sticky`,
  `e1002`, `e1003`, `e1004`, `pico`, or `all`.
- `--who` starts with your session's name as `ListAgents` shows it, so whoever
  finds the board taken can `SendMessage` you; set `FRAMEOS_BENCH_WHO` to it
  once and the tools below read it.
- A booking ends at its `until` (default two hours from booking). Past it the
  board is free again, so a session that died holds nothing; `extend` while you
  still need it, and `release` the moment you are done. Leave the board as you
  promised the others (often: back on the release, on a still scene).
- Never use a board someone else holds. Ask them; take it with `release
  --force` only when they said so, or the owner did.
- The tools keep to it: `bench.py run` books every board it benches, moves the
  booking on at each suite and releases it at the end; it never opens the
  console of a board someone else holds (nor a port another process has open),
  benches the free boards first and each held one when it is free
  (`--skip-booked` leaves those out, `--wait-hours` bounds the wait).
  When you do more with a board after the bench (a check of your own, putting
  the release back), keep the booking for the whole sequence: book it first,
  run the bench with `--keep-booked`, and release it yourself at the end, or
  an agent waiting for it takes it the moment the suites end.
  `bench.py discover` skips them too. The flashing scripts under
  `~/.frameos-bench/firmware/` (`flash_checked.sh`, `xversion.py`) refuse a
  board booked by anyone but `$FRAMEOS_BENCH_WHO`; `xversion.py` books what is
  free, flashes and benches it, and takes the rest as they come free.
- `FRAMEOS_BENCH_SAMPLES=<checkout>` makes the desktop and code suites push
  that checkout's samples, to bench a branch's layouts with main's tooling.

## Before you run it

1. **A backend the frames are attached to.** Every frame's `backend` points at
   it and it holds each frame's scenes (it is the source of truth: a push
   replaces what a board holds). `FRAMEOS_BENCH_BACKEND` (default
   `http://localhost:8989`) and `FRAMEOS_BENCH_TOKEN` (an API token:
   `POST /api/user/api_tokens` with `current_password`, or Settings → API
   tokens). `FRAMEOS_BENCH_HOST_IP` is this machine's address as the frames see
   it (the offline suite points a frame at a port here that never answers).
   The frames' network must be able to open connections to it (a router rule).
2. **Nothing else holds the serial ports** (`fuser /dev/ttyUSB* /dev/ttyACM*`):
   the bench keeps every port open for the whole run. A board with a CH340 /
   CH9102 bridge resets when its DTR/RTS lines flip one at a time; the bench
   opens ports with pyserial's defaults and never touches the lines. Never use
   `dtr=False; rts=False` on these boards.
3. pyserial: `frameos/.venv/bin/python3` has it.

## Linux frames (a Raspberry Pi, over SSH)

A Pi has no USB console, so `framebench/linux.py` makes one: the runtime's
journal followed over SSH (`journalctl -u frameos -f`), its HTTP API for what
a console is told (`scene <id>` is `POST /event/setCurrentScene`, with the
backend's `serverApiKey` bearer), SSH for the rest (`restart` is
`systemctl restart frameos`). A render is said the way the firmware says it
(`render #N ... done in`), so every suite runs on it; what it cannot do is a
`skipped` with the reason (the offline suite).

- **List it** in `~/.frameos-bench/linux-frames.json` (`["root@10.8.0.171"]`)
  or `$FRAMEOS_BENCH_SSH`; its port is `ssh:root@10.8.0.171`, its booking key
  its board's in `boards.json` (`cloudw`: a Pi Zero W). `--linux-only` on
  `discover` and `run` opens no USB port (the other sessions' boards).
- **Attach it** with the backend's own adoption (`POST /frames/adopt`, which
  needs the frame's admin login: put one in its frame.json over SSH first),
  then copy its scenes into the backend frame (a cloud-pushed set is not in
  its local API: `state/uploaded.json`) and push. A push restarts its runtime
  (~15 s on a Pi Zero). Take a layout chosen ON the frame off
  (`state/scene-frame-layout.json`): it wraps every scene, the benchmark's too.
- **Times are the frame's own.** The runtime's logger thread hands lines to
  the journal up to 250 ms late, and SSH adds more (350-600 ms on a Pi Zero),
  so each line carries the journal's stamp, turned into this machine's clock
  by a measured offset (`+-` half a round trip, in the raw log's first line).
- **The benchmark scenes go on with `uploadScenes`** beside the frame's own,
  and come off by putting `state/uploaded.json` back and restarting the
  runtime (an upload leaves memory no other way); `bench.py restore` does it
  for a killed run from `~/.frameos-bench/uploaded-before-bench-<host>.json`.
- **An animation is not logged frame by frame**: the runtime pauses its render
  log for ten seconds after two fast renders. The two frames logged at each
  pause give a frame's period (`render:animation`, `via: linux log burst`).
  That pause also hides the first render after an animation (2026.11.14): such
  a switch is confirmed by a render after it and reported `switch_unlogged`,
  untimed.
- **Restart** is the runtime's (systemd), not the OS's: the Pi's boot is not
  in `resp.boot.first_render_ms`. **Memory** is RAM and the runtime's RSS
  (`mem.idle.ram_available`, `mem.process.rss`, `mem.bench.process_peak_rss`),
  never scored against PSRAM; a soak flags a resident set that rises every
  round. A crash is the service ending badly (a core dump, a kill, a non-zero
  exit, systemd's watchdog, the OOM killer); a restart that was asked for (a
  push, `restart`) ends `Deactivated successfully` and is none.
- One SSH connection carries every call (`ControlMaster`): a burst of fresh
  logins went unanswered on the Pi Zero for a minute.

## Running

```
tools/frame-bench/bench.py discover            # which frames answer, on which port (saved to ~/.frameos-bench/inventory.json)
tools/frame-bench/bench.py run --rediscover    # every default suite on every frame, frames in parallel
tools/frame-bench/bench.py run --quick         # 3-4 scenes each: a smoke test (~10 min)
tools/frame-bench/bench.py run --full          # no sampling on the slow e-paper panels
tools/frame-bench/bench.py run --frames sensecap,e1003 --suites scenes,desktop
tools/frame-bench/bench.py run --baseline ~/.frameos-bench/<older-run>   # flag regressions
tools/frame-bench/bench.py report <run-dir> --baseline <older-run-dir>
tools/frame-bench/bench.py run --suites status,reboot,benchmark   # the scored benchmark alone (~5-15 min)
tools/frame-bench/bench.py import            # backfill run dirs into ../frameos-benchmarks/data/*.jsonl
tools/frame-bench/bench.py sizes --elf v2026.11.13   # a new release's image sizes (and ELF shas)
tools/frame-bench/bench.py html              # ../frameos-benchmarks/index.html: scores, trends, image size, stability
tools/frame-bench/bench.py restore           # undo a killed benchmark suite (backend address, scenes)
```

## Scores and records

The results are their own repo, `FrameOS/frameos-benchmarks`, cloned beside
the main checkout (`../frameos-benchmarks`; `$FRAMEOS_BENCHMARKS` to put it
elsewhere; a worktree finds it through git). Every finished `run` is imported
into its `data/` (`boards`, `runs`, `metrics`, `images` as JSON Lines: its
`SCHEMA.md`); run `bench.py html` (its `index.html`, the GitHub Pages site)
and commit and push both there, saying in the message what the run was for
(the build, the change). Nothing of a run goes into this repo.
The scores (`tools/frame-bench/SCORES.md`) come from the **benchmark** suite:
fixed scenes (`tools/frame-bench/benchmarks/`) put on the board over USB,
timed by the lines every firmware prints, so a release from before the suite
existed is benched exactly like main. While it runs, the board's backend points
at a closed port on the board (no pulls, and no over-the-air update to the
backend's release halfway: a board on 2026.11.10 checks every 8.3 minutes);
`~/.frameos-bench/isolated.json` keeps the real address until it is back.

A build is known by its image's ELF sha, never by the version it prints:
`bench.py sizes --elf <tag>` records each release's sha, so a run on a bench
build that prints `2026.11.11` lands as `2026.11.11+elf.<sha>`, not as the
release. Run `sizes --elf` for every release you flash.

**Benching an older release** (`~/.frameos-bench/releases/<v>/` holds the
signed images): `~/.frameos-bench/firmware/xversion.py <worktree> <label>
<generic-app.bin> <32mb-app.bin>` finds every ESP32 by `usb_api status`,
flashes each through `flash_checked.sh` (module checked again, the board's
own slot and baud), waits until each answers, and runs
`--suites status,reboot,benchmark` (about 10 minutes for all five; the E1004
is last). Flash the next version straight after: a board on an older release
reconnected to the backend installs the latest release over the air within
minutes (the Sticky on 2026.11.11 did, 2026-11-19). Never `ota` (the SenseCAP
boot-loops on releases up to 2026.11.12), and put each board back on what it
ran before. Its benchmark data then compares like for like across versions:
`~/.frameos-bench/firmware/compare_builds.py <worktree> <build> ...` lists it
per board, `bench.py scores --builds ...` as scores.

**Slow panels are sampled.** A frame whose panel takes 20 s or more to
refresh (the 7.3" and 13.3" Spectras: the E1002, the E1004) runs what has
broken before every time and the rest in turns: the photo, big and clock
scenes (`TROUBLE_SCENES`) and its largest scenes always, a third of the other
scenes per run (by the day, or `--rotation N`), one warm render each (two for
the trouble ones), the macOS and BeOS desktops back to back (`TROUBLE_LAYOUTS`)
plus a third of the other layouts, two windows instead of four, and three
soak rounds of the same picks. The report notes what was left for another
run's turn (`sampled`). `--full` runs everything, as before; a release check
or a change to rendering that touches every scene wants it.

A full run takes one to two hours (e-paper refreshes and the 16-grey E1003's
slow scenes dominate). Run it in the background and read
`<run-dir>/report.md`; `issues.json` is the same list as data, `run.json`
every measurement, `<frame>.raw.log` every console line with host timestamps.
Exit code 2 means a `crash` or `fail` issue.

## Suites (`framebench/suites.py`)

| suite | what | on |
|---|---|---|
| `status` | firmware, memory, storage, scene list, HTTPS state | all |
| `reboot` | `restart`: time to the bootup event and the first picture; nothing crashes | local |
| `benchmark` | the benchmark scenes (CPU, raster, UI, JPEG decode + dither, animation on an LCD, a tap on touch), each cold and five times warm, then `heapinfo`: the scores' input (`SCORES.md`) | local, console only |
| `scenes` | every scene: switch (wall vs render time), an LCD's animation for `--passive` s (fps vs the scene's period, stalls), `--warm` renders with the per-phase probe (`set debug 1` for the run), the render path (`in place` on an LCD), a tap on touch boards | local |
| `builtin` | scene switcher and scene settings open / close | local |
| `input` | a drag across the panel, next / previous scene; on an ESP32, a swipe up from the bottom and down from the top of the picture through its own touch task (`touch drag`, the edges turned by the console's `rotate`, after two quiet seconds so the picture is not a burst's), each timed from the command to the scene list's or the settings' finished picture, the 250 ms drag included (`resp.input.swipe_switcher_ms` / `swipe_settings_ms`) | touch |
| `desktop` | every scene dressed in each desktop layout (Windows 98, Tiling, macOS, BeOS, Classic Mac, NeXTSTEP, OS/2 Warp, Omarchy, Commander samples), pushed through the backend, four scenes opened as windows, a tap in each, refocus; the window limit and memory; the frame's own scenes restored after | local + backend |
| `code` | the Code editor (`docs/code-editor.md`) installed beside the frame's scenes and opened on its list and on a few scenes (one with a JS app, one with a code node): open time, render, JavaScript errors in the log (`is not a function`, …), a tap; on a native-USB console the panel after each open is saved as `<frame>.code-<n>.bmp`, since the editor shows a failed `frameos.code` on the screen; the frame's scenes restored after | local + backend |
| `settings` | what a person changes that restarts or redresses the frame: the rotation turned 90° and back (through the backend frame, else `set rotate` + `restart`), each a single restart woken by `restart`, the runtime up at that rotation and a picture after, and its `restart:notice` ("Restarting..." in the fast waveform) recorded; on a touch board the scene switcher opened and dragged a screenful at a time, two rounds of three pages, every render ending (the Sticky's grey hang at its second page, 2026-11-23); a first drag that draws nothing means every tile is on the screen (`fits`, the E1003), a later one is a `fail`; then every layout the frame holds put around every scene, one push after another, and none, each push that would change nothing skipped (`unchanged`: a board takes nothing it could be timed by); a panic, watchdog, second boot or failed push is the issue (the Sticky and a reTerminal, 2026-11-22) | local (+ backend for layouts) |
| `video` | a Linux frame plays video without a stutter (`framebench/video.py`): four clips made here with ffmpeg (360p at 24, 720p and 1080p at 30, and a 720p phone video turned to be shown upright) copied to the frame's assets (`frame-bench/videos/`, paced, only when they differ), each played on a loop for 65 s in a bench scene of its own (`benchmarks/video/app.tsx`), judged by the runtime's own `video:playback` lines (docs/video.md "Playback in the log"), each clip's first line (its start) left out: a late (over 1.5 frame times) or dropped frame is a `slow` `video_stutter`, under 95% of the clip's rate `video_not_realtime`, a hardware decoder giving way or nothing shown `fail`; the report's video table has each clip's path (decoder, plane or canvas) | Linux frames with ffmpeg |
| `storm` | eight switches 300 ms apart: alive, showing the last | local |
| `soak` | every scene each round (3): memory after each round; a steady fall is a leak | local |
| `offline` | the backend hangs (a tarpit port): switches must stay prompt | local + backend |
| `thin` | the plane's render for the frame (ms, bytes), a 304 for an unchanged picture, `X-FrameOS-Next-Render` vs the panel's refresh; the Pico's own pull + refresh | thin clients, Pico |

Issue severities: `crash` (panic, abort, watchdog, brownout, reboot, OOM),
`fail` (didn't work), `slow` (a number out of line or a slower path),
`note` (worth knowing). Thresholds are at the top of `suites.py`.

## The UX bench (no boards needed)

`tools/ux-bench/README.md`: every sample scene on every bench board's size,
format, rotation, keys and event map in the wasm runtime (`run_all.sh`, then
`report.py --sheets`), with the reTerminal layouts both ways round and the
built-in scenes (`run_extra.sh`). It catches what this bench cannot see: a
scene whose controls fall off a small panel, a key or swipe that does not do
what the board's map says, text lost to a round panel's rim. Its
`device_ux.py <port> <board>` runs the edge swipes and keys on a real board
(booked) and times what they open.

## Adding things

- **A new board kind**: nothing is required; results are keyed by what
  `usb_api status` says it is (module, panel, chip, PSRAM, flash). Add it to
  `tools/frame-bench/boards.json` for its name and panel size (the per-megapixel
  scores need the size: the status gives it from 2026.11.10 on).
- **A new benchmark**: a folder in `tools/frame-bench/benchmarks/`, a line in
  `framebench/benchmarks.py`, its metric in `records.frame_metrics` and, if
  it scores, `scoring.CATEGORIES`; bump `WORKLOAD`.
- **A new Linux frame**: "Linux frames" above.
- **A new frame**: plug it in, attach it to the backend (copy its scenes into
  the backend frame FIRST — `usb_api scene-list` / `scene-get` on 2026.11.7 and
  later — then `set backend`, `set api_key`, `set frame_id`, `restart` on its
  console), run `discover`. Its kind (`local` / `thin` / `pico`), LCD, touch
  and refresh time come from `usb_api status` (`framebench/inventory.py`:
  `TOUCH_MODULES`, `PANEL_REFRESH_S`; a panel is fast when its display id starts
  `LCD_` or `AMOLED_` or `boards.json` gives its panel `kind: lcd`).
- **A new suite**: a function `(ctx, frame) -> {..., 'issues': [...]}` in
  `suites.py`, registered in `SUITES` and, if it should run by default, in
  `DEFAULT`. Use `ctx.console(frame)` (shared, held open), `wait_render`,
  `summarize` (`parse.py`), `incidents_since`.
- **A new firmware log line** worth reading: `parse.py`. A new crash signature:
  `INCIDENT_PATTERNS` in `console.py`.

## Reading a report

- Watch `switch ms` minus `cold ms`: the time a switch waited for something
  other than its render (a backend round trip on the render task, a store
  write).
- `path`: `in place` is an LCD drawing in its back buffer (the fastest path);
  `pack N ms` is a separate image packed for the panel; `update` / `skipped`
  is what the panel did.
- An e-paper render line carries the probe split only on firmware that has
  it on that path; compare phases (`get`, `walk`, `parse`, `raster`) between
  runs, not absolute numbers between boards.
- A slow animation's issue says where a quiet frame went (`a quiet frame:
  scene 33.2, app 26.6, ...`): the average of the frames between two logged
  ones, from the logged frame's line (`passive.quiet` in `run.json`). The
  logged frame's own split is a third slower and not what the frame rate is
  made of.
- `paint NxMS` on a render line is the gradients and images filled through a
  shape: three page-sized ones were most of a 10 s render on the E1003
  (2026-11-18).
- After a firmware change, run with `--baseline` against the last good run on
  the same frames.
