# Real-time rendering — what is still open

*Written 2026-10-25. The model and the measurements are in
`docs/realtime-rendering.md`; read that first. When an item ships, delete it.*

The yardstick is DVD Logo Bounce at 24 fps (41.7 ms a frame) on the SenseCAP
Indicator. Animation mode, the in-place LCD canvas, the luma canvas and the
owed background brought it from one frame per 300 s (and ~570 ms when forced)
to ~290 ms a frame (3.3 fps), back to back. Roughly in order of what each
buys there:

1. **Keep an animating scene's JS runtime alive.** ~170 ms of the 290 is
   building QuickJS, compiling the 6.4 KB prelude and the app, and tearing it
   all down again, every frame (`single_scene_host.nim` releases idle runtimes
   after every embedded render). Keeping the resident scene's runtimes while
   it animates costs ~150–225 KB of PSRAM held, and module variables would then
   survive renders on an ESP32 for those scenes — a documented rule today
   (AGENTS.md "Retiring a built-in Nim app"), so the preview must follow the
   same rule. Measured with a throwaway patch that kept them through the
   quiet frames (2026-10-25): **7.8 fps, ~115 ms a quiet frame**, 5.1 MB of
   PSRAM still free, the scan-out still clean. Independently, shipping the prelude as QuickJS bytecode in flash
   (~12.7 KB) would take most of its 100 ms off every cold start on every
   board, e-paper included. Owner's call before either.
2. **The SVG path.** Parse 28 ms (the logo's path data is the same every
   frame: memoize parsed `d` strings), the JSON round trip of the returned
   spec 12 ms (read `svg`/`width`/`height` straight off the JS object), the
   raster 57 ms, most of it the full-screen rect on the 565 canvas — a fill
   at bus speed (two pixels per store, or a DMA fill from internal RAM) and
   `-O2` for pixie's span loops.
3. **Damage tracking.** The logo changes ~6% of the screen per frame. Track
   the rectangles a frame changed; on a solid background repaint only those;
   with two frame buffers, bring the back buffer up to date with the union of
   the last two frames' rectangles. This is what makes 24 fps comfortable and
   it is the substrate of the UI layer (`docs/ui-todo.md`).
4. **A retained compositor** for the UI layer: elements with bounds, a moved
   or changed element repaints its old and new box, a tap hit-tests the
   retained list and redraws one element into a `view()` of the canvas. The
   DVD logo would be a sprite moved by the compositor: a few milliseconds a
   frame, the panel's refresh the limit.
5. **The board's settings,** each needing a bench run with `lcd`: a 13.63 MHz
   pixel clock (48 Hz, so 24 fps is exactly two scans; 12 MHz is 42.3 Hz and
   judders), QIO flash, a 32 KB instruction cache and a 64 KB data cache with
   64-byte lines (internal RAM is tight), httpd/WebSocket/tcpip/touch pinned
   to core 0, `-O2` for QuickJS against the OTA slot's ~190 KB of headroom.
   120 MHz octal PSRAM is experimental in ESP-IDF and temperature-sensitive:
   not for the fleet image.
6. **Touch latency.** The FT6336U is polled every 30 ms (no interrupt line on
   the Indicator) and events reach the scene between frames: poll at 10–15 ms
   on LCD boards and let a touch cut the frame wait short.
7. **Photos waive the background too.** A JPEG decoded straight into the
   canvas with cover or stretch covers every pixel opaquely; the decode path
   could settle the owed background the way the SVG path does
   (`takeDecodeTarget` with `deferBackground`).
8. **The Pi.** The framebuffer driver converts into a staging buffer and
   `write()`s it, opening and closing `/dev/fb0` every frame: convert straight
   into an mmapped framebuffer (a full-frame copy and a syscall less), with
   the rotation fused into that pass (a scalar `rotateDegrees` per frame on a
   rotated HyperPixel 4.0 today), keep the canvas between frames, push to the
   driver on its own thread, and wake on input instead of polling at
   200/100 ms. Needs a bench Pi with a HyperPixel and an HDMI panel.
