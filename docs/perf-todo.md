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

## memo() and a handler's call in C (2026-11-20)

Where a tap's time goes that no state model would skip: a research pass
(branch `research/ui-state-model`) put probes on the SenseCAP Indicator and
found two fixed costs in JavaScript plumbing.

- **memo() was 1.1 ms a call**, hit or miss: a `Map` lookup, `Object.keys`
  twice and a loop, each a builtin read from flash. An element made inline is
  ~0.1 ms, a plain component call ~0.35, so memo() made things slower unless
  it skipped a big subtree: six memo()'d cards were 6 to 7 ms of the home
  panel's 11 ms `get()`. It is C now (`js_runtime/jsx_native.nim`: the slots
  in two arrays of C structs, swapped when a new `get()` begins), the same
  semantics, ~0.25 ms a call.
- **A handler went through the prelude's `__frameosHandle`**: the payload as
  JSON text, `JSON.parse`, two object spreads, then the handler; 1.5 to 2 ms
  for a handler that itself ran in 0.1. It is called straight from Nim now,
  its event built there, `e.target` only where the docs promise one (a
  field's edit, a box's scroll).

The render line says what the events since the last line took to dispatch
(`| input 7.2/2`: two events, handlers included). Measured on the board, the
same scenes and taps, main against this change (medians):

