# Frame bench scores

One number per category, per board, per FrameOS build, in the spirit of
LVGL's board certification: a fixed test suite, published scores. Here for
every release and every dev build between them. The code is
`framebench/scoring.py`; the records it reads are `results/SCHEMA.md`; the
page is `bench.py html` (`results/report.html`).

## What is measured, and why this way

**The benchmark scenes** (`benchmarks/`, `framebench/benchmarks.py`) do the
same fixed work on every board and every firmware. The frame's own scenes
cannot: they differ per board and change between runs (the scene sets were
brought to the repo samples on 2026-11-19), so their times compare a board
with itself on one scene set at best. Old firmware cannot gain commands, so
the benchmarks are ordinary scenes, put on the board over USB
(`usb_api scene-put`, firmware 2026.11.7 and later) next to its own and
deleted after, and timed only by what every firmware prints:

- `render #N (...): render X ms, dither+pack Y ms` (or `in place`): the scene's work, then the panel's;
- `render #N done in Z ms`, the `render:done` event (`freePsram`), `render:animation` (fps);
- the apps' own `frameos.log({bench: ...})` lines, timed by the board's clock.

| scene | does | measures |
|---|---|---|
| `base` | a JS app returning a three-shape SVG | what any JS-app render costs (the call, the walk, a full-frame fill) |
| `cpu` | four fixed JavaScript loops, each timed by `Date.now()` in the app: a sieve + xorshift (`int`), a Mandelbrot (`float`), `JSON.stringify` / `parse` of 200 rows (`json`), split / replace / upper-case (`str`) | QuickJS on this chip and this build (its `-O2` modules, its allocator) |
| `raster` | one SVG of 160 translucent circles, 60 curves, 40 rotated rects, four gradients, moved a pixel each render | the rasterizer over the whole panel |
| `ui` | a JSX UI of 48 cards (flex, grid, Tailwind, text), one picked each render; a tap picks one | layout + text + raster; the tap's path to a picture |
| `image` | a 1024x768 JPEG inside the scene (a data URL), through `data/downloadImage` (cache off) and `render/image` (cover) | JPEG decode, resize to the panel, and on e-paper the dither + pack |
| `anim` | twelve balls moved by the clock at 30 fps | the frame rate an animation gets (fast panels only) |

Each is switched to once (cold: compile + first render) and rendered five
times (three for `raster` and `ui` on a panel with a 20 s or longer refresh,
whose picture changes each render). The CPU, base and image pictures are the
same each render, so an e-paper panel does not refresh after the first.

While the suite runs the board's backend points at `http://127.0.0.1:9`, a
closed port on the board itself: no scene pull takes the benchmark scenes
away, no log upload or settings sync shares the render task with them, and a
release older than the backend's does not install the newer one over the air
halfway (every awake release up to 2026.11.12 checks every 8.3 minutes).
`~/.frameos-bench/isolated.json` keeps the real address until it is put back
(`bench.py restore`; every run starts with it). The suite also runs with
`debug 0`, as the boards ship: the probe split is not on every release's
render line.

## Categories

A metric's score is **1000 x reference / value** (lower is better) or
**1000 x value / reference** (higher is better). The reference is the median
over the boards benched on **2026.11.12** of that metric, normalized as below,
frozen in `scoring.REFERENCE` (the five ESP32 boards, 2026-11-19/20;
`bench.py scores --reference 2026.11.12` prints it again). A category is the **geometric mean** of the
scores of the metrics a board has; a board without touch has no tap score,
an LCD has no dither, and neither is counted as zero.

