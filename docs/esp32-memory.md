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

One rule in three places — `fos_render_canvas_bits_per_pixel`
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
~6.5 MB. The streamed cover decode of a 24 MP photo planned 5.8 MB against
that (a mild clamp) until the cover window landed (pixie 28a9cc3, same
day): the scaled JPEG decoder now samples only the crop, so the same photo
plans 2.9 MB with a 1.9 MB luma channel and fits the RGBX headroom with
room to spare. Differential sweep: the whole jpeg suite (orientations
included) byte-identical; 24 MP-class photos identical except the
outermost crop-boundary row/column (footprint rounding).

## The 13.3" on 8 MB packs its picture into its canvas (2026-11-15)

The E1004 (1200×1600 Spectra 6, 8 MB) held a 3.84 MB 565 canvas and, beside
it, a 960 KB packed panel buffer reserved at boot, and idled at ~676 KB of
free PSRAM: renders ran out. The pack now writes the picture into the first
960 KB of the canvas itself (`utils/palette_pack.nim`, `main.c`
`canvas_holds_panel_picture`; docs/realtime-rendering.md "The picture in the
canvas"), byte for byte the picture it packed before:

| | before | after |
|---|---|---|
| canvas | 3,840,000 | 3,840,000 |
| panel buffer (reserved at boot) | 960,000 | 0 |
| refresh copy while the glass refreshes (when it fitted) | 960,000 – 1,920,000 | 0 |
| idle free PSRAM | ~676 KB (measured) | ~1.6 MB (arithmetic, not yet measured) |

The refresh copy had seldom fitted (676 KB free for a 960 KB copy), so the
refresh then ran on the render task anyway; now the display's task refreshes
from the canvas and the next render waits for the glass. Unrotated only; a
turned frame keeps both blocks.

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

(The cover column window shipped the same day — pixie 28a9cc3: a 3:2
photo on this 3:4 panel plans 2.9 MB instead of 5.8 MB, luma 1.9 MB
instead of 3.75 MB.)

And two things changed on the visibility side:

- `render:degraded` (utils/image.nim) is logged each time the ladder drops a
  rung, with the rung, the decode size and the headroom it was planned
  against. A frame whose photos got soft now says why in the cloud log.
- `memory:oomAbort` (frameos_nim_glue.c) is logged on every abort, with
  free/largest PSRAM and the post-first-render baseline. When the aborts
  have leaked more than `FOS_OOM_LEAK_RESTART_PERCENT` (50%) of that
  baseline, the frame restarts immediately instead of rendering
  degraded until someone power-cycles it. The old streak rules stay.
  (Since 2026-11-15 the leak is measured — free PSRAM when the aborted call
  began minus free after the recovery, summed, `leakedPsram` — not read off
  free memory: a reTerminal E1003 in a switch storm had 1.65 MB of a 4.88 MB
  baseline free, held by live scenes and fragmented to 328 KB blocks, and
  one scene load that did not fit restarted it. `fos_oom_policy.h`.)

## A 1200x1600 board's aborts were two allocations (2026-11-16)

The hardware bench's reTerminal E1004 (8 MB PSRAM, Spectra 6, a 3.84 MB
RGB565 canvas and the 960 KB panel buffer claimed at boot) has ~2.4 MB free
after its first render, and every other allocation shares it. Its aborts were
two allocations, each fine in total memory and each one block too many:

- **The degrade ladder's rung.** A photo decoded into its 1184x1450 box was
  refused by the plan (free PSRAM 1.4 MB, under `EmbeddedReserveBytes`), and
  the half-res rung asked for its temporary image: 592x725 in RGBX, the
  1,716,804-byte request of every abort. Its check read the 0 that
  `availableRenderBytes` answers under the reserve as "unknown" and allocated
  anyway. The rung now asks `roomForImage` (an ESP32's 0 is no room; what a
  render can rebuild goes first, and the interpreters holding a UI's handlers
  before the rung is given up) and is made in the target's format, 858 KB for
  the 565 canvas. The kept pictures, the evicting of idle interpreters, the
  SD card's buffered read and the disk tier's read had the same "0 is unknown"
  reading and have the same fix.
