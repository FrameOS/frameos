# Real-time rendering

*Written 2026-10-25. The open work is `docs/realtime-todo.md`; this file is
the model and the measurements behind it.*

Most FrameOS frames are e-paper: a render every few minutes, a refresh that
takes seconds. LCDs are the other half — HyperPixel and HDMI panels on a Pi,
the SenseCAP Indicator's 480x480 glass on an ESP32-S3 — and there a scene can
ask for a new frame many times a second (`refreshInterval` below 1 s) and a
touch should answer in well under 100 ms. This file is about making that
fast, mostly on the ESP32, where it is hardest.

The yardstick is the store scene **DVD Logo Bounce**
(scenes.frameos.net/s/dvd-logo-bounce) at 24 fps on the SenseCAP Indicator:
a render event, a `render/image` (stretch) fed by a JS app that builds a
full-screen 480x480 SVG every frame — a background `<rect>`, the logo's five
paths twice (the shadow at `opacity="0.32"`) — and returns
`frameos.svg(svg, {width, height})`. `refreshInterval` 0.0333.

The second yardstick is **Hellfire**, the first effect of the Pixel toys sample
(`repo/scenes/samples/Pixel toys`, `fire.ts`): the Doom fire, a byte of heat per cell, its
spread rule in the app's own JS and the cells returned in the **8-bit palette
mode** (below), which writes the ones that changed straight into the panel's
buffer. No SVG, JSX or canvas is involved, so what it measures is the
interpreter's loop and the raw pixel path. It reads its own number off the panel: the scene's **footer**
shows the renders a second the panel gets (simulation, blit and pacing
included), in the fire's own cells so that it does not slow what it
measures (below), and its **Quality** field picks the cell size: automatic (4 px, 8 on
an ESP32), 8, 4 or 2 px. (It was a sample of its own until it joined Pixel toys.) The rule stays in JS on purpose: a native Doom spread
in every runtime (`frameos.fire`, tried and taken out again) was one scene's
inner loop as a core API, and the interpreter's cost is what the yardstick is
for. Measured on the SenseCAP Indicator (480x480, the panel's 16 KB
instruction cache, no counter), by the firmware's `render:animation` line:

| Step | 8 px cells (3,600) | 4 px cells (14,400) |
| --- | --- | --- |
| The first JS spread: an LCG through `Math.imul` per cell, module variables in the loop | 10.9 fps | 5.4 fps |
| Locals and xorshift: no global lookup or call per cell, and no seed above 2^31 turning into a float | 11.9 fps | |
| One flat pass over the cells, the random numbers from a table | 15.0 fps | |
| The changed span of a row of cells copied into its other rows, not stored pixel by pixel (the blit is PSRAM-bound: 21 to 18 ms) | 15.8 fps | |
| No branch (a `Uint8ClampedArray` keeps a cold cell at 0), and cooling that follows the grid, so the black sky above the flames does not change and is not written | 20.5 fps | 8.5 fps |
| The pass starts at the first warm row | 26.0 fps | 13.3 fps |

What is left at 8 px (with `set debug 1`): ~13 ms of spread, ~10 ms of blit
and ~13 ms of the scene around them; the panel scans out at ~42 Hz (PCLK
12 MHz), which no scene passes. A call from JS into the runtime costs
~125 µs on this board (instruction-cache misses: 45 µs with a 32 KB cache,
which bought Hellfire 8% and cost 16 KB of internal RAM, so no), and an
`app.config` read through its Proxy ~0.3 ms: an app reads its config once a
render, never in a loop.

Two things the first version got wrong on the way: the pass ran from the
bottom up, so each row read what the row below had just written and heat
crossed the whole panel in one step (noise, not Doom's rising flames), and
Doom's cooling of half a heat unit a row burns ~72 rows high, so a 60-row grid
was a wall of fire. The pass now runs from the top down and the cooling
follows the grid: the flames stand ~40% of the way up at any cell size.

### The 8-bit palette mode

`return frameos.pixels(cells, palette, { width, height, pixelSize })` from a JS
app's `get()` (`imageFromPixels` in `js_runtime/app_runtime.nim`): a byte a
cell, an index into up to 256 colors, every cell a `pixelSize` square. It is
the one raster an app hands the runtime itself, and it is kept to the
smallest shape that does the job, for the firmware's flash: no RGBA, no
layers, no writes into a canvas (all three were built and taken out again).

- It is written straight into the target the planner offers, the panel's own
  buffer on an LCD, and a grid that covers it waives the background it owes.
- Each panel buffer keeps a copy of the cells and the 256 colors it was drawn
  with (`PixelFrame` in `utils/svg_frames.nim`, up to 256 KB of cells), so the
  next frame into that buffer writes only the cells whose index changed or
  whose color did. Any other render into the buffer, or a firmware write,
  means every cell is written next time.
- An RGB565 buffer takes `js_runtime/pixel_ops.nim` (compiled at `-O2` on the
  ESP32, the palette packed once a frame); every other format goes a pixel at
  a time through pixie's `setPixel`, which e-paper and a Pi never notice.

So an app can animate two ways. It can change cells, as the **Pixel toys** do
(`repo/scenes/samples/Pixel toys`, each effect a component of one app: Hellfire
in three palettes, fireworks, a fountain, a waterfall, a starfield,
Matrix rain, ripples, blobs, a plasma and Life; the footer's buttons, a tap
(on the ripples it drops a stone), a swipe, Enter, Space or the right arrow
for the next, the left arrow for the one before). Or it can change only the
palette, as 8-bit games did: the **Color cycling** sample
(`repo/scenes/samples/Color cycling`, moved through the same way) draws each
of its six scenes once, with
ranges of colors laid out the way things move (down the waterfall, out from
where a drop lands, up a flame, along an aurora), and from then on rotates
those ranges by the clock. A frame of it is a palette of 256 colors worked out
in JS and the cells of the colors that moved; the cells that hold still, most
of the picture, are never written again.

Both have a **footer** (`footer.ts` in each app, a public `footer` state
field, on by default): Previous and Next, the name of what shows, the frame
rate the panel gets and Hide. Hidden, a tap along the bottom edge or the
scene's settings bring it back. It is drawn in the picture's own cells with
the 3x5 font, not as JSX: an `<img>` takes no pixel frame, and a node drawing
over the pixels makes the render more than one node (`wholeFrame` in
`scene_compiler.nim`), after which the panel gets every cell again each frame;
the controls bar that was a layer of its own went with the layers in #666.
The strip is drawn again only when its text changes (the rate, once a
second) and copied over the bottom rows each frame, in the cells' own typed
array kind (QuickJS copies one typed array into another with `memmove` only
when the two are the same kind, element by element otherwise), and what it
covered is put back before the next step, so the effect under it runs as
before. Pixel toys draws it in each effect's darkest and brightest colors;
Color cycling keeps the last two of its 256 for it. Rendered on a laptop into
an RGB565 buffer at an ESP32's cell sizes (a frame's median, before / footer
shown / hidden), it costs nothing measurable: Hellfire 124 / 118 / 126 µs,
Matrix rain 66 / 64 / 65, Color cycling's waterfall 72 / 71 / 72. What it
saves is writing: the cells under it stop changing, so a Hellfire frame writes
~34,000 pixels instead of ~47,000 (the wasm runtime, 480x480).

