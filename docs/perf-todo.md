# Interactive performance — where a frame's time goes, and what is left

*Written 2026-11-07, from a three-pass investigation (code readers, outside
research, host benchmarks, designs and skeptics) and then a day of work on a
SenseCAP Indicator on the bench (PR #681). The older model and measurements
are `docs/realtime-rendering.md` and `docs/jsx-ui.md`. Read cold: what was
wrong, what changed and what it measured, what is still open and why. When an
open item ships, move it up into "What changed" with its number.*

## The question, and the answer

A JSX UI on the SenseCAP Indicator (ESP32-S3, 480x480 RGB565 LCD in PSRAM)
answered a tap in ~300 ms where a native toolkit on the same board is
estimated at 15–35 ms. The gap was not the scene language. Where that tap
went (the home panel, `e2e/scenes/jsxSquareHome.json`, one card toggled):

| Where | Then | Why |
| --- | --- | --- |
| Console I/O on the render task | ~100–150 ms | every log line a `printf` through ESP-IDF's UART VFS, one character per call at 115200 baud; two lines sat between the finished render and the buffer switch |
| Raster of 28,564 px | 68–98 ms | 6–15% of it wrote pixels: bold drawn as a round-joined stroke (a circle flattened per join), every glyph and box re-flattened and re-scanned each frame, a fill colour parsed per element per draw, ~9k heap calls a toggle |
| layout + emit + parse + damage | ~31 ms | each toggle re-typeset its texts and re-read class strings |
| JS `get()` + the JSX walk | ~18 ms | |
| the diagram interpreter | ~7 ms | |

Native scene code of any language replaces only the `get()` row. What makes
native toolkits fast — cached glyph coverage, span fills, dirty rectangles,
a retained tree, no allocation in the hot path — this pipeline now has most
of, while scenes stay TSX.

## Measured: main against this branch, one board

2026-11-07, the same scenes and the same scripted sequence (four cold
switches, eight home-panel taps over the HTTP event route, the scene switcher
opened twice, the JSX DVD bounce for 40 s); main built from 0267672c
(3,231,952 B, the release's size).

| | main | this branch |
| --- | --- | --- |
| Home-panel tap, render (steady) | 295–349 ms | **76–83 ms** |
| Tap to `render:done` | 323–360 ms | **~85–90 ms** |
| Scene switcher open (cold / again) | 2,293–2,547 ms | **812–854 / 319–340 ms** |
| Switcher closed, back to the home panel | a rebuild, ~250 ms | **64 ms** (its buffer holds the panel), ~300 ms (it holds another frame) |
| Cold switch: Weather / Home / Calculator | 1,229 / 361–421 / 492 ms | 675–696 / 218–264 / 337–344 ms |
| JSX DVD bounce, 33 ms period | 29.0–29.2 fps; a quiet frame 31.4 ms on average (the max, 170–185 ms, is the frame logged in full) | 29.5–29.6 fps; a quiet frame 30.5–30.7 ms, the logged one 39 ms |
| Free internal RAM after the sequence | 72.4 KB (largest 36.9 KB) | 67.7 KB (largest 30.7 KB): the log ring task's stack |
| Free PSRAM after the sequence | 3.62 MB | 3.44 MB: coverage masks, glyph paths, the covered scene |
| App image | 3,231,952 B | 3,261,328 B (+29.4 KB; 343,152 B free in the OTA slot) |

A toggle's split now (`set debug 1` puts it on every render line): scene 76
= the JS app node 69 (get 11, walk 3.5, layout 8: build 4, text 1–1.5; emit
3, parse 4.5, damage 4.6, raster 24.6 with 28–29 coverage hits) and ~7 ms of
interpreter around it.

## What changed (PR #681)

**pixie is in the tree** (`frameos/pixie`, a squashed subtree of
FrameOS/pixie@930bee30; `config.nims` puts its `src/` on the path,
`FRAMEOS_PIXIE_PATH` still overrides). `make test-pixie` runs its suite (CI
shard 2); `test_gray8` / `test_rgb565` failed before the move (one
quantisation step on this host) and are skipped with a note.

The firmware loop:
- `fos_log_ring.c`: log lines go into a PSRAM ring a core-0 task drains, one
  `write()` per line; flushed before deep sleep and on `esp_restart`. The
  three ~30 ms gaps between `render:*` stamps went to ~1–6 ms.
- On an LCD a frame the scene asked for renders before a backend-managed
  frame's pulls (scenes/settings GET, commands POST) and its mid-render log
  flushes wait for `render:done`. Unmeasured: the bench board is standalone.
- The touch controller is polled every 10 ms while a finger is down (the
  idle poll stays at 30 ms: at 10 it cost the DVD scene a third of a frame
  a second).

The raster (pixie and the UI layer):
- Bold on a one-face runtime is a double strike, not a round-joined stroke;
  a stroke's join circle is flattened once per outline.
- **The coverage cache** (`paths.nim`, its test `test_coverage_cache.nim`): a
  shared path filled or stroked again at the same subpixel offset and
  axis-aligned scale is blended from an 8-bit mask, made the second time it
  is seen; a row's fully covered run is a span fill. LRU within
  `coverageCacheBudget` (256 KB ESP32, 8 MB Pi render thread, 2 MB preview),
  masks up to 48 KB, dropped when render memory runs short. A few edge pixels
  can differ by one quantisation step from a fresh fill. The probe line says
  why a fill skipped it (`| skip first 1 big 1`).
- Text is glyph runs: one shared path per typeface, rune and size placed by
  `SvgNode.offset` (new) at a quarter pixel. Boxes and border rings are shared
  per size; SVG shape elements (`<circle>`, `<line>`, `<rect rx>`, …) are
  shared by geometry as `<path d>` already was; every element's path is shared
  once parsed.
- Translucent backgrounds over an in-flow box with a flat opaque background
  are pre-blended; a fill colour is parsed once per element (from a cache of
  recent colour strings), not per draw.
- **A path whose masks go unused makes no more for a while** (`maskWaste` on
  the path, `| skip wasted` on the probe line). The JSX DVD bounce places its
  logo at `Date.now()`'s whole milliseconds × 0.11 px, a hundred fractions
  that recur, so the second-sight rule made a 10 KB mask in most frames, each
  evicted before its fraction came back: 0 hits, 1–2 misses a frame, the
  cache full at 255 KB with the UI's masks pushed out, and frames spread from
  under 28 ms to 40 ms where main's sat at 28–33 (a frame faster than the
  period banks nothing, one slower makes the next late). That was the
  branch's "DVD ~1 fps below main" (27.7–28.7 fps), now 29.5–29.6.

The layout and the JS side:
- The text memo keeps a layout's unused texts one layout longer (a toggle's
  two texts are each typeset once); class strings and their flags are read
  through small caches; two quadratic lookups are gone.
