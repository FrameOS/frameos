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

## The 1 MB emergency reserve stays

`FOS_NIM_EMERGENCY_RESERVE_BYTES` (frameos_nim_glue.c) was sized when a
render could exhaust the pool. It no longer can (4.17 MB to spare at the
worst probed point), so shrinking it would buy headroom only for
pathological decodes — which the budget/degrade ladder already absorbs —
while weakening the OOM-containment backstop that keeps a failed
allocation from rebooting the device. Decision 2026-08-14: keep 1 MB.

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