The Pixel toys use `frameos.ops` where the runtime has it (the trails' fade
is one `map` over all the cells, the ripples' wave five passes) and keep their
JS loop for an older runtime (`if (frameos.ops)`). `convolve` leaves a grid's
edges as they are, so an array whose edges must stay put holds nothing else:
the ripples once wrote the heights they show into the array of neighbour
sums, and the edges grew every frame until bright squares filled the pond.

The Pixel toys on the SenseCAP Indicator, automatic cells, by the
`render:animation` line (2026-11-14, firmware with QuickJS's hot loop at `-O2`,
#744; "JS only" is the same firmware with the effect's `frameos.ops` path off):

| Effect | Cells | fps | JS only |
| --- | --- | --- | --- |
| Hellfire (three palettes) | 8 px | 24.8 to 25.1 | |
| Fireworks | 4 px | 26.2 | 18.4 |
| Fountain | 4 px | 18.4 | 14.9 |
| Waterfall | 4 px | 18.6 | 14.1 |
| Starfield | 4 px | 17.0 | |
| Matrix rain | 4 px | 23.8 | 16.3 |
| Ripples | 8 px | 21.5 | 13.3 |
| Blobs | 8 px | 15.9 | |
| Plasma | 8 px | 16.8 | |
| Life | 8 px | 20.1 | |

Starting the scene is the other wait. It took 2.9 s, 2.2 s of it every
effect's palette built when the app's modules loaded, through helpers with a
closure, an array and nine `Math.*` calls a color (300 ms for a 256-color
gradient). Each effect now builds its own when it first starts, with integer
helpers: 0.6 s. Hellfire warmed its fire up with ~36 steps (the step carries
heat one row up), 300 ms; one pass going up the rows, each cell taking the
heat of a cell below it, is the same fire at once: a swipe to it is 0.18 s.

The Color cycling scenes on the same board, at 160x160 cells (3 px), all at the
scene's own 20 fps (`refreshInterval` 0.05). Two things it needed there: the
palette's per-frame rotation blends with integers inline (a helper with a
closure and three `Math.round` a color was 37 ms of a 68 ms frame; now 3.6),
and a scene's first draw keeps to integers, `| 0` and values worked out once
per row or column, because the S3 has no double-precision FPU and a native
`Math.*` call from QuickJS costs microseconds a cell. Drawing a scene is still
1.3 to 2.1 s on a swipe (the loading mark shows), so the app keeps every scene
it drew, and swiping back to one is a frame (~90 ms).

What the first versions spent and the rewrite took out, in a frame's `step`:
the fireworks' fade over every row (30 of 34 ms), a `trails.plot` call and a
property lookup per particle (the fountain's other 36 ms), and Life at ~60
bytecodes a cell (66 ms; bit-sliced it went from 10 to 19 fps).

A whole 480x480 frame at one pixel a cell, a plasma on the same board, is
1,294 ms of JS and 78 ms of writing: the interpreter is the cost, and fewer,
larger cells (or a palette that moves instead of the cells) are the lever. A
panel buffer's copy of a frame's cells is a new record each time, never the
old one cut to size: a seq keeps its capacity when it shrinks, and once held
2.7 MB across the three LCD buffers, so that every interpreter after it was
discarded for memory.

### Whole typed arrays: `frameos.ops`

`frameos.ops` (`js_runtime/typed_ops.nim`, `-O2` on the ESP32) is the loops
such scenes are made of, over whole typed arrays: `map` through a table, `add` /
`sub` / `mul` by an array or a number, `convolve` with a 3x3 integer kernel.
Nothing in it is one effect's: what a scene simulates stays its own JS, and a
pass that is one of these is a call instead of a few bytecodes a cell. On the
SenseCAP Indicator, a 120x120 grid:

| Pass | JS | `frameos.ops` |
| --- | --- | --- |
| A byte table over the cells | 58.5 ms | 1.4 ms |
| A wave's neighbour sum (four taps) | 109 ms | 5.0 ms |
| 1k particles: gravity, then position by velocity | 11.1 ms | 1.3 ms |

A scene keeps its JS loop for an older runtime (`if (frameos.ops)`).
`convolve` leaves a grid's edges as they are, so an array whose edges must
stay put holds nothing else.

## Where an ESP32 frame goes

Measured on the SenseCAP Indicator D1S (ESP32-S3 at 240 MHz, 8 MB octal PSRAM
at 80 MHz, DIO flash, a 16 KB instruction cache and a 32 KB data cache with
32-byte lines, `-Os`), with a per-phase probe around one render:

| Phase | Before (PR #622) | After (this change) |
| --- | --- | --- |
| Background fill (921 KB RGBX canvas) | 47 ms | **0.7 ms** (owed, waived by the SVG's rect) |
| QuickJS runtime + context | 19.5 ms | 19.5 ms |
| Prelude compile + run (6.4 KB of JS) | 104 ms | 102 ms |
| `app.ts` compile | 36 ms | 33 ms |
| `get()` | 10 ms | 9.5 ms |
| Return path (JSON round trip of the spec) | 12 ms | 12 ms |
| SVG parse | 28 ms | 28 ms |
| SVG raster (full-screen rect + paths) | 79 ms | **57 ms** (565 canvas: half the bytes) |
| QuickJS teardown | 15 ms | 14.5 ms |
| RGB565 pack | 66 ms | **0** (drawn in place) |
| Hash, log lines, copy into the back buffer, swap | ~150 ms | **~0** on a quiet frame |
| **Per frame** | **~570 ms (1.75 fps)** — and the loop ran it once per 300 s | **~290 ms (3.3 fps), back to back** |

The scan-out stayed clean throughout: 0 dropped frames and 0 late refills over
continuous rendering (`lcd`), worst refill 0.5 ms late against 0.9 ms of
slack.

A second round the same day took it to **~50 ms a frame (19.6 fps)**, each
step measured on the board:

| Step | Frame | fps |
| --- | --- | --- |
| After the first round | ~290 ms | 3.3 |
| JS interpreters kept between frames | ~120 ms | 8.0 |
| Repaint only the box that changed; parsed paths shared; `-O2` for pixie's raster | 94 ms | 10.2 |
| QIO flash | 71 ms | 13.5 |
| A third frame buffer | 56 ms | 17.0 |
| No heap walk per frame; the SVG spec read off the JS object; the fast XML reader; flattened shapes kept | ~50 ms | 19.3 |
| The metrics sample with the frame logged in full, not every second | ~50 ms | 19.6 |

The `-O2` of the third row took effect only in images built with the flox dev
shell's Nim, which ROT13s the names of the C files it generates, the names
`components/frameos_nim/CMakeLists.txt` picks the modules by. The official
Nim of the Docker image, CI and every release writes them plain, so those
images drew pixie's raster at `-Os`: 17.9 fps instead of 19.4 on the SenseCAP
(2026-11-10). Both names are listed now, and `ci_build_image.sh` fails a build
whose hot modules came out without `-O2` (+39 KB of flash).

Where the 50 ms go now, from probes around each phase (not in the tree):
`get()` ~5 ms, the SVG parse ~10 (half of it the XML), the raster of the
logo's ~130x85 box ~20, the interpreter around them ~7, the rest the
allocator (~560 allocations and frees a frame at 6 and 3.4 µs each on the
PSRAM heap) and the LCD's refill interrupt, which copies 19.2 KB of the
front buffer out of PSRAM every 0.9 ms on the render core: halving the pixel
clock took a frame from 62 to 55 ms. `docs/realtime-todo.md` has what is
left.

## Why loop tuning alone cannot get there: PSRAM is the wall

- **Bandwidth.** Octal PSRAM at 80 MHz moves roughly 27 MB/s PSRAM→PSRAM
  through the cache (a write-allocate cache fetches every line before it is
  written), 40–50 MB/s for straight writes. A full pass over a 480x480 RGBX
  canvas (921 KB) is 20–35 ms; the old pipeline made several per frame (fill,
  the SVG's own full-screen rect, the pack's read, its write, the copy into
  the back buffer, the SHA of the result) — ~6.5 MB a frame, more than the
  bus delivers at 24 fps.
- **The scan-out takes its share.** At the 12 MHz pixel clock (548x518 total,
  42.3 Hz) the panel reads 19.5 MB/s out of PSRAM continuously; its refill
  interrupt runs on the render core every 0.9 ms, and the driver preloads each
  next 19.2 KB chunk into the 32 KB data cache. A flash write that erases
  holds that interrupt off (the cache is off), so it costs a disturbed frame;
  the driver restarts the DMA at the next vertical blank. A scene store is
  hundreds of such writes, so for its length (tens of seconds while SPIFFS
  collects garbage) the glass shows the FrameOS mark on black with "Updating"
  under it instead of the scene, which tears into black bands
  (`lcd_st7701s_rgb.c` `fos_lcd_st7701s_updating_begin`); the picture from
  before comes back if no new one follows. Not with
  `CONFIG_LCD_RGB_RESTART_IN_VSYNC`: in IDF 5.5 its restart at every blank
  keeps the refill count whose parity picks the buffer to refill, and after
  such a frame half the time every refill wrote the buffer in flight, the
  picture one bounce buffer ahead (the next frame's top on the bottom rows)
  until the next flash write (2026-10-26).
- **Code fetches share the bus.** Every instruction-cache miss is a flash
  read on the same bus PSRAM uses, and a 3.2 MB firmware with QuickJS in it
  misses a 16 KB cache often. In DIO mode that was the largest single cost:
  QIO flash took DVD Logo Bounce from 10.2 to 13.5 fps, exactly what a 32 KB
  instruction cache did in DIO (which costs 16 KB of internal RAM; a 64 KB
  data cache on top added nothing).

So the work is to touch the full frame in PSRAM at most once per frame (and,
later, to touch only what changed), not to make each pass a little faster.

## What runs now

### Animation mode (ESP32, `main/fos_animation.c`)

A scene whose `refreshInterval` is below 1 s, on a display that shows a frame
the moment it is drawn (an LCD, `fos_display_is_lcd`), on a frame that does
not deep-sleep, animates:

- Frames are paced by the interval in microseconds (an `esp_timer` sets
  `FRAME_DUE_BIT`), from the start of one frame to the next; a frame slower
  than the interval is followed at once, with no catch-up burst. The wait
  between frames still serves presses, touches, command pulls and the
  schedule, like the ordinary wait.
- The per-pass work runs once a second instead of once a frame: the settings
  and command pulls, the scene sync, the battery, charger and gauge reads,
  the power decision, the Nim settings pushes. The metrics sample goes with
  the frame logged in full (below).
- One frame in ten seconds is logged in full — `render:scene` …
  `render:done`, the cloud's render announce, the backend's image push (once
  per scene while it animates, `fos_animation_push_wanted`: on an LCD each
  push hashes, copies and uploads the whole picture, and held the frames
  around it to 115 ms instead of 75) — with
  a `render:animation` summary of the frames before it (`frames`, `fps`,
  `avgMs`, `maxMs`, `periodMs`). The frames in between are quiet: no render
  lines, no scene log lines (`frameos_nim_set_quiet`, the logger off, like
  the Linux runner's fast-render log pause). The first frame of an animation
  always logs in full: it is the `render:done` a deploy waits for
  (`docs/deploy-progress.md`). A frame that fails logs at once. A switch from
  one animating scene to another is not a frame of the new animation: its
  first render (the code compiled, the first picture) counts in neither the
  summary's frames nor its seconds (`fos_animation_scene_started`). Counted
  in, the Pixel toys' start read as a 2.7 s frame among 78 ms ones and a
  third off their frame rate (the hardware bench, 2026-11-16); the start is
  the render line's `prelude` / `compile` / `init` and the switch's time.
- The render task blocks for one tick a second, so the idle task on its core
  runs while a frame slower than the panel never waits.

The same scene on e-paper does not animate: the whole-second loop renders it
on every pass, a **fast loop** (`fos_animation_fast_loop`). Its timed frames
are a burst's (below): one in ten seconds logged in full, the rest quiet, the
pulls once a second, a `render:burst` line when the scene stops asking. The
gap that keeps it going is `FOS_ANIMATION_LOOP_GAP_US` (3 s), not the burst's
second: a pass's pulls or a refresh waited for can hold a frame back past it.
Each pass of the Kitchen sink (0.05 s) on a reTerminal Sticky logged seven
lines in full, which the backend dropped (`log:dropped`) and which moved the
frame's status to `rendering` and back twice a second (2026-11-24). The
`power` line goes out in such a run (an animation, a burst, a fast loop)
only when what it decided changes.

Every line the firmware logs is also printed on UART0 at 115200 baud
(11.5 KB/s), so the ~2.2 KB of lines a fully logged pass prints take ~190 ms on
the wire. The task that logs does not wait for them: they go into a 16 KB PSRAM
ring that a low-priority task on core 0 prints (`fos_log_ring.c`). Printed in
place, they stalled a running animation's periodic logged frame that long once
every ten seconds, a stutter in Hellfire's 30 ms frames. A ring that fills drops
the newest lines, so the quiet frames still matter, not only for the logs'
readers.

### The panel's buffer is the canvas (an RGB565 LCD)

An RGB565 LCD's scene canvas is 565 whatever the PSRAM, and it is the panel's
own back frame buffer: `fos_display_render_target` hands the render task the
buffer neither scanned nor waiting to be,
`frameos_nim_render_panel` makes it the canvas (`panelCanvas` in
`embedded_runtime.nim`, pixie's `newImage565Over` with `ditherStores`, the
rounding the pack used to do), and the blit is a buffer switch — no pack, no
copy, no SHA, and with three buffers (below) no wait for the panel either. A
rotated panel draws into a 565 canvas of its own and copies it into the
buffer turned: the words go to their places in 32 x 32 tiles, nothing read
back or dithered again (`packImageRgb565`; 30 ms a frame at 480x480, where
the general pack took 787 ms). That copy is the price of a rotation, and the
settings panel says so under it (docs/scene-settings.md). The boot mark
(`lcd_splash.c`) is drawn turned too.

The snapshot behind `/image`, `image_get` and the backend push is the front
buffer itself, dropped before it is drawn in again; a stream copies it out
under the lock and lets go, so a slow socket never holds a frame back. The
local network access code and the voice notice are drawn into the buffer the
panel shows next, after a clean copy went to the snapshot (`docs/lan-access.md`:
the code never leaves the device in an image).

### Half a byte on sixteen greys, one on the other grey panels

A sixteen-grey panel renders in `pfGray4`: two pixels a byte, in the panel
buffer's own layout, so the 1872x1404 E1003's canvas is 1.3 MiB (2.5 in luma)
and the pack is a copy, or a turn of a rotated frame. What is written is still
8-bit, and every store goes through the 4x4 ordered matrix the pack used to
apply (`grayLevel16Ordered`), keyed on the pixel's place in the owner's buffer:
a single layer holds exactly what luma plus the pack gave, a gradient keeps
some 240 steps per 4x4 cell, the sixteen exact levels stay flat. A blend reads
the dithered backdrop back, which holds its mean to about a quarter of a level.
A loop that writes one row and copies it down would print the matrix as
vertical stripes, so pixie's horizontal gradient computes every row on this
surface. Colour correction of the whole frame reads the sixteen levels, not
the 256 they came from.

On the ESP32, unrotated, the canvas and the packed picture are one block:
the panel-sized buffer `main.c` reserves at boot is handed to the runtime as
its canvas (`canvas_is_panel_picture`, `frameos_nim_share_canvas`), the pack
skips the copy onto itself, and the 1.31 MB the E1003 held twice of its 8 MB
goes to the renders (idle free PSRAM with a scene 3.2 MB -> 4.66 MB,
2026-11-10). The render borrows the buffer before the scene draws there, so
a snapshot of the last picture in it lets go first (`snapshot_before_lend`),
and anything else that borrows it (a status screen, a console `display_test`)
is counted (`fos_framebuffer_foreign_lends`) and makes the next render draw
whole (`frameos_nim_canvas_forget`). A rotated frame packs with a turn and
keeps a canvas of its own; changing the rotation restarts the firmware. The
AI chat's memory simulation counts one buffer too (`esp32CanvasIsPanelBuffer`
in both device-limits ports): it is told the frame's rotation, and only on
firmware from `ESP32_SHARED_CANVAS_FIRMWARE` on (`esp32CanvasRotation`);
older or unknown firmware keeps the two.

Any other grey or black-and-white panel renders in pixie's 8-bit luma surface
(`pfGray8`), because its error diffusion wants the 256 levels, whatever the PSRAM: blending is
per channel, so the luma of a composite is the composite of the lumas, and
every pass over the canvas — a fill, a blend, the dither — moves a quarter of
the bytes. The rule, in every copy (C, Nim, the backend, both device-limits
ports, `docs/device-limits-fixtures.json`): 4-bit for sixteen greys, luma for
another grey panel, and 565 for an RGB565 LCD and every colour e-paper panel (RGBX where two of it
fitted PSRAM until 2026.11.13: see docs/esp32-memory.md). So a canvas does not say what the panel is: what a scene hears
of it (`app.frame.fast`, `paper` and `color`, the built-in scenes' look, the scene
rhythm's floor) is the panel the firmware names at init
(`panel_shape.boardPanelFormat`, set in `embedded_main.nim`).

### The picture in the canvas (a colour panel's 565 canvas)

A colour e-paper panel whose 565 canvas and a panel buffer apart would take
more than half the module's PSRAM (a 1200x1600 Spectra 6 on an 8 MB board:
the reTerminal E1004, the XIAO EE02) packs its picture into the first bytes
of that canvas, unrotated, and holds no panel buffer of its own
(`canvas_holds_panel_picture` in `main.c`, `utils/palette_pack.nim`). Only
there, because the canvas is the display task's until the glass is done, and
the next render waits out the refresh: on an 800x480 board (the reTerminal
E1002, 0.77 + 0.19 MB of 8) that was 37.9 s from a render's start to its
picture (bench 2026-11-21), so it keeps a buffer of its own and renders the
next picture while the panel refreshes, as does a 1200x1600 panel on 16 MB.
The device-limits ports charge the panel buffer by the same rule
(`esp32CanvasIsPanelBuffer`, given the panel size and PSRAM). It can
because of the order the dither reads in: canvas row y + 1 is read into the
error row before the first pixel of row y is handed out, so while packed row
y (bytes `R*y ..< R*(y+1)`, R the picture's bytes a row) is written, every
canvas byte below `C*(y+2)` has been read (C the canvas's bytes a row), and
`R <= C`. Nothing is cleared first: in scan order the first pixel of a byte
stores it and the rest OR in, the same bytes a clear and an OR give. The
bytes are those of a pack into a buffer of its own (`test_palette_pack.nim`).
A turned frame writes down the panel's columns and keeps the two apart; a
panel with a partial waveform (which needs the canvas of the picture shown)
does too.

What it frees: the 960 KB panel buffer reserved beside the 3.84 MB canvas
(the E1004 idled at about 676 KB of free PSRAM, 2026-11-15), and the refresh
copy: the display's task refreshes from the canvas as it is
(`fos_display_lend`, the queue's `lent`), where it copied the picture (960
KB, 1.92 MB with one waiting). The rules that make it safe:

- The canvas no longer holds the scene after a pack: the render forgets what
  it knew of it (`rhythmForgetCanvases`, `lastPackedFromCanvas`), so the next
  one draws whole.
- Nothing writes the canvas while the display's task reads it. The render
  waits for the glass before it draws (`fos_display_wait_for` in
  `fos_client.c`; a timed render already waits in slices that serve keys,
  one somebody asked for now waits too); the LAN code and the notice are
  taken off only after it; any other borrower of the panel buffer (a status
  screen, a console `display_test`, a pull rendered on the server) gets
  memory of its own meanwhile (`fos_framebuffer.c`).
- Otherwise the head of the canvas is the panel buffer as a sixteen-grey
  canvas is (`fos_framebuffer_adopt`, `frameos_nim_share_canvas`): the
  render borrows it before the scene draws, the preview's snapshot of the
  last picture lets go then, and a foreign borrower is counted.

The device-limits ports charge no panel buffer for it from
`ESP32_PACK_IN_CANVAS_FIRMWARE` on (`esp32CanvasRotation` takes the panel
format).

### A JPEG decoded into a target draws its lines in one loop

pixie's JPEG sink (`drawLineInto` in `fileformats/jpeg.nim`) works out once
per decode where each position along a target line samples each channel
(`prepareLines`), once per line the row half, and writes a line through one
loop per format with no call in it, `-O2` on the device. Per pixel it was a
chain of calls and divisions: 11 us a pixel on an ESP32-S3, 24.5 s of a
30.8 s decode of a gallery photo into a reTerminal E1003's 1848x1179 window;
now 4 s, the pixels byte for byte the same (every master of pixie's JPEG
suite into five sizes, three fits and three formats). What is left of a
gallery photo there is the socket: 4-13 s for 115-180 KB at lwIP's default
window.

### The background is owed, not painted

A render used to begin by filling the canvas with the scene's background
colour — a whole pass, painted over at once by any scene that draws a
full-canvas background of its own. Now the render owes it
(`ExecutionContext.backgroundPending`): whatever draws first pays it
(`paintPendingBackground`: a node in the flow, a producer taking the live
canvas, an error frame, the end of a render that drew nothing), and a first
paint that covers every pixel opaquely waives it. The one waiver today is an
SVG painted straight into the canvas whose first element is an opaque,
solid, square-cornered rect over the whole of it (pixie's `coversOpaque`,
FrameOS/pixie#13). Every platform runs it: the Pi and the browser preview
save the same pass. `frameos/tests/test_background_deferral.nim` pins the
cases, including a canvas that starts out holding the frame before last.

### JS interpreters live between frames on a frame that stays awake

The single-scene host used to tear every idle JS app interpreter down after
each render on an ESP32 and build it again on the next: QuickJS, the 6.4 KB
prelude, the app, ~170 ms of a SenseCAP frame. A frame that does not
deep-sleep (`frameos_nim_set_keep_js`, from the client's housekeeping) now
keeps them (`settleIdleJsAppRuntimes(keep)`), the way a Pi always has: 181 KB
for DVD Logo Bounce, reported as `jsKB` on the `render:animation` line next
to the free PSRAM, which held at ~4.6 MB. They go when render memory runs
short (`utils/memory.renderMemoryReleaseHook`): below 2 MB free before a
render or a decode, and when a decode finds the largest free block under
that. A deep-sleeping frame releases them as before (it wakes to a fresh boot
anyway), and so does the editor's preview while it runs as an ESP32, so that
an app keeping values in module variables misbehaves there and not only on a
sleeping frame: `frameos.remember` stays the way to keep a value.

### A whole-frame SVG repaints what changed

When a scene's render is one fused node drawing one SVG into an LCD's buffer
(`ExecutionContext.wholeFrame`) and the SVG covers it opaquely,
`utils/svg_frames.nim` keeps the parsed SVG each buffer holds; the next render
into that buffer repaints only the boxes pixie's `damageRects` finds between
the two SVGs (up to six; a `view()` of the buffer each, `renderInto` with its
origin, which skips every element whose bounds miss it) — for DVD Logo
Bounce a box around where the logo was and where it is, ~130x85 pixels
instead of 230,400; for a JSX home panel a toggled card and the count it
changed, 28,564 pixels and ~80 ms of raster where the one box spanning both
was 93,522 and ~790 ms (`docs/jsx-ui.md` "Repainting what changed"). The two
element lists are matched in order, so an element added or removed is
damage where it is, not a whole frame. The firmware counts every write into a buffer that is not a render
in place (a copy, a clear, an overlay: `s_generation` in
`lcd_st7701s_rgb.c`), and a buffer whose count moved, a render of anything
else, or a failed one leaves no record, so its next frame is drawn whole.
`utils/tests/test_svg_frames.nim` checks every frame against a whole render.
`render/svg` takes the same path when it is the whole frame (the store's
Touch test: a code node writes the SVG, the dot moves), and settles the owed
background itself (`FlowAppsSettlingBackground` in interpreter.nim): the
canvas was filled twice per render, by the background and by the SVG's own
full-canvas rect, and a fill ahead of it would wipe what the damage repaint
keeps.

pixie shares the parsed data of a `<path d>` between SVGs (a per-thread cache
by the data's text), so "this element did not change" is a pointer
comparison, its bounds are measured once, and a fill keeps the shapes it
flattens to (`share`), per scale, so a path drawn every frame under a new
translation is flattened once.

### The SVG path

- The spec `frameos.svg(markup, {width, height})` returns is read straight
  off the JS object: the markup copied out once, the other properties one by
  one when they are plain values (`plainSpecRestFromJs`), the old JSON round
  trip only for anything else.
- pixie reads the markup an app writes without std/parsexml's
  character-at-a-time token building (`parseSvgXmlFast`, the same tree, a
  differential test over pixie's SVG corpus), and refuses — to the full
  parser — whatever it does not reproduce exactly.
- An SVG drawn into the target the planner offered never computes the
  standalone raster bound (`boundedRequestedDimensions`): it is only needed
  when the SVG is rasterized on its own.
- pixie's raster modules (`paths`, `images`, `blends`, `internal`, `rgb565`,
  `common`) compile at `-O2` on the ESP32 (+36 KB of flash): the logo's
  raster went from 31 to 26 ms. The XML and string modules gained nothing at
  `-O2` and stay `-Os`.
- QuickJS's interpreter loop (`JS_CallInternal`), its small-block allocator
  and its cycle collector compile at `-O2`, the rest of `quickjs.c` at
  `-Os` (+8 KB; `components/frameos_quickjs/CMakeLists.txt` adds the
  attributes to a copy of the vendored file): bytecode ~25% faster, small
  objects ~30%, a scene's typed-array loops 14-16%. All of `quickjs.c` at
  `-O2` cost +166 KB for a few percent more.
- The 565 and grey coverage stores write a fully covered pixel of an opaque
  fill packed, without unpacking, blending and packing it.

### Per-frame code does not walk the heap

`availableRenderBytes()` asks for the largest free PSRAM block, and ESP-IDF
answers that by walking every block of the heap: 0.5–2 ms with the ~800 a
running frame holds. The render path asked it several times a frame: the
decode budget before every render and every SVG, the kept interpreters'
check, the SVG's raster bound. The decode budget's largest-block half is now
measured only when a decode first reads it (pixie's
`setDecodeContiguousBudgetProvider`), and the other checks ask
`availableRenderHeadroomBytes()` (the free total, 8 µs). A new per-frame
memory question asks the free total; the largest block is for a decision
about one big allocation.

A walk is not only slow for the core that asks. The heap's lock is held
for all of it, and a task on core 1 that allocates meanwhile waits with its
interrupts masked, the LCD refill's among them. `fos_heap_largest_free_block`
walks on core 0, which was enough while a walk took a quarter of a
millisecond there, but a heap that the Form showcase's interpreters and
trees have fragmented takes 5–7 ms, and every one cost a frame from stale
lines. The metrics sample walked after every scene render, so every tap
flickered: 20–35 lost frames in 40 renders on the SenseCAP Indicator
(2026-11-14). A number that is only logged takes the newest reading on an
LCD (`fos_heap_psram_largest_cached`, at most ten minutes old, not renewed
while someone taps): no lost frames in 1,700 after it. The internal heap's
walks that run every pass (the metrics sample's, the log upload's check)
go to core 0 too: 0.8 ms on core 1 was most of the refill's 0.9 ms slack.

### Three frame buffers

With two, a finished render had to wait for the frame boundary at which the
panel switched to it before the next could draw in the other buffer: a
55 ms render took three 23.6 ms scans, 71 ms. With three
(`lcd_st7701s_rgb.c`) the next render draws into the third while the last
waits for its boundary, and a writer waits only before handing a picture
over, while the one handed over before is not on the glass yet. Each buffer
holds the frame from three renders back, so the damage box spans three
steps of the logo. 460 KB more PSRAM (`fos_display_render_psram_bytes` and
both device-limits ports count three).

### Flash in QIO mode (the S3)

The S3 fetches every instruction through a 16 KB cache, and in DIO mode a
miss moves two bits a clock. The S3 image is built for QIO
(`sdkconfig.defaults`): the header still says DIO and the bootloader switches
the flash to quad itself. A flash that refuses its QE bit does not fall back
to DIO: the bootloader drops to slow reads, the app's flash init
(`esp_flash_init_default_chip`) fails setting quad mode and startup asserts,
so a board flashed over USB boot-loops, and an updated one rolls back to its
previous app. QEMU's emulated flash is such a chip, which is why the boot
smoke builds DIO (`sdkconfig.qemu.defaults`); a new S3 board gets a bench
boot before it ships with this image. The bootloader is only replaced by a
USB flash, so a frame updated over the air keeps its DIO bootloader and its
speed; a DIO bootloader with a QIO app was measured to boot, render and
write flash as before (on a flash whose QE bit was already set). The C3 overlay keeps
DIO: measured on the S3 only, and a thin client is not fetch-bound.

### Bursts: a finger on the glass

A scene that renders on its own render rule (the Touch test redraws on every
pointer move; its interval is an hour) is not an animation, and every one of
those renders used to be a pass of its own: the settings, command and scene
pulls, a metrics sample, and ~2 KB of render:* lines into a console buffer of
2 KB at 115200 baud. ~300 ms a touch for a ~90 ms render. Frames the scene
asked for (`fos_client_render_for_scene`, its own bit, not `render_now`'s)
that follow each other within a second are a burst (`fos_animation.c`,
host-tested), with an animation's rules: the pulls once a second, the first
frame and one in ten seconds logged in full, the rest quiet, and once the
burst is a second over a `render:burst` line and, when its last frame was
quiet, the render announce and backend push it skipped. A frame about to
deep-sleep is never quiet. With the SVG damage repaint above, a touch is ~65
ms on the SenseCAP Indicator (2026-10-26): pixie's parse of the SVG, mostly
its three text lines, ~22 ms; the damage, ~8 ms; and the raster of one box
around both the dot and the text, a quarter of the screen, ~25 ms. (That box
is two now, the dot's and the text's.)

### Metrics with the logged frame

An animating frame takes its metrics sample with the frame it logs in full,
every ten seconds, not with every second's housekeeping: a sample is three
heap walks and a line the provider's Metrics panel stores, and once a second
was 3,600 an hour.

### Photos in motion: Ken Burns

The store's Ken Burns slideshow is the Local Image app (data/localImage until
2026.11.15), cached per cycle, under
render/zoomPan at 24 fps. On the Indicator it went from 0.4 fps with every
photo refused (2026-10-25) to 7.4-7.9 fps between photo changes
(2026-10-26):

| Step | Frame |
| --- | --- |
| Before: pixie's float `getRgbaSmooth` per canvas pixel (~10 µs each) | 2.3 s |
| Fixed-point bilinear (`utils/resample.nim`, `-O2`): columns precomputed, each source row interpolated once for two target rows | 330 ms |
| Onto a 565 canvas from a 565 copy of the photo made once, mixed in spread words | ~150 ms |
| From the photo itself again, rounded against a threshold fixed to the screen; rows on both cores; 64-byte cache lines | ~130 ms |

The 565 copy banded. It was dithered once, so its noise belonged to the
picture, and every frame resampled that noise at a new phase and rounded it
again: between two frames of a sky the pixels that changed formed a grid of
lines, and the grid slid as the zoom moved. The draw now reads the RGBX photo
and rounds each pixel to 565 against a 4x4 Bayer threshold picked by its
place on the screen, so a still sky is a still pattern and a gradient keeps
its level within one 8-bit step (`test_resample.nim`, and zoomPan's test of a
flat sky at two moments of a zoom). The draw, alternating the variants frame
by frame:

| Draw | 32-byte lines | 64-byte lines |
| --- | --- | --- |
| 565 copy, one core | ~100 ms | |
| RGBX, one core | ~145 ms | ~125 ms |
| RGBX, both cores | ~115 ms | ~90 ms |

**Any source format.** The draw reads a 565 or grey source too, each
pixel expanded as its row is interpolated. Only an RGBX photo had the
fixed-point path at first, and anything else went through the float
sampler: on the SenseCAP Indicator a slideshow with no photos in its folder
(2026-11-15) ran at 0.4 fps, 2.25 s in zoomPan, because on a device the
producer's error frame is drawn into the 565 canvas, the node cache kept that
alias, and zoomPan zoomed the canvas into itself. A source that shares the
canvas's pixels is now left as it is.

**Both cores.** The render task shares core 1 with the LCD's refill
interrupt, and core 0 mostly waits on the network. `fos_rows.c` hands a
job's rows out in blocks of 32 to the render task and to a helper pinned to
core 0 at the render task's priority, each block taken when the last is
done, and resample.nim's row loop is that job: a C callback over plain
values and pointers, since the helper is a task the Nim runtime knows
nothing about. Both cores share one bus to PSRAM, so two cores draw 1.3x as
fast, not 2x.

**64-byte data cache lines** (`sdkconfig.defaults`, the same 32 KB of
cache) halve the PSRAM transactions of whatever streams through the cache:
the refill's copies, the photo's reads and the back buffer's writes. DVD
Logo Bounce went from 19.6 to 20.5 fps with them, and under the slideshow
the refill stayed clean (none late, the worst at 387 µs of its 913).

The photos had not shown at all at first: a progressive JPEG decoded to a
new image sized its strips to the whole decode budget and was then refused
for the output next to them (fixed in pixie, which now plans the output's
room first). The cached photo is let go before the next one decodes
(`withCache`), and kept past the 1 MB memory limit while render headroom
stays at that limit or more with it held. The bar was 2 MB at first, and
the Indicator's 1 MB photo left 2.03 MB: for the first minute after a boot a
few KB of TLS buffers put it under, and the slideshow decoded its photo
every frame at 0.2 fps until they went. What is left, the decode at each
photo change, is in `docs/realtime-todo.md`.

### The Pi

The interpreter's savings above are the Pi's too. On a Pi Zero W with a
HyperPixel 4.0 Square (720x720, a 16 bpp KMS framebuffer, 2026-10-28) a
touch in the Touch test cost ~70 ms of render and ~100 ms in the driver,
back to back: the driver converted all 518,400 pixels from RGBX to 565,
`write()` the megabyte through a fresh 1 MB stdio buffer and closed
`/dev/fb0` again, every frame. The write itself is cheap (3-11 ms for 1 MB,
measured with `dd`); the conversion was the cost. The armv6 core has no NEON,
so pixie runs its scalar code there whatever the format.

**A 565 panel's canvas is 565** (`frameos/panel_canvas.nim`). When the
framebuffer is 16 bpp in pixie's 565 order, the driver says so
(`frameos/driver_render_hint` `reportPanelCanvas`, the library symbol
`frameos_driver_panel_canvas`), and a frame that is unrotated, unflipped and
at the panel's own size renders into one `pfRgb565` canvas kept for the
uptime, stores dithered as on the ESP32. Anything else keeps the fresh RGBX
canvas, the scaling and the rotation as before. On a 64-bit Pi this trades
pixie's NEON RGBX kernels for its scalar 565 ones. Measured on a Pi 5 with
the 565 canvas forced (`FRAMEOS_PANEL_CANVAS=rgb565`, 800x480): a full-frame
photo pan (Slideshow with motion) renders in 8.7 ms against 7.2 ms on RGBX,
and the Touch test in 2.0 ms against 4.8 ms, since only its damage is
redrawn. NEON's ~1.5 ms is about what converting RGBX for a 16 bpp panel
would cost, so the rule is the same on every Pi.

**The canvas holds the last frame, so a whole-frame SVG repaints what
changed.** The runner brackets every render into it with
`beginPanelFrame` / `endPanelFrame` (utils/svg_frames.nim), as the ESP32
brackets its LCD buffer; anything else that draws into the canvas (the
control code, the cloud link code, the frame-wide color correction, the
local network access code) bumps its generation, and the next frame is
drawn whole.

**The driver writes the rows that changed** (`drivers/frameBuffer/panel_push.nim`).
It keeps a copy of what the panel shows in the panel's own layout, stages
each frame into it a row at a time (a 565 canvas as it is, anything else
converted), and `pwrite`s only the runs of rows that differ, on a descriptor
it keeps open. The copy is trusted for a minute at most, and forgotten on an
unblank or a failed write, so a console that drew over the panel heals.

Measured on that frame (2026-10-28, a finger dragged across the Touch test,
the runtime's own `render:done` / `render:driver` lines):

| Per frame | Before (2026.10.21, 33 frames) | After (300 frames) |
| --- | --- | --- |
| Render | 71.9 ms median | **33.0 ms** (p90 36.2) |
| Driver | 99.6 ms | **16.1 ms** (p90 16.8) |
| **Together** | **~172 ms (~5.8 fps)** | **~49 ms (~20 fps)** |

**A turned panel is turned on the way in.** The HyperPixel 4.0 is natively
portrait, so a landscape frame owes a 90-degree turn: a scalar
`rotateDegrees` pass over the whole frame, every frame, before the driver
converted it again. Now the framebuffer driver says it turns frames itself
(the panel hint's `rotates`), the runner hands `drivers.render` the frame as
the scene drew it with `rotate`, and the driver gathers each panel row from
the unturned frame as it stages it (`panel_push.nim` `stageImage`, the
mapping `rotateDegrees` uses, pinned by `test_panel_push.nim`). A driver
without `frameos_driver_set_render_rotation`, and every statically linked
one, still gets the frame turned by the host. With it, a turned 565 panel
keeps the 565 canvas too, at the scene's own size.

**The staging loops run without Nim's checks.** The driver libraries are
built for size (`-Os`, and one set of C flags for every file of a library,
so a per-file `localPassC` never reaches them). At `-Os` gcc keeps each
overflow-checked index sum as a branch inside the loop, which made staging a
turned 800x480 frame 14 ms on a Pi 5. `panel_push.nim` turns the checks off
for the module (every index comes from the layout the shadow was prepared
for) and works out a 32 bpp layout's shifts once per frame, not per pixel.
On the Pi 5 at `-Os`, every row new: 3.0 ms turned, 2.2 ms upright, 0.18 ms
for a 720x720 565 canvas.

Measured on Cloud-5 (Pi 5, HyperPixel 4.0 at 32 bpp, a landscape frame
turned 90 degrees; 30 touch moves, 32 frames each, 2026-10-28):

| Per frame | 2026.10.21 | Turned in the driver |
| --- | --- | --- |
| Render | 12.0 ms median | **4.8 ms** |
| Driver | 12.8 ms | **3.3 ms** |
| **Together** | **~25 ms** | **~8 ms** |

What is left (`docs/realtime-todo.md`): the push on its own thread, and
waking on input instead of polling.

### A press shows at once

A tap's answer is a render, and a render waits its turn: the press is not
reported until it has settled (`TOUCH_SETTLE_MS`, 20 ms), the render task
may be in the middle of another render (a clock's 385 ms, a slideshow's 0.5
to 0.7 s on the SenseCAP Indicator), and a JSX UI's press render (its
`active:` look) and the answer after the lift are 40 to 100 ms each there.
Measured on 2026.11.14 (the hour of console taps in `docs/perf-todo.md`
"Where a tap's time goes"), the pressed look came 80 to 110 ms after the
finger, and on an element with no `active:` class nothing changed until the
finger lifted. On the reTerminal E1003 nothing moves on the glass before the
answer's waveform starts, ~0.2 s after the lift, and finishes ~0.5 s later.
What the person sees sooner now (2026-11-24, `fos_press.h`, `lcd_press.h`):

- **An LCD lights the press itself** (`lcd_press.c`, host-tested). The touch
  task (core 0) asks the press map of the last render (`fos_client_press_find`:
  every touch board keeps it now, not only e-paper) what is under the finger
  at its first report, before the settle, and an element of the scene's UI
  (`taken` 3: its own box, `interpreter.panelPressMap` `element`) is shaded a
  quarter of the way to black (to white on a dark box) in the frame buffer on
  the glass, its pixels saved first, under the loading mark's lock. The next
  picture presented puts it away (`present_back`: it is the scene's answer,
  its own `active:` look or the result), and so does the lift when no picture
  follows within `FOS_PRESS_LINGER_MS` (250 ms, the mark's task), a move past
  `FOS_PRESS_SLOP_PX` (a drag) or a second finger. A box over a quarter of
  the panel is no button (a scene that takes every press: nothing is lit).
  Put away by the render task it gives the buffer's write count back; put
  away from another task the count stays moved, because a render may have
  been copying from that buffer meanwhile (`svg_frames.nim` checks the count
  after a whole-frame copy too now), and that buffer's next render draws it
  whole. The mark and a press are never up together: the mark is the newer
  news. On the SenseCAP Indicator the shade of a 200x120 button is drawn
  5 ms after the touch task's first report of the finger (the console's
  `touch tap`, below), so it is on the glass within the controller's 10 ms
  poll and one scan of the panel (24 ms) of the contact, where the scene's
  own `active:` look came 80 to 110 ms after it.
- **A quick tap still looks pressed** (`ui/events.nim` `pressLinger`, an ESP32
  only: `quickTapLingers`). Its press and its lift handled in one go behind a
  busy render left no render that drew the `active:` look; now the look stays
  with the tap's answer and goes `PressLingerMs` (150 ms) after a render drew
  it, as a typed key's light does. The idle wait looks at a UI timer every 50
  ms (`fos_nim_next_async_ms_impl`), so the key's light no longer stays up to
  a whole second slice either.
- **A handler that takes long shows the loading mark** (LCD). The mark used to
  count from the render that answered a tap; a handler that blocks (a
  synchronous `fetch` in an `onClick`) ran before that render and showed
  nothing. It counts from the input's arrival now (`process_input_events`,
  `FOS_LOADING_ANSWER_EXTRA_MS` past the usual 200 ms, so at half a second),
  and goes where no render follows.
- **A timed render does not start under a finger**
  (`fos_timed_render_waits_for_finger`, host-tested): a render whose interval
  ran out while a finger is on the glass waits for the lift, in 50 ms slices,
  at most `FOS_TIMED_UNDER_FINGER_MAX_US` (1.5 s) past its time, so the tap's
  render goes first. A render already running is not stopped: see
  `docs/perf-todo.md` "Still open" for why there is no safe checkpoint.
- **E-paper says it heard the press.** On a press the map takes, the touch
  task lights the board's LED (`fos_led_busy`, the E1003's GPIO16) until the
  waveform that draws the answer has run (`FOS_PRESS_WAVEFORM_MS` after it
  starts, 4 s at most), beside the buzzer's click. On an element whose taps
  took `FOS_PRESS_INK_AFTER_MS` (600 ms) or more to answer (contact to the
  answer's picture ready, smoothed over its last few, by its box: the last
  eight elements pressed, timed afresh on every scene), the render task inks the pressed box
  before it hands the press on (`ink_press`): the box inverted in pure black
  and white in the picture showing, for the upload alone, and one DU over it
  (`fos_display_glass_rect`, the IT8951's `glass_rect`: its tiles marked
  `stale`, so the next update sends the picture's own pixels whatever the
  digests say, and the settle does when none comes). A quicker element is not
  inked: its answer would wait for the ink's 470 ms waveform. A scene switch
  somebody waits for (input within the hold's quiet 10 s) puts the loading
  tile up the same way at once (`fos_client_switch_begin` at the switch call
  sites in `fos_scenes.c`: the wake ring, `fos_panel_mark_box`), while the
  scene loads; its first picture takes it away. On the E1003 (2026-11-24) a 1.5 s
  button's ink went up 39 ms after the render task took the press (its 224x128
  tiles' upload included), the answer's update sent the box's own pixels back
  with its own, and the loading tile took 56 ms of a switch. Either one
  invalidates the display state in memory, so the next render updates the
  panel even when the scene drew nothing new (a switch that failed).

The console's `touch tap <x> <y> [ms]` (`fos_touch_inject`) puts a finger
on the glass through the touch task, in the controller's own coordinates, so
the bench times all of this without one, and prints when the touch task saw
it and lit it.

### A switch that takes a while: the loading mark

On a fast panel a scene switch used to give no sign of life while the next
scene was built and rendered, which can be seconds (QuickJS compiling a
scene's apps, its HTTP fetches). Now, when the new scene has not put its
first frame on the panel within **200 ms** of the switch being asked for,
three dots in a small dark pill, pulsing in turn, are drawn over the picture
still showing, and they go the moment the new frame lands. Up to ~100 ms a
change reads as instant and from ~250 ms a pause reads as "did it hear me":
200 ms leaves a quick switch (most scenes on a Pi) exactly as it was, with
room to spare, and answers before the pause starts to read as one.

Every switch counts, whoever asked: the frame's event map (an edge swipe, a
held button), the cloud's `set_current_scene`, the HTTP API, the schedule,
a scene's own dispatch, and a pushed scene set (a preview, a deploy). So
does the scene switcher (`docs/scene-switcher.md`), opening and closing:
nothing loads for either on the ESP32 (the switcher is built in, and the
scene it covers stays resident), but the panel still waits for a render. A
switch begun while another still loads keeps the first one's start, and its
mark if one is up. A frame rendered for an older switch ends nothing.

**Every render counts as well**, so nothing has to ask for the mark: a tap whose
next frame is slow, the scene settings' gear, a refresh that fetches something.
Each render pass begins it (`runner.nim` at the top of a pass, `fos_client.c`
before `render_once`) and its frame ends it. Timer-driven renders are included,
so a scene that refreshes every minute and takes 3 s to do it shows the mark
for the last 2.8 s. The exception is a render the frame's own clock repeats
more often than every 5 seconds (`LoadingMarkMinIntervalSeconds`): an animation
(on the ESP32 a scene `fos_animation` is pacing), a ticking clock, a layout's
clock bar. Nobody is waiting for those, and the mark would blink on every tick
that ran a little over the delay. With a layout the interval that counts is the
scene's own, and only on a pass that will run it (`rhythmAwaited`): a slow map
inside a clock bar shows the mark when the map renders and not when the bar
ticks. A switch still shows it. On an ESP32 LCD a render that answers
somebody (input, or an event from HTTP, the cloud or the console, handled
since the last render began) is waited for, an animation's too: a swipe to
the next Color cycling scene draws for a second or two. Its mark shows at
500 ms (`FOS_LOADING_ANSWER_EXTRA_MS`), since a UI answering a key in 200 to
400 ms flashed it at 200 ms on most keys (the Form showcase on the SenseCAP
Indicator), and no other render shows it while somebody taps
(`input_hold_on`).

**E-paper has no mark to draw, so it chirps.** When someone at the frame touched
it or pressed a key in the last ten seconds, a load that has taken 1.5 seconds
plays a quiet pair of chirps on the buzzer, a higher one and a lower one close
together, every 1.3 seconds, until the picture lands (`fos_buzzer_loading_begin`, `fos_client_loading_begin`), 20
seconds at the most. A schedule or a scene pushed from elsewhere stays silent,
an ordinary partial update is done before that, and the frame's
Touch beep switch turns it off.

**An interpreter that holds a UI's handlers is not let go to save memory.** An
awake ESP32 keeps its JS interpreters between renders while there is room, but
a UI's `onClick` and friends live only in its interpreter, so one released
between renders leaves a picture that no longer answers. It stays whatever the
headroom, and goes only when an allocation actually failed
(`keepIdleInterpreters`, `releaseRenderMemory`). The scene showing keeps its
interpreters (and its layout's) whatever the floors while the headroom is above
the reserve: its next render needs them again before anything it decodes, and
a switch drops them with the scene (`settleIdleJsAppRuntimes`'s `resident`;
docs/esp32-memory.md, 2026-11-23). Any interpreter that does go
while its scene stays is logged (`js:interpreterDiscarded`, with the reason),
and when it held handlers the panel says so for a few seconds
(`reportInterpreterDiscards`). `test_kitchen_sink_esp32.nim` and
`tools/esp32_kitchen_sink.mjs` (CI: the wasm runtime in an 8 MB board's memory)
keep the Kitchen sink working on the smallest board that runs it.

**The mark** is `frameos/loading_mark.nim`, one drawing for both runtimes,
a frame of it every 50 ms. It composes a rectangle of the panel's own pixels
from a copy of what was there, so a host puts it away by writing the copy
back, and it allocates, raises and refs nothing, because it runs beside the
busy render path, not on it. It sits in the viewer's top right, through
frame.json's `flip` and `rotate`, and scales with the panel's shorter side.
There is no setting: a switch to turn it off would be one boolean.

On the HyperPixel 2.1 Round (`frameos/panel_shape.nim` `panelIsRound`) only
the circle inside the 480x480 square is glass, so the pill sits at the top
middle instead, as high as its top corners stay 14 px inside the rim.
`test_loading_mark.nim` checks that every pixel it touches there is 12 px
inside the circle, at every turn. The Waveshare ESP32-S3-Touch-AMOLED-1.75's
466x466 AMOLED is round the same way: the firmware says so at init
(`fos_display_round`, `panel_shape.boardPanelRound`) and its mark sits there
too.

**On a Pi** (`frameos/loading_mark_panel.nim`, the framebuffer family only:
HDMI, DPI, the HyperPixels) a thread of its own draws the mark straight into
`/dev/fb0`, from `beginLoadingMark` in the runner's switch (before the new
scene's init, which is part of the wait). The driver writes only the rows
that differ from its copy of the panel, so the mark is never on the panel
while the driver writes: every push goes through `withLoadingMarkAway`,
which holds the mark's lock across the driver's render and first writes back
what the mark covered. The render loop tags each frame with the newest
switch when its render began, and only a frame tagged with it lands it.
The stored image (`GET /image`, snapshots) never has the mark: it only ever
reaches fb0.

**On an ESP32 RGB LCD** (`components/frameos_display/lcd_loading.c`,
host-tested, and its task in `lcd_st7701s_rgb.c`) the render task begins the
mark when it applies a switch (`fos_scenes.c`, counted from when the switch
was queued), and a task on core 0 draws it into the frame buffer being
scanned, through the one C entry `loading_mark.nim` hands the driver as the
runtime starts (`fos_lcd_st7701s_set_loading_mark`; no runtime lock: the
render task holds the runtime for the whole load). `present_back` puts it away
before the next picture is handed over, so it never reaches the new scene's
buffer, and a render that shows nothing ends it after the fact. Each frame
of it is ~1,000 pixels in PSRAM, tens of microseconds; a buffer it goes into
counts a write (`s_generation`) while it is there, so a damage repaint never
takes it for a frame of its own. Put back, the buffer holds exactly what it
held, and the count goes back with it unless something else wrote there
since (nothing should: the mark is only in the scanned buffer, every other
writer writes the back one). Kept moved, it cost the frame under the mark
its damage repaint: on the SenseCAP every opening of the scene switcher
after the first drew all of it, 1.8 s instead of 0.3 s, because the way back
put the mark over the switcher's own frame. A snapshot (`/image`) taken while a switch loads can
carry the mark: the front buffer is the snapshot.

Flash is the ESP32's budget, so the firmware builds only what its one LCD
needs (`loading_mark.nim` `Only565`, `Flips`, `RoundPanels`): RGB565 only,
no flip, no round panel, and no log line. The 565 pixel is darkened and
lit with its channels spread out in one word, one integer multiply each.
The pill is worked out once a frame in panel pixels (a half turn is both
flips, a quarter turn a swap of axes), the C side keeps 32-bit milliseconds
of the tick count, and the runtime hands the driver its one entry itself.
That costs 2,192 bytes of the S3 image (2026-10-28, against #642): 1.3 KB of
Nim drawing (0.7 KB of it the per-pixel loop) and 0.9 KB of C state, task
and the calls at a switch.

### The mouse cursor

A Pi with a mouse draws its cursor the way the mark is drawn, and for the
same reason (`frameos/cursor_panel.nim`, `frameos/cursor_sprite.nim`;
docs/events.md "The cursor"): straight into `/dev/fb0`, composed over a copy
of what was there, never in the canvas. It is the runner thread's, not a
thread of its own: a move the dispatcher reports (`takeCursorDirty`) writes
back the old rectangle and draws the new one, inside `withLoadingMarkAway`,
and `pushToPanel` puts it away before the driver writes and back over the
new picture after (`putCursorAway` / `putCursorBack`), so the driver's copy
of the panel never holds it and its row diff stays exact
(`test_cursor_panel.nim` replays the driver's staging around it). Its
rectangle is 12x19 sprite pixels at 1x (2x from a 1080-pixel short side, 3x
at 4K), turned and flipped with the picture.

On a Pi a switch slow enough to show the mark logs it once it lands:
`render:loadingMark` with the scene and `ms`, from the switch being asked
for to its first frame. A switch that never lands stops showing it after two
minutes, past every render's own deadline, on both.

## Partial refresh on e-paper

A panel with a partial waveform (`PARTIAL_PANELS` in
`components/frameos_display/generate_panel_table.py`; the reTerminal Sticky's
SSD1677 is the first) updates without the full-screen flash. Three layers make
a small change cost what it should:

- **The glass.** `fos_display_update` (`frameos_display.c`) sends the picture
  on the glass and the new one to the panel's two RAM planes, and the waveform
  moves only the pixels that differ. It takes the whole frame each time: the
  update drives the whole panel whatever the RAM window says. Every picture
  that reaches the glass goes through it or `fos_display_blit`, so the copy it
  keeps is exact whoever drew it. `fos_partial_refresh.c` (host-tested) picks
  a full refresh instead for the first picture after a boot or a deep sleep, a
  new scene nobody switched to by hand, a picture that mostly changed, and a
  glass the ghosts have worn (next paragraph). `render:done` says
  `"refresh":"partial"`, and each update logs its kind and the wear
  (`display: partial, 1834 bytes changed, ghosts 2.3 deep, 41 of 1500 tiles
  worn`; `display: full refresh (ghosts), ...`). The panel
  stays awake between updates, its analog supply on and its waveform loaded.
  After ten idle seconds the supply goes off and the controller stays awake
  (`fos_display_park_if_idle`); after five minutes, or before the chip's own
  deep sleep, the panel is parked. A reset and a sleep around every update were
  300 ms; the supply, the waveform load and an 8 MHz bus 270 ms more. What is
  left is about 500 ms: some 40 ms for the two frames on the bus, the rest the
  waveform itself.
- **The ghosts, counted where they are.** A partial update leaves each pixel
  it moves a little short of black or white, and the next move of that pixel
  starts from there; a pixel that never moved has no error at all (Waveshare:
  "after repeated partial refreshes, this error accumulates and produces
  ghosting"). So what wears the glass is how often each place was rewritten,
  not how many updates there were. The display layer counts the pixels every
  partial update flips per tile of 16x16 pixels (`fos_ghost_add`, a table of
  1,500 counts beside the Sticky's 48 KB copy of the glass, 3 KB, cleared by a
  full refresh), a tile's depth being its flips over its pixels: one flip of
  every pixel is 1.0, a page of text turned about 0.2 in the text. The glass
  is due a full refresh when a quarter of its tiles are 1.0 deep (pages of
  text: every fifth page, as an e-reader's and the panel makers' "one full
  update after five or six partial updates" have it), or when one tile is 16
  deep (a digit rewritten in place: about 27 times, the Sticky's tap
  counter). The one deep tile waits for the idle frame while someone taps or
  pictures come quickly, up to 32 deep; a worn quarter does not wait, as a
  page turn does not. Nothing else flashes the glass: no count of updates,
  no timer on a glass with no ghosts. What it replaced flashed every 20th
  update (120 while someone tapped) and once the updates since the last full
  refresh had moved a panel and a half of bytes, and the idle frame flashed
  30 seconds after the last update whenever 20 updates or half a panel's
  bytes had gone by: after almost any use, the flash "about a minute after I
  leave it". Measured on the Sticky (2026-11-24): 25 taps of the tap counter
  then nothing, the old rule flashed 30.2 s after the last update (25
  updates, 12.7 KB moved), the tiles left its digit 14.9 deep and nothing
  flashed; a clock with a seconds hand flashed every 120 updates, two
  minutes, and with the tiles every 3 min 41 s (its hand wears a quarter of
  the glass); ePub pages flash every fifth page under both. Each update
  takes one pass over the changed rows (`memcmp` skips the rest) and one
  over the tiles. One exception keeps a timer: a glass partially
  updated a day ago is cleaned when idle, ghosts or not, since a pixel a
  partial update left black or white is held there by a charge no waveform
  balanced (the panel makers' "refresh at least every 24 hours"). Not the
  IT8951 (next): it keeps no copy of the glass to count against, its slow
  pictures go up with GC16 over their grey areas, which clears them, and it
  takes a full refresh after 20 of its partial updates (120 while someone
  taps).
- **A controller that keeps the picture** (the IT8951 behind the reTerminal
  E1003's 10.3" glass). The display layer holds no copy here, 1.25 MiB this
  8 MB board does not have: the driver hashes the packed picture in tiles of
  32x8 pixels (the controller's display area snaps X to 32) and loads only the
  tiles that changed. This panel's waveform file (`LUT M392`) has three modes
  that draw what they are sent: INIT, GC16 for sixteen greys and DU for pure
  black and white. GL16, GLR16, GLD16, DU4 and A2 finish in 645 ms and leave
  the area one flat tone. Waveforms run one at a time and take the same time
  whatever the area, DU 470 ms and GC16 580 ms, so the count is what matters.
  While someone taps there is one: **a single DU over everything that changed**,
  however far apart. DU moves only the pixels that change (16 grey bars stay as
  they are under one), so the box costs nothing where nothing changed and the
  rest of the picture does not flash. It draws black and white only, so a
  changed area with greys goes up as a halftone
  (`fos_it8951_row_halftone`) and its tiles are owed their greys; a tile drawn
  in pure black and white again owes nothing. **A change of any size** goes up
  that way while someone taps (`controller_keeps` in `fos_partial_refresh.c`):
  a page turned by a tap is one DU, not the whole panel's GC16, which flashed
  for 580 ms. 4.5 s after the last of these updates, and never while a finger
  is down or a press is queued (`fos_display_settle_due`, the idle wait in
  `fos_client.c`), the kept canvas is packed again, with the scene not run,
  and those areas get GC16, three rectangles at the most: a tap that lands on
  a settle waits out its 580 ms, and 2.5 s was the gap between two taps of
  somebody reading.
  **What goes up first is the render's box.** Hashing the whole 1.3 MB
  picture to find what changed was 30-50 ms between a tap's render and its
  upload, and the SHA-256 the firmware kept for "unchanged, skip the refresh"
  another 40 (2026-11-24). The render says where it wrote the canvas
  (`frameos_nim_render_damage`: one SVG repainted in its own frame's damage,
  `svg_frames.nim` `takePanelPaint`; anything else is the whole canvas), the
  render task hands that to `fos_display_hint_damage`, and the driver hashes
  only those tiles before the upload (`fos_it8951_10in3_hint`). The whole
  picture is hashed after the waveform has started, on both cores
  (`fos_rows_run`), when the next upload could not go yet anyway
  (`verify_after_hint`): a tile changed outside the box is sent at once in a
  follow-up (`fos_display_followup_due`) and logged as `changed outside the
  render's box`, so a wrong box costs a waveform, never a picture left
  behind. A box is good only for the canvas as the controller last took it:
  any other way onto the glass (a blit, a quick update) or a picture taken
  off the canvas after its update (an overlay: `fos_display_hint_forget`)
  makes the next update hash it all. While somebody taps, the SHA-256 is not
  worked out at all and the hash of the last picture is written to flash when
  the tapping stops, and before a deep sleep (`pay_display_state`): the
  controller's tiles skip an unchanged picture already. The `it8951:` lines
  go through the log ring (a `printf` waited 10-45 ms behind a render's own
  lines for room on the 115200-baud console), HRDY is spun on for 5 ms before
  a wait sleeps a tick, and a wait for the last waveform sleeps until shortly
  before it is due and then reads LUTAFSR every half millisecond.
  **Quick pictures go up the same way** (`fos_pictures_fast`): a scene whose
  own interval is under 2.5 s (an animation, a clock's seconds) from its first
  frame, and any picture within 2.5 s of the one before. Before, an animation
  nobody touched put a GC16 over every changed rectangle with a grey in it,
  every frame: the Kitchen sink's balls flashed sections of the E1003 (their
  anti-aliased edges are grey). Like a tapping session they take a full
  refresh after 120 partial updates, not 20, and go on with DU after it. Slow
  pictures, and the settle's own, go up rectangle by rectangle, DU for pure
  black and white and GC16 for the rest. A new scene is GC16 over the whole
  panel. A panel picks this path by
  giving `PARTIAL_PANELS` a `changed`, a `clean` and an `owed`. The controller
  is not put in standby between updates, only when it is parked, and on USB
  power not even then (`fos_display_keep_controller_awake`; a deep sleep
  parks it all the same): its first waveform after a standby ran 898 ms where
  a GC16 runs 580, while SYS_RUN itself answered in 22 ms (2026-11-24), so
  the cost is the panel's supply coming up and waking it early saves nothing.
  An awake controller is not sent SYS_RUN and the SHT40's temperature on
  every full refresh any more; the temperature goes again every 5 minutes. At
  boot it is brought up on a task of its own while Wi-Fi joins
  (`fos_display_warm_up`), not after the first render; every way onto the
  glass waits for that task first. Measured on an E1003 (2026-11-10): five
  scattered areas in 511 ms of waveform and 15 ms of upload; a tap in about a
  second from the finger to the picture.
- **A refresh is started, not waited for.** The IT8951 runs its waveform and the
  Sticky's SSD1677 its update on their own, 0.5-0.9 s; the driver returns once
  it has started one, and waits for it only before the panel's next use (the
  next upload, which overwrites what the waveform reads, a clean, a standby,
  which would cut it short): `finish_waveforms` in `it8951.c`,
  `EPD_3in97_WaitPending`. The render task handles the taps that came meanwhile
  and draws the next frame while the glass changes. A new driver entry point
  waits first. A full refresh goes the same way: on any other SPI panel
  `fos_display_blit` copies the picture and a task of the display's own
  (`refresh_task` in `frameos_display.c`) runs init, picture, refresh and
  sleep, so the E1002's 28.7 s color refresh and the Sticky's 2.2 s after a
  scene switch no longer hold the render task, which answers keys and
  commands meanwhile. A picture asked for during one waits as the next (the
  newest only), every other use of the panel waits for the task first, a deep
  sleep parks the panel after it and a restart waits for it (a shutdown
  handler). A timed render waits for the glass too (the idle wait in
  `fos_client.c`), or a one-second scene on a color panel would draw pictures
  nobody sees, seconds of the render task each; a render somebody asked for
  does not. The IT8951 keeps the picture, so it is left awake after a full
  refresh, like after a partial one, and its waveform is waited for at its
  next use. Measured on the E1002 (2026-11-10): a scene switch starts drawing
  in 0.2-0.35 s instead of 6-18 s, and the render task is free 6 s after it
  began instead of 35-53 s.
- **Slow chores leave the render task.** The scene state that waited its delay is
  written by a task of its own (`scene_state_writer_task` in `main.c`), and the
  file write runs outside the store's lock, a load meanwhile getting the state
  being written. Off the render task is not out of its way: every name a SPIFFS
  call takes is a walk of the partition's lookup pages (0.5 s on a 24 MB
  `/state`), flash reads with the cache off on both cores, and a render going
  on meanwhile ran at half its speed. So a write names its file once, in place
  (through a temporary file it was six names, 3.2 s on the Sticky), and a scene
  without state, which says "nothing to keep" every time it is shown, is no
  flash work at all (it was the remove of a file that is not there, 0.6 s, a
  minute after every such scene). Measured on the Sticky (2026-11-18), ten
  scenes walked and one drawn as their state came due: 4.9 s of writes and the
  3.7 s render in 8.1 s before, 0.7 s of writes and 3.9 s after.
  More than half the store's sixteen slots waiting writes them all
  (`fos_scene_state_crowded`), so a walk through the scenes never writes on the
  render task. The picture pushed to the backend after a render (1.3 MB on the
  E1003, a median 8.8 s with the 16 KB send buffer, 14.5 s at lwIP's default;
  `embedded/esp32/README.md` "Wi-Fi and lwIP buffers come from PSRAM first")
  gives way to a tap, a key, an event
  from HTTP, the cloud or the console, or any render asked for, and starts over
  later. A frame that stays awake does its backend round trips on a task of its
  own (`backend_link_task` in `fos_client.c`): the log uploads every second, the
  picture push after a render, and every 10 s the scenes, settings and
  commands pulls. Between two renders of a one-second clock on the Sticky they
  were 2-8 s of the render task, and the clock stood still for up to ten
  seconds. The link task applies nothing: the commands it pulls are handed over
  and run on the render task (the backend marks what it hands out `sent`, so
  a pull is never only a look; `fos_commands_fetch` / `fos_commands_run`), and
  settings that changed it fetches and the render task applies
  (`fos_settings_fetch` / `fos_settings_apply`: before, the render task fetched
  them again whole, and a backend that hung held it for the connect timeout).
  A changed scene set the link task
  downloads itself (`fos_scenes_backend_fetch`); the render task only parses
  it into the runtime (`fos_scenes_take_backend_payload`, 0.3 s for 337 KB),
  once nobody is tapping (`serve_link` skips it under the input hold, and its
  release serves it), and the scene store's own task writes it to flash
  (`store_task` in `fos_scenes.c`: the combined file, then the etag and the
  source, so a crash never claims a set that is not on flash; a deep sleep
  and a restart wait for it). On the E1003 a forced sync held the render task
  13-20 s (the download 6-13 s, the write 6-7 s) and an event sent as it
  began waited up to 11.7 s; now the worst wait is the new set's first
  render, 3.2 s. A deploy's own sync goes the same way: a commands answer
  that says `sync` (a deploy waiting) is handed to the render task only with
  the set and settings it asks for, downloaded by the link task with the pull
  (`fos_commands_fetch`); the render task takes them and only then runs the
  answer's commands, since a switch queued behind the push names a scene
  from it, and the link task's next pull reports the new ETags so the
  backend records the deploy (`fos_sync_plan`). Downloaded on the render
  task, a 35-scene, 1.48 MB deploy froze a reTerminal Sticky's screen and
  dropped its taps for 42 s (2026-11-23). A flash write turns the cache off for every erase and page
  program and both cores wait it out, so the store task writes 2 KB at a time
  between renders and never while someone taps (`store_pace`); on an RGB LCD,
  which shows "Updating" for the write, as fast as it goes. A cloud push or an
  upload is split into its per-scene files by the same task, with the same
  pacing, and the render task's apply only reads the new index
  (`store_split_stored`, embedded/esp32/README.md "Scene storage"). A
  nudge to pull the commands (the backend's, a new address, a store action) is
  the link task's pull while it has the round trips (`serve_commands_nudge`,
  `fos_commands_nudge_to_link`), ahead of its logs and picture push; only the
  voice relay's is pulled on the render task
  (`fos_client_request_commands_pull_here`), since its release counts on the
  answer in the very next render, and so is everything on a frame about to
  deep-sleep and on a boot's first pass. When the round trips come back to the render task (a
  deep sleep comes) it waits for the round the link task is in, which runs
  under `s_link_round`, and runs the commands it pulled: they would otherwise
  still be in memory as the chip sleeps (`link_hand_back`). The rules are
  host-tested in `fos_animation.c` (`fos_backend_link_on`,
  `fos_image_push_yields`, `fos_input_hold_applies`, `fos_sync_plan`) and the threading read
  off the source by `test_esp32_backend_link.py`. The picture stream no longer holds the snapshot for the
  whole upload: a snapshot up to 256 KB is copied out, a larger one is read a
  row at a time and a render taking the buffer back ends the stream (it held a
  one-second clock back 1.3-4.3 s). A batch of logs is 32 lines now, not 8: a
  backend on a laptop answers a POST in one to two seconds, and a second's
  renders log about eight lines.
- **The input hold.** The render task drains the touch queue and also does the
  backend pulls, the log uploads and the image push, 200-1000 ms a round trip
  on Wi-Fi, and writes the scene state to flash, up to 3 s, so a tap made during
  one came back late with the ones behind it in one go. On these panels, and on
  any board with a touch screen or keys (the SenseCAP Indicator's LCD held a tap
  2.5 to 3.5 s behind a settings pull, the E1003 the scene switcher's close 2.8
  s), a touch, a key or an event from HTTP, the cloud or the console (a remote,
  the editor, Home Assistant) holds all of that back until ten
  seconds without input, a minute at the most (`fos_input_hold_*` in
  `fos_animation.c`), and the idle wait then runs it once, a round trip at a
  time, giving way to the next tap. A backend's command nudge is still served
  at once, and a frame about to deep sleep runs what it held first. The full
  refresh that clears a deep tile's ghosts waits the same way (twice as deep
  at the most, "The ghosts, counted where they are" above), and the frame
  does it from the idle wait 30 seconds after the last update, only if the
  glass is due one.
- **The dither.** On the sixteen-grey panels there is no error to carry:
  `grayLevel16Ordered` is a 4x4 Bayer matrix, so a pixel's level depends on
  that pixel alone and a small change is a small change on the wire. It is
  integer arithmetic, applied as a 4-bit canvas stores each pixel: the pack
  that took 167 ms over 2.6 Mpx on both cores is a copy now,
  where double-precision Floyd-Steinberg, which an S3 does in software, took 49
  s. The 1-bit panels are another matter: Floyd-Steinberg carries its error across the picture, so
  packing a whole frame after a small change rewrites the dither of every grey
  below it, and all of those pixels would move on the glass.
  `utils/panel_damage.nim` compares the gray canvas with a copy of how it was
  last packed, and dithers only the runs of pixels that changed, per row and
  from no error at their edge, over the packed picture from before. Everything
  else stays as it was, bit for bit. Runs and not boxes: a crosshair that
  moved is two full-height lines. The comparison is of the canvas and not of
  what the renderer reports, because a scene is more than its SVGs and the
  copy cannot miss a writer. A whole frame (a new scene, more than half the
  canvas changed) goes through the same integer runs, one a row
  (`packCanvas1bpp`), so a switch and the taps after it put down the same
  pixels: the float pass it replaced took 1.6 to 2.3 s on the Sticky.
- **The raster.** The canvas is kept between renders, so on these panels it
  takes the same SVG damage records as an LCD's buffer
  (`beginKeptCanvasFrame`, `utils/svg_frames.nim`).

Around them, a frame a touch asked for does its picture first, as on an LCD:
the backend's pulls and the log flushes wait until it is up, three and more
round trips that used to run in front of the first pixel. Measured on the
reTerminal Sticky (Touch test in the Windows 98 layout, 2026-11-09): about
0.2 s from the press to the render starting, 90 ms render, 30 to 80 ms pack,
500 ms on the panel; 0.85 to 0.95 s in all, down from 2.6 s and more.

## Measuring

- The render line's bracket with `set debug 1` (`frameos/render_probe.nim`):
  the phases of that render, pixie's fills by kind (`fill`, `fillMask`,
  `stroke`, `strokeMask`, and `paint` for a gradient or an image through a
  shape), and, on the frame an animation logs in full, the average of the
  quiet frames since the last one: `| quiet 234: scene 33.2 native 2.1 ...`
  in ms a frame. Read that one for an animation: the logged frame builds its
  log lines and is a third slower than the frames between.
- `set debug 1` on the console logs a profile line per node per render (not
  for an animation's quiet frames: the logger is off for those, and building
  the lines for nobody was most of the scene program's own cost per frame on
  a host), and puts the per-phase split on the render line
  (`frameos/render_probe.nim`). `scene` less `app` is a pass's own cost;
  `native` says how much of it is the Nim the scene program calls (fields,
  state, the image hints, a Nim app's run) rather than the program's JS.
- `lcd` prints the scan-out's health (frames, drops, late refills, the worst
  refill) and `lcd pclk <MHz>` retunes the pixel clock live.
- Whether the bounce buffers are in step is visible from the CPU: the LCD's
  GDMA channel (`peri_sel` 5) names the descriptor in flight, and the frame
  buffer chunk each bounce buffer holds says whether the idle one is ahead of
  it or behind. Sampled through a refill, a healthy scan-out is ~63% "idle
  one ahead" (the refill's copy is the rest); one stuck a buffer ahead is
  the reverse. That probe found the restart bug above; it is not in the tree.
- `render:animation` lines carry the frame rate while a scene animates.
- A per-phase probe like the ones behind the tables above is a dozen lines of
  `getMonoTime` around the phases (`ensureReady`, the `get()` call and
  `toValue` in app_runtime.nim, the parse and the raster in svg_frames.nim),
  printed every twentieth frame; it is not in the tree, because its own
  console line costs a frame ~20 ms of UART.
- Sampling core 1's PC from core 0 through the S3's Assist Debug registers
  (`ASSIST_DEBUG_CORE_1_RCD_PDEBUGPC_REG`) looks like a free profiler and is
  not one to trust: on this workload a quarter of the samples landed in
  QuickJS's compiler, which a hardware breakpoint on core 1
  (`esp_cpu_set_breakpoint` from a task pinned there) showed never runs once
  the scene is up. A breakpoint that does fire panics with a full backtrace,
  which makes it the honest way to ask "is this called every frame, and from
  where".