- **The scene set.** A whole set from the backend (378 KB, 465 KB) was copied
  out of the firmware's buffer into one Nim string (`$payload`) with 1.5 MB
  free in blocks of 300 KB. `fos_scenes.c` splits it where it lies with the
  store's scanner (`fos_store_split_scenes`) and the runtime copies one scene
  at a time (`frameos_nim_load_scenes`). The download held one block of the
  answer's size too, and a 378-415 KB set or `?patch=1` answer did not get
  one beside a photo (`no-memory`): a backend's answer is now read in pieces
  (`fos_scene_pieces.c`), each scene in a block of its own and the rest
  (`[]`, or the patch with `"put":[]`) in a small one, and every consumer
  takes the scenes as they are (the runtime, the store's puts, the combined
  file written from them by `fos_scene_store_write_set`). The largest block
  a set needs is its largest scene.

The soak's "leak" (130 KB, 585 KB, 1.4 MB over three aborts in five seconds,
then the restart) was those aborts: each abandons the JS interpreters it
jumped out of (`jsDroppedBytes`, 420-550 KB a time: the photo app's, the
scene's, the layout's) and whatever the decode and the download held. Nothing
leaked outside an abort.

Why a 1 MB block is the largest: the emergency reserve. It is armed at boot
next to the canvas, but once a render spends it, it is armed again wherever
TLSF finds 1 MB, which on this board is likely the one ~1.8 MB region left:
the largest block sat at 1792 KB for most of the bench and at 736-835 KB
(about 1.8 MB less the reserve) once the reserve had been spent and armed
again, and right after an abort it is exactly 1,048,576 bytes, the reserve's
own slot. Not changed here; the two allocations above no longer need the
block it splits.

## A map of 49,000 points on the 13.3" (2026-11-18)

The hardware bench's reTerminal E1004 failed the Map sample every time:
"out of memory" in `frameos.fetchJson` with 2.4 MB free, and in the soak the
body's own copy aborted the render three times (1.7 MB free, largest block
278 KB), each abort leaving its interpreters behind (`jsDroppedBytes` 299 KB),
until Flights Above Me ran out and the frame restarted. The map is 341,366
bytes of JSON (`maxkb=400`): 338 KB of path data, 48,962 points, 62 bytes of
it past ASCII. What it cost, measured with `-d:memProbe` and the heap's
low-water mark (`heapinfo`, `min_ever_free`):

