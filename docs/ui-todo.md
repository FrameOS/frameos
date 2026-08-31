# FrameOS UI — JSX widgets that render and react on the frame

*Written 2026-08-31. Read cold: each section says what exists before what is
missing. When an item ships, delete it. Repo-wide odds and ends live in
`docs/todo.md`; this file carries only the widget-UI work.*

The goal: a JS app returns a JSX tree — boxes, text, images, buttons — and the
frame turns it into pixels *and into behavior*: elements hit-testable by touch,
clickable by GPIO/keyboard focus, re-rendered when a handler changes state.
Today JSX is print-only: apps use it to build SVG strings. Nothing consumes a
JSX tree as *UI*.

This is not an e-paper-only feature. FrameOS renders to HDMI framebuffers,
HyperPixel LCDs and the browser (wasm preview) where "react to events" means
interactive latency, not a 20-second refresh. The same tree must feel live on
an LCD and merely current on Spectra 6.

## What already exists (build on it, don't rebuild it)

- **JSX lowering.** The native transpiler lowers `.tsx`/`.jsx` to
  `__frameosJsx(type, props, ...children)` (`js_runtime/transpiler.nim`,
  helpers installed in `js_runtime/runtime.nim`). The helper returns plain
  `{type, props}` objects. Lowercase tags arrive as strings, capitalized tags
  as identifiers — **user function components come free** once a walker calls
  `type(props)`.
- **Events flow end to end.** evdev emits `mouseMove`/`mouseDown`/`mouseUp`/
  `keyDown`/`keyUp` (`drivers/evdev/evdev.nim`), gpioButton and the ESP32's
  `fos_buttons.c` emit `button` with a label, and
  `RunnerThread.dispatchSceneEvent` (`frameos/runner.nim`) routes any of them
  into the active scene.
- **One rasterizer: pixie.** Text at any size from one TTF, the strict SVG
  subset, gradient LUT kernels, the per-board canvas (RGBX or RGB565).
- **Partial-refresh scaffolding.** `driver_render_hint.nim` passes timing
  hints host↔driver; waveshare has `renderImagePartial` and per-panel
  `supportsPartialRefresh` (mostly `false` today).
- **The wasm preview** runs interpreted scenes in the browser — the natural
  place for instant UI iteration once clicks pass through.

## Standing decisions

