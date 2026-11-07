# Interactive performance — the ladder, and where it stands

*Written 2026-11-07 from a three-pass investigation (nine code readers, five
researchers, three host benchmarks, four designers, four skeptics, one
critic; the raw reports are not in the tree). The model and the device
measurements behind it are `docs/realtime-rendering.md` and `docs/jsx-ui.md`;
the open items of those files that this one absorbs are struck there when
they land here. Read cold: each section says what is before what to do.
When an item ships, tick it and move its measurement into the "Measured"
table; when a tier is done, delete its list and keep the numbers.*

## The question and the answer

A JSX UI on the SenseCAP Indicator (ESP32-S3, 480x480 RGB565 LCD in PSRAM)
answers a tap in ~300 ms where a native toolkit on the same board answers in
an estimated 15–35 ms. The gap is not the scene language. Where the
documented ~300 ms went (the home panel, one card toggled, `docs/jsx-ui.md`):

| Where | Share | How sure |
| --- | --- | --- |
| Console I/O **on the render task**: ten `printf`s (~2.2 KB of `render:*` JSON) through ESP-IDF's UART VFS, one character per call, 115200 baud; two whole lines sit between the finished render and the buffer switch | ~150 ms blocked, ~60 of them before the present | mechanism read in `fos_client.c` + IDF `uart_vfs.c`; the ~30 ms gaps between the `render:*` stamps are one 380-character line each |
| Raster of 28,564 px | 68–97 ms | documented. 6–15% of it writes pixels; 52–66% is **one `font-semibold` label** (no bold face on an ESP32, so bold = fill + a 0.75 px round-joined stroke, and pixie flattened a circle per join: 303 circles for 11 glyphs); strokes were never cached; ~9k heap calls per toggle |
| layout 12 + emit 7 + parse 5 + damage 7 | ~31 ms | documented |
| JS `get()` 15 + walk 3 | 18 ms (6%) | documented, memo()'d. As the scene AI writes (no memo): ~40 + 13 ms, est. |
| diagram interpreter | ~7 ms | documented; the graph walk alone 1.5–3 ms |
| touch poll (30 ms period) | ~10 ms average | by the constants |

Native scene code of any language replaces the 18 ms row and nothing else;
the built-in scene switcher is already a Nim tree on the same pipeline and
took 0.3 s (damage) / ~2 s (whole) to draw. What makes native toolkits fast
is a retained tree, cached glyph bitmaps, span fills, dirty rectangles and no
allocation — all of which this pipeline can have while scenes stay TSX.

The ESP32 image's own side of this is `docs/esp32-image-size.md`; the
"scene = app directory" question is orthogonal (flash and concepts, not
frame time) and is tracked at the end of this file.

## The ladder

| Tier | What | SenseCAP tap (est.) | Flash | Effort |
| --- | --- | --- | --- | --- |
| **T0** measured fixes | console off the render task, present before logging; 10 ms touch poll; bold as a double strike; stroke circle cached; `share()`d boxes; damage bounds from geometry; leaner JSX factory; the four bugs; prelude as bytecode; the Pi runner wakes on input | ~300 → ~165–200 ms; cold start 155–180 → ~65–100 | +5–8 KB | 2–3 weeks |
| **T1** raster inside pixie | A8 glyph/icon coverage cache + span/corner-mask boxes as typed element kinds inside pixie's `Svg` (one damage model; Gray8 kernel for e-paper); pre-blend over flat parents; plain-object `app.config`; `JS_NewContextRaw` without Proxy/normalize; a kept canvas in the wasm preview | ~90–120 ms (card raster 3–7 ms) | −15..+10 KB | 6–9 weeks |
| **T2** retained UI | dirty flags + relayout boundaries on the `UiNode` tree, incremental emit, typed ops (parse → 0); "blocks" lowering of JSX in quickts; refs + `frameos.animate`; scroll as a row move; LCD refill off the CPU | ~45–65 ms; a small element animates at the panel's 42 Hz | +10–20 KB | 3–5 months |

Everything below is estimated from host measurements scaled by documented
device/host ratios (raster ~90–200x, layout ~250x, `get()` ~640–1,280x). A
device number replaces an estimate the day it is read; nothing beyond T0 is
committed to before the T0 probe has run on the board.

## Measured (the device, this branch)

