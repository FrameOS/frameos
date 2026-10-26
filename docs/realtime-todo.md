# Real-time rendering — what is still open

*Written 2026-10-25. The model and the measurements are in
`docs/realtime-rendering.md`; read that first. When an item ships, delete it.*

The yardstick is DVD Logo Bounce at 24 fps (41.7 ms a frame) on the SenseCAP
Indicator. It runs at ~50 ms a frame (19.6 fps) now: animation mode, the
in-place LCD canvas with three buffers, the owed background, JS interpreters
kept between frames, damage repaints of a whole-frame SVG, QIO flash and the
SVG path work. Roughly in order of what each would buy there:

1. **The LCD refill off the CPU.** The RGB driver's bounce-buffer interrupt
   copies 19.2 KB of the front buffer out of PSRAM every 0.9 ms on the render
   core (`memcpy` was ~12% of core 1 in a PC sample, and halving the pixel
   clock took a frame from 62 to 55 ms). A GDMA memory-to-memory transfer
   would do the copy: `esp_async_memcpy` cannot (it allocates descriptors on
   every call, so not from the interrupt), so it means `no_fb` mode with the
   driver's `on_bounce_empty` callback, our own three frame buffers, and a
   descriptor chain built once and restarted from the callback, with the
   frame buffer written back from the cache before it is handed over. Moving
   the interrupt to core 0 was measured: no faster, and 60 late refills.
2. **The SVG parse, ~10 ms.** An app that returns its SVG as JSX skips the
   markup (`docs/jsx-ui.md`): pixie reads the node tree the JSX makes, 4 µs
   where the DVD frame's markup took 18 µs on a laptop. Not measured on the
   board yet; the store scene still builds markup. What is left of the parse
   is each element's attributes read from strings; for an app that rebuilds
   the same document with new numbers each frame, re-reading only the
   attributes that changed would take most of it.
3. **A retained compositor** for the UI layer (`docs/ui-todo.md`): elements
   with bounds, a moved or changed element repaints its old and new box, a
   tap hit-tests the retained list and redraws one element into a `view()` of
   the canvas. The DVD logo would be a sprite moved by the compositor (a
   coverage mask rasterized once per subpixel phase) instead of six paths
   rasterized again into its box, ~20 ms today: a few milliseconds a frame,
   the panel's refresh the limit. The damage repaint
   (`utils/svg_frames.nim`) is its first half.
4. **QuickJS.** `get()` is ~5 ms; QuickJS frees an arena of a size class the
   moment its last block goes and builds a new 4 KB one on the next
   allocation (`js_malloc_new_arena`, hit every frame from property
   creation): keeping one empty arena per class is a patch to the vendored
   quickts tarball. `-O2` for `quickjs.c` costs flash the OTA slot may not
   have (measure). Shipping the prelude as bytecode in flash (~12.7 KB) would
   take most of its ~100 ms off every cold start on every board, e-paper
   included.
5. **The allocator.** ~560 allocations and frees a frame at ~6 and ~3.4 µs on
   the PSRAM heap, ~5 ms. A free list per size class in front of
   `heap_caps_malloc` was measured (2026-10-25) and bought nothing
   measurable: it served ~430 small blocks a frame, and the time sat in the
   rest — ~85 blocks of 0.25–4 KB and ~75 reallocs at ~17 µs each. Fewer and
   smaller allocations on the per-frame path (item 2) are the lever.
6. **The board's settings,** each needing a bench run with `lcd`: a 13.63 MHz
   pixel clock (48 Hz, 24 fps exactly two scans) against the refill load it
   adds; httpd/WebSocket/tcpip/touch pinned to core 0. A 32 KB instruction
   cache gives nothing over QIO and costs 16 KB of internal RAM; 120 MHz octal
   PSRAM is experimental in ESP-IDF and temperature-sensitive: not for the
   fleet image.
7. **Touch latency.** The FT6336U is polled every 30 ms (no interrupt line on
   the Indicator) and events reach the scene between frames: poll at 10–15 ms
   on LCD boards and let a touch cut the frame wait short. A Touch test frame
   is ~65 ms now (bursts, `render/svg`'s damage repaint), and the damage is
   a box per change since 2026-10-26 (pixie's `damageRects`); the SVG parse
   (~22 ms) still lays its three text lines out again every frame, where
   unchanged text could keep its layout as a JSX UI's does.
8. **Photos waive the background too.** A JPEG decoded straight into the
   canvas with cover or stretch covers every pixel opaquely; the decode path
   could settle the owed background the way the SVG path does
   (`takeDecodeTarget` with `deferBackground`).
9. **A slideshow's photo change.** Ken Burns (data/localImage under
   render/zoomPan) freezes for the decode every time its photo changes:
   3.7 s for a 640x640 baseline JPEG and 6.3 s for a progressive one on the
   Indicator at 240 MHz (2026-10-25), next to ~130 ms frames. The file read
   is a small part (the flash store serves ~140 KB/s over HTTP) and `-O2` for
   pixie's JPEG module bought ~10% for 9 KB: profile the decode (coefficient
   and channel planes in PSRAM; a progressive photo also decodes in strips,
   ~20 passes at the memory a cached photo leaves), then consider decoding
   straight to 565 or across several frames.
10. **Full-frame motion is memory-bound.** zoomPan's draw is ~90 ms on the
   Indicator (from 2.3 s), on both cores with 64-byte cache lines: every
   frame reads the photo and writes the 460 KB back buffer through the PSRAM
   cache while the LCD scans the front one, and the second core bought 1.3x,
   not 2x. 24 fps for a frame that changes every pixel needs a faster bus
   (120 MHz PSRAM, above) or a draw that touches less memory.
11. **The Pi.** The framebuffer driver converts into a staging buffer and
   `write()`s it, opening and closing `/dev/fb0` every frame: convert straight
   into an mmapped framebuffer (a full-frame copy and a syscall less), with
   the rotation fused into that pass (a scalar `rotateDegrees` per frame on a
   rotated HyperPixel 4.0 today), keep the canvas between frames, push to the
   driver on its own thread, and wake on input instead of polling at
   200/100 ms. Needs a bench Pi with a HyperPixel and an HDMI panel.
12. **A tap's frame after the render.** A JSX home panel's toggle renders in
    ~180 ms in place, and `render:done` comes ~90 ms later: about 30 ms
    between `render:framebuffer`, `render:device` and `render:done` each,
    the picture on the glass in the middle. Find where it goes (the
    snapshot, the stage lines on a 115200-baud console with a 2 KB TX
    buffer) and move what can go after the picture.
13. **What a JSX render still pays whole.** Per toggle of the home panel:
    `get()` ~17 ms, the walk ~9, the layout's build ~10 and flex ~12, the
    emit ~12, pixie's parse ~13 and the damage ~8–14. The parse and the emit
    could keep the elements of boxes that did not move as text keeps its
    nodes now, and the walk could skip a subtree whose JS objects are the
    ones of the last render.
