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

What is left is the JavaScript lifecycle: the runtime is built, the prelude
and the module compiled, and all of it torn down again on every render
(`single_scene_host.nim` `releaseIdleJsAppRuntimes`), about 170 ms of the
290. Keeping the runtime through an animation's quiet frames (a throwaway
patch, measured the same day) took the scene to 7.8 fps, ~115 ms a frame.
That and the SVG path (parse, return trip, raster: ~100 ms) are the next
steps in `docs/realtime-todo.md`.

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
  next 19.2 KB chunk into the 32 KB data cache.
- **Code fetches share the bus.** Every instruction-cache miss is a DIO flash
  read on the same bus PSRAM uses, and a 3.2 MB firmware with QuickJS in it
  misses a 16 KB cache often.

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
  the power decision, the Nim settings pushes, the metrics sample.
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
buffer nobody scans (after the switch to the previous frame has happened),
`frameos_nim_render_panel` makes it the canvas (`panelCanvas` in
`embedded_runtime.nim`, pixie's `newImage565Over` with `ditherStores`, the
rounding the pack used to do), and the blit is a buffer switch — no pack, no
copy, no SHA. The switch is asked for at once and waited for by the next
writer (`settle_front` in `lcd_st7701s_rgb.c`), so a render longer than a
frame never waits for the panel. A rotated panel still packs, into the same
buffer.

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

### The Pi

The interpreter's savings above are the Pi's too. The Linux path's own
per-frame costs are elsewhere (measured on a laptop, scaled for a Pi Zero 2
W): a fresh canvas each frame (an mmap and its page faults), a full copy for
`setLastImage`, a scalar `rotateDegrees` every frame on a rotated HyperPixel
4.0 (natively portrait), and the framebuffer driver converting the whole
frame into a staging buffer, `write()`ing it to `/dev/fb0` and closing the
device, with no vsync. The conversion itself cannot go away while pixie draws
RGBX and a 32 bpp framebuffer wants BGRX (and on a 16 bpp one a 565 canvas
would trade NEON blending for scalar 565 code); the staging copy and the
rotation pass can. `docs/realtime-todo.md` has them.

## Measuring

- `set debug 1` on the console logs a profile line per node per render.
- `lcd` prints the scan-out's health (frames, drops, late refills, the worst
  refill) and `lcd pclk <MHz>` retunes the pixel clock live.
- `render:animation` lines carry the frame rate while a scene animates.
- A per-phase probe like the one behind the table above is a dozen lines of
  `getMonoTime` around `ensureReady` (app_runtime.nim) and
  `renderSvgIntoTarget`; it is not in the tree, because its own console line
  costs a frame ~20 ms of UART.