| step | before | now |
|---|---|---|
| the body | a 512 KB chunk, a 341 KB string of it, a 682 KB JS string of that (two bytes a character: one Greek name), JSON.parse's UTF-8 copy of that | one 341 KB chunk, parsed where it lies |
| the values parsed (JS) | 325 KB, held to the end of the render | 325 KB, let go before the tree is drawn |
| the tree (the walker's nodes) | 365 KB, and the render before's beside it from the second render on | 365 KB, once |
| every path's commands (twelve bytes a point) | 1,155 KB at once, from the parse to the last fill | one path's, while it is flattened |
| the largest fill (13,600 edges) | 1.4 MB: commands, shapes, edges, a seq of partition entries and the partitions' own | 1.2 MB less the commands and that seq |
| free at the worst moment, first render | 552 bytes after the 1 MB reserve was spent | 880 KB, reserve untouched |
| free at the worst moment, a render after it | abort, 2.25 MB leaked, restart | 843-849 KB, reserve untouched (486 KB while the tree was held twice) |
| free with the map on the panel | 2.25 MB after the first render, 1.87 MB after the next | 2.24-2.25 MB |

What changed:

- **`fetchJson` parses the bytes that came** (`http_client.boundedGetWhole`,
  `app_runtime.jsFetchJson`): a body whose length the server states is read
  into one block of that size (`fos_http_chunks.h`; every answer took a
  512 KB block before, a 2 KB one too), ended with a NUL, and handed to
  `JS_ParseJSON` as it is. The 1 MB allocation that failed was JSON.parse's
  own copy of the 682 KB string; QuickJS says "out of memory" for that as for
  a scene past its heap budget, so the error now says which
  (`fos_js_take_refusal`, `describeJsError`: "the frame's memory is short: no
  free block of N bytes").
- **An allocation the size of a download asks first** (`memory.roomForBlock`
  / `makeRoomForBlock`, `http_client.requireRoomForBody`): Nim's allocator
  cannot refuse, and on the device a failed one is the longjmp. A body with
  no block to go in is an IOError its node shows; what a render can rebuild
  goes first.
- **The reserve is armed again when it could not be**
  (`fos_nim_emergency_reserve_unarmed`, `recoverEmergencyReserve`): one failed
  arm in the desktop suite left the frame without a reserve for the twenty
  minutes until the soak's first abort, which a reserve would have served.
  It is tried after every pass now.
- **An SVG drawn once reads its long paths late** (pixie `parseSvg`'s
  `lateData`: `renderSvgIntoTarget`, `decodeSvgWithFallback`,
  `frameos.draw`): a `<path>` too long for the path cache keeps its data as
  text and the fill and the stroke read it for themselves, so its commands go
  before the fill's edges are made. Not for a frame kept for its damage.
- **A fill holds less** (pixie `shapesToSegments`, `partitionSegments`): the
  edge list is made at its size, and the partition entries are made as they
  are handed out, not in a seq of their own first.
- **One tree, not two** (`ui/layout.nim` build, `UiMemo.source`,
  `app_runtime.get`): the layout keeps the element it was built from when the
  next render's says the same; the app's tree now takes that element in place
  of its own equal one, get()'s JS result goes before the tree is drawn, and
  the tree of the render before goes before the next get().

Not changed: the abort itself still leaves the interpreters it jumped out of
(they can be neither run nor freed, see below), and a fill still holds its
shapes and its edge list beside the partitions (about 380 KB of the largest
fill above): making the partitions straight from the shapes is the next
400 KB.

## Text keeps coverage, not outlines (2026-11-19)

What a text costs in memory beside the typeface was three caches of the same
glyphs: the typeface kept the outline of every glyph it ever drew, in font
units, for good (`OpenType.glyphPaths`, about 0.9 KB a glyph on a 64-bit
host, never trimmed: a page of Cyrillic grew it by a few hundred KB); the
layout kept a path per glyph and size with its flattened shapes (256 on an
ESP32); and the coverage cache kept 8-bit masks of those paths, each with a
row table and a 96-byte header. Now a glyph is one entry of pixie's glyph
cache (`docs/jsx-ui.md` "The glyph cache"): its coverage at its size and
quarter pixel, trimmed, four bits a pixel, plus 48 bytes counted for the
entry, within 64 to 128 KB on an ESP32 (a 32nd of what the panel leaves the
scenes, `memory.sceneMemoryBytes`: 78 KB on the 13.3" E1004, whose canvas
leaves the least; `embedded_main.nim`). Nothing of an outline outlives the
fill that needed it.

A home panel's UI (eight cards, ~300 glyphs at four sizes) laid out and drawn
into a 480x480 565 canvas with the ESP32's budgets, 200 taps, on a 64-bit
host (`getOccupiedMem`, the canvas excluded):

| Held after the taps | Before | After |
| --- | --- | --- |
| Typeface (Ubuntu-Regular parsed) | 162 KB | 162 KB |
| Glyph outlines (typeface + layout) | ~90 KB | 0 |
| Masks of text | ~43 KB in the coverage cache | 12 KB (113 glyphs) |
| Everything the render holds | 584 KB | 463 KB |

The repaints took the same time (whole-canvas repaint of a tap 237-241 µs
before, 240 µs after; a glyph's blit 365 ns against a coverage mask's 378).
A glyph not kept costs about 1.6 times a direct fill of its outline the
first time (7.9 µs against 4.8 for a 16 px glyph), once per size and
quarter pixel.

## The built-in face is read where it lies (2026-11-19)

Until then the built-in face was inflated whole from flash on first use
(140,772 bytes, into a string that grew to 256 KB on the way) and parsed,
which held **162 KB for the life of the process** (64-bit host: the glyf
table copied, both loca tables, hmtx, cmap, the name table and the GPOS
pairs and class tables) and **peaked at 424 KB** while the first text was
drawn. Now every runtime compiles in `assets/compiled/fonts/Ubuntu-Regular.fosf`
(`tools/generate_indexed_font.py`, made from the stripped TTF) as a string
constant, which stays in the program's read-only data (flash on an ESP32),
and pixie reads it in place (`fontformats/indexedfont.nim`):

- the character map (125 runs), the advances and a box per glyph (8 bytes a
  glyph), the kerning pre-resolved in pixie's lookup order (21 KB: per class
  subtable its left glyphs' classes and nonzero rows, and the right classes
  of all of them at once, 250 distinct combinations over 776 runs of glyphs)
  are binary searches over those bytes, nothing copied;
- the TrueType glyf records, less the box each record repeats (the glyph
  table has it; the outline reader skips it), sit in blocks of about 2 KB; the blocks holding
  printable ASCII are stored as they are and read in place, the others are
  deflated, and a glyph the glyph cache does not have inflates its block into
  a two-block cache on the thread that asked (a block at its exact length).

| | Before | After |
| --- | --- | --- |
| Held once the face is made | 162 KB | under 1 KB |
| Peak at the first text | +424 KB | one block, ≤ 2 KB, and zippy's ~3.5 KB of tables on the stack |
| Held while text is drawn | (the 162 KB) | ≤ 4 KB of blocks per drawing thread; none for ASCII |
| The home panel's render, everything held | 463 KB | 303 KB |

The options weighed (flash is the font's bytes in the image; Δ against the
gzipped TTF's 57.6 KB):

| | Flash | Δ | Held |
| --- | --- | --- | --- |
| The gzipped TTF, inflated and parsed (before) | 57.6 KB | – | 162 KB |
| The stripped TTF uncompressed, read in place | 140.8 KB | +83 KB | ~0 |
| **The indexed font (chosen)** | **74.5 KB** | **+16.9 KB** | **< 1 KB + ≤ 4 KB of blocks** |
| … every block deflated | 72.8 KB | +15.2 KB | same, and ASCII inflates (32 inflates a cold home panel) |
| … kerning deflated and expanded into RAM | 68.0 KB | +10.4 KB | ~21 KB |
| … its first cut (records with their boxes, a right-class range table a subtable) | 87.9 KB | +30.3 KB | the same |

ASCII stored raw costs 1.7 KB of flash and is the difference between 32
inflates and 1 on a cold render of the home panel. The first cut was 13.4 KB
larger: the 8-byte box every glyf record carries (7.5 KB of deflated blocks;
the glyph table already had a box, rounded outwards) and a range table of
right classes for each of the eight class subtables (10.2 KB, now 4.3 KB as
the combinations shared by all of them, and one search instead of eight).
Bigger blocks (4 KB: −1.8 KB, twice the RAM), narrower left ranges (−1.4 KB)
and bitmap rows (−1.2 KB, a popcount a pair) were measured and left. Text sets and draws
identically: the reader's advances, kerning and outlines are the TrueType
font's, command for command (`test_indexed_font.nim`; the generator's
`--check` replays the same in Python in the backend suite). A face from the
SD card is still a TTF parsed whole (≤ 1 MB, one at a time, 3 MB headroom):
reading those in place (by `pread`, the kerning built in RAM) is the next
step, and needs nothing from either control plane, which sync raw TTFs.

## Gradient fills paint in strips (2026-08-24)

The 16 MB 13.3" (frame 529463b4, fw 2026.8.35) OOM-aborted every Weather
render: `memory:oomAbort where=render` at 3.7 MB free with a 1.5 MB largest
block, 3.1 MB leaked, 54 % of the baseline left so no restart — the frame
sat crippled until a reboot. The allocation was the weather panel's
background: a `<rect fill="url(#bg)">` over the whole cell. pixie fills any
non-solid paint through a coverage mask and a paint image, and sized BOTH
to the whole target: 6.1 MB for the 1200×640 cell, 9.2 MB for the 1200×960
one, against 1.8 MB for the same rect on the 7.3". The JS `frameos.svg` →
`renderSvgIntoTarget` fusion path rasterised straight into the canvas cell
with no band fallback, and the OOM abort is a longjmp, not a
`CatchableError`, so the banded fallback after it never ran.

Fixed in the pixie fork (`paintStripRows`, `paintThroughMask` in paths.nim):
paint-server fills run in row strips sized from the decode budget (the pair
takes at most half of it) and the contiguous budget (each image fits the
largest block). The shape is re-rasterised per strip translated by an
integer row offset; the gradient is evaluated at the strip's true
coordinates, so colours are bit-exact and integer-coordinate rects are
identical to a one-pass render (pinned by pixie `test_paint_strips` and
`test_svg_paint_strips` here). With no budget — every host — it is one
strip and the untouched original algorithm. FrameOS refreshes the budget
right before each SVG raster (`decodeSvgWithFallback`,
`renderSvgIntoTarget`), because the render tick's value predates the
QuickJS runtimes the SVG came from. The SVG-level XML re-parse banding
(`svgBandHeight`/`renderSvgBanded`) is gone: it only covered the standalone
path and cost a full parse per band.

## An abort no longer breaks the renders after it (2026-10-13)

The longjmp skips every `finally` as well as every destructor, and some of
those put shared state back. On the E1002 (PR #544) a Google Photos render
aborted inside `frameos.httpRequest`, on the 1.17 MB copy of a share page,
and from then on every JS call in that boot failed at once with "render
exceeded its 90000ms wall-clock deadline": `interpreter.runEvent` disarms
the run's deadline in a `finally`, and an armed deadline is never re-armed,
so every later run rode on the dead render's clock. The same jump left the
event dispatcher `draining` (no event delivered again), `runNodeStack`
holding nodes (false "depends on itself" cycles), `sceneJsLock` taken (the
next code node waits forever), and the QuickJS interpreter it jumped out of
marked as mid-call for good.

`nim_oom_abort_note` now calls `fos_nim_recover_oom_abort_impl` first, at
every guarded entry point (render, scene switch, scene load, input tick,
event dispatch). It:

- closes the HTTP streams and frees the response bodies and spill files the
  aborted call held (`releaseStrandedHttp`). A stranded stream keeps its
  socket and TLS session in internal RAM; the incident's stranded body was
  the 1.17 MB page. Before the memory readings, so the restart rule counts
  what came back.
- puts back what the skipped `finally`s owned
  (`single_scene_host.recoverAbortedRun`): the deadline and dispatch
  budget, the dispatcher's flags, the recursion guards, the lock.
- drops the JS interpreters that were mid-call (`QuickJS.abandon`). The
  runtime still points at a stack frame that is gone, so running it again
  walks that frame on the next thrown error, and `JS_FreeRuntime` asserts
  that nothing is still referenced, which on the device is a panic. They
  are leaked on purpose and their bytes come off the scene's JS heap budget.
  "Mid-call" lasts until the caller has freed the last value it got back
  (`get` reads its payload after JS returns). The next render builds the app
  a new interpreter; `frameos.remember` values carry over.

`memory:oomAbort` gains `jsDropped`, `jsDroppedBytes` and `httpReleased`.
`test_single_scene_host.nim` aborts with a real longjmp from inside a JS
app's `httpRequest` and from inside a code node, and checks that the next
render and the next button press work.

What the aborted call allocated in Nim stays leaked; the restart rules above
still decide when that is too much.

## A 32 KB instruction cache (2026-11-20)

The S3's instruction cache is 16 KB (`CONFIG_ESP32S3_INSTRUCTION_CACHE_16KB`,
IDF's default), and QuickJS's interpreter, the JSX factory, the walker and
the layout run from flash through it. With 16 KB, how fast the same
JavaScript runs depends on where the linker put things: the same list of a
hundred elements took a 11.4, 12.4, 15.3 or 21.4 ms `get()` in four images
that differed only in code that list never runs (`docs/perf-todo.md`
"memo() and a handler's call in C"). 32 KB makes the JavaScript faster and
the swings smaller (SenseCAP Indicator, same scenes and taps, medians of 12
to 13 taps):

| Tap | 16 KB | 32 KB |
| --- | --- | --- |
| 100 memo()'d cells, render (`get()`) | 114 ms (55) | 68 ms (11.8) |
| 100 cells, no memo() (`get()`, walk) | 79 ms (21.4, 24.4) | 54 ms (9.1, 13.0) |
| Home panel | 66 ms | 52 ms |
| A handler that changes nothing | 16 ms | 12.5 ms |

What it costs is internal SRAM, 16 KB of it, and that is what the frame
has least of. The cache's second 16 KB comes out of the main internal heap
region (`0x3fcb0878`, 233,112 bytes with 16 KB; `0x3fcb48b0`, 216,672 with
32 KB). The same image's internal heap with each, from boot through a
Scene store fetch (TLS), a switch storm over 18 scenes, the frame page and a
desktop with two windows (`heapinfo`, `build/pressure.py` on the research
branch):

| Internal heap | 16 KB | 32 KB |
| --- | --- | --- |
| Free at boot | 69.8 KB | 53.8 KB |
| Free after the storm, the frame page, two windows | 52.9 KB | 36.1 KB |
| `min_ever_free` at the end | 10.7 KB | **3.8 KB** |
| Largest free block | 19.5 KB | 24.6 KB |

The largest block is no gain: it is the 64 KB region kept for internal-only
allocations (`CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL`), which sits at another
address in each image and fragments differently.

### Where the floor is, and what pays for it

That run's floor is one run's. Four reboots of each image, `heapinfo` after
boot and again after a Scene store visit (TLS), say more (`build/bootfloor.py`
on the research branch). The floor is reached at boot, in Wi-Fi's start and
the first connections, not under the pressure run: the store visit, the
switch storm and two windows never took it lower. Nearly all of it is the
64 KB internal-only region's own minimum; the main region is full (4 bytes
left at its lowest) in every image, and `malloc` then goes to PSRAM.

| Image (same tree, SenseCAP) | `min_ever_free`, four boots | First Scene store render |
| --- | --- | --- |
| 16 KB cache, 10 static Wi-Fi RX buffers (today) | 10.0-10.5 KB | 2,383-2,394 ms |
| 32 KB, 10 | 7.9-8.4 KB | 1,923-1,928 ms |
| 32 KB, 6 | 9.8-10.8 KB | 1,909-1,941 ms |
| 32 KB, 4 | 13.4-13.5 KB | 1,909-1,921 ms |
| 32 KB, 4, `SPIRAM_MALLOC_ALWAYSINTERNAL` 4096 | 13.3-13.4 KB | 1,931-1,952 ms |

The lever is the static Wi-Fi RX buffers (`CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM`,
1.6 KB of internal DMA memory each, held from `esp_wifi_init` on). The others
were measured once each and did not help: `SPIRAM_MALLOC_ALWAYSINTERNAL` at
4096 or 2048 (8.3, 7.7 KB) and the internal-only reserve at 32 KB (9.2 KB).
Task stacks were not moved: the render task's must stay internal (it reads
SPIFFS with the cache off), and so must any task that touches flash.

