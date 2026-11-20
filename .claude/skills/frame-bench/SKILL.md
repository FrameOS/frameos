---
name: frame-bench
description: Bench every FrameOS frame attached to this machine (ESP32 boards and Pico thin clients on USB, attached to a local backend) — scenes, layouts and desktop windows, input, switch storms, memory soak, offline backend, reboots, server rendering — and report crashes, OOMs, slow paths and regressions. Use when asked to "bench the frames", check that a firmware change keeps working on real hardware, or compare against an earlier run.
---

# Frame bench

`tools/frame-bench/bench.py` drives every frame on this machine's USB through
its serial console and the backend it is attached to, and writes a report of
everything that crashed, failed, ran slow or took a slower path than before.

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
tools/frame-bench/bench.py import            # backfill run dirs into tools/frame-bench/results/*.jsonl
tools/frame-bench/bench.py sizes --elf v2026.11.13   # a new release's image sizes (and ELF shas)
tools/frame-bench/bench.py html              # results/report.html: scores, trends, image size, stability
tools/frame-bench/bench.py restore           # undo a killed benchmark suite (backend address, scenes)
```

## Scores and records

Every finished `run` is imported into `tools/frame-bench/results/`
(`boards`, `runs`, `metrics`, `images` as JSON Lines: `results/SCHEMA.md`);
commit those files and `results/report.html` with the change the run was for.
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
| `input` | a drag across the panel, next / previous scene | touch |
| `desktop` | every scene dressed in each desktop layout (Windows 98, Tiling, macOS, BeOS, Classic Mac, NeXTSTEP, OS/2 Warp, Omarchy, Commander samples), pushed through the backend, four scenes opened as windows, a tap in each, refocus; the window limit and memory; the frame's own scenes restored after | local + backend |
| `code` | the Code editor (`docs/code-editor.md`) installed beside the frame's scenes and opened on its list and on a few scenes (one with a JS app, one with a code node): open time, render, JavaScript errors in the log (`is not a function`, …), a tap; on a native-USB console the panel after each open is saved as `<frame>.code-<n>.bmp`, since the editor shows a failed `frameos.code` on the screen; the frame's scenes restored after | local + backend |
| `storm` | eight switches 300 ms apart: alive, showing the last | local |
| `soak` | every scene each round (3): memory after each round; a steady fall is a leak | local |
| `offline` | the backend hangs (a tarpit port): switches must stay prompt | local + backend |
| `thin` | the plane's render for the frame (ms, bytes), a 304 for an unchanged picture, `X-FrameOS-Next-Render` vs the panel's refresh; the Pico's own pull + refresh | thin clients, Pico |

Issue severities: `crash` (panic, abort, watchdog, brownout, reboot, OOM),
`fail` (didn't work), `slow` (a number out of line or a slower path),
`note` (worth knowing). Thresholds are at the top of `suites.py`.

## Adding things

- **A new board kind**: nothing is required; results are keyed by what
  `usb_api status` says it is (module, panel, chip, PSRAM, flash). Add it to
  `tools/frame-bench/boards.json` for its name and panel size (the per-megapixel
  scores need the size: the status gives it from 2026.11.10 on).
- **A new benchmark**: a folder in `tools/frame-bench/benchmarks/`, a line in
  `framebench/benchmarks.py`, its metric in `records.frame_metrics` and, if
  it scores, `scoring.CATEGORIES`; bump `WORKLOAD`.
- **A new frame**: plug it in, attach it to the backend (copy its scenes into
  the backend frame FIRST — `usb_api scene-list` / `scene-get` on 2026.11.7 and
  later — then `set backend`, `set api_key`, `set frame_id`, `restart` on its
  console), run `discover`. Its kind (`local` / `thin` / `pico`), LCD, touch
  and refresh time come from `usb_api status` (`framebench/inventory.py`:
  `TOUCH_MODULES`, `PANEL_REFRESH_S`).
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
