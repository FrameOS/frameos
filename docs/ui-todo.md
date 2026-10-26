# FrameOS UI — JSX widgets that render and react on the frame

*Written 2026-08-31, rewritten 2026-10-25 when the static half shipped. Read
cold: each section says what exists before what is missing. When an item
ships, delete it. Repo-wide odds and ends live in `docs/todo.md`; this file
carries only the widget-UI work.*

The goal: a JS app returns a JSX tree — boxes, text, images, buttons — and the
frame turns it into pixels *and into behavior*: elements hit-testable by touch,
clickable by GPIO/keyboard focus, re-rendered when a handler changes state.
The pixels part exists (`docs/jsx-ui.md`); the behavior part does not.

This is not an e-paper-only feature. FrameOS renders to HDMI framebuffers,
HyperPixel LCDs, the SenseCAP Indicator's glass and the browser (wasm
preview), where "react to events" means interactive latency, not a 20-second
refresh. The same tree must feel live on an LCD and merely current on
Spectra 6.

## What already exists (build on it, don't rebuild it)

- **JSX UIs that render and answer the pointer** (`docs/jsx-ui.md`):
  `onClick` and friends, `hover:` / `active:` / `group-hover:`, hit-tested in
  the interpreter's event path on every host (`ui/events.nim`). `get()` returns JSX; the prelude
  calls function components on the spot; `js_runtime/jsx.nim` reads the tree
  off the JS objects into pixie's `SvgNode`s; `ui/layout.nim` lays a
  non-`<svg>` tree out (block, flex, grid, absolute; Tailwind classes read by
  `ui/tailwind.nim`; text through pixie's typesetter) and emits the SVG that
  draws it. Drawing, the damage repaint on LCDs and the background waiver are
  the SVG path's (`utils/svg_frames.nim`).
- **Events flow end to end.** `frameos/input_state.nim` turns evdev and the
  preview's pointer into `pointer*` / `key*` events with gestures (`tap`,
  `longPress`, `swipe`; `docs/events.md` "Input"), gpioButton and the ESP32's
  `fos_buttons.c` emit `gpio` edges (the dispatcher makes `button` presses out
  of them), the SenseCAP's FT6336U and the reTerminals' GT911 queue pointer
  events on the ESP32, and `RunnerThread.dispatchSceneEvent` routes any of
  them into the active scene.
- **Partial-refresh scaffolding.** `driver_render_hint.nim` passes timing
  hints host↔driver; waveshare has `renderImagePartial` and per-panel
  `supportsPartialRefresh` (mostly `false` today).

## Standing decisions

- **No LVGL** (measured 2026-08-31: +112 KB flash trimmed to the bone, a
  second rasterizer and visual language). The whole JSX UI layer cost
  +37.3 KB (2026-10-26).
- **Tailwind classes, not style objects** (Marius, 2026-10-25: "tailwind
  inspired ... className='flex ... p-2' ... this seems the tightest"). One way
  to style; a class the reader does not know is ignored, as in a browser.
- **A UI is an SVG.** The layout's output is pixie SVG nodes, so there is one
  rasterizer, one damage model and one background rule.
- **Immediate-mode render, retained hit-test.** `get()` returns the whole
  tree every pass; the *layout result* (rects + handler ids) is to be
  retained for hit-testing. No vdom, no hooks, no reconciler. State lives in
  scene state; a handler calls `setState`, which schedules a re-render.

## The work

1. **Focus for frames with buttons and no glass.** Handlers and pointer
   classes work (`docs/jsx-ui.md` "Events"); a frame with GPIO buttons only
   needs a focus ring and prev/next/activate from `button` events, with a
   `focus:` variant, so the same UI is usable there.
2. **The fast loop.** Event → pixels well under 100 ms on interactive
   displays: a render that skips the scheduler, and dirty rects between
   consecutive frames (the ESP32 LCD already repaints only pixie's damage box
   when the UI's first paint is an opaque full-size background). Budget the
   pass on a Pi Zero W and on the SenseCAP.
3. **E-paper partial refresh.** The same dirty rects into
   `renderImagePartial` for panels that can; flip `supportsPartialRefresh`
   per verified panel. Spectra 6 stays full-refresh.
4. **Layout gaps** (`docs/jsx-ui.md` "Not supported"): clipping
   (`overflow-hidden`, a picture in a `rounded-full` box), `z-*`, shadows on
   LCDs, inline boxes with a background inside a line of text, min-content
   sizing for flex items. Each is flash on an ESP32: measure before merging
   (the firmware-size comment on the PR).
5. **Emit typed elements instead of attribute strings.** The layout builds
   SVG nodes with string attributes that pixie parses again; a builder that
   appends pixie's elements directly would cut ~2 KB of flash and the
   per-frame string work of a UI. Worth it once a UI animates.
6. **On the device:** DVD Logo Bounce from JSX on the SenseCAP against the
   markup version's 50 ms frame (the parse was ~10 ms of it), and a UI
   dashboard's frame time.
7. **Preview + editor.** Focus simulation for GPIO frames in the device
   picker; scene-store lint rules for JSX (`scene-lint.ts`); a "New UI app
   (JSX)" template in `repo/apps/image/`; the AI evals against the scene
   guide's JSX section.
8. **Dogfood: the status screen.** `buildStatusScreen` (both copies) and the
   provisioning screens are hand-drawn: port one to JSX once handlers exist.
   If the layer can't express our own status screen, users will hit the same
   walls.

## Caveats to document, not paper over

- E-paper latency is physics: on Spectra 6 a "button press" answers in ~20 s.
  The interaction model that fits e-paper is focus + a few buttons and
  coarse state changes, not scrubbing a slider.
- No scrolling on e-paper (a list pages); real scrolling only with the fast
  loop on touch/LCD.
- Text input waits on a keyboard story.
- The browser preview renders our layout, not Chrome's: parity between the
  wasm preview and the device matters more than parity with browsers.