| | main | now |
| --- | --- | --- |
| Home panel (six memo()'d cards), tap render | 68 ms, get 10.1 | 63 ms, get 6.7 |
| 100 memo()'d cells, tap render | 165 ms, get 104 | 87 ms, get 28 |
| To-do, a tap's dispatch (pointerUp, tap, handler) | 15.0 ms | 9.8 ms |
| Calculator / Counter, a tap's dispatch | 8.8 / 9.3 ms | 7.2 / 7.6 ms |
| A tap whose handler changes nothing, its dispatch | 8.7 ms | 7.2 ms |

+2.3 KB of flash (the C memo with its class, less the prelude's handler).

What is still fixed in every tap, for the next pass (the research branch's
probes, a tap whose handler changes nothing): ~7 ms of dispatch (the input
state 1.4 for down and up, the event maps 0.6, the `event:render` log line
0.7, the handler's call around it 0.9, the rest the queue), ~3 ms between the
dispatch and the render (`render:scene`'s log line and the frame buffer), a
16 ms render of a tree that did not change (the scene program around the app
node ~4, the app node ~6, `native` ~5 of which the debug profile is most),
and ~5 ms after it for the `render:framebuffer` / `render:device` /
`render:done` lines and the buffer switch.

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

## A tap on the E1003, lift to waveform (2026-11-24)

Of ~185 ms between a tap's lift and its DU starting on the reTerminal E1003,
the render was 22 ms (main's signal() Calculator). The rest, from the
`render:timeline` line (`set debug 1`) and the code:

| | 2026.11.14 | now |
| --- | --- | --- |
| render done → update call (a SHA-256 of 1.3 MB for the display state) | 43.5 ms | 0.8 |
| hash of every tile before the upload | ~30-50 (inside `update`) | 0: the render's box |
| `it8951:` printf behind the render's lines, HRDY in 10 ms ticks | 10-45 | gone |
| NVS commit of the display state after the update | 14.2 | 0.1 |
| lift → DU starts | ~185 | ~37-50 |
| `render #N done in` (probe off) | 183 | 78-98 |

How (docs/realtime-rendering.md "Partial refresh on e-paper"): the render's
box (`svg_frames` `takePanelPaint`) is what is hashed before the upload, and
the whole picture after the waveform has started (31 ms on both cores, 20 ms
when nothing changed), any tile it missed sent in a follow-up and logged; the
display state is not hashed or written while somebody taps, only when the
hold releases and before a deep sleep; the log ring; LUTAFSR polled per tick,
then every 0.5 ms near the waveform's end (DUs ran 413-443 ms); the settle at
4.5 s and never under a finger; any change while tapping one DU; GT911 reads
of 9 bytes at 400 kHz. Standby: SYS_RUN answered in 22 ms, but the first
waveform after a standby ran 898 ms against 580, so on USB power the
controller is no longer put in standby; at boot its 1.9 s bring-up runs while
Wi-Fi joins (done 3.0 s after `restart`, the first render at 7.0 s).

## A tap lays out, sets in type and parses only what changed (2026-11-24)

Where a tap's render went on a SenseCAP Indicator (2026.11.14, `set debug 1`,
main's `signal()` Calculator sample, one key): render 46 ms (37 without the
probe), of which **layout 25 to 29 ms, its text 10.5 ms, on every tap**,
where the same scene on a reTerminal E1003 laid out in 2.2 ms. And a to-do
list's tap parsed 15 ms of SVG with nothing in the list changed. Three
caches kept too little:

- **A label kept one arrangement.** A text in a flex row is measured in the
  room its container offers (106 px for a key), then set in the width it
  took (19 px): two widths, three or four layout calls a layout. One kept
  arrangement missed at every other call, and each miss built the memo key
  and looked it up in the memo's lists, 197 lookups a press of the
  Calculator (`ui/layout.nim` `arrange`). A text node keeps two now, each
  with its memo entry; entries are refs the node holds, so a label that did
  not change is neither looked up nor set, and stays in the memo (`claim`).
- **A node kept two layout answers.** An item of a row in a column is asked
  three questions a layout (in the room, at its width, at its width and
  height): every node of the keypad was laid out again at every press. Four
  kept (`older`), a press of the test's keypad makes 55 layout calls where
  it made 335, and looks up 3 texts where it looked up 161
  (`test_ui_layout.nim` "a key pressed in a grid lays out that key alone").
- **A changed picture deep in a UI kept its old parse.** pixie keeps the
  parse of a nested viewport's children since #997, so a node that
  `fillSceneImages` or `fillUrlImagesIn` changes in place (a `<Scene>`'s
  picture, an `<img src>` that came in) is forgotten with its ancestors now,
  not alone. A test pins the list case ("a change in a list that scrolls
  parses that row alone": 4 nodes parsed when one of twelve rows changes).

The render line gained `copy`, under `damage`: the pixels copied in from
another of the LCD's buffers.

On the SenseCAP Indicator, main (eae3bfe32) against this change, the same
board and session, five taps each after a warm one, medians:

| | main | now |
| --- | --- | --- |
| Calculator (`signal()`), a key's render, probe on | 45 ms: layout 25.1, text 10.2 | **24 ms**: layout 4.0, text 0.3 |
| the same, probe off | 38 ms | **20 ms** |
| the same, a tap's two renders (press and result, `render:burst`) | 53 ms each | **33 ms** each |
| Calculator (2026.11.14's, `get()` every tap), layout of a render | 32.3 ms, text 10.7 | 7.5 ms, text 0.3 |
| To-do, a tap in a row's field: parse | 16.3 ms | 4.5 ms (nested parses kept: the board ran this branch's own version, #997's landed first and is the one kept) |
| Home, a card's toggle | 47 ms | 45 ms (raster 15: the card) |

## A press shows at once (2026-11-24)

An hour of console taps on release 2026.11.14 (the SenseCAP Indicator and the
reTerminal E1003, `set debug 1`; main's `signal()` samples beside the boards'
older copies) found the render itself no longer the main cost of a tap on
either. On the SenseCAP the `signal()` Calculator's key renders in 37 ms (46
with the probe on), of which layout is 25 to 29 (text 10.5 every tap); the
same scene on the E1003 renders in 22 ms. But on the LCD nothing showed until
that render was on the glass, 80 to 110 ms after the finger (the touch
chip's 10 ms poll, the 20 ms settle, the dispatch, the press render, a scan),
and on an element with no `active:` class not until the lift; a tap behind a
timed render waited for all of it. On the E1003 nothing moved on the glass
before the answer's waveform started (~0.2 s after the lift) and finished
(~0.5 s more). What changed (docs/realtime-rendering.md "A press shows at
once"):

| | before | now |
| --- | --- | --- |
| SenseCAP: contact to the pressed element shaded on the glass | 80-110 ms (`active:` only), else at the lift | 5 ms after the first report: within the 10 ms poll and a 24 ms scan, `active:` class or not |
| SenseCAP: a quick tap behind a busy render | never looked pressed | its `active:` look with the answer, 150 ms |
| SenseCAP: a handler that blocks (sync fetch in `onClick`) | no sign until its render | the loading mark at 0.5 s |
| Either: a timed render due under a finger | the tap waited for all of it | waits for the lift (1.5 s at most) |
| E1003: contact to something showing | the answer's waveform, ~0.4-0.7 s after the lift | the LED at the press; a slow element (the Press test's 1.5 s button) inked: its DU started 39 ms after the render task took the press, the upload included; the quick button beside it is not inked |
| E1003: a scene switch somebody waits for | nothing on the glass for 1.4-6 s | the loading tile, its DU started 56 ms into the switch |

What it costs: about 7.5 KB of the S3 image (3,224,576 bytes against the
3,217,024 of #994, the main this was built on: `fos_client.c` and
`fos_touch.c` most of it, `lcd_press.c` 0.4 KB, `fos_press.c` 0.3 KB), 115
KB of PSRAM on the SenseCAP once a press has been lit (a quarter of the
panel's pixels, for the biggest box), and the press map made after every
render on an LCD too. That build is 0.02 us on a host for DVD Logo Bounce
(nothing to press) and 0.32 us for the Home panel (six entries), and an
animation's quiet frame on a scene whose last map was empty builds none
(`press_map_publish`). Main and this branch in turn on one SenseCAP, DVD
Logo Bounce's steady ten seconds: 29.6 fps (296 frames, 28 ms a frame)
against 29.5 (295, 29 ms; the line rounds to whole ms), twice each, before
that gate. The 27 ms of 2026.11.14 against 30 seen earlier the same day was
main's own change since the release: main itself measured 28.

## Still open

- **A render that is already running is not stopped for a tap** (2026-11-24).
  A timed render no longer starts under a finger (`fos_timed_render_waits_for_finger`),
  but one under way when the finger lands runs to its end: there is no safe
  checkpoint. The scene program runs its nodes in one go and a node's own
  work has none (the Slideshow's 0.5-0.7 s is one JPEG decode); stopping
  between nodes, or through QuickJS's interrupt handler, would leave a
  `get()` half run (a slideshow's index moved on, its photo not drawn), the
  e-paper canvas (the panel buffer itself) half drawn and the damage records
  of `svg_frames.nim` describing a frame that is not there. It would need a
  render to be a transaction it is not. The lit press (an LCD) and the ink
  and LED (e-paper) are what shows meanwhile.
- **Closing the scene switcher on the E1003 renders the covered scene again**
  (Analog clock face 2.9 s and a GC16). Keeping its picture in the IT8951's
  memory (a second image buffer: `LISAR` on load, `DPY_BUF_AREA` to show it)
  was looked at and not built: the controller's buffer starts at 3.86 MB
  (`0x003dbe78`) and a second 1872x1404 frame needs 2.6 MB more, which the
  SDRAM's size (not reported by the controller) was not shown to hold; and the
  frame's own canvas is the panel buffer, which the switcher draws over, so
  the covered scene's picture would have to be kept on the board too (1.3 MB
  of PSRAM) for the next tap's damage to be right. The loading tile shows
  while it renders.

- **~7 ms of interpreter** around one app node per render, and ~6 ms inside
  the app node outside the probed phases: not located.
- **Build** (4 ms of a toggle): what is left after the class caches.
- **The wasm preview has no kept canvas**: the editor never runs the damage
  path (`src/wasm/wasm_main.nim` renders a fresh image every call).
- **`JS_NewContextRaw` without Proxy / normalize / WeakRef** (−25 KB on the
  ESP32): needs the prelude's Proxy views of `app.config` / `state` /
  `frame` / `context` replaced first.
- **Dirty flags and relayout boundaries** on the `UiNode` tree, an in-place
  reconcile: what is left of layout and emit. With four answers kept, a
  press of a 4x4 keypad still makes 55 layout calls: the pressed key's row,
  the column and the root are built again, have no answers, and ask their
  kept children again at each of their own calls.
- **The first two renders after a scene's first picture copy a whole frame**
  on an LCD: the other two buffers hold no record of the new scene, so each
  takes the newest frame in whole (`copy` 22 to 25 ms on the SenseCAP, the
  first two taps of a Home or To-do panel), and only then repaints by
  damage. Copying the first picture into the idle buffers while the frame
  waits (an async DMA copy, recorded as their frames) would take it off
  those taps.
- **The scene switcher's open on a SenseCAP** is not the 1.7 to 1.9 s of the
  2026.11.14 bench run on main: 920 to 954 ms the first time after a boot
  (raster 546 to 560, of which 385 ms are 187 glyphs drawn into the glyph
  cache for the first time; layout 188 to 238, text 168 to 218), 121 to
  206 ms after. The first open's text is the place to look.
- **The SenseCAP's pixel clock** (12 MHz since 2026-10-25, when 16 and 18
  dropped frames on 160 MHz DIO flash; the image runs 240 MHz QIO now):
  `lcd pclk 14` and `16` on 2026-11-24 dropped no frame in 25 s of DVD Logo
  Bounce, and lost 5 or 6 during a flash write as 12 MHz does. DVD Logo
  Bounce ran 29.5 fps at 12 and 14 MHz and 27.6 at 16. 14 MHz (49.3 Hz)
  would take ~3.4 ms off the average wait for the next frame and its scan;
  not the default until a soak under Wi-Fi traffic says it holds.
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
- **A DU's picture at 1 or 2 bits a pixel** (the IT8951): while somebody taps
  every changed tile goes up as 4 bpp and is halftoned to black and white on
  the way, so a whole-panel change is 1.3 MB on a 20 MHz bus, ~0.55 s before
  its DU starts. The controller has a 1 bpp mode (register UP1SR bit 2 and
  the foreground/background greys in BGVR, an 8 bpp load whose bytes are
  eight pixels each: Waveshare's `EPD_IT8951_1bp_Refresh`), a quarter of the
  bytes. Not done: the mirrored E1003 reverses bits as well as bytes, the
  mode has to be switched off before the next 4 bpp load (after its
  waveform, which the driver otherwise never waits for), and a wrong bit
  order only shows on the glass, which no bench check can read. Worth it for
  page turns by tap; a key's tiles are a few KB either way.
- **An upload beside a running waveform** (the IT8951): the image buffer
  outside the running area could take the next tap's tiles while the last DU
  runs, so only the new waveform would wait. Built and taken out again
  (2026-11-24): on the E1003 every pair of quick taps on the Calculator and
  the To-do touched the same area (the display, the count left), so the
  second upload overlapped the first waveform every time, and a tap's
  upload is 3-16 ms anyway. Worth it only for a scene whose taps change
  places far apart and nothing shared.

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