**A/B on one SenseCAP Indicator, 2026-11-07** (the same scenes, the same
scripted sequence: four cold switches, eight home-panel taps over the HTTP
event route, the scene switcher opened twice, the JSX DVD bounce for 40 s;
main built from 0267672c, 3,231,952 B, the release's size):

| | main | this branch |
| --- | --- | --- |
| Home panel tap, render (steady) | 295–349 ms | **88–95 ms** |
| Scene switcher open (cold / again) | 2,293–2,547 ms | **812 / 319 ms** |
| Scene switcher closed, back to the home panel | (a rebuild: ~250 ms) | **64 ms** when its buffer holds the panel, ~300 ms when it holds another frame |
| Cold switch: Weather / Home / Calculator | 1,229 / 361–421 / 492 ms | 675–696 / 218–264 / 337–344 ms |
| JSX DVD bounce (33 ms period) | 29.1–29.2 fps, max frame 170–182 ms | 28.0–28.7 fps, max 54–73 ms |

A home-panel toggle's split now (`set debug 1`): get 12–13, walk 3.5,
layout 12, emit 4.5–5, parse 7–8, damage 5.5, raster 26–27 (28–31 coverage
hits), about 8 ms of interpreter and 6 of the app node's own around them.

The DVD's frames render faster on the branch (23 ms against 30 ms for a
logged frame) and the 180 ms frame each logged second-tenth is gone, yet it
loses about six frames in ten seconds to frames of 50–60 ms where main loses
five to that one long frame. Open: find what those frames do (a 10 ms idle
touch poll was a third of it and went back to 30 ms).

| What | Before | After | When |
| --- | --- | --- | --- |
| JSX Weather, isolated render (`render:framebuffer` → `render:device` → `render:done` stamps) | 80 ms render in place; stamps at 116 / 145 / 178 ms | | 2026-11-07, 2026.11.2 firmware |
| JSX Home, warm tap, the probe's split (`set debug 1`, firmware with the first T0 batch + bytecode preludes) | documented (PR #631 session): get 15, walk 3, layout 12, emit 7, parse 5, damage 7, raster 70 | get 12–13, walk 3–4, layout 11–13, emit 9–10, parse 4.5–5, **damage 11–38**, **raster 68–98**; render 138–189 ms | 2026-11-07. The raster did not move with the bold fix: its device share of the stroke was below the host's 52–66%. The damage step is 2–5x the documented figure. Both are T1's. |
| Cold scene switch (first render of jsx-weather / jsx-home after `scene …`), render ms | 877 / 448 / 403 / 374 | with bytecode preludes: 839 / 226 / 327 / 296 (the whole-frame raster of the weather scene is 459 ms of its 839) | 2026-11-07 |
| JSX Home, warm toggle, T1 so far (coverage cache, glyph runs, pre-blend, shared box shapes, scaled icon masks, span blits) | raster 68–98, render 138–189 | **raster 31–32 ms** (fills 8, mask blits 9.5, one stroke 3.3; 28–31 cache hits), **render 93–95 ms**, `render:done` ~103 ms | 2026-11-07 |
| JSX Home, one card toggled by a tap over the frame's HTTP event route (`/event/pointerDown` + `pointerUp`), warm, six taps: the Nim render (interpreter + app + raster) and the stamps | render 230–267 ms; `render:framebuffer` +32, `render:device` +29, `render:done` +32 → **323–360 ms** | render 140–181 ms (56 once); stamps +6 / +1 / +0 → **147–188 ms** | 2026-11-07, after the first T0 batch (console ring, bold without the stroke, stroke circle cached, JSX factory, memo, lookups); `lcd`: 0 dropped, 0 late refills |

## T0 — measured fixes (branch `perf-t0`)

### pixie into the tree (branch `pixie-in-tree`, first)

- [x] `git subtree add --squash` of FrameOS/pixie at 930bee30 under
  `frameos/pixie` (its tests and docs included: the raster work below is
  written on both sides of that line, and it has been one repository in all
  but name since the 565 surface). `config.nims` puts `frameos/pixie/src` on
  the path by default; `FRAMEOS_PIXIE_PATH` still points at another checkout.
  pixie's dependencies (vmath, chroma, flatty, nimsimd, bumpy, crunchy) are
  `frameos.nimble`'s now; `nimble.lock` lost its `pixie` entry.
- [x] `make test-pixie` runs pixie's own suite (`frameos/pixie/tests`); two of
  its files (`test_gray8`, `test_rgb565`: an AA circle's luma / 565
  quantisation one step off the RGBX canvas on this host) failed before the
  move and are skipped with a note.
- [ ] The Nim CI job runs `make test-pixie` when `frameos/pixie/**` changed.
- [ ] Every place that named the fork's URL or a `pixie` package: the
  Dockerfile's dependency layer (it only installs the lock now), the
  cross-toolchain images, `backend/app/tasks/_frame_deployer.py`'s
  `FRAMEOS_PIXIE_PATH` plumbing (still valid), `docs/esp32-image-size.md`,
  AGENTS.md.