Six buffers is IDF's own floor for them (no fewer than the block-ack window,
`CONFIG_ESP_WIFI_RX_BA_WIN`, 6), and it gives back the 16 KB cache's floor.
Four gives 3 KB more but sits under that window. A 1 MB HTTPS download
(`fetchText`) took 1.44-1.67 s and a 300 KB photo through `fetchImage` (its
decode included) 4.96-5.14 s with 10, 6 or 4 buffers alike, six runs each;
that path is held at about 5 Mbit/s by the internet, not the radio.

On the LAN at full speed, where fewer buffers would show first as dropped
frames and retransmits, they did not: the board fetched its own scene set
(453 KB, `GET /api/frames/4/embedded/scenes` from the bench backend, through
`frameos.httpRequest` with `find` so the body never became a JS string),
eight fetches a render, the backend's side captured with tcpdump:

| Image | One fetch (median, range) | Retransmits | Zero-window ACKs |
| --- | --- | --- | --- |
| v2026.11.13 release (16 KB, 10) | 580 ms (567-698), 40 fetches | 0 | 227 |
| 32 KB, 10 | 408 ms (399-426), 40 fetches | 0 | 4 |
| 32 KB, 6 | 401 ms (391-588), 48 fetches | 0 | 11 |

About 9 Mbit/s with the larger cache. Every image's limit is its own receive
path, not the radio: the board's zero-window ACKs say it, and the release's
227 of them are the 16 KB cache's slower lwIP and copy. The 6-buffer image's
four slow fetches (466-588 ms) were each a render's first or second, with no
retransmit among them. An OTA download was not measured.

A console `restart` sometimes ends in an RTC watchdog reset (`rst:0x10`)
instead of a software one, right after `fos_wifi: connection lost reason=8`:
twice in twelve restarts of the images with four or six buffers, never in
eight with ten, and once in eight of the release image (ten buffers) in the
bench logs of 2026-11-18. Too few to blame the buffers or clear them; watch
for it.

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