- **No LVGL.** Measured 2026-08-31 (LVGL 9.5, esp32-s3, IDF 5.5.4, `-Os`,
  FrameOS' size flags): +112 KB flash trimmed to the bone, +234 KB with stock
  component defaults, +405 KB with widgets + two bitmap font sizes — against
  ~191 KB free in the 8 MB OTA slot. Its default theme links every enabled
  widget whether used or not; its allocator is a 64 KB *static* DRAM pool; its
  fonts are per-size bitmaps (montserrat_48 alone is 97 KB) next to our
  render-any-size TTF. It would be a second rasterizer with a second visual
  language, plus a QuickJS↔`lv_obj` binding and reconciler we would maintain
  forever. Revisit only if FrameOS targets 30 fps touch products on 16/32 MB
  boards.
- **Immediate-mode render, retained hit-test.** `render()` returns the whole
  tree every pass; layout/paint run in Nim; the *layout result* (flat list of
  rects + handler ids) is retained for hit-testing and dirty-rect diffing.
  No vdom, no hooks, no effects, no reconciler. State lives in scene state;
  a handler calls `setState`, which schedules a re-render. This deletes 80%
  of what makes UI toolkits expensive, and e-paper's cadence hides the cost
  of full re-layout.
- **As close to HTML/JSX as honesty allows.** Lowercase HTML names
  (`<div>`, `<span>`, `<img>`, `<button>`), `style` props with CSS names and
  units, `onClick`. But a *subset*, documented as such: flexbox only, no
  cascade/classes/selectors, no floats, no CSS files. Where HTML semantics
  are ambiguous on a frame, pick one meaning and write it down rather than
  approximating the browser.

## The vocabulary (target)

Elements: `div` (flex container), `span`/`text` (inline text), `img`
(asset/URL/imageRef through the existing cache), `svg` (leaf, strict
renderer — the graphics escape hatch), `button` (focusable + `onClick`),
fragment. Later: `input` (needs a keyboard story), `list` (windowed).

Style props (CSS names, camelCased, on a `style` object — React style):

- **Box:** `width`/`height` (px, `%`), `flexDirection`, `flexGrow`,
  `flexShrink`, `flexBasis`, `flexWrap`, `gap`, `padding*`, `margin*`,
  `alignItems`, `justifyContent`, `alignSelf`, `position: absolute` +
  `top/right/bottom/left`, `overflow: hidden`, `aspectRatio`.
- **Paint:** `backgroundColor`, `backgroundImage` (linear/radial gradient —
  reuse the LUT kernels), `border` / `borderWidth`/`borderColor` per side,
  `borderRadius` per corner, `opacity`. Shadows LCD-only if ever; they
  dither badly.
- **Text:** `color`, `fontSize`, `fontFamily` (asset fonts + bundled),
  `fontWeight`, `lineHeight`, `letterSpacing`, `textAlign`, `maxLines` +
  ellipsis.
- **Shorthands:** parse the small CSS string forms people type without
  thinking — `padding: "8px 16px"`, `border: "2px solid #333"`,
  `background: "linear-gradient(...)"` — and nothing more (no `calc()`,
  no `em`, no variables).

Handlers: `onClick` (touch tap / mouse / select-button on the focused
element), `onFocus`/`onBlur`, `onKeyDown` at the root. GPIO buttons map to
focus movement + activate by default; a scene can still consume raw `button`
events itself.

## The work

1. **Layout engine (Nim).** Flexbox subset over the element tree; text
   measurement through pixie's typesetter (wrapping, `maxLines`). Output: a
   flat display list — `(rect, paint spec, nodeId, handlerIds, focusable)`.
   Property-test it against browser flexbox on a fixture corpus so "subset"
   means *same answers on what we support*, not "similar". This is the
   riskiest item; everything else is wiring.
2. **Painter.** Display list → pixie calls on the existing per-board canvas:
   rounded-rect fills/strokes per corner, gradients, `overflow: hidden`
   clipping, text runs, `img` through the image cache, `svg` leaves through
   the strict renderer. Must respect the memory-aware rendering budgets and
   the ESP32 565 canvas.
3. **Tree walker + static `frameos.ui(tree)`.** Walk `{type, props}` (calling
   function components), validate, hand to layout+paint, return a
   `frameos.image`. Ships as a data app output wired into `render/image` —
   useful on every frame on day one, zero event risk, and the vehicle for
   iterating on 1–2. Also the moment to write `docs/ui.md`: the vocabulary,
   the HTML deltas, examples.
4. **Handlers + hit-testing + focus.** Per-render handler table in the scene's
   QuickJS context (`__frameosJsx` registers function props, tree carries
   ids); hit-test the retained display list on `mouseDown`/touch before
   `dispatchSceneEvent`; focus ring + prev/next/activate from `button`
   events for GPIO-only frames. Handler runs → `setState` → re-render.
   Stale-context safety: scene JS contexts are evicted under memory pressure
   (`runtime.nim` evict path) — a handler id that no longer resolves must
   drop the event and force a fresh render, never crash.
5. **The fast loop.** Interactive displays (framebuffer, HyperPixel, wasm)
   need event → pixels well under 100 ms: an on-demand render path that
   skips the scheduler (re-render *now*, not at next interval), dirty-rect
   diffing of consecutive display lists so a toggled button repaints its own
   rect, and double-buffering on the framebuffer driver. Budget the whole
   pass (walk + layout + paint + blit) on a Pi Zero W — if a full-screen
   re-layout misses the budget there, dirty-rect *layout* (subtree
   re-layout) is the fallback, not a faster language.
6. **E-paper partial refresh.** Wire the same dirty rects into
   `renderImagePartial` for panels that can (mono/gray fast panels first);
   flip `supportsPartialRefresh` per verified panel; keep the
   partials-before-full bookkeeping honest. Spectra 6 stays full-refresh —
   the model still works, it just refreshes at panel speed.
7. **Preview + editor.** Pass clicks/taps/keys from the wasm preview into the
   scene (browser events → `dispatchSceneEvent` shim); focus simulation for
   GPIO frames in the device picker; scene-store lint rules for the new
   vocabulary (`ai-scene.ts` and the field-type checklists apply).
8. **ESP32.** Same Nim layout/painter compiles in; measure flash cost before
   merging (firmware-size CI catches it), keep the handler table inside the
   existing per-scene QuickJS budget, and accept full-frame renders only —
   no dirty rects on SPI panels driven over strips. Buttons-as-focus is the
   input story; there is no touch.
9. **Dogfood: the status screen.** `buildStatusScreen` (both copies) and the
   provisioning screens are hand-drawn today — port one to the widget layer
   once 1–3 land. If the layer can't express our own status screen, users
   will hit the same walls; better we hit them first.

## Caveats to document, not paper over

- E-paper latency is physics: on Spectra 6 a "button press" answers in ~20 s.
  The interaction model that fits e-paper is focus + a few buttons and
  coarse state changes, not scrubbing a slider. Say so in `docs/ui.md`.
- No scrolling on e-paper (a `list` pages); real scrolling only with the
  fast loop on touch/LCD.
- No animations/transitions initially, anywhere. If ever: fast loop only.
- Text input waits on a keyboard story (evdev keyboards exist; on-screen
  keyboard is its own project).
- The browser preview will render our flexbox subset, not Chrome's — pixel
  parity between wasm preview and device matters more than parity with
  browsers.

## Open questions

- One vocabulary or two dialects: accept *only* the HTML-ish names, or also
  keep RN-style `<view>`/`<text>` aliases? (Lean: HTML names only, one way
  to write everything.)
- Where does a UI app live in the scene graph — a new `render/ui` node, or
  data-app-returns-image plus an `interactive: true` flag? Interacts with
  the render/data app split (render apps in the prev/next chain currently
  draw nothing from scene-local JS apps).
- Focus model for multi-button boards: per-scene explicit `focusOrder`, or
  document order with `tabIndex`-style overrides?
- Does `setState` from a handler re-render just the UI node or run the full
  scene graph? Full graph is simpler and correct; measure whether it is fast
  enough on the fast loop before optimizing.
