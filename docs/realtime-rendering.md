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
  the driver restarts the DMA at the next vertical blank. Not with
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
  `render:done`, the cloud's render announce, the backend's image push — with
  a `render:animation` summary of the frames before it (`frames`, `fps`,
  `avgMs`, `maxMs`, `periodMs`). The frames in between are quiet: no render
  lines, no scene log lines (`frameos_nim_set_quiet`, the logger off, like
  the Linux runner's fast-render log pause). The first frame of an animation
  always logs in full: it is the `render:done` a deploy waits for
  (`docs/deploy-progress.md`). A frame that fails logs at once.
- The render task blocks for one tick a second, so the idle task on its core
  runs while a frame slower than the panel never waits.

Every line the firmware logs is also printed on UART0 at 115200 baud
(11.5 KB/s, a 2 KB transmit buffer): the ~2.2 KB of lines a fully logged pass
prints cap a loop at about 5 fps on their own. That is why the quiet frames
matter, not only for the logs' readers.

### The panel's buffer is the canvas (an RGB565 LCD)

An RGB565 LCD's scene canvas is 565 whatever the PSRAM, and it is the panel's
own back frame buffer: `fos_display_render_target` hands the render task the
buffer neither scanned nor waiting to be,
`frameos_nim_render_panel` makes it the canvas (`panelCanvas` in
`embedded_runtime.nim`, pixie's `newImage565Over` with `ditherStores`, the
rounding the pack used to do), and the blit is a buffer switch — no pack, no
copy, no SHA, and with three buffers (below) no wait for the panel either. A
rotated panel still packs, into the same buffer.

The snapshot behind `/image`, `image_get` and the backend push is the front
buffer itself, dropped before it is drawn in again; a stream copies it out
under the lock and lets go, so a slow socket never holds a frame back. The
local network access code and the voice notice are drawn into the buffer the
panel shows next, after a clean copy went to the snapshot (`docs/lan-access.md`:
the code never leaves the device in an image).

### One byte per pixel on grey and black-and-white panels

A greyscale or black-and-white panel renders in pixie's 8-bit luma surface
(`pfGray8`) whatever the PSRAM, not only when RGBX does not fit: blending is
per channel, so the luma of a composite is the composite of the lumas, and
every pass over the canvas — a fill, a blend, the dither — moves a quarter of
the bytes. The rule, in every copy (C, Nim, the backend, both device-limits
ports, `docs/device-limits-fixtures.json`): luma for a grey panel, 565 for an
RGB565 LCD, and for a colour e-paper panel RGBX while two of it fit PSRAM,
565 beyond.

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

The store's Ken Burns slideshow is data/localImage, cached per cycle, under
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

## Measuring

- `set debug 1` on the console logs a profile line per node per render.
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
