# ESP32 memory & render-cost background

Reference measurements and measurement tooling for the ESP32-S3 frames —
the numbers behind decisions that would otherwise look arbitrary. Open work
lives in `docs/todo.md`; the architecture (decode budgets, streaming
decode, OOM containment) is documented where it is implemented:
`frameos/src/frameos/utils/memory.nim`, `frameos/src/embedded/`, and
`embedded/esp32/components/frameos_nim/frameos_nim_glue.c`.

## Where the PSRAM goes

Bench 7.3" PhotoPainter, 8 MB PSRAM, Weather scene — the heaviest standard
scene. The 2026-08 memory push (#318, #320, #322, #329) moved the resident
baseline from 2.72 MB to 1.05 MB; a render now starts with 7.1 MB free
instead of 5.5 MB.

Measured 2026-08-14 on v2026.8.19 with `-d:memProbe`:

| Point | Free PSRAM |
|---|---|
| Idle, scene loaded (1 MB reserve armed) | 7.14 MB |
| First-render low-water (scene load, both weatherPanel transpiles, SVG rasters) | 4.17 MB |
| Post-render steady state | 6.2 MB |

The first render after a boot — the one that also pays the scene parse and
the app transpiles — no longer touches the emergency reserve.

## The canvas is RGBX where it fits, 565 where it must (2026-08-23)

One rule in three places — `fos_render_canvas_bytes_per_pixel`
(components/frameos_display), `sceneCanvasFormat` (embedded_runtime.nim),
`embedded_render_canvas_bytes_per_pixel` (backend embedded_firmware.py):
**4 B/px when width×height×4 ≤ PSRAM/2, else 2 B/px.** 800×480 on 8 MB →
RGBX (1.5 MB); 1200×1600 on 16 MB → RGBX (7.3 MB); 1200×1600 on 8 MB → 565.
A 565 canvas sets pixie's `ditherStores`, which is what fixes the gradient
banding the 2026.8.31 move caused (see embedded/esp32/README.md, "The
render canvas"). RGB888 (3 B/px) for the 8 MB 13.3" was considered and
rejected: 5.5 MiB canvas + 0.9 packed + 1.5 reserve leaves ~1.8 MB of
headroom for decodes, fonts, QuickJS and TLS, which turns every large
photo into a clamped decode; dithered 565 costs nothing and removes the
banding.

Consequence for the 16 MB 13.3": idle free PSRAM drops from ~10.3 MB to
~6.5 MB, so the streamed cover decode of a 24 MP photo (5.8 MB plan, see
below) no longer fits the headroom and clamps mildly (~93% sampling
resolution) until the cover column-window follow-up in todo.md lands
(2.9 MB plan). That follow-up is what makes RGBX on 16 MB free of
compromise.

## The canvas was 2 bytes per pixel everywhere (2026.8.31 – 2026-08-23)

The scene canvas became a 16-bit RGB 5/6/5 pixie image (`embedded/esp32/README.md`,
"The render canvas is 16-bit"). The budget arithmetic that moved with it, in
its four mirrors — `FOS_RENDER_CANVAS_BYTES_PER_PIXEL` in
`components/frameos_display/include/frameos_display.h`,
`EMBEDDED_RENDER_CANVAS_BYTES_PER_PIXEL` in `backend/app/tasks/embedded_firmware.py`,
the `byteSize` the interpreter's cache limits use, and the 1.5 MiB reserve
shared with `frameos/src/frameos/utils/memory.nim`:

| panel | canvas (was RGBA) | packed | reserve | total (was) |
|---|---|---|---|---|
| 800×480 4bpp | 0.73 MiB (1.46) | 0.18 | 1.50 | 2.42 MiB (3.15) |
| 792×272 2bpp | 0.41 MiB (0.82) | 0.05 | 1.50 | 1.96 MiB (2.37) |
| 1200×1600 4bpp | 3.66 MiB (7.32) | 0.92 | 1.50 | **6.08 MiB** (9.74) |

The 13.3" row is the one that changed category: it fits the 8 MB module now.
The measured ~1.3 MB non-canvas render peak above was taken at 800×480; the
pieces of it that scale with canvas width (pixie's per-row scratch, SVG
bands) are small, but a 1200×1600 measurement on an 8 MB board is still the
number to take before trusting the margin. The canvas block is claimed at
boot (`frameos_nim_reserve_canvas`) and never freed, so "largest free block"
no longer has to hold it at render time.

## The 1 MB emergency reserve stays

`FOS_NIM_EMERGENCY_RESERVE_BYTES` (frameos_nim_glue.c) was sized when a
render could exhaust the pool. It no longer can (4.17 MB to spare at the
worst probed point), so shrinking it would buy headroom only for
pathological decodes — which the budget/degrade ladder already absorbs —
while weakening the OOM-containment backstop that keeps a failed
allocation from rebooting the device. Decision 2026-08-14: keep 1 MB.

## Leaks are permanent, and they look like blur (2026-08-23)

A longjmp OOM abort skips every Nim destructor, so whatever the aborted
call held is gone until reboot. Case from a 16 MB 13.3" board on 2026.8.34:
idle free PSRAM was 10.3 MB after boot; a scene switch cost 1.6 MB (open
question, no abort logged); one `render-cycle-failed` at 01:08Z took it to
4.3 MB with a 1.9 MB largest block. Every render afterwards "succeeded" —
`decodeIntoTargetWithDegrade` dropped each 24 MP photo to a half/quarter
decode and stretched it — so the abort streak reset on every render and
the frame showed soft images for a day with nothing in the log.

Both leaks had a root cause, fixed in the pixie fork (ab4085b):

- **The 1.6 MB "scene switch leak" was the typeface.** The first text the
  boot ever drew (the error frame) parsed Ubuntu-Regular into the global
  typeface cache, and a parsed font kept the raw GPOS kerning matrix
  (class1 x class2 ValueRecords, per lookup) next to the derived tables the
  lookup actually reads — 1.6 MB of a 2 MB parsed font on a 64-bit host.
  The parser now drops that scratch: 2039 KB -> 910 KB retained, kerning
  and rendered pixels identical.
- **The abort was a contiguity miss.** The streamed-JPEG plan for a
  6000x4000 cover-fit into 1200x1600 is 5.8 MB, and its luma channel is
  ONE 3.75 MB allocation (cover samples the full 2400-wide row and crops
  later). The budget check asked only whether 5.8 MB fit the 7.1 MB
  headroom; the largest free block had fragmented below 3.75 MB, the
  malloc failed, and the longjmp abort leaked everything the render held.
  pixie now carries a second, contiguous budget
  (`setDecodeContiguousBudgetBytes`, fed from the largest free PSRAM block
  by `refreshDecodeContiguousBudget`): the SOF plan clamps its sampling
  resolution so the largest channel fits, and refuses catchably when even
  that cannot. Measured on the host: 6 MB block -> untouched; 3 MB block ->
  2172x1448 sampling, 3.07 MB luma, decodes.

Follow-up worth doing: cover-fit should sample only the cropped column
window. A 3:2 photo on this 3:4 panel would plan 2.9 MB instead of 5.8 MB
(luma 1.9 MB instead of 3.75 MB), which is the difference between full
sharpness and a clamp on a heap that has seen a day of churn.

And two things changed on the visibility side:

- `render:degraded` (utils/image.nim) is logged each time the ladder drops a
  rung, with the rung, the decode size and the headroom it was planned
  against. A frame whose photos got soft now says why in the cloud log.
- `memory:oomAbort` (frameos_nim_glue.c) is logged on every abort, with
  free/largest PSRAM and the post-first-render baseline. When one abort
  leaves less than `FOS_NIM_OOM_LEAK_RESTART_PERCENT` (50%) of that
  baseline free, the frame restarts immediately instead of rendering
  degraded until someone power-cycles it. The old streak rules stay.

## Boot and render costs

Same bench frame, for context when weighing "do less at boot" ideas:

- Cold-boot transpile: ~3.3 s total (weatherIcons 0.55 s + weatherPanel
  1.38 s ×2) after the allocation fix (#329). This is why deploy-time
  transpilation is parked: shipping readable TS source to the device is a
  feature, and per-render costs dominate anyway.
- Per render: SVG raster 7–8 s, dither+pack ~3.2 s, panel refresh ~29 s
  (7.3" Spectra-6).
- A per-source-digest transpile-output cache was built and removed the same
  day (2026-08-13): pinning ~50 KB per unique source in PSRAM with no
  pressure-driven eviction is the wrong trade on a board that counts bytes.
- Spill bench (13.3E6, 2026-08-13): a 4.4 MB JPEG force-spilled to SD
  `.cache` held a ~5.2 MB PSRAM floor; spilled PNGs stream.

## How to measure

- `FRAMEOS_EXTRA_NIM_FLAGS="-d:memProbe" ./build_nim.sh` — logs free
  PSRAM, largest block and a millisecond timestamp before every
  interpreter node and at the JS/SVG choke points (`MEMPROBE …` console
  lines), so one trace answers both "where did the memory go" and "where
  did the seconds go".
- `FRAMEOS_BOOTMEM=1` in the environment at configure time — compiles in
  the same per-init-step logging in `main/main.c` (`BOOTMEM …` lines; the
  env hook lives in `main/CMakeLists.txt`). This is how the 1.57 MB
  default-font parse was found.
- Distrust host-side models: one predicted 3.7 MB where the device wanted
  ~4.5 MB, and separately put the source map at 45 % of a transpile when
  it was 5 %. Reconcile any host measurement against a device run before
  trusting it.