| category | metrics | normalized |
|---|---|---|
| **CPU** | `bench.cpu.int_ms`, `float_ms`, `json_ms`, `str_ms` | no: the same work everywhere |
| **Graphics** | `bench.raster.net_ms` (raster minus base), `bench.ui.net_ms`, `bench.anim.fps` | raster per panel megapixel; the UI and fps as felt |
| **Image** | `bench.image.render_ms`, `bench.image.pack_ms` (e-paper that packs apart) | decode + resize per megapixel decoded plus drawn (0.79 + the panel's); dither per panel megapixel, against panels of the same colors only (a black-and-white threshold is 31 ms a megapixel, a six-color Spectra dither 2,100: `BY_PANEL_COLORS`) |
| **Responsiveness** | `bench.switch_ms` (median cold switch to a benchmark scene), `bench.ui.tap_ms`, `resp.boot.first_render_ms`, `resp.switcher.open_ms` | no: as felt, the panel's refresh included (a 30 s Spectra is slow to respond, and that is the board) |
| **Memory** | `mem.min_ever.psram`, `mem.min_ever.internal` (heapinfo's minimum since boot, after the benchmark), `mem.largest.psram`, `mem.idle.psram_free` | no: room left for scenes on this board (a panel's frame buffer is part of the board) |

**FrameOS score** = geometric mean of CPU, Graphics, Image and
Responsiveness. **Memory** and **Stability** stand beside it and are never
folded in: a fast board that crashes must not hide behind its speed.

**Stability** = 100 x 0.5^crashes x 0.9^failures for a run (a crash is a
panic, abort, watchdog, brownout, unexpected reboot or out-of-memory; a
failure a switch, push or render that did not happen), the median over the
runs of a build. It compares only runs of one mode: a `full` run does three
times what a `sampled` one does on a slow panel. The counts are shown with it.

## Noise

- Every metric is a median: of the renders in a run (n = 5), then of the runs
  of one board on one build. Each row keeps `n`, `min`, `p25`, `p75`, `max`.
- A score carries a range: the scores of the quartiles (p25 and p75, or the
  spread between runs when there are several). Two builds whose ranges
  overlap are not different. One run's spread on the SenseCAP is about 5 %.
- What else moves a number is recorded beside it: Wi-Fi RSSI
  (`net.wifi_rssi`), the battery (`power.battery_mv`), the scene set
  (`runs.scene_set`).

## Comparing fairly

- Across **builds on one board**: everything, like for like.
- Across **boards**: CPU as is (same work); raster, decode and dither per
  megapixel; responsiveness and memory as felt (they include the panel). A
  board runs its CPU at the clock FrameOS gives it: an RGB LCD or touch board
  says `cpu: 240 MHz (touch)` at boot (recorded as `chip.cpu_mhz`), the
  others (the E1002, the E1004) print nothing, yet run the integer loop as
  fast as the 240 MHz boards (662 ms against 659 ms, 2026-11-19). What differs
  is memory: the allocation-heavy JSON loop is 40 % slower on the E1002 and
  E1004 than on the E1003 and the Sticky, and every loop is about 10 % slower on
  the SenseCAP, probably because its RGB LCD reads its frame buffer from PSRAM
  all the time (not measured). A CPU score is the board as it ships, not the
  chip at its best.
- A dev build is `<release>+<sha>` (`2026.11.12+49345dbb4`); a build made on
  the bench under a release's number is `+elf.<sha>` and is never mistaken for
  the release (the run of 2026-11-18 18:00, long taken for "the last full run
  on 2026.11.11", was one).

## Not measured (yet)

- **Power.** Every bench board is powered over the same USB cable its
  console uses: the reTerminals' fuel gauge (bq27220 on the Sticky) reads the
  cell's current, which is about zero while USB powers the board, and nothing
  reads the USB side. Power wants an inline USB meter that logs (an FNIRSI
  FNB58 or a POWER-Z KM003C over its USB/serial port). The slot is
  `power.*` metrics per run: `power.idle_mw` (a minute on a still scene),
  `power.render_mj` (energy of one benchmark render above idle),
  `power.sleep_uw` (deep sleep). Normalize by panel area for "power vs screen
  size": mJ per render per panel megapixel. Only the battery voltage is
  recorded now (`power.battery_mv`), as context.
- **Hardware image blocks.** No attached board is an ESP32-P4, and FrameOS has
  no P4 build (`fos_board.c` only names the chip): its JPEG decoder and PPA
  are unused. When a P4 build uses them, the Image category is where it shows
  (same scene, same normalization); `boards.json` `chips` already says which
  chip has them.
- **The CPU clock from the status.** `usb_api status` does not report it;
  only the boot line does, so a run without the restart suite has no
  `chip.cpu_mhz`.

## Versions

- `framebench.BENCH_VERSION` — what the suites measure. Bump it when a
  suite's measurement changes.
- `benchmarks.WORKLOAD` — the benchmark scenes. Any change to what they do
  (a loop count, a shape) bumps it, and the scene ids change with it
  (`frame-bench-cpu-w1`): numbers of two workloads never mix.
- `scoring.SCORE_VERSION` — the formula and `REFERENCE`. A new reference
  build is a new score version.