- The JSX factory is C (`js_runtime/jsx_native.nim`), installed over the
  prelude's; quickts' fresh props are no longer copied; `memo()` swaps two
  cleared maps per render (one map grew to the 4 MB heap cap with changing
  keys).
- The JS preludes are QuickJS bytecode in the firmware image
  (`tools/prelude_bytecode.nim`, run by `build_nim.sh` against a host QuickJS
  built from the tree's sources), the source as fallback, a compile-time
  check against the engine version and the prelude source. The prelude went
  from ~102 ms to ~10 ms of a cold start. Bytecode never comes from a control
  plane: QuickJS checks one version byte and verifies nothing.
- The scene JSON is parsed once (a jsony postHook stamps
  `__frameosSourceNodeId`); `burrito.evalBytecode`'s double free is fixed.

Hosts:
- The scene a built-in scene (switcher, settings) opens over stays resident
  for the way back while the headroom kept interpreters use holds
  (`single_scene_host` `covered`).
- The Pi runner wakes on input: `channels.nim` triggers an `AsyncEvent` after
  queueing, and both runner loops end their sleep on it.
- `frameos/render_probe.nim`: the per-phase split on the device's render line.

## Still open

- **~7 ms of interpreter** around one app node per render, and ~6 ms inside
  the app node outside the probed phases: not located.
- **Build** (4 ms of a toggle): what is left after the class caches.
- **The wasm preview has no kept canvas**: the editor never runs the damage
  path (`src/wasm/wasm_main.nim` renders a fresh image every call).
- **`JS_NewContextRaw` without Proxy / normalize / WeakRef** (−25 KB on the
  ESP32): needs the prelude's Proxy views of `app.config` / `state` /
  `frame` / `context` replaced first.
- **"Blocks"** (JSX lowered to a static template plus holes): the parser
  side shipped in quickts `2026-06-04-quickts.3` (2026-11-07) as
  `JS_EVAL_FLAG_JSX_BLOCKS`, a `__frameosBlock(template, ...holes)` call per
  site with the template a sealed constant-pool array (`docs/quickts.md`
  "Blocks"). Still to do here: a `__frameosBlock` that reads a template once
  by identity and diffs the holes (the walker's `JsxMemo` and `__frameosNode`
  keyed reuse need redesigning around it), the prelude's JavaScript fallback,
  then the flag in `quicktsFlagsFor`.
- **Dirty flags and relayout boundaries** on the `UiNode` tree, an in-place
  reconcile: what is left of layout and emit.
- **Refs with setters and a native `frameos.animate`** (a drag or an
  animation without `get()`): new API, needs a design.
- **Scroll as a row move**: nothing on the bench board scrolls (the
  switcher's 18 tiles fit), so a scroll step is unmeasured.
- **The LCD refill off the CPU** (GDMA from the bounce callback,
  `docs/realtime-todo.md` item 1): IDF internals, high risk.
- The 460 KB image push after a render on a backend-managed frame
  (`push_image_to_backend`, at most every 10 s) still runs on the render task.
- An e-paper board (Gray8 surface, the reTerminal E1003's touch) and a Pi
  have not been benchmarked with these changes; the cache and blits run on
  every surface and their test covers RGBX, 565 and Gray8.

## What it costs in flash

+29.4 KB over main (it was +49.6 KB until the map was read symbol by symbol:
the prelude's source stayed in the image beside its bytecode, 10.3 KB;
`rasterizeMask` called pixie's generic `fillShapes` with a `ColorRGBX`, a
second 4.2 KB copy of it, which also took gcc's inlining of
`computeCoverage` — a call per scanline — out of every fill; three `Table`
instantiations, 3.9 KB; the probe templates compiling the timed code twice
and `strformat` for its line, ~2 KB). What is left, roughly: the layout's
glyph runs, shared boxes and caches 5.7 KB; the coverage cache 4.9 KB; the
QuickJS bytecode reader 4.4 KB (the bytecode itself is 0.9 KB smaller than
the source it replaced); the probe ~4 KB; pixie's SVG shape sharing 2.8 KB;
generic seq code 2.1 KB; the covered scene 1.5 KB; the log ring 1.5 KB; the
C JSX factory 0.7 KB. A build with no render probe would save its ~4 KB; it
stays, so a frame in the field can say where its time goes.

To read a change's cost: build both trees, then diff the two
`frameos_esp32.map` files by symbol (Nim's `_u<n>` suffixes and the pixie
path stripped), not `firmware-size.json`'s groups, which moved with pixie.

## Not on the ladder, on purpose

- A second rasterizer (LVGL +112 KB measured, ThorVG ~170 KB): one
  rasterizer, one damage model, one background rule (`docs/ui-todo.md`).
- Scenes in Rust, Nim, C or wasm for frame time: `get()` is ~11 ms of ~80.
- A second JS engine: none is faster on scene logic; the engine's costs are
  cold start (addressed) and flash.
- Plane-pushed QuickJS bytecode, or bytecode as the wire format.
- `-O2` for all of quickjs.c: +165–270 KB of flash for an unmeasured gain.
- A bold face file for the bold problem: 140–270 KB for what the double
  strike does.
- A structural digest per JSX node (tried: the layout did not move, the walk
  paid ~1 ms).

## Scene = app directory (orthogonal; `docs/convergence-todo.md` owns it)

A scene as `config.json` + `app.tsx`, old scenes as a diagram transpiled off
the device: yes as the format and the authoring default, a conditional yes
for taking the interpreter out of the ESP32 image. It buys flash (−120 to
−165 KB with the Nim apps behind a bridge, −340 to −390 KB with them ported)
and one QuickJS runtime per scene, not frame time (the interpreter is ~7 ms
of a frame). The stored corpus does not fit yet (3 of 48 catalog scenes are
the exact one-app shape, 23 composite with Nim render apps). The scene AI
writes code nodes with SVG markup into `render/svg` today (11 of 13
production scenes), steered by `prompts.ts`; make JSX its default for
interactive and sub-second scenes first.
