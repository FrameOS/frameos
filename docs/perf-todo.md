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

| What | Before | After | When |
| --- | --- | --- | --- |
| JSX Weather, isolated render (`render:framebuffer` → `render:device` → `render:done` stamps) | 80 ms render in place; stamps at 116 / 145 / 178 ms | | 2026-11-07, 2026.11.2 firmware |

## T0 — measured fixes (branch `perf-t0`)

### pixie into the tree (branch `pixie-in-tree`, first)

- [x] `git subtree add --squash` of FrameOS/pixie at 930bee30 under
  `frameos/pixie` (its tests and docs included: the raster work below is
  written on both sides of that line, and it has been one repository in all
  but name since the 565 surface). `config.nims` puts `frameos/pixie/src` on
  the path by default; `FRAMEOS_PIXIE_PATH` still points at another checkout.
  pixie's dependencies (vmath, chroma, flatty, nimsimd, bumpy, crunchy) are
  `frameos.nimble`'s now; `nimble.lock` lost its `pixie` entry.
- [ ] `make test-pixie` runs pixie's own suite (`frameos/pixie/tests`), and the
  Nim CI job runs it when `frameos/pixie/**` changed.
- [ ] Every place that named the fork's URL or a `pixie` package: the
  Dockerfile's dependency layer (it only installs the lock now), the
  cross-toolchain images, `backend/app/tasks/_frame_deployer.py`'s
  `FRAMEOS_PIXIE_PATH` plumbing (still valid), `docs/esp32-image-size.md`,
  AGENTS.md.

### The probe (first, and the gate for everything after T0)

- [ ] A per-phase, per-element and heap-call probe behind the console's
  `set debug 2`: `ensureReady` / `get()` / `toValue` (app_runtime.nim),
  build / layout / emit (ui/layout.nim), parse / damage / raster
  (utils/svg_frames.nim), each element's raster inside pixie's `renderSvg`
  loop, `heap_caps_malloc` counts and time around `renderInto`
  (frameos_nim_glue.c), an empty `__frameosInvoke`. Printed on the logged
  frame only (every console line costs ~20 ms). Record which control plane
  the board is on.

### The firmware loop (C)

- [ ] **Console off the render task, present before logging.**
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
- [ ] **A backend-managed frame's pulls off the tap path.** On an isolated
  tap `fos_scenes_sync` (ETag GET), `fos_settings_sync` (GET) and
  `fos_commands_sync` (POST) run before the render and a log POST per line
  plus the 460 KB image push around it, all on the render task. Unmeasured;
  plausibly 100–300 ms. Move them behind the present (the housekeeping that
  follows a render), keep `render:done` for the deploy-progress signal.
- [ ] **Touch poll at 10 ms** on LCD boards (`fos_touch.c`
  `TOUCH_POLL_NO_IRQ_MS` 30 → 10, `TOUCH_POLL_HELD_MS` 20 → 10): ~10 ms less
  on average per touch-down, 5 ms per release.
- [ ] Re-run the icache / dcache / 10-line bounce buffer / 13.63 MHz pixel
  clock experiments on the unquantized three-buffer loop; the recorded
  "no gain" predates the third buffer.

### The raster (pixie + the UI layer)

- [ ] **Bold without the round-joined stroke** (ui/layout.nim `emitText`): a
  second fill of the same shared path, translated `size / 24` to the right,
  instead of a stroke with round joins. Host: the label 453 → 42 µs, its
  8,740 malloc+realloc → 52; the toggle's raster 2.0–2.4x. Bold looks a
  shade different; every text snapshot regenerates once (CI commits them).
- [x] **One flattened circle per stroke outline** (pixie paths.nim
  `strokeShapes`): the circle for round joins and caps is flattened once per
  stroke and translated per join. Pixel-identical; −69% of the toggle's
  malloc+realloc on host.
- [ ] `share()` the layout's rounded-rect, ring and scroll-bar paths
  (ui/layout.nim): their bounds and flattened shapes are kept.
- [ ] Damage bounds from control points (pixie `localBounds` /
  `paintBounds`): a rounded rect from its corners, text from its
  arrangement, instead of flattening to measure. Most of the damage step's
  ~7 ms on a changed tile; boxes may come out a little larger.
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
- [ ] **Prelude as bytecode in the signed image**: a host build step linked
  against the pinned quickts writes both preludes with `JS_STRIP_DEBUG`;
  `ensureReady` / `ensureSceneJs` load them with `JS_ReadObject` +
  `JS_EvalFunction`; the build fails on a `QuickjsVersion` mismatch. Cold
  start per interpreter ~155–180 → ~65–100 ms (estimated: 9–14x on host);
  +4.4–6.4 KB of flash (the reader is 5.3 KB on xtensa, the 7.1 KB bytecode
  replaces the 8.0 KB source string). Bytecode never comes from a control
  plane: QuickJS checks one `BC_VERSION` byte and verifies nothing.
- [ ] A device-written bytecode cache for apps at scene install (the same
  reader; no trust change; flash writes disturb an LCD's scan-out, so write
  at install only).

### Bugs found on the way

- [x] `burrito.evalBytecode` freed `obj` after `JS_EvalFunction` consumed it
  (no caller today; the prelude work below is the first).
- [x] `ui/layout.nim` `build()` scanned the previous children for each child
  (quadratic in a list's length); it tries the same index first.
- [ ] `js_runtime/jsx.nim` scans the kept memo entries for each memo'd
  element.
- [ ] `interpreter.nim` parsed the scene JSON twice with a serialization in
  between (`annotateInterpretedSceneSourceNodeIds`): ~35 ms per 6 KB scene
  on the device, ~0.5 s for the 72 KB Weather sample, on every wake.

### The Pi

- [ ] **The runner wakes on input.** The message loop's wait grows to 200 ms
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
- [ ] Typed element kinds inside pixie's `Svg` (`seRoundRect`, `seRing`,
  `seGlyphRun`, `seSprite` beside today's rect and image), a typed fill
  colour parsed once; the layout emits them instead of attribute strings.
  Damage, `coversOpaque`, the nested viewport and svg_frames stay one
  implementation on every host.
- [ ] Span fill for opaque rects, corner masks for rounded rects and rings
  (masks built by pixie's own filler, so boxes stay pixel-identical); the
  565 blend in spread words; Gray8 and RGBX kernels.
- [ ] The A8 coverage cache (`utils/coverage_cache.nim`) behind glyph runs
  and icon sprites: keyed on (face, glyph, device size, bold, quarter-pixel
  phase), 64 KB LRU (16 KB on large e-paper canvases), released by
  `renderMemoryReleaseHook`; a miss fills through pixie. Host: 13x on a
  regular label, 182x on a semibold one, zero allocations.
- [ ] Pre-blend a translucent box over a flat opaque parent (card
  background 82 → 20 µs on host); apply only when nothing else lies under.
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