### The probe (first, and the gate for everything after T0)

- [x] A per-phase probe (`frameos/render_probe.nim`) behind the frame's
  `debug` setting (`set debug 1` on the console): `get()`, the walk, layout,
  emit, parse, damage, raster, accumulated per render and printed on the
  render line (`[get 15.2 walk 3.1 …]`).
- [ ] Still to add to it: each element's raster inside pixie's `renderSvg`
  loop, `heap_caps_malloc` counts and time around `renderInto`, an empty
  `__frameosInvoke`.

### The firmware loop (C)

- [x] **Console off the render task.** (The present no longer needs to move:
  a line costs the render task a memcpy now.)
  `frameos_nim_log_hook` (components/frameos_nim/frameos_nim_glue.c) hands
  the line to a ring drained by a low-priority task on core 0 that writes
  whole lines with `uart_write_bytes` / `usb_serial_jtag_write_bytes`; the
  ring flushes from the panic handler and before deep sleep. In `render_once`
  (main/fos_client.c) the blit moves ahead of the `render:framebuffer` and
  `render:device` lines. Expected: the picture 2–3 LCD scans (~60 ms) sooner,
  `render:done` ~85 ms sooner, the loop free ~150 ms sooner (estimated from
  the format strings and the driver). Cheap check first: a bench build at
  `CONFIG_ESP_CONSOLE_UART_BAUDRATE=921600` should collapse the three ~30 ms
  stamp gaps to ~4 ms.
- [x] **A backend-managed frame's pulls off the tap path.** On an isolated
  tap `fos_scenes_sync` (ETag GET), `fos_settings_sync` (GET) and
  `fos_commands_sync` (POST) ran before the render and a log POST per line
  around it, all on the render task (unmeasured; plausibly 100–300 ms). On
  an LCD a frame the scene asked for now renders first and pulls after
  (a command that arrives with the tap lands one frame later), and the
  mid-render log flushes wait for `render:done`; e-paper keeps both as they
  were. The bench board is standalone, so this is unmeasured.
- [ ] The 460 KB image push after a render (`push_image_to_backend`, at most
  every 10 s) still hashes and POSTs on the render task.
- [x] **Touch poll at 10 ms while a finger is down** (`fos_touch.c`
  `TOUCH_POLL_HELD_MS` 20 → 10): a drag's moves and the release 5 ms late on
  average, not 10. The idle poll stays at 30 ms: at 10 it cost the animating
  DVD scene about a third of a frame a second.
- [ ] Re-run the icache / dcache / 10-line bounce buffer / 13.63 MHz pixel
  clock experiments on the unquantized three-buffer loop; the recorded
  "no gain" predates the third buffer.

### The raster (pixie + the UI layer)

- [x] **Bold without the round-joined stroke** (ui/layout.nim `emitText`): a
  second fill of the same shared path, translated `size / 24` to the right,
  instead of a stroke with round joins. Host: the label 453 → 42 µs, its
  8,740 malloc+realloc → 52; the toggle's raster 2.0–2.4x. Bold looks a
  shade different; every text snapshot regenerates once (CI commits them).
- [x] **One flattened circle per stroke outline** (pixie paths.nim
  `strokeShapes`): the circle for round joins and caps is flattened once per
  stroke and translated per join. Pixel-identical; −69% of the toggle's
  malloc+realloc on host.
- [x] `share()` the layout's rounded-rect, ring and scroll-bar paths
  (ui/layout.nim): their bounds and flattened shapes are kept.
- [x] Damage bounds without flattening: `share()` above does it — a shared
  path's bounds are measured once and kept (pixie `localBounds`), and the
  layout's boxes and the memo's text are all shared now.
- [ ] Reuse pixie's raster scratch between fills (hits, coverage row, band
  entries): 20–50 malloc+realloc per fill today.

### The JS side

- [x] **Leaner JSX factory** (js_runtime/runtime.nim `__frameosJsx`): quickts
  hands the factory `null` or a fresh object per element (quickts_jsx.h
  `OP_object`), so the spread copy and the `delete` were redundant. Host:
  −34% on tree building, −32..−48% of `get()`.
- [x] **memo() prunes its Map** each render: keyed slots never left it, so a
  list with changing keys grew until the 4 MB heap cap (kept-interpreter
  hosts: an awake LCD board, the Pi, the preview).
- [ ] Walker: attribute names cached by atom, numbers read as numbers
  (js_runtime/jsx.nim).
- [ ] `app.config`, `app.frame` as plain objects; `app.state` converted once
  per render (the Proxy getter is 24 bytecodes per read).
