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
`FRAMEOS_PIXIE_PATH` still overrides). `make test-pixie` runs its suite (CI's
"pixie tests" job, `PIXIE_TEST_JOBS` compiles at a time); `test_gray8` / `test_rgb565` failed before the move (one
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

## The glyph cache (2026-11-19)

Text no longer goes through the coverage cache: a glyph is a glyph path (no
outline) and a fill of one is a blit from pixie's glyph cache, its coverage
at its size and quarter pixel, four bits a pixel, kept the first time it is
drawn (`docs/jsx-ui.md` "The glyph cache"). It covers the JSX layout's glyph
runs, SVG `<text>` in one colour and pixie's `fillText` (the Text app, the
status screens), which used to fill a whole line's outline every render. On a
host the repaint time is unchanged (a blit 365 ns against a coverage mask's
378, a whole home-panel repaint 240 µs either way); what it buys is memory
(`docs/esp32-memory.md` "Text keeps coverage, not outlines": the text
caches of a home panel went from ~133 KB to 12 KB) and, for the Text app and
SVG text, a mask where there was an outline. The render line has its counts
(`glyphs hits/misses KB`). Not measured on a board yet.

## The hardware bench's slow renders (2026-11-18)

The bench run of 2026-11-18 (2026.11.11) flagged four scenes at 10 to 16 s a
render on the reTerminal E1003 (1872x1404, sixteen greys) and two animations
below their frame rate on the SenseCAP Indicator. Where the time was, from
the render line's probe (which gained `paint`, the gradient and image fills
through a shape, and the average split of an animation's quiet frames,
`| quiet 234: scene 33.2 ...`: the frame logged in full builds its log
lines, so its own split says little about the frames between):

**A page's gradients, on any panel that is not RGBA.** Analog clock face,
Big typographic clock, Word clock and Chess puzzle of the day each lay three
to five gradients over the page: a background, a corner glow, a vignette.
Each was an RGBA mask the size of the page made and cleared (0.5 s of PSRAM
writes each), the rectangle filled into it, and a fill that read the mask
back a pixel at a time, evaluated the gradient with a division or a square
root a pixel (library calls on an S3) and blended through the general store:
8.8 to 10.6 s of each render. Now (`pixie/paths.nim` "A gradient into a grey
or 565 image", `pixie/paints.nim`):

- a box of whole pixels has no mask (`fillGradientBox`), and any other
  shape's mask is a byte a pixel, in strips eight times as tall;
- a grey target takes its rows as luma and alpha from tables made once a
  fill (`prepareGrey`): blended over a grey G, a colour's luma is its own
  plus G * (255 - alpha) / 255, exactly, and two pixels of a sixteen-grey
  byte go in one store;
- the table entry of a diagonal gradient is a fixed-point sum along the row
  and a radial one's is found by the squared distance against thresholds,
  stepped from the pixel before (`forEachIndex`): no division, no root;
- a radial table whose ends hold no ink (a glow fades out, a vignette starts
  from nothing) is only looked at between the ellipse's crossings of the row
  (`inkSpans`): two thirds of those pages' gradient pixels were transparent;
- the rows are a job both cores take (`rowsRunner`, the firmware's
  `fos_rows.c`), and `pixie/paints` is on the -O2 list.

The pictures are the ones the masked fill made: `tests/test_gradient_box.nim`
holds a box to the mask's pixels and any shape to the composite spelled out,
a pixel at a time. Two things may differ from before by one table entry (a
quarter of a colour level): a pixel on the line between two entries of a
diagonal or radial table.

| E1003, warm render | 2026.11.11 | main, same day | this branch |
| --- | --- | --- | --- |
| Word clock | 10.4 s | 10.2 s (gradients 8.8) | 2.7 s (1.2) |
| Analog clock face | 12.4 s | 11.1 s (9.1) | 3.3 s (1.3) |
| Big typographic clock | 15.3 s | 15.1 s (10.3) | 6.7 s (2.0) |
| Chess puzzle of the day | 15.6 s | 14.3 s (10.6) | 5.3 s (1.6) |

What is left of them: the solid fills (0.6 to 2.2 s: a thousand decorative
shapes in the big clock), `get()` in QuickJS (0.9 s for the big clock, 1.5 s
for the chess board), and the gradients that remain.

**Every frame built the frame's whole scene list.** `render_once` asked
`frameos_nim_scene_info_json` for the id of the scene showing, which builds
and prints every scene of the frame as JSON: 5.7 ms a frame on a SenseCAP
Indicator holding 25 scenes, a seventh of a DVD Logo Bounce frame, more with
more scenes. It asks `frameos_nim_current_scene_id` now. And a quiet frame
looks at the state to persist four times a second, not every frame (0.9 ms;
an event's look and a scene about to go are unchanged).

| SenseCAP Indicator | 2026.11.11 | main, same day | this branch |
| --- | --- | --- | --- |
| DVD Logo Bounce (30 fps asked) | 18.8 to 20.8 fps | 23.2 fps, 42 ms a frame | 27.4 fps, 36 ms |
| Pixel toys (50 fps asked) | 17.1 to 17.7 fps | 18.4 fps, 54 ms | 20 to 21 fps, 47 to 49 ms |

Neither reaches what it asks for. The panel scans 42.3 times a second
(12 MHz, 548x518 with its porches), so 50 fps is not there to have, and its
refill interrupt takes about half of the render's core while it scans.

- DVD Logo Bounce is 3 ms a frame short of 30 fps. A quiet frame: `get()`
  7.6 ms, the raster 9.2 (two marks of three paths from the coverage cache,
  one of them a translucent shadow), pixie's parse of six paths 4.4, the
  scene program around the app 4.5, its natives 2.1, the JSX walk 1.7. The
  parse is the place to look next.
- Pixel toys' `get()` alone is 25 ms of JavaScript a frame (the effect's
  cells), and the cells' way into the panel buffer another 12: 20 fps is
  about what this board has for it. 50 fps would need the effect out of
  QuickJS.

## Still open

- **~7 ms of interpreter** around one app node per render, and ~6 ms inside
  the app node outside the probed phases: not located.
- **Build** (4 ms of a toggle): what is left after the class caches.
- **The wasm preview has no kept canvas**: the editor never runs the damage
  path (`src/wasm/wasm_main.nim` renders a fresh image every call).
- **`JS_NewContextRaw` without Proxy / normalize / WeakRef** (−25 KB on the
  ESP32): needs the prelude's Proxy views of `app.config` / `state` /
  `frame` / `context` replaced first.
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

- **"Blocks"** (JSX lowered to a static template plus holes), tried and
  parked 2026-11-07. quickts `2026-06-04-quickts.3` (#682) added the
  lowering; the FrameOS half (#684, branch `jsx-blocks`: a C
  `__frameosBlock` making lazy elements, the walker building them from
  templates read once and taking back nodes whose values did not change)
  halved a laptop's walk of a UI without memo(), but on the SenseCAP
  Indicator a home-panel tap went 74.5 → 79.5 ms (`get()` 11.1 → 13.1: a
  component's props built from the template cost more than the factory's
  bytecode literal), a calculator tap stayed at 67 ms, the DVD bounce at 28
  fps, and a scene's first walk grew 5 ms. The walk is 3–5 ms of a tap here,
  so there was little to win, for +15.4 KB of flash and the parser's own
  bytes. Both were reverted to quickts `.2`. Worth another look only with a
  board scene whose walk is a real share of its frame.
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