- [x] **Prelude as bytecode in the signed image** (`tools/prelude_bytecode.nim`,
  run by `build_nim.sh` against a host QuickJS built from the tree's own
  sources): both preludes with `JS_STRIP_DEBUG` (7.1 KB + 1.8 KB), loaded
  with `JS_ReadObject` + `JS_EvalFunction`, the source as the fallback; a
  module for another engine version or an older prelude fails the build.
  Bytecode never comes from a control plane: QuickJS checks one `BC_VERSION`
  byte and verifies nothing. Device cold start: see "Measured".
- [ ] A device-written bytecode cache for apps at scene install (the same
  reader; no trust change; flash writes disturb an LCD's scan-out, so write
  at install only).

### Bugs found on the way

- [x] `burrito.evalBytecode` freed `obj` after `JS_EvalFunction` consumed it
  (no caller today; the prelude work below is the first).
- [x] `ui/layout.nim` `build()` scanned the previous children for each child
  (quadratic in a list's length); it tries the same index first.
- [x] `js_runtime/jsx.nim` scans the kept memo entries for each memo'd
  element.
- [x] `interpreter.nim` parsed the scene JSON twice with a serialization in
  between (`annotateInterpretedSceneSourceNodeIds`): ~35 ms per 6 KB scene
  on the device, ~0.5 s for the 72 KB Weather sample, on every wake.

### The Pi

- [x] **The runner wakes on input.** The message loop's wait grows to 200 ms
  after ~4 s idle and the render loop sleeps in 100 ms slices, so every
  handler-triggered render of a long-interval scene (every JSX UI) waits up
  to 100 ms and a first tap up to 300 ms: a JSX UI on a Pi is capped near
  10 Hz by the loop, not the frame (a Pi 5 draws the Touch test in 8 ms).
  An `AsyncEvent` triggered by `channels.nim`'s senders ends both waits; it
  carries no ref across threads.

## T1 — the raster inside pixie (branch `perf-t1`)

- [ ] A kept 565 / Gray8 canvas mode in the wasm preview
  (`src/wasm/wasm_main.nim`) with a repaint-rects export, and an e2e
  differential (kept canvas vs whole render after each scripted input): the
  gate for every raster step, so the editor runs the device's path.
- [x] **The coverage cache, inside pixie** (`paths.nim`, the fork's own
  test `test_coverage_cache.nim`): a shared path filled or stroked again at
  the same subpixel offset and axis-aligned scale is blended from an 8-bit
  mask kept the second time it is seen (not the first: a toggle draws
  mostly paths it never draws again), through the per-format coverage rows
  a fresh fill uses, a row's fully covered run as a span. Keyed by path
  identity, fill rule or stroke, offset fraction, scale. LRU within
  `coverageCacheBudget`: 256 KB on an ESP32, 8 MB on a Pi's render thread,
  2 MB in the preview; dropped when render memory runs short. A handful of
  edge pixels may differ by one quantisation step from a fresh fill.
- [x] **Text as glyph runs** (`ui/layout.nim` `emitGlyphs`): one shared path
  per typeface, rune and size, placed by `SvgNode.offset` (new in the fork:
  a translation without a transform string) at a quarter pixel; a letter
  drawn again anywhere is a mask hit. Underlined and struck text keeps the
  path per span. Glyphs sit up to 1/8 px from where the typesetter put them.
- [x] **Box shapes shared per size** (`boxShape`): a rounded box and its
  border ring are one shared path per (size, radii, border) at the origin,
  placed by offset, so a card that only changes colour hits its mask. A box
  with a gradient keeps its own path (the gradient's coordinates).
- [x] **Translucent boxes pre-blended** over an in-flow parent whose
  background is one flat opaque colour (`overBackdrop`); absolute children
  are painted over nothing known. The two directions of a toggle were 28 ms
  apart on the board for this alone.
- [x] An element's fill colour parsed once at parse time, from a cache of
  the colour strings parsed lately (`parseFillColor`): it was a
  `parseHtmlColor` per element per draw, ~0.1 ms a call on the board.
- [x] **The scene a built-in scene opens over stays resident** for the way
  back (`single_scene_host` `covered`), down to the headroom kept
  interpreters use: no init, no rebuild from JSON when the switcher closes.
- [ ] Typed element kinds inside pixie's `Svg` for the rest of the per-node
  attribute work (parse is 7–8 ms of a toggle).
- [ ] Gray8 (e-paper) and RGBX: the cache and the span blits run on all
  three surfaces (the test covers them); not measured on an e-paper board.
- [ ] Text-memo fixes (press-feedback renders stop re-typesetting; cold flex
  rows typeset once).
- [ ] `JS_NewContextRaw` with a chosen intrinsic list on embedded (−25 KB:
  normalize tables, Proxy/Reflect, WeakRef) after the prelude stops using
  Proxy; a scene guide line.
- [ ] Conditional on the probe's cache-miss answer: `JS_CallInternal` in
  IRAM, its dispatch table in DRAM, small QuickJS blocks in internal RAM.

## T2 — the retained UI (branch `perf-t2`)

- [ ] Dirty flags and relayout boundaries on the existing `UiNode` tree, an
  in-place reconcile and a spliced display list: layout 12 → 2–4 ms, emit →
  ~1 (estimated).
- [ ] Layout-supplied bounds for damage; parse → 0.
- [ ] "Blocks": quickts lowers each JSX site to a static template plus
  dynamic holes; the walker diffs holes. Source-compatible in principle
  (memo() and `__frameosNode` keyed reuse need redesign); fallback: literal
  lowering plus a native factory. Host: handler + get + read 14.8 → 4.3 µs.
- [ ] Refs with setters and a native `frameos.animate`: a drag or an
  animation runs no `get()`.
- [ ] Scroll as a viewport translation: move the rows, draw the entering
  strip (415 KB at 27 MB/s ≈ 15 ms plus the strip).
- [ ] The LCD refill off the CPU (GDMA memory-to-memory from the bounce
  callback; `docs/realtime-todo.md` item 1; high risk: IDF internals).

## Not on the ladder, on purpose

- A second rasterizer (LVGL +112 KB measured, ThorVG ~170 KB, a display list
  beside pixie): one rasterizer, one damage model, one background rule
  (`docs/ui-todo.md`).
- Scenes in Rust, Nim, C or wasm for frame time: ≤17 ms a frame today, ≤4 ms
  after blocks. Native pays only when the device log shows `get+walk`
  exceeding layout+emit+parse+damage+raster together, and then as
  `frameos.*` kernels in shared Nim first.
- A second JS engine: none is faster on scene logic (XS 0.36x QuickJS,
  QuickJS-ng 0.9x, mquickjs an ES5 subset); the engine is cold start and
  flash, both addressed above.
- Plane-pushed QuickJS bytecode, or bytecode as the wire format.
- `-O2` for all of quickjs.c: +165–270 KB of the ~372 KB OTA headroom for an
  unmeasured gain behind a 16 KB instruction cache.
- Ubuntu-Bold.ttf for the bold problem: 140–270 KB of flash for what the
  double strike does in a few lines.

## The device measurements that replace estimates (in this order)

1. The instrumented home-panel toggle on the Indicator, ten taps, the plane
   recorded, with the switcher's reopen and first draw in the same session.
2. The same scene's warm `get()` on an e-paper S3 and on the Indicator with
   the scan-out stopped, with perfmon cycle and cache-miss counters: whether
   JS is 640–1,280x host because of flash/PSRAM misses (then IRAM placement
   moves up).
3. A tap on the reTerminal E1003 (touch e-paper, 1872x1404 Gray8): the second
   interactive population nobody sized.
4. A scroll step and an in-UI animation (two estimates disagree 5–10x).
5. `uiraster.c`-style specialized fills and the bold-removed toggle on the
   board: the raster ceiling on this exact hardware.

## Scene = app directory (orthogonal; `docs/convergence-todo.md` owns it)

A scene as `config.json` + `app.tsx`, old scenes as a diagram transpiled off
the device: yes as the format and the authoring default, a conditional yes
for taking the interpreter out of the ESP32 image. It buys flash (−120 to
−165 KB with the Nim apps behind a bridge, −340 to −390 KB with them ported)
and one QuickJS runtime per scene (−(N−1) × ~155–180 ms cold start, −(N−1) ×
150–580 KB PSRAM for the 25% of catalog scenes with 2–6 runtimes), not frame
time: the interpreter is ~7 ms of a frame. The stored corpus does not fit
yet (3 of 48 catalog scenes are the exact one-app shape, 23 composite with
Nim render apps, 11 react through event nodes). Keep the JSON envelope
(`apps.<key>.sources` already is the directory), one TypeScript transpiler
for both planes, the Pi keeps the interpreter, the ESP32 drops it only on
fleet telemetry. The scene AI writes code nodes with SVG markup into
`render/svg` today (11 of 13 production scenes), steered by
`prompts.ts` "Write a scene-local JS app only for what no catalog app does":
make JSX the default for interactive and sub-second scenes now, for the rest
after one runtime per scene lands (a scene-local app is its own ~580 KB
runtime; a code node shares the ~148 KB scene context).
