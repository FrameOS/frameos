# JSX in JS apps: SVG without markup, and UIs with Tailwind classes

*Written 2026-10-25. The open work is in `docs/ui-todo.md`.*

A JS app whose main file is `.tsx` (or `.jsx`) can return JSX from `get()`
where it would return an image:

```tsx
export function get(app) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 bg-slate-900 text-white">
      <span className="text-7xl font-bold">{new Date().toTimeString().slice(0, 5)}</span>
      <span className="text-xl text-slate-400">{app.config.city}</span>
    </div>
  )
}
```

Two kinds of tree come back:

- **An `<svg>`** is drawn as it is, with the subset of SVG pixie draws
  (`docs/js-apps-and-code-nodes.md` "SVG"), exactly as the same markup
  through `frameos.svg(...)` would draw it — pixel for pixel
  (`js_runtime/tests/test_jsx_ui.nim`).
- **Anything else is a UI**: boxes, text, images and SVG icons laid out with
  a subset of CSS and styled with Tailwind class names. It is laid out at the
  size of the image the node draws (the cell, or the frame) and turned into
  the SVG that draws it.

`<image width={..} height={..} color={..} />` keeps its old meaning: the plain
canvas spec `frameos.image(...)` makes.

## How it works

The prelude's JSX factory (`__frameosJsx`, `js_runtime/runtime.nim`) makes
plain `{type, props}` objects and calls a function component on the spot, so
what `get()` returns is a tree of elements. The runtime reads that tree
straight off the JS objects (`js_runtime/jsx.nim`) into the node tree pixie
draws from (`SvgNode`, FrameOS/pixie): no markup is built in JS and none is
parsed in Nim. A UI goes through the layout (`ui/layout.nim`, with
`ui/tailwind.nim` reading the classes), which hands back another node tree,
an SVG one. From there both take the road a `frameos.svg` spec takes: into
the target the planner offered when there is one (no second image), the
owed background waived by an opaque full-size first rect, and on an LCD only
what changed repainted ([Repainting what changed](#repainting-what-changed)).

Text is set with pixie's typesetter and drawn as its outlines, pictures go
in as `<image>` elements that carry the decoded image, and boxes are rects
and paths. A UI is therefore exactly as fast to draw as the SVG it becomes,
and the engine itself is only the layout.

What it saves, measured on DVD Logo Bounce (a full-screen SVG every frame)
on a laptop: the frame took 104 µs from markup and 64 µs from JSX, the
markup's reading and parsing gone; the pictures are identical. pixie reads
the DVD frame's markup in 18 µs and the same drawing from nodes in 4 µs. On
the SenseCAP Indicator the parse was ~10 ms of a 50 ms frame
(`docs/realtime-rendering.md`); the device number for JSX is still to be
measured.

## Repainting what changed

Each render builds the whole tree again, as React does; what keeps a tap
cheap is that the pictures are reconciled, not the code:

- **Text that did not change is not set again.** The layout keeps, per UI
  (its `UiMemo`, on the UI's target in `ui/events.nim`), what the last
  layout set in type: the arrangement of each text by its runs, style,
  width and alignment, and the glyph nodes it emitted at a place. Text that
  comes back the same is not typeset again, and it is handed to pixie as
  the very same nodes, so pixie compares it by identity. What a layout did
  not use is let go. Each glyph is drawn from pixie's glyph cache ("Text and
  fonts"). A text node keeps two arrangements, for the last two widths it
  was set in (measured in the room its container offers, then set in the
  width it took), each with its memo entry: a label that did not change is
  not looked up by key at all, which was ~200 lookups and 10 ms of a
  Calculator tap on a SenseCAP Indicator.
- **Damage is a few boxes, matched in order.** On an LCD whose canvas is
  the panel's own buffer, `utils/svg_frames.nim` keeps the parsed SVG each
  buffer holds and compares the next with it (pixie's `damageRects`): the
  two element lists are matched in order, identical with identical, like a
  keyed list, so an element added or removed (a check mark ticked) is
  damage where it is and the rest still match. The damage is up to six
  boxes, joined where they meet. A box that scrolled (more than eight of
  one viewport's elements differ) is damage whole, its viewport one box,
  and the rest of what is in it is passed over without a look: matching a
  page's thousand moved glyphs one by one was up to 390 ms of a scrolled
  frame on the SenseCAP against 20 ms of raster (the Browser sample,
  2026-11-24).
- **A box draws only what can touch it.** Each box is repainted alone, and
  pixie skips every element whose bounds miss it: a card's box costs that
  card's paths, not the other cards' flattening and strokes.
- **A subtree that did not change goes through every stage as the same
  objects.** The layout keeps its last tree (on the UI's `UiMemo`), and an
  element whose node at the same place is the same, or equal, and that the
  pointer left as it was takes back its laid-out node: no classes read, its
  size from the layout cache (four calls kept per node, since a flex item is
  measured, then placed, and an item of a row in a column is asked three
  questions a layout; its children are placed again for its final call
  before it is drawn), and, where its place, size and opacity did not
  change, the very SVG nodes it emitted. pixie keeps the parse of a node it
  is handed again (`parseSvg`'s `reuse`), and damageRects knows those
  elements without comparing them. Gradient ids and handler numbers are part
  of what must match.
- **`memo(Component)`**, as React's (in C, `js_runtime/jsx_native.nim`; the
  prelude's JavaScript one in `js_runtime/runtime.nim` is the reference):
  a component called with props shallow-equal to its last call at the same
  place (its turn among the render's calls, or its `key`) returns the element
  it made then, the same object. The walker gave that element a number
  (`__frameosNode`) and takes its nodes back without reading it, its
  handler functions copied into the render's list at the numbers they had.
  Pass values, not functions made anew each render, and make the handlers
  inside the component. A call costs about 0.25 ms on the SenseCAP Indicator,
  hit or miss (the JavaScript one was 1.1 ms), and an element made inline
  about 0.1: memo() pays off around a component of a few elements or more.
- **The pointer alone does not run get().** A render asked for only because
  hover:, active: or group-hover: changed (no handler ran) lays the last
  tree out again with the new pointer, as a browser restyles `:hover`
  without React rendering. Any other event, a different config or the
  scene's own interval coming round runs `get()` as before.

On the SenseCAP Indicator (three frame buffers, so each is compared with
the frame from three renders back), toggling one card of the home panel in
`e2e/scenes/jsxSquareHome.json` repaints that card and the count above it:

| One card toggled | Before | Now |
| --- | --- | --- |
| Pixels repainted | 93,522 (the box from the count to the card) | 28,564 (the card, the count) |
| Raster | ~790 ms | 68–97 ms |
| The JS app's node (get, layout, parse, damage, raster) | ~900 ms | 135–167 ms |
| Render, tap to `render:done` | ~1,040 ms | ~300 ms |

The other square fixtures, the same way (`render:done`, steady): a to-do
row ticked 493 → 219 ms, a calculator key 328 → ~200 ms, the counter's +
363 → 226 ms. A frame into a buffer that holds a different scene is drawn
whole, as before.

## Signals (experimental)

*2026.11.14+. In the scene guide and `appTypeDeclarations.ts` since the
store's tap-driven samples moved to it (2026-11-22).*

A tap normally runs `get()` again: the whole tree is made and read, and
`memo()` hands back what did not change. A `signal` lets a handler say what
changed instead:

```tsx
const on = devices.map(() => signal(false))
const Tile = memo(({ i }) => {
  const lit = on[i].value                    // reading it subscribes this Tile
  return <div className={lit ? 'bg-amber-300' : 'bg-white/10'}
    onClick={() => { on[i].value = !lit }} />
})
export const get = () => <div className="grid grid-cols-2">{devices.map((_, i) => <Tile i={i} />)}</div>
```

- `signal(v)` (a prelude global) holds a value: `.value` reads and sets it,
  `.peek()` reads without subscribing. A `memo()`'d component that reads
  `.value` while it runs is subscribed to it; a read anywhere else
  subscribes nothing.
- **A handler that set signals and nothing else** asks for a partial render:
  the components that read them run again alone, with the props they had,
  and their elements are spliced into the tree the walker read last
  (`jsx.nim` `jsxSplice`: the nodes from the root down to each copied,
  everything else the same objects). `get()` does not run, and nothing
  that did not change is walked; the layout, the damage and the raster
  are as for any render. A `memo()`'d call that reads a signal gets a
  record (the C `memo()`'s, `js_runtime/jsx_native.nim`), made at the first
  read, so an app with no signals makes none and pays nothing: a set marks
  it dirty, the next call or the partial render runs it, and the
  `memo()`'d components around it run at the next whole render (what they
  made holds the old element).
- **Anything else is a whole `get()`**, as before: a handler that set no
  signal, a different config, the scene's own interval, a render from
  outside. So the rule an app keeps: a handler that sets a signal changes
  nothing else that `get()` reads (a module variable it changes there shows
  at the next whole render). A component whose handlers change in number
  when it runs again, or a dirty one never drawn, is a whole `get()` too.
- **A list wants a signal per item**, as above: one `selected` signal that
  every cell compares with makes every cell run when it is set.

On the SenseCAP Indicator a tap in a grid of a hundred `memo()`'d cells is
a 28 ms `get()` and an 87 ms render; with a signal per cell the partial
render's JavaScript is 3 to 12 ms (`docs/perf-todo.md`; how much depends
on where the image's code landed in the 16 KB instruction cache,
`docs/esp32-memory.md`).

## What it costs

Flash on the generic ESP32-S3 image, measured against the build before it
(2026-10-26): **+37.3 KB**, 321 KB left in the 3520 KB OTA slot. The layout
and its SVG output are 19.9 KB (`ui/layout.nim`), the class reader with the
palette 10.1 KB (`ui/tailwind.nim`), pixie's node input and `<image>` 2.9 KB,
the JSX reader and its glue 3.6 KB. Both modules read classes and indexes in
place, without copies and with Nim's run-time checks off, because the
straightforward versions were twice the size; what would shrink it further
is dropping a feature (gradients ~1.5 KB, icons ~2 KB, truncation ~1.3 KB).
Nothing is allocated for a scene that returns no JSX.

Fields, the keyboard on the screen, scrolling and clipping added +18.8 KB
(2026-10-29, against main built at the same paths): the layout's part
5.8 KB, pixie's nested viewport 2.6 KB, the events 2.4 KB, the keyboard's
tree 2.4 KB and its strings 1.5 KB, and 2.4 KB of link drift (the
interpreter's `runNode`, the same object code, with fewer of its calls
relaxed to short ones once more code sits between it and its callees).
What kept it there: `UiRegion` holds plain values only (a field's text is
`fieldText`, read off the last layout's tree), `events.nim` runs without
checks and raises nothing, a viewport's transform is written out in pixie,
and the ESP32 build leaves out the key and wheel events it never gets.

Select boxes added about +2.9 KB (2026-11-04): the layout 2.7 KB, the events
0.3 KB, and the settings panel, whose chips they replaced, 0.1 KB less. A
closed select is laid out as a box with two children, and its list is an
ordinary tree of classes built on the fly, as the keyboard is; a scene that
shows no select pays only the code.

## Elements

| Element | What it is |
|---|---|
| `svg` | A drawing. At the root, the whole image; inside a UI, a leaf whose `viewBox` is fitted into its box (centered, whole; `preserveAspectRatio="none"` stretches), sized by its classes, else its `width`/`height`, else its viewBox. `currentColor` in it is the text color. |
| `img` | A picture: `src` is what `frameos.fetchImage` (its result, or its `image`), `frameos.loadAssetImage`, `frameos.canvas` or `frameos.video` (the frame due now, decoded at the `<img>`'s size: docs/video.md) returned, or a URL, which the runtime fetches at the size the `<img>` is laid out at (give it one: `w-[…] h-[…]`), off the render where it can, and draws nothing until it is in (`docs/async-js.md`). `object-cover` / `object-contain` / `object-fill` (the default, as in CSS). One size given, the other follows the picture's aspect. |
| `span`, `b`, `strong`, `i`, `em`, `u`, `s`, `small`, `a`, `code`, `label`, `mark` | Inline: in a block they flow with the text around them and only their text classes count (color, size, weight, ...). In a flex or grid container they are items, like any element. An `<a href>` opens its link on a tap ([Links](#links)). |
| `br` | A line break. |
| `input`, `textarea` | A field to type into ([Fields and the keyboard](#fields-and-the-keyboard)). |
| `select`, `option` | A select box ([Select boxes](#select-boxes)). |
| `Scene`, `yield` | Another scene, as a picture ([Scenes inside a UI](#scenes-inside-a-ui)). |
| anything else | A box: `div`, `p`, `h1`, `section`, `layout`, ... No tag has a default style (Tailwind's preflight). |

Text is any string or number child; `null`, `undefined`, `true` and `false`
draw nothing, and arrays (`items.map(...)`) and fragments are flattened, as
in React. Function props starting with `on` are handlers ([Events](#events)).

**White space works as in React.** A space inside a line is kept, so
`{count} items` draws "42 items" and `March <b>12</b>` "March 12". White
space that touches a line break is dropped, so indenting children adds
nothing, and white space alone between two items of a flex or grid
container is no item, as in CSS.

`e2e/scenes/jsx*.json` are fifteen interfaces built this way (a dashboard,
an agenda, a month, a departure board, a photo card, a forecast, a status
board, an energy chart, a front page, a word clock, a recipe, a player,
the DVD frame), snapshotted by CI like every scene fixture. The
`jsxSquare*` ones are made for a 480x480 touch screen (the SenseCAP
Indicator), each snapshotted after the taps its `e2eEvents` make: a home
panel's switches, a calculator, a to-do list, a player, tabs, a color
picker, a counter, a forecast's days, a settings form with "Oslo" typed on
the keyboard on the screen, and an analog clock, a word clock and the DVD
frame with their `at` field pinning the time.

In an `<svg>`, React's camelCase attribute names are read as SVG's
(`strokeWidth` is `stroke-width`), except SVG's own camelCase ones
(`viewBox`, `gradientUnits`, `gradientTransform`, `preserveAspectRatio`);
`style={{ fill: "red" }}` becomes a style attribute; `<image href={ref}>`
takes an image ref like `img`.

### Scenes inside a UI

`<Scene id="clock" city="Oslo" />` draws another scene of the frame where the
element lands; its other props are that scene's state (`count={3}` stays a
number). `<yield />` is where a layout's content goes (`docs/scene-layouts.md`).
Both are holes in the canvas the scene draws straight into, not pictures, unless
something asks them to be one (opacity, something painted over it, a box that
scrolls around it). With no size of its own it takes the room left (`flex-1`),
so in a block give it a height.

It runs on its own `refreshInterval`: a pass that finds it not due leaves its
pixels alone and the scene does not run (`docs/scene-rhythm.md`), and the frame's
next wake comes forward to when it is due. When only it is due the UI around it
sits out. A tap on it is the scene's, in its own coordinates, unless the UI drew
something over it there that listens for that event (a menu, a window on top, a
pane that takes a press): then it is that element's, and a press it took is its
own to the end, its tap included. What the UI drew under it hears nothing
there. One drawn as a
picture counts against the same budget as a panel's copy (a quarter of free
render memory, at most 1 MiB on an ESP32); a device that cannot keep it runs the
scene again each render. An LCD repaints what the scene changed.

A scene cannot hold itself, and nesting stops eight deep. A `<Scene>` inside a
root `<svg>` draws nothing: it needs the layout to know its size.

### Photos that stay

`frameos.fetchImage`'s image lasts one render: the runtime lets it go when
`get()` returns. A UI that shows a photo across renders (a tap on a button
beside it, a hover, the scene's own interval) would download and decode it
again each time. It keeps it instead:

```tsx
let photo = null // the ref, while this interpreter lives
export function get(app) {
  if (!photo) {
    photo = frameos.fetchImage(url, { keep: true, width: 480, height: 480 }).image
  }
  return <img className="w-full h-full object-cover" src={photo} />
}
// Another photo: frameos.releaseImage(photo); photo = null
```

- **`keep: true`** stores the picture with the app's interpreter. Its ref
  stays valid in later renders until `frameos.releaseImage(ref)` (true once,
  for a kept picture) or until the interpreter goes. An app keeps 8 at most,
  and a ninth lets the oldest go, unless they are small: past eight it keeps
  pictures while they hold no more pixels than eight 480x480 photos, up to
  48 of them (the Scene store's grid of covers, the Files sample's
  thumbnails). `frameos.loadAssetImage(path, { keep: true, width, height })`
  keeps a picture of the assets folder the same way, decoded at that size.
- **`width` / `height`** (and `fit`, `cover` by default or `contain`) are the
  size it is decoded at, in the canvas's pixel format: an ESP32 holds a
  480x480 photo in 450 KB of RGB565, and drawing it is a copy. A host decodes
  at the picture's own size.
- **Only with room for it** (`keptPictureTarget` in `app_runtime.nim`): short
  of memory the app's older kept pictures go first (their refs then draw
  nothing, and the app fetches again), then the photo is decoded at its own
  resolution when that is less than the size asked and more than half of it
  (smaller, it would be more than twice blown up on the panel); with no
  room at all `fetchImage` answers an `error` and no `image`. The size the
  photo has comes from the start of the download (`downloadImageWithDataSizedBy`),
  so the gallery's random photo is the one decoded. On a reTerminal E1003
  (8 MB, 1872x1404) a kept full-window photo is 1.09 MB; an unchecked one
  next to two others aborted the render and restarted the firmware.
- **A kept picture is never the consumer's target.** A UI draws the canvas
  whole and the photo is one of its elements, so the photo decodes into an
  image of its own.
- **Its memory is the interpreter's.** An ESP32 that releases the interpreter
  (a decode short of memory, a sleeping frame; `docs/js-apps-and-code-nodes.md`)
  releases the pictures with it, and module variables are new in the next
  interpreter. So the ref belongs in a module variable, never in
  `frameos.remember`, and a missing one means fetch again.
- **Keep what is on screen**, and perhaps the one before. Every kept 480x480
  photo is 450 KB of PSRAM that the next decode does not have.
  - An ESP32 keeps an interpreter that holds pictures while 1 MB of headroom
    is left, after a decode too: letting it go would only decode them again.
  - An interpreter without pictures needs 2 MB after a decode
    (`utils/memory.nim`).

### A picture at another size

An `<img>` drawn larger or smaller than its picture (any picture: a kept one,
a fetch of the render's own, a canvas) is stretched into its box by
`drawResampled` (pixie `images.nim`, from `drawSvgImage` in `svg.nim`) when
the layout only scales and moves it, which is all a layout does. Fixed point:
a table of source pixels and weights per axis, each source row resampled
across once, and the opacity in the weights. Larger than the picture it is
bilinear with the edge pixels held, smaller every target pixel is the average
of the source it covers, and a target pixel is drawn when its centre is in
the box. Nothing the size of the picture is allocated: the general draw (for a
turned or mirrored picture, and `image-rendering="pixelated"`) doubles or
halves the whole picture into a copy to scale it more than twice, copies it
again for an opacity, and samples each pixel through floats (11 µs a pixel on
an ESP32-S3, 40 s for a reTerminal E1003's 1848x1179 window). On a laptop a
2400x1600 photo into that window went from 45 to 12 ms, and a 3x enlargement
from 42 to 4 ms.

### Canvases

A picture the app draws into, kept between renders, for a paint page or a
chart that grows a point at a time:

```tsx
let canvas = null
export function get(app) {
  canvas = frameos.canvas('paint', 448, 276, '#f1f5f9')
  if (canvas.fresh) replay(canvas) // made just now: draw the record into it again
  return (
    <div onPointerMove={(e) => e.buttons && frameos.draw(canvas, <line x1={last.x} y1={last.y}
      x2={e.localX} y2={e.localY} stroke="#0f172a" strokeWidth={6} strokeLinecap="round" />)}>
      <img className="w-[448px] h-[276px]" src={canvas} />
    </div>
  )
}
```

- **`frameos.canvas(key, width, height, color)`** is the app's canvas called
  `key`. It is made and filled with `color` (white by default) the first
  time, or again when the size changes, and it is the same picture every
  render while the interpreter lives. An app has 4 at most; a fifth key lets
  the oldest go.
- **`fresh` is true the render it was made.** A canvas goes with its
  interpreter, as kept photos do (an ESP32 short of memory, a new scene), so
  keep what was drawn as a compact record in `frameos.remember` and draw it
  into a fresh canvas. Only then, never every render.
- **Undo starts from a second canvas.** Drawing a full record again takes
  seconds on an ESP32 (~6 s for 3,000 points of 18 px strokes on the SenseCAP
  Indicator). Keep all but the last few strokes in another canvas too, and
  undo by drawing it back, `<image href={base} x={0} y={0} width={w}
  height={h} preserveAspectRatio="none" />` (its rows copied), then the
  strokes it does not hold.
- **`frameos.draw(canvas, content)`** draws SVG over what is there: JSX
  (`<line>`, `<circle>`, `<path>`, `<polyline>`, `<rect>`, `<g>`, or an
  `<svg viewBox>` for other units) or SVG markup, in the canvas's pixels.
  Only the box the drawing touches is painted. `frameos.clear(canvas, color)`
  fills it. Both work in handlers too, the way a drag paints.
- **A frame repaints what was drawn**, not the canvas and not the rest of the
  UI.
  - Each draw is noted with its box (`utils/canvas_log.nim`), and each frame
    an LCD buffer holds knows which version of the canvas it showed.
  - The next render into that buffer repaints the boxes drawn since, where
    the `<img>` puts them (`utils/svg_frames.nim`). With three buffers, that
    is every box since each one's own frame.
  - A canvas drawn into more often than its log keeps (48 draws) is
    repainted whole.
  - pixie's `damageRects` cannot see the change itself: the element and its
    picture are the same objects.
  - A stroke's box is its path grown by how far the stroke reaches: half the
    width for round or bevel joins, round or butt caps and a single line,
    and up to the miter limit for a miter join. Draw strokes with
    `strokeLinejoin="round"` and `strokeLinecap="round"`.
  - A box inside the picture draws the picture alone (a 565 canvas has no
    alpha, so nothing under it shows), its rows copied as they are.
  - On the SenseCAP Indicator a finger drawing repaints ~4K pixels a frame
    in ~4 ms, ~50 ms a frame in all, and that stays flat after hundreds of
    strokes.
- **It is in the canvas's pixel format**, as kept photos are: on an ESP32,
  RGB565 (a 448x276 canvas is 242 KB), and drawn 1:1 by `<img>` at its own
  size.
- **`imageRendering="pixelated"`** on an `<image>` draws a scaled RGB565
  canvas as its nearest pixels: blocky, with no copy and a few ms a frame on
  an ESP32 (2026.11.5+), where a smooth scale takes ~600 ms at 480x480. For a
  picture that follows fingers and is drawn again when they lift, as the Map
  scene's pinch is.
- **Trails are a canvas never cleared.** The Solitaire sample's win cascade
  (`cascade.ts`, Windows solitaire's) draws each frame's few new copies of a
  falling card over the last ones: the trails cost the canvas, the screen's
  size, however long it runs, and a frame repaints only the copies' box. Its
  record is the seed and the step, and a fresh canvas gets the steps so far
  in at most 120 copies. A list of SVG elements that grows each frame would
  be parsed whole every render instead.

## Layout

A subset of CSS, with Tailwind's preflight: every box is a border-box (`w-24
p-2` is 96 px including the padding) and has no margins, padding or borders
of its own.

- **The root fills the image** unless its own classes size it.
- **Block** (the default): children stacked top to bottom, each as wide as
  the box unless it has a width (`mx-auto` centers one that does); text and
  inline elements flow into lines.
- **`flex`**: a row (`flex-col`: a column) with `grow`, `shrink`, `basis`,
  `flex-1` / `flex-auto` / `flex-none`, `flex-wrap`, `gap`, `justify-*`,
  `items-*`, `self-*` and `auto` margins. As in a browser, an item does
  not shrink below its content (CSS's automatic minimum, `min-height: auto`
  / `min-width: auto`): in a column its content's height, in a row its
  longest word; one with a set size not below that size. A column or row
  too small for its items overflows instead (a scroller scrolls to it), and
  a title never ends up over the paragraph under it. `min-h-0` / `min-w-0`
  (or any `min-*`), or an item that clips (`overflow-hidden`,
  `overflow-y-auto`, and `truncate` / `line-clamp-*`), may shrink to fit
  as before, and so may a set size given a `min-*` (`h-64 min-h-0`); a
  picture (`<img>`, `<svg>`) and a box holding a `<Scene>` or `<yield />`
  (they take the room they get) always may, and a scroller lays its
  children out at their own heights anyway. `flex-1` items share the room from their
  content up: one holding more keeps it and the others share the rest.
  Unlike a browser, what clips inside an item counts for nothing in the
  item's minimum: a `truncate` name in a `flex-1` box cuts at the box's
  edge without the box's `min-w-0`.
- **`grid grid-cols-N`**: equal columns, items in order, `col-span-N`; each
  row as tall as its tallest item (a grid is laid out as a wrapping row whose
  items are as wide as the columns they span).
- **`absolute`**: placed against its parent's padding box with `inset-*`,
  `top-*`, `right-*`, `bottom-*`, `left-*` (every box is a containing block,
  so `relative` changes nothing), drawn after the in-flow children.
- `gap-*` and `space-x/y-*` space the children of any container.
- **`overflow-hidden`** clips what does not fit at the padding box;
  **`overflow-y-auto`** (`-scroll`, `-x-`, `overflow-auto`) also scrolls it
  ([Scrolling](#scrolling-and-clipping)). A box that scrolls lays its
  children out at their own heights: nothing shrinks to fit it.
- Lengths: Tailwind's 4 px scale (`p-2` = 8 px), `px`, fractions (`w-1/2`),
  `full`, `screen`, `auto`, and brackets: `w-[37px]`, `[2rem]`, `[50%]`,
  `[10vw]` / `[10vh]` (of the image).

## Scale

A frame has a **render scale** (`frameos/src/frameos/render_scale.nim`): a
.tsx or .jsx app on a frame at scale 2 is told its canvas is half the
panel's width and height, lays its UI out at that size, and what it returns
is drawn at the panel's full size. pixie stretches the root `<svg width
height>` (or `viewBox`) to the target as vectors, so it stays sharp. A scene
made for an 800x480 screen fills a 1600x960 one with the same layout instead
of sitting small in whitespace, and an app that fetches for its size (the
Map scene's lines) fetches a quarter of the data. It is the one setting that
makes every scene larger or smaller, so every scene's text comes out about
the same size on a frame (the reTerminal E1003, 2026-11-27: its scene list
and most JSX scenes were half the size of its settings page and of the
Handwriting notes, which grew themselves, while the setting moved only some).

- **Which scale.** A field with `role: "renderScale"` whose state holds a
  number, else the scene's `settings.renderScale`, else the frame's
  (frame.json `renderScale`, the control planes' `render_scale`). The
  frame's 0 is automatic, a whole number, by the panel's **density**: its
  pixels per inch over 130 (the 7" to 7.5" 800x480 panels scenes are made
  on, 124 to 133 ppi) to the nearest whole number, never below 1, and never
  leaving a layout under 576 px on the shorter edge (480 and a fifth: a
  smaller screen is seen closer, and a scene has to fit). The panel's size
  comes from its driver's name (`EPD_10in3` is 10.3") or a short table of
  those whose name does not say it (`NamedPanelInches`), handed over by an
  ESP32's display (`fos_display_name`) and by a plane rendering for a board
  (`frameos_wasm_set_frame` `panel`); a panel of unknown size is 1. HDMI (the
  `framebuffer` device), a screen of unknown size seen from across a room, is
  the largest whole number that leaves 1080 px, and no panel (`web_only`) is
  1. So the reTerminal E1003 (10.3", 1872x1404, 227 ppi) and a 4K screen are
  2; a 13.3" 1200x1600 e-paper (150 ppi), every 800x480 panel and a 1080p
  screen 1. `docs/render-scale-fixtures.json` pins the runtime's rule and the
  SPA's. **Whole numbers only**: at 2 a one-pixel line is two, every box edge
  lands on a pixel and pixie fills in solid spans; at 1.25 or 1.75 every edge
  is antialiased (slower, and soft) and a hairline is a pixel and a grey,
  dithered on e-paper. A fraction stays the owner's to set.
  A scale below 1 (0.25, 0.5 and 0.75 are offered) works the other way: the
  layout gets more room than the panel has and everything is drawn smaller.
  Out-of-range values (above 4) are ignored.
- **What follows it.** A .tsx/.jsx app's UI (above); the built-in scenes,
  laid out at it between 0.75 and a 320 px layout and sized for a 480 px
  panel (sceneSwitcher's `uiRoom` / `panelUnit`, docs/scene-settings.md "At
  the frame's scale"); and the pixel sizes of three Nim apps:
  render/text's font size, padding, border and offsets (rich text's own
  sizes too: `TextRenderOptions.scale`), a render/split's gaps and margins,
  and data/qr's pixels (`nodeRenderScale`). The Pi's own pages (the boot
  guard, the setup hotspot) and the runner's overlays keep sizing
  themselves by `apps.panelScale`.
- **A UI does not grow by itself.** Text, buttons and lists are sized in
  pixels for about 480 px of the shorter side and may shrink below that; a
  zoom of the scene's own that grows with the canvas fights the setting (the
  samples' desktops, Terminal, Browser, Files, Books, PDF viewer, Fonts, the
  Scene store, the Home Assistant and Homey remotes, the Handwriting notes,
  Sketchbook and Pixel art each had one, up to 2.25x, until 2026-11-27). A
  picture meant to fill the canvas (a clock face, a poster, a board game)
  may size itself to it: it fills the panel at any scale.
- **What a scaled app sees.** `context.imageWidth` / `imageHeight`,
  `targetWidth` / `targetHeight` and `app.frame.width` / `height`, divided by
  the scale and rounded. Every app, scaled or not, reads the scale as
  `app.frame.scale`. A plain .js or .ts app keeps the panel's pixels: one
  that fetches a photo for its size wants every one of them.
- **Raster stays raster.** Pixels the app hands over are drawn stretched
  (soft): an image spec or `frameos.canvas` made at the app's size, or an
  image returned instead of JSX. Drawing into `context.image` with
  `frameos.draw` is in the canvas's own pixels; multiply by
  `app.frame.scale`.
- **The pointer** is divided by the scale before it meets the UI's regions,
  so handlers get `localX` / `width` in the UI's own pixels.
- **Repainting** an LCD's damage still works: pixie measures each element's
  box through its transform, the root's stretch included.
- The browser preview renders at the frame's size, so the automatic scale
  matches the frame's; a frame's own setting reaches it through
  `frameos_wasm_set_render_scale`.

## Classes

- **Display and flex**: `block`, `flex`, `inline-flex`, `grid`, `hidden`,
  `flex-row`, `flex-col`, `flex-wrap`, `flex-nowrap`, `flex-1`, `flex-auto`,
  `flex-initial`, `flex-none`, `grow`, `grow-0`, `shrink`, `shrink-0`,
  `basis-*`, `items-{start,center,end,stretch}`,
  `self-{auto,start,center,end,stretch}`,
  `justify-{start,center,end,between,around,evenly}`, `gap-*`, `gap-x-*`,
  `gap-y-*`, `space-x-*`, `space-y-*`, `grid-cols-N`, `col-span-N`,
  `col-span-full`.
- **Size and space**: `w-*`, `h-*`, `size-*`, `min-w-*`, `min-h-*`,
  `max-w-*` (also `xs` .. `7xl`), `max-h-*`, `p-*`, `px-*`, `py-*`, `pt-*`,
  `pr-*`, `pb-*`, `pl-*`, `m-*` (also `auto` and negative: `-mt-2`),
  `mx-*`, `my-*`, `mt-*`, `mr-*`, `mb-*`, `ml-*`, `aspect-square`,
  `aspect-video`.
- **Position**: `absolute`, `relative`, `inset-*`, `inset-x-*`, `inset-y-*`,
  `top-*`, `right-*`, `bottom-*`, `left-*` (negatives too).
- **Colour**: `bg-*`, `text-*`, `border-*` with Tailwind's palette
  (`slate` .. `rose`, `50` .. `950`), `black`, `white`, `transparent`, an
  opacity (`bg-black/50`) and any CSS color in brackets (`bg-[#123456]`,
  `text-[tomato]`). Gradients: `bg-gradient-to-{t,tr,r,br,b,bl,l,tl}` with
  `from-*`, `via-*`, `to-*`. `opacity-*` multiplies into everything inside.
- **Borders and corners**: `border`, `border-{0,2,4,8}`, `border-[3px]`,
  per side (`border-b`, `border-t-2`, `border-x`), `rounded`,
  `rounded-{none,sm,md,lg,xl,2xl,3xl,full}`, `rounded-[12px]`, per side and
  corner (`rounded-t-lg`, `rounded-bl-xl`).
- **Text**: `text-{xs,sm,base,lg,xl,2xl..9xl}` (each with its line height),
  `text-[24px]`, `font-{thin..black}`, `font-sans`, `font-serif`,
  `font-mono`, `font-[Family_Name]`, `italic`, `underline`, `line-through`,
  `uppercase`, `lowercase`, `capitalize`, `text-{left,center,right}`,
  `leading-{none,tight,snug,normal,relaxed,loose}`, `leading-6`,
  `leading-[1.2]`, `whitespace-nowrap`, `truncate`, `line-clamp-N` (both end
  in an ellipsis).
- **Overflow**: `overflow-{hidden,clip,auto,scroll,visible}` and per axis
  (`overflow-y-auto`, `overflow-x-hidden`).
- **Variants**: `sm:`, `md:`, `lg:`, `xl:`, `2xl:` test the image's width
  (640, 768, 1024, 1280, 1536 px), `portrait:` and `landscape:` its shape;
  `hover:`, `active:` and `group-hover:` the pointer ([Events](#events));
  `focus:` the field that has the keyboard and `placeholder:` a field's
  placeholder text. Every other variant (`dark:`) never applies on a frame.

A class this does not know is ignored, as a browser ignores one Tailwind did
not generate.

## Events

An element can have handlers, as in React, and its classes can follow the
pointer:

```tsx
let count = 0
export const get = () => (
  <div className="flex items-center justify-center bg-slate-900">
    <div className="rounded-xl px-8 py-4 bg-sky-500 hover:bg-sky-400 active:bg-sky-700 text-3xl text-white"
      onClick={() => { count++ }}>
      {`Tapped ${count} times`}
    </div>
  </div>
)
```

- **`onClick`** runs on a `tap` (a press and a release in one place, by
  finger, pen or mouse), and on a slow panel (e-paper) on a `longPress` of
  an element with no `onLongPress` too (no press shows there, so people hold
  until something does; a fast panel keeps a phone's rule), **`onDoubleClick`**
  on a `doubleTap`, **`onLongPress`** on a `longPress`, **`onPointerDown`** / **`onPointerUp`**
  on the raw press and release, **`onPointerMove`** as the pointer moves,
  **`onSwipe`** on a `swipe` (its `direction`, to the element it began on,
  wherever it lifted), **`onPinch`** on a `pinch` (two fingers that moved,
  once, when the first lifts: `scale`, and `startX` / `startY` to `x` / `y`
  between them, to the element under the point between them at the start;
  neither finger is a tap or a swipe then). A swipe in from the screen's edge is the frame's
  (`edgeSwipe`, docs/events.md "Edge swipes"): no element hears any of that
  touch, so a slider at the edge of a page is safe from it. The handler gets the event's payload plus `type`, `localX` and `localY`
  (from the element's corner) and `width` / `height` (the element's size,
  2026.10.22+): `onClick={(e) => ...}`. `e.target` (a copy of the event,
  as React's) is there for a field's edit and a box's scroll only
  (`e.target.value`, `e.target.scrollTop`): a pointer's handler has none
  since 2026.11.14. The innermost element
  with a handler for the event takes it, so a tap on a label inside a card
  runs the card's `onClick`.
- **A press is captured**, as a browser captures a touch: the innermost
  element with an `onPointerDown` or `onPointerMove` under the press gets
  that pointer's `pointerMove`s and its `pointerUp` until it lifts, inside
  its box or not, and no other element hears them (unless it scrolls, or a
  box that scrolls is drawn over it: that box is dragged,
  [Scrolling](#scrolling-and-clipping)). `localX` / `localY` stay
  from its corner, so they go negative or past its width: a slider clamps
  them. `localX / width` is how far along it the finger is, so a slider
  needs no width of its own and works on any frame. A move with no press goes to the element under it,
  as in a browser, with `buttons` 0: a mouse or a pen passing over (a finger is over nothing
  until it presses). `buttons` is the mask of what is held (`1 << button`), so a slider or a
  paint brush that follows the pointer acts only while it is set. A drag renders at
  the frame's render rate, with the newest position (the ESP32 coalesces a
  finger's moves while a render runs); the positions of the moves it stood for
  are in `e.points` (`[x, y, x, y, ...]`, oldest first, from the element's
  corner as `localX` / `localY`; docs/events.md "Pointer"), so a drawing keeps
  every point of a stroke.

  ```tsx
  const setLevel = (e) => { level = Math.max(0, Math.min(100, Math.round((e.localX / e.width) * 100))) }
  <div className="h-8 rounded-full bg-white/10" onPointerDown={setLevel}
    onPointerMove={(e) => { if (e.buttons) setLevel(e) }}>
    <div className={`h-8 w-[${level}%] rounded-full bg-sky-500`} />
  </div>
  ```
- **The frame renders again after a handler**, whatever it did: a handler
  changes what the next `get()` returns (a module variable, `frameos.setState`,
  `frameos.remember`), and the picture follows. A pointer handler
  (`onPointerDown`, `onPointerMove`, `onPointerUp`) that returns `false` asks
  for no render: what it did shows with the next one (2026.11.15+; other
  handlers' `false` is a value like any other). A drawing keeps a stroke's
  points at every move (`e.points` too) and asks for a render at every move,
  on e-paper as well: the frame renders when its glass can take the next
  picture, and the moves that came meanwhile arrive as one with their
  `points`, so each partial update carries all of them (the Sketchbook and
  Handwriting notes samples, their `ink.ts`; `test_smooth_ink_scenes.nim`;
  docs/realtime-rendering.md "A stroke on e-paper").
- **`hover:`** applies while the pointer is over the element, **`active:`**
  while it is pressed on it, **`group-hover:`** while the pointer is over an
  ancestor with the class `group`. A change renders again. A finger that
  lifts is over nothing, so on a touch screen `hover:` lasts for the press.
  On an ESP32 a tap whose press and lift were handled before any render drew
  its `active:` look (both behind a busy render) keeps the look with its
  answer, for 150 ms once a render has drawn it (`pressLinger`), and an
  LCD's touch task shades the element a finger lands on in the picture on
  the glass before any render at all, `active:` class or not, until the
  scene's next picture (docs/realtime-rendering.md "A press shows at once").
- **Renders cost what they cost on the panel.** On an LCD, a HyperPixel or
  the browser preview a click answers at once; on e-paper it answers in a
  refresh, so e-paper draws no `hover:` or `active:` at all (a press asked
  for a refresh of its own, and the tap's render waited behind it:
  `ui/events.nim`). Every handler is a render, so an app
  that follows a finger checks `app.frame.fast` (2026.11.10+, the same in a
  handler, `onEvent` and `get()`; before it, `!app.frame.paper`, where an
  ESP32 said paper on an LCD outside a render) and takes the whole drag as
  one `onSwipe` where it is false, as the Map scene does, and two fingers as one `onPinch`
  (2026.11.10+): a frame rendered on its plane hears a gesture only when the
  fingers are off the glass, so there it is the one way to zoom.
- **Where the events come from**: the dispatcher's pointer events and
  gestures (`docs/events.md` "Input"), on every host: a Pi's touch screen or
  mouse, the touch glass of an ESP32 LCD board (the SenseCAP Indicator, the
  reTerminal Sticky and E1003), the pointer over the browser preview, and
  `POST /event/pointerDown` / `pointerMove` / `pointerUp` (0..32767 across
  the panel).
- **How**: the JSX walker keeps the handler functions of each render in the
  app's interpreter (`__frameosHandlers`) and numbers them in the tree; the
  layout hands back the boxes of the elements with handlers or pointer
  classes (`UiRegion`), placed where the UI lands in the canvas (its cell, or
  the canvas's corner when the UI is the canvas's size; a UI drawn scaled is
  not hit-tested); the interpreter hands its scene's pointer events to them
  (`ui/events.nim`, `runEventInner`) before the scene's event nodes, and the
  scene listens for pointer events while a UI has regions. A handler runs
  in its app with the bridge set up as for `get()`; one that throws is logged.
  An interpreter released since the render (an ESP32 short of memory, a
  sleeping frame) took its handlers with it: the tap draws the UI afresh and
  nothing else happens.

### The mouse cursor

A frame with a mouse draws its cursor (docs/events.md "The cursor"), and an
element says what it looks like over it with Tailwind's `cursor-*` classes:
`cursor-pointer` (a hand), `cursor-text` (an I-beam), `cursor-move`,
`cursor-ew-resize` / `ns-resize` / `nwse-resize` / `nesw-resize` (and
`col-resize`, `row-resize`, the one-sided `e-resize` ... `se-resize` as their
axis), `cursor-grab` / `cursor-grabbing` (the hand), `cursor-default` /
`cursor-auto` (the arrow) and `cursor-none`. One more is FrameOS's own:
`cursor-resize` (or `cursor-resize-[14px]`) on a window's frame that resizes
from its edges: the shape is that of the edge or corner the pointer is
within 12 px (or the given width) of, which is how every desktop's frame
picks the edge a press drags (`cursor_shape.nim` `edgeCursor`).

- The class is the element's own: the topmost element under the pointer
  decides, one with none is the arrow, and a child does not inherit its
  parent's, so a title bar or a scene inside a resizing frame shows its own.
  A `<Scene>` / `<yield />` on top hands the question to the scene in it, in
  its own coordinates, through the layout as a press goes
  (interpreter.nim `cursorShapeAt`, `ui/events.nim` `uiCursorAt`).
- A press an element holds keeps its cursor until it lifts: a window being
  resized shows its arrows wherever the mouse goes.
- An element with a `cursor-*` class and nothing else is a region for the
  cursor alone: it takes no press and asks for no event.
- Not on an ESP32, which has no mouse: the class reads as nothing there.
- In the browser preview (`frameos-wasm`, the scene workspace's "The frame's
  mouse cursor" toggle) the runtime says the shape under the page's pointer
  (`frameos_wasm_cursor`, the worker's `cursor` message): the page shows it
  as its own cursor by CSS name, or hides its own over the canvas and draws
  the frame's picture of it into the canvas (`frameos_wasm_cursor_sprite`,
  `frameos/wasm/src/cursor.ts`), put away before each frame is painted.

## Fields and the keyboard

`<input>` and `<textarea>` are fields to type into, controlled as in React:
the field shows `value`, and every edit calls `onChange` (or `onInput`)
with the text as it would be, as `e.value` and `e.target.value`. Keep it
in a variable and set it there; the frame renders again after the handler,
like after any other.

```tsx
let city = 'Brussels'
export function get(app) {
  return (
    <div className="flex flex-col gap-2 p-4 bg-slate-900 text-white">
      <span className="text-sm text-slate-400">City</span>
      <input className="h-12 px-3 rounded-lg bg-slate-800 text-xl focus:bg-slate-700"
        value={city} placeholder="Where is it?"
        onChange={(e) => { city = e.target.value }}
        onKeyDown={(e) => { if (e.key === 'Enter') frameos.setState('city', city) }} />
    </div>
  )
}
```

- **A tap on a field gives it the keyboard**, the caret where the tap
  landed. A tap anywhere else (a button, the page) takes it away and then
  does what it does; so do Enter in an `<input>` (a `<textarea>` gets a new
  line) and Escape.
- **The frame's `back`** (a swipe in from the left edge, a reTerminal
  Sticky's Action key pressed twice) puts the keyboard away as Escape does, and
  goes no further: the scene, its layout and their apps never hear that
  `back`, so it does not also leave the page or the scene. A key's accents
  or a selection made by touch go first, the keyboard staying; an open
  `<select>`'s list and a link's code go too. Every host, from
  `interpreter.runEvent` (`ui/events.nim` `uiBack`); a built-in scene puts
  its own away.
- **The keyboard is on the screen** when the frame has none of its own: a
  US layout under the UI, which is laid out in what is left and scrolled so
  the field shows. Its pages are letters (shift for one capital, shift
  tapped twice for all of them), `123` and `#+=`; a `type="number"` field
  gets a number pad. Its keys stop growing on a wide panel, and every row is
  then as wide as the page's widest one, the space bar taking what the keys
  beside it leave (not the panel's width). A key is a region of the UI like a button, so it works
  with a finger, a pen or the mouse over the preview, and on e-paper too, a
  refresh a key (it shows no press there). An ESP32 board has no keyboard of
  its own, ever.
- **On a round panel** (the HyperPixel 2.1" Round, `panel_shape.nim`
  `panelIsRound`) a UI that is the whole canvas gets the keyboard higher up,
  its last row four fifths of the way from the circle's centre to its rim,
  each row cut to the chord it sits on (`RoundInset` in from the rim) with
  its keys narrower where the circle is, on no band of its own; the UI is
  laid out above it (`keyboardBox`, `UiInput.round`). Not on an ESP32: no
  board of it is round.
- **Inside a layout** the keyboard is the frame's, not the scene's
  ([The frame's keyboard](#the-frames-keyboard)): on a small screen it takes
  the bottom of the panel and the whole layout, its bars included, is laid
  out above it; on a desktop of windows it is a window of its own over every
  other.
- **The keyboard reaches the screen's edges**, so a press on it is a key and
  never an edge swipe (docs/events.md "Edge swipes"): a finger on its outer
  keys types instead of changing the scene. A key is typed where the finger
  lifts, however it rolled on the way, and a tap between the keys or in the
  keyboard's margin at the very edge is the nearest key, as on a phone.
- **Two thumbs taken for one finger type both keys.** A touch controller
  that tracks one point (the SenseCAP Indicator's FT6336U) glides it from
  one thumb to the other when the second lands before the first lifts, and
  the tap comes only where the second one is. A tap that went down on
  another character 1.5 keys or more to the side, mostly sideways and
  within 250 ms, types that key first (`typeGlided` in `ui/events.nim`). A
  thumb rolling goes up the keys and a finger sliding to choose takes
  longer: both type where they lift.
- **A key just typed stays lit** for a moment (250 ms from the first render
  that shows it) in its pressed color, so a quick tap that the panel never
  showed pressed still says which key it was. Not on e-paper.
- **A key held shows its symbol and accents**, as on a phone: after the dispatcher's
  long press (`gestures.longPressMs`, delivered while the finger is still
  down on every host that ticks: the Pi, the ESP32 awake, the preview) the
  key lights and its accented forms come up in a row of keys above it —
  `a` gives `à á â ä æ ã å ā`, `e` `è é ê ë ē ė ę`, and so on for `c i l n
  o s u y z`, with `$ - " ' . ? ! 0 %` giving `€ £ ¥`, dashes, curly quotes,
  `…`, `¿ ¡ ° ‰` (`ui/keyboard.nim` `Accents`); under shift the letters are
  capitals. Every letter also holds a symbol, after SwiftKey: the digits
  over `q`–`p`, `@ # & * - + = ( )` over `a`–`l`, `_ $ " ' : ; /` over
  `z`–`m` (`ui/keyboard.nim` `Hints`), and the letters page's full stop holds
  `!` and `?`, which that page has no keys for (on the symbols page and the
  number pad `.` holds its `…` alone). The first symbol is drawn small and dim in the
  key's top right corner. It is the first form of the key's row, always right
  over the key and lit, the other forms in order away from it toward the side
  with room: to the right, or for a key in the right half (`o`, `u`) to the
  left, narrower when a long row needs it, so the finger slides through every
  form without reaching the screen's edge. Hold a letter and lift, and its
  symbol is typed. Sliding sideways moves the light
  along the row by how far the finger went (`UiInput.accentFrom`), at any
  height from above the row to a couple of rows below it (no need to go up
  onto the row), and the light follows on e-paper too (a touch e-paper
  draws it in a partial update); a row without a symbol (`$` on the symbols page) is
  centred on its key and lights the form nearest the finger's x. Lifting
  types the lit one. Slid far away from the row, nothing is lit, and lifted
  there the row stays up for a tap on one. Lifted or tapped anywhere else,
  the row goes away and the tap does what it does (a key types); the
  frame's `back` closes the row first and keeps the keyboard.
  The row is centred on the key as far as the screen, or a round panel's
  circle, allows, and goes under the key when there is no room above. Keys
  with neither a symbol nor accents have no hold, but for backspace:
- **Backspace held erases** one character at the long press, then one every
  100 ms, every 50 ms after a dozen, until the finger lifts. On e-paper it
  erases once: a refresh a character is seconds.
- **The space bar dragged moves the caret**, as on a phone: once the finger
  has moved sideways more than a tap's slop (and more sideways than up or
  down: a thumb landing low on the bar and rolling up is typing the letter
  above it), every 0.45 of the bar's height sideways is one character left
  or right, and every bar's height up or down a line in a `<textarea>` (the
  start or the end of an `<input>`), each an arrow key to `onKeyDown`. Its
  release types no space.
- **A real keyboard** (a Pi's, the computer's over the preview) types into
  the field instead: once a key has been typed on one, fields get no
  keyboard on the screen. Left and right, Home, End, Backspace and Delete
  move and erase; Up and Down move a line in a `<textarea>` (keeping the
  column they set out from, to the start or the end off its first or last
  line) and go to the start or the end of an `<input>`.
- **`onKeyDown`** hears every key typed into the field, before it applies:
  `e.key` is the character, or `Enter`, `Backspace`, ... (and the rest of
  the `keyDown` payload from a real keyboard). It cannot stop the key.
- **`type="password"`** shows a dot a character; **`placeholder`** shows
  while the value is empty, in its `placeholder:` classes, else at half the
  text's color.
- **Styles**: a field is a box like any other (no default style), whose
  text is one line (`<input>`, scrolled sideways to keep the caret in sight)
  or wraps (`<textarea>`, scrolled down to it). A `<textarea>` with more
  text than fits scrolls like a box with `overflow-y-auto` ([Scrolling](#scrolling-and-clipping)):
  a finger drags it, a wheel scrolls it, a bar says where in it you are,
  and it keeps its place when it lets go of the keyboard; an edit or a key
  brings the caret back into sight. The caret is the text's
  color. `focus:` classes apply while it has the keyboard.
- **A field without `value`** shows what is typed while it has the keyboard
  and forgets it after: always give it one.
- **A `value` the app changed** (in `onChange`, or anywhere since) is what
  the next edit starts from, as in React. The caret, and a selection, stay
  on their text when what is before them is unchanged, or what is after
  them (lines added above or below, as a code editor's window of lines
  slides: [Scrolling](#scrolling-and-clipping)); otherwise the caret goes to
  the end (a line the Terminal empties on Enter).
- **Colored text**: `<span>`s (and text) inside a field, whose text together
  is its `value`, draw it each in its own classes (`text-*`, `font-*`), as a
  code editor colors its tokens. The caret, the selection and the keyboard
  work on the value as before. Children that do not spell the value (an edit
  the app has not seen yet) are not drawn: the value is, in the field's own
  style.

  ```tsx
  <textarea value={code} onChange={(e) => { code = e.value }}
    className="whitespace-nowrap overflow-x-auto font-[Cascadia_Mono]">
    <span className="text-[#569cd6]">const</span>{' x = '}<span className="text-[#b5cea8]">1</span>
  </textarea>
  ```

- **`whitespace-nowrap` on a `<textarea>`**: its lines are not wrapped, and
  with `overflow-x-auto` a long one scrolls it sideways under a finger or the
  wheel, as the caret does.
- **`frameos.measureText(texts, {className, width})`**: how tall each text is,
  in pixels, set in those classes' font, size and `leading-*` into `width`
  exactly as a `<textarea>` of that width sets it (the same typesetting:
  wrapped at spaces, spaces kept, an empty text one line). An app that lays
  out wrapped rows itself measures them before they are drawn: the Code
  editor's line numbers beside each line's first row, and the height of the
  lines out of sight in a virtualized list (`layout.nim` `measureText`).

How: the field is a region of the UI's layout (`UiRegion.field`), its
text and caret are kept with the UI's input state (`UiInput`: `focus`,
`text`, `caret`), and `ui/events.nim` edits them from a key of the
keyboard (`ui/keyboard.nim`, keys numbered from `KeyBase` like handlers),
`textInput` or `keyDown`, then runs the field's handler. The layout places
the caret from a tap with the text's own glyph boxes, draws it as a bar in
the field's viewport, and lays the keyboard out under the UI as another
tree with Tailwind classes. A key with accents carries an `on-long-press`
handler of its own number; the hold sets `UiInput.accents` to the key, the
layout draws the row from where it placed that key (`accentPopup`, its
forms handlers from `AccentBase`), and the holding pointer's moves and
release are the row's until it lifts (`UiTarget.holdPointer`, the finger's
x in `UiInput.accentX`, the lit form in `accentLit`). What happens with
time — a typed key's light going out (`UiInput.flash`), backspace held —
is the dispatcher's tick asking `uiTimerDue` and sending the scene showing
`uiTimer` (docs/events-contract.json: the runtime's own, `internal`, no
scene listens for it), which `dispatchUiEvent` turns into the next erase or
a render. A host that ticks only while input is held (the preview) also
ticks while `uiTimersPending`; the Pi's message loop wakes every 20 ms then.

### The frame's keyboard

A field of the scene a layout wraps (docs/scene-layouts.md), or of the layout
itself (a launcher's search), types on a keyboard the frame draws, not one
inside the scene's `<yield />`:

- **On a small screen** (a layout that is no desktop) it is docked: as tall
  as the panel's keyboard would be, across the whole width at the bottom, and
  the layout is laid out in what it leaves above it, so its bars move up or
  shrink with the scene and the focused field is scrolled into sight there. A
  layout that returns a bare `<yield />` while `app.frame.typing` is true
  gives the scene all of it (docs/scene-layouts.md, "While a scene types").
  The layout has the whole panel again when the field lets go.
- **On a desktop** (a layout with scenes open in windows,
  docs/scene-layouts.md "Windows") it is a window of its own over every other
  window and the desktop's bars, at the bottom of the desktop (at its top
  when that would cover the field), with a bar to drag it by; it stays where
  it was dragged. Its keys type into the field of the window in front: a tap
  on it never reaches the layout or a window under it, so nothing comes
  forward, nothing moves and the field keeps the keyboard. It comes up when
  a field there gets the keyboard on the screen (none once a key was typed on
  a real keyboard) and goes when no field has it, or when another window comes
  forward: a window behind keeps its field's caret and draws no keyboard of its
  own, and has the frame's again when it comes back to the front.
- **Everything else is the keyboard's as before**: its look (the layout's
  theme), a held key's accents (drawn over the layout), the space bar dragged,
  backspace held, e-paper's look. A press on it is never an edge swipe, and a
  board its plane renders hands it the press map with the keyboard taken.

How: the interpreter places it before the layout's pass (`placeKeys`,
`ui/layout.nim` `KeyboardDock`, `frameKeyboard`), in the frame canvas's
pixels, and docked gives the layout a view of the canvas above it. The
field's UI lays the keyboard out there (`layoutUiDocked`, from `imageFromJsx`
and the built-in scenes' `drawUi`): its keys are regions of that UI like any
key, at places outside the UI's own image, and what it draws is a picture of
the frame's size that the interpreter draws last (`drawKeys`). A pointer
event on it (`keysTake`) goes to that UI alone (`dispatchUiEvent`'s
`keysOnly`) in its scene's pixels, before the layout sees it. When it comes,
goes or moves, or a key's row does, the canvas is forgotten
(`rhythmForgetCanvases`) and everything under where it was draws again: a
frame buffer kept between renders holds its pixels there. One rule for every
host: the Pi, the ESP32 and the preview run it from `interpreter.runEvent`.

### Selecting, copying and pasting

A field's text can be selected, copied, cut and pasted, as in a browser.

- **On a keyboard** (a Pi's, the computer's over the preview): shift with
  the arrows, Home or End selects from where the caret was; left or right
  without it lets go at that end of the selection. Ctrl or Cmd (`meta`) with
  `A` selects all, with `C` copies, `X` cuts and `V` pastes, the letter as
  the layout has it (else the key it is on: Ctrl+V on a Cyrillic layout
  pastes). `onKeyDown` hears the chord too, first.
- **With a mouse**: a press on a field gives it the keyboard at once, the
  caret where it went down, and a drag from there selects, as on a desktop.
  Shift with a click (or a press) extends what is selected to it, on the
  field that has the keyboard. The modifiers come with the press and its
  tap from the dispatcher (`pointerDown` / `tap` `shift`, `ctrl`, `alt`,
  `meta`: docs/events.md "Input"). A finger dragged over a field still
  scrolls what is around it.
- **On a touch screen**, as on a phone: a long press on a field gives it
  the keyboard and selects the word there (a password's whole text), and
  the finger, still down, slides the selection on to where it goes; a
  double tap selects the word too. Its ends get handles, a bar and a knob
  under it leaning out of the selection, which a finger drags (the other
  end stays), and a menu comes up over it, or under it without room: Cut
  and Copy (text selected, no password), Paste (something on the
  clipboard), Select all (more to select). Copy keeps the selection and
  puts the menu away; dragging a handle hides it until the finger lifts. A
  long press where there is no word brings the menu alone, at the caret
  (Paste). A tap on the field puts the caret there as before, and anything
  typed, a key moved, a tap elsewhere or the frame's `back` lets the
  selection go (`back` first, keeping the keyboard). On e-paper the
  handles drag without a refresh until the finger lifts. Every host,
  ESP32 touch boards included.
- **What is typed replaces the selection**, and Backspace or Delete takes it
  out. Every edit runs `onChange` as before.
- **The clipboard is the frame's** (`ui/events.nim` `clipboard`, 64 KiB at
  most, 4 KiB on an ESP32), shared by every UI on it. A password is never
  copied (a cut takes it out and copies nothing), and an `<input>` pastes
  the clipboard's first line. **In the browser's preview it is the
  computer's**: the worker hands a Copy or a Cut on to the page
  (`{type: 'clipboard', text}`, when `frameos_wasm_clipboard_changes`
  moves), which writes it with `navigator.clipboard` when the person
  pressed a pointer or a key on the preview within the last five seconds
  (`previewHasGesture`: a Copy is theirs then, and a scene's own code, which
  can move the frame's clipboard too, never writes the computer's by
  itself), and a Ctrl/Cmd+V's
  `keyDown` waits for the browser's `paste` event (100 ms at most) so the
  frame gets its text first (`onPaste` in `attachKeyboardInput`, both
  copies of the pointer file; `FrameOSPreview.setClipboard`). The frame's
  own menu's Paste pastes what was last copied either way.
- **The selection is drawn** as a band a line behind the selected glyphs, in
  the text's color at a third, inside the field's viewport (on e-paper,
  where a third dithers into a stipple that eats the glyphs, a solid band
  with the selected text inverted, as a lit key is), and the caret is not
  drawn while text is selected: SVG nodes like the rest of the UI,
  so it is damaged and repainted as any other change.

How: the selection is `UiInput.sel`, its other end + 1 (0 for none), and the
caret, so everything that moves the caret moves one end of it (`selected`
gives the bytes). A drag of a mouse places the caret as a tap does
(`place`) and its other end where it went down (`anchor`, `anchorX`,
`anchorY`), both from the glyph boxes at the next layout. It is kept
between pulls with the rest of the field (`sel`). A long press or a double
tap sets `word` with `place`, and the layout widens the caret to the word
(`isWordByte`: letters, digits, `_` and any character past ASCII). A
selection made by touch sets `handles` and `menu`: the field's emit leaves
its two ends as regions a pixel wide (`EndsKey`), which the boxes around it
scroll and cut off like any region, and `layoutUi` takes them back out and
draws the handles and the menu (`ui/keyboard.nim` `editMenuTree`, the
keyboard's look) on top, from them. Their handlers are numbered from
`SelectBase` (above the accents, below a `<select>`'s options): + 0 and + 1
the handles, which a press grabs (`ui/events.nim`, the other end made the
anchor), + `EditCut` ... the items.

## Keys

Every UI can be used without touching it: from a keyboard (Linux, the
preview), and from a frame's buttons, which are the same keys. **Tab** walks
every element there is to press, in the order of the tree: a field, a
`<select>`, an element with an `onClick`, a link. One stop per element,
however much is inside it: a tile's icon and its name are one tile.
**Shift+Tab** goes back; either goes around past the end. The element the
keys are on is **ringed**: two pixels out from it, sky on an LCD, black and
thicker on e-paper, and its `focus:` classes apply (an element that has any
draws its own focus and gets no ring). A box that scrolls brings it into
sight. **Enter** presses it, as a tap in its middle would (its `onClick`
hears `tap`, with `key: "Enter"`), opens a `<select>`'s list (Tab then walks
the options, Enter picks one and the ring goes back to the select) or gives
a field the keyboard. **Escape** closes a list or a link's card, lets go of
a field, and then takes the ring away. A tap or a click anywhere takes it
away too: the ring is for the keys, as a browser's focus ring is.

A keyboard's Tab gives a field the keys at once (its `onKeyDown` hears the
Tab that leaves it); Ctrl, Alt or Cmd with any of the three is the scene's.
The on-screen keyboard has a Tab key of its own (an arrow to a bar, left of
the comma or the space), which goes to the next field down the tree, around
past the last, the keyboard staying up; held, to the one before. A
`<select>` is passed over there: its list is no place to type.

**A frame's buttons** are the keys, by role (docs/events.md "Buttons"):
`next` and `down` are Tab, `prev` and `up` Shift+Tab, `primary` Enter (a
reTerminal's green key), `back` and `menu` Escape: a menu key is a way out,
as on a remote. `refresh` is Enter too, for a frame that gave a key that
role by hand. A press is one, a
double press two, so every tap counts however quickly they come, and taps
made while e-paper refreshes all land: each moves the ring from where the one
before left it, on what the last render drew, and the next refresh shows
where they got to. A long press stays the frame's event map's (a reTerminal's
arrows held walk the scenes, its green key held talks). A UI with nothing to
press hears neither keys nor buttons.

**A frame's buttons turn pages.** On an element in a box that scrolls
([Scrolling](#scrolling-and-clipping)), while the box has more below, `next`
goes to the next element only when it shows whole there. When it does not (it
is cut off at the bottom, or the walk would leave the box for the scene's
header or the layout's bar), the box scrolls down a page instead, its height
less an eighth so the reader keeps their place, and the ring goes to the first
element the new page shows below the one it was on. With nothing to press on
the new page it stays where it was while that shows, else it rings the box
itself. Only at the box's end does `next` go on past it. `prev` mirrors it
upward. A box that scrolls with nothing to press showing in it is a stop of
its own, so a long text pages too. Presses that come before the new page is
drawn (a double press, taps while e-paper refreshes) go on from where the ring
lands, one element each. A keyboard's Tab walks on without pages and brings
what it goes to into sight by what that needs, as a browser does.

**The scene's own code hears them first.** A scene or a layout with an event
node for `keyDown` or `button` keeps every one of them. A JS app subscribed to
them (`"events"` in its config.json) hears each one before the keys move,
and one its `onEvent` returns `true` for is its own: a desktop's Alt+Tab, the
Commander's Tab between its panels, a game's Enter. What it returns `false`
for is the keys'. The UIs never act on it twice: a key the keys take is not
also typed into a field (`interpreter.keysPlanned` decides before anything
hears it, `keysTo` applies it after).

The UIs of the scene showing and of the layout it wears are **one walk with
one ring** (`interpreter.keysTo`, `ui_events.uiKeys`): Tab goes on from the
scene's last element to the layout's first, and a ring in one is never a
second ring in the other. The built-in scenes keep their own: the scene
switcher's highlight is its focus (Tab moves it a tile), and the scene
settings' form walks alone, without the layout around it.

The ring is `UiInput.ring` (the element's key + 1, kept with the UI's input
like a field's focus, and between a plane's pulls), drawn by `ui/layout.nim`
`ring` over the UI and under the keyboard; an element gone from the next
render takes the ring with it and Tab starts over from the top. A page is
turned in two halves: `ui/events.nim` `turnPage` decides from the regions
(each knows the box around it that scrolls, `UiRegion.scroller`) and scrolls
the box, and the next layout's `turnPage`, before `reveal`, knows every
element in the box, shown or not, and moves the ring (`UiInput.turn`).
`ui/tests/test_ui_keys.nim` and `tests/test_frame_keys.nim` are where a rule
gets its test.

## Select boxes

`<select>` holds its options, controlled as in React: it shows the `<option>`
whose `value` is its `value`, and a pick calls `onChange` (or `onInput`) with
the option's value, as `e.value` and `e.target.value`.

```tsx
let city = 'oslo'
export function get(app) {
  return (
    <select className="h-12 px-3 rounded-lg bg-slate-800 text-xl"
      value={city} placeholder="Choose a city"
      onChange={(e) => { city = e.target.value }}>
      <option value="oslo" className={city === 'oslo' ? 'bg-sky-600 rounded' : 'active:bg-slate-600 rounded'}>Oslo</option>
      <option value="riga" className={city === 'riga' ? 'bg-sky-600 rounded' : 'active:bg-slate-600 rounded'}>Riga</option>
    </select>
  )
}
```

- Every child of a `<select>` counts as an option, and what is in an option
  is its row.
- **Closed** it is a box like any other, a row of what the option shows (cut
  with an ellipsis to fit) and a chevron in the text color. No option holds
  its `value`: its `placeholder`, at half strength.
- **A tap opens the list**, as wide as the select, on top of everything and
  out of every box that clips or scrolls. A field with the keyboard lets go
  first, and the list is placed for the screen that leaves.
- **It stays on the screen.** It opens below the select if all of it fits
  there or there is at least as much room as above, else above, and is no
  taller than that room, 8 px from the edge. What does not fit scrolls like
  any box, with a finger, a wheel and its bar, and it opens with the option
  the select holds in the middle of it. With room for fewer than three rows
  on either side it keeps three, moved up the screen over the select.
- **A row is as tall as the select** and has its left padding. An option's
  classes are its row's, so what the app lights is its own: the option it
  holds, `active:` for the press. The list's box is the select's background
  and corners with a thin line of its text color around it.
- **While it is up nothing else answers**: a tap on an option picks it and
  closes the list, a tap anywhere else, the frame's `back` or Escape closes
  it. A drag scrolls the list and picks nothing.
- **On a round panel** it keeps an eighth of the height from the top and the
  bottom.

How: `<select>` is a region of the layout (`UiRegion.field` 4), and which one
is open is kept with the UI's input (`UiInput.open`). `layoutUi` builds the
list as another tree after the UI is emitted, as it does the keyboard, from
where the select's region landed, so a scrolled or moved select needs no
second pass; its regions are then the only ones, so the page under it needs no
guard. A row's handler is `OptionBase` + its number (`ui/events.nim`
`pickOption`).

## Links

`<a href="https://…">` opens on a tap. A frame has no browser, so on a Pi and
an ESP32 (and a board its control plane renders for) the link's **QR code**
goes up over the whole UI, as large as fits, black on white on every panel,
with its URL under it and a Close button: a phone scans it and opens the page
there. In the browser (the editor's preview, the playground) the tap opens the
URL in a new tab instead.

```tsx
<p>Tickets at <a href="https://example.com/tickets" className="underline">example.com</a></p>
<a href="tel:+37120000000" className="px-4 py-2 rounded bg-sky-600">Call us</a>
```

- **Only `http://`, `https://`, `mailto:` and `tel:`**, at most 1024 bytes
  with no control characters (`ui/layout.nim` `isLink`); any other href
  (`javascript:` above all) is no link and a tap on it does nothing.
- **An `onClick` of its own replaces it**: the handler runs and nothing
  opens, so an app that routes its own links keeps them.
- **The target** is the `<a>` itself where it is a box (an item of a flex or
  grid container, the outermost element), and in running text (a `<p>`, a
  block) the run of text it is in: a tap anywhere on that text opens the first
  link there. Two links in one sentence want two elements.
- **While the code is up nothing else answers**: a tap anywhere on it, the
  frame's `back` or Escape puts it away. A field's
  keyboard and an open `<select>` go first. A board its plane renders keeps
  it between pulls (`lastingUiInput`).
- `<a>` has no look of its own: give it `underline`, a color, or a button's
  classes. Under a mouse it shows the hand (`cursor-pointer`) unless it has a
  `cursor-*` class of its own (not on an ESP32, which draws no cursor).
- No `<Link>` component: none exists in the runtime or the repo's apps.

How: the walker keeps `href` as a plain attribute (a string; an image ref in
`href` is still a picture). The layout gives a linking `<a>`, or the run of
text holding one, the tap handler `LinkOpen` (past every handler number a tree
can hold, as `OptionBase` is), so a link is a `UiRegion` like any element and
needs no `UiEvent` of its own: it has no JavaScript to call. A tap on it
(`ui/events.nim` `openLink`) asks the host's `uiOpenLink` hook first: the wasm
runtime sets it (`wasm_main.nim` → `frameos_wasm_js_open_link` →
`Module.onFrameosOpenLink`), and only the browser preview's worker defines
that, posting `openLink` to `FrameOSPreview` (`onOpenLink`, default
`window.open`); a plane's renderer defines none, so its boards get the QR code.
Otherwise the URL goes into `UiInput.link` and `layoutUi` draws the card after
the UI (`linkCard`), as it does a `<select>`'s list, its one region
`LinkClose`. The code is `utils/qr.nim`, the encoder the frame's setup screens
already use, so the ESP32 image carries no second one; it is encoded once per
URL and size (`UiMemo.linkQr`).

## Scrolling and clipping

A box with `overflow-y-auto` (or `-scroll`, `overflow-x-auto`,
`overflow-auto`) shows what fits and scrolls the rest:

```tsx
<div className="flex flex-col h-full">
  <header className="h-12">...</header>
  <div className="flex-1 overflow-y-auto">
    {items.map((item) => <Row item={item} />)}
  </div>
</div>
```

- **Its bar**: a thin bar at its right edge says where in what it holds it
  shows. On a round panel's whole canvas (`UiInput.round`: the circle inside
  the square shows) the bar of a box whose right edge is right of the
  centre is an arc along the rim instead, `RoundInset` and a little in from
  it, across the box's height as far as 45° either side of 3 o'clock
  (`rimBar` in `ui/layout.nim`): every UI that scrolls gets it, the built-in
  scenes' and every app's. The app does nothing for it.
- **A finger drags it**: once a press on it moves past the tap's slop
  along the way it scrolls, the content follows the finger and nothing is
  pressed (from where the box is at each move, so a `scrollTop` the app set
  during a drag holds); the swipe that ends the drag is the box's, not a handler's. A
  press on an element that takes it (`onPointerDown`, `onPointerMove`: a
  slider) stays that element's, unless the box that scrolls is that element
  or drawn over it (inside it, or over it): a menu that takes its presses, so the
  cover under it that closes it does not, still scrolls under a finger, and a
  slider inside a list stays the slider's. A wheel scrolls the box under the pointer
  (72 px a notch, about three lines; a trackpad's fractions of a notch their
  share of it), and the box around it once that one is at its end. In a
  layout it is routed like the pointer: over a scene in a window it scrolls
  that scene's box in its own coordinates, a window behind's too, without
  bringing it forward. On e-paper the box shows where it got to when the finger
  lifts.
- **It needs a height**: a box that scrolls is as tall as its own classes
  or its container make it (`h-*`, `max-h-*`, `flex-1` in a column with a
  height), and lays its children out at their own heights however tall,
  so nothing shrinks to fit it. Without one it is as tall as what it holds
  and there is nothing to scroll.
- **What shows answers the pointer**: the elements inside it are hit where
  they are drawn, and only where it shows them.
- **A focused field inside it** is scrolled into sight, with the keyboard
  up too. A `<textarea>` taller than the box (a code editor's lines) has the
  line of its caret scrolled into sight, or the line a tap placed it on.
- **A drag along a way the box under it does not scroll** (down, over a row
  that scrolls sideways) scrolls the box around it that does, as in a browser.
  So does the wheel.
- **`onScroll`** hears every scroll a finger or the wheel makes (on a slow
  panel, once the finger lifts): `e.scrollTop` and `e.scrollLeft` (also on
  `e.target`, as React's), in the UI's pixels. A scroll the layout makes
  itself (a caret brought into sight) is heard with the next event (a key,
  a tap): the layout runs inside a render, where no handler can. Like any
  handler it runs `get()` again, unless it returns `false` and set no
  signal: then it changed nothing `get()` reads, and the box scrolls on the
  tree laid out last, as one with no `onScroll` does (2026.11.15+; a
  `get()` after every one before). A virtualized list returns `false` while
  the rows it built still cover what shows.
- **`scrollTop={y}`** scrolls the box to `y` when the app changes it (a file
  opened at the top, or where it was left), kept in range; the same value
  render after render leaves the box where a finger took it, as a browser
  does. The two together make a **virtualized list**: a box as tall as all
  its rows, spacers for the rows out of sight, and only the rows around
  `scrollTop` built and laid out. The Code editor does this with 2,000-line
  files (`docs/code-editor.md` "The file open").
- **A bar** at its right edge says where in it you are, in the text color.
- **`overflow-hidden`** clips at the padding box without scrolling: a
  picture in a box, a long name cut at the box's edge. Clipping is
  rectangular: a `rounded-*` box does not round off what it clips.
- **Where the scroll is kept**: with the UI's input, by the box's place in
  the tree, as hover and the focused field are; a box that moves to another
  place starts at the top.

How: the box's children are emitted, unscrolled, inside a nested `<svg x
y width height viewBox>` of its padding box, whose viewBox the scroll moves
(FrameOS/pixie draws every element inside it into a view of the canvas
that is that viewport, and keeps its damage there). Its regions are moved
by the scroll and cut to the viewport. A scroll repaints the viewport on an
LCD; what did not change in the tree is still taken back unbuilt, and the
children of a viewport that only moved keep their parse: pixie hands their
elements back moved with it (`parseViewportChildren`), all but a child with
a clipping box of its own. On the Waveshare 1.75" AMOLED that took a scroll
frame's parse from 33-45 ms to 6-8 (2026-11-24).

## Themes

The UIs FrameOS builds in Nim (the scene settings and the frame page, the
scene switcher, the keyboard on the screen) take their look from
the layout around the frame's scene, so a desktop's settings look like that
desktop's (`frameos/ui/theme.nim`), and so does a JS app that gives its
elements a `look` ([below](#a-js-app-in-the-desktops-look)). A layout gives its theme in its state as
**`theme`**, an object of roles; the samples set it from their "Look of the
settings pages" field (`Windows 98`: Windows Standard, `macOS`: Light and Dark,
`BeOS`, `Classic Mac`: Classic, `NeXTSTEP`, `OS/2 Warp`: Warp 4, `Omarchy`: its theme's colors, `Commander`, each with High contrast
and FrameOS, the built-in look; `Tiling`: FrameOS and High contrast):

```js
frameos.setState('theme', {
  page: 'bg-[#c0c0c0] text-black',
  button: ['bg-[#c0c0c0] border-t-1 border-l-1 border-white', 'border-b-1 border-r-1 border-black'],
})
```

A role is a string of classes, one box, or a list of them, a box each, one
inside the other: a bevel is two or three boxes, as a box has one border color.
The element keeps its place and size (`w-`, `h-`, `shrink-0`, position, the text
size) on the outermost box, which also takes its presses, and how its content is
laid out (`flex`, `items-`, `justify-`, padding, gaps) on the innermost; its own
look (`bg-`, `text-` colors, `border`, `rounded`, font weights, `opacity-`, with
their `active:`, `focus:` and `placeholder:` forms) gives way to the role's. A
role the theme leaves out keeps the element's own look.

| Role | What |
|---|---|
| `page`, `bar` | the page (its background and text color) and its header's line |
| `button`, `primary`, `selected` | a button, the one that does it (Save with something to save), one lit while what it opens shows |
| `field`, `option`, `picked` | a select box or a line to type on, a select box's option, the option it holds |
| `switch`, `switchOn`, `knob`, `knobOn` | a switch's track and knob, off and on |
| `muted`, `accent` | quieter text, the switcher's dot for the scene it was opened from |
| `card` | the frame page's facts |
| `tile`, `tileLit` | a scene in the switcher, the one the keys are on |
| `keyboard`, `key`, `keyMod`, `keyLit` | the keyboard on the screen, a key, a key that does something else, one lit (shift, held, just typed) |

`page`, `bar`, `muted`, `accent`, `option`, `picked` and `keyboard` are one box
always (a list's innermost). A `look="field"` box around one text field (a magnifier
and an `<input>`, say) is that field to a finger as well: a tap anywhere on it,
its glyph and padding too, focuses the field as an HTML `<label>` would
(`UiRegion.labelFor`), with or without a theme. A child of it with a handler
of its own (a clear button) keeps its taps. The samples set no theme on
e-paper, where the pages keep their black on white, except High contrast.

On every host, an ESP32 included: there a layout's theme costs about 7 KB of
the S3's flash (2026-11-15).

### A JS app in the desktop's look

A JS app takes the same theme where it asks for it: **`look`**, one of the
roles above, on any element (2026.11.10+):

```tsx
<div look="page" className="flex flex-col bg-slate-900 text-white">
  <div look="bar" className="flex items-center h-12 px-4">Files</div>
  <div look="button" className="px-3 py-2 rounded-lg bg-slate-700" onClick={up}>Up</div>
</div>
```

An element with `look` takes the desktop's look for that role where a layout
around the frame's scene gives a theme (a desktop, its windows included): it is
dressed as a Nim UI's element of that role is, its own look giving way to the
role's, a list of boxes going around it, the outermost taking its place and its
presses. With no theme, an empty one, or a role the theme leaves out, it keeps
its own classes, so an app writes its own look as it always did and is drawn in
it everywhere else. **An element without `look` always keeps its own classes**:
that is how a scene with a look of its own opts out, a custom button among
themed ones included. `role` is not used for theming: it stays the app's own
(ARIA's) attribute. `option` is a row that lights while pressed, as a select's
option does, and `tile` a square picture's box. A memo()'d element keeps the
look it was read in until its props change.

The **Theme roles** sample (`repo/scenes/samples/Theme roles`) draws every
role, each with its name, live where it can be (the buttons press, the switch
toggles, the field types): open it in a desktop to see that desktop's theme, or
full screen for FrameOS's own look. `frameos/src/frameos/tests/test_theme_roles_scene.nim`
renders it under every theme the desktop samples give; with
`FRAMEOS_THEME_SHOTS=<dir>` it writes one picture per theme there.

**`app.frame.theme`** is the theme itself (its roles' class strings, or lists
of them), undefined with none: for what `look` cannot dress, such as an
`<svg>` drawn in the accent's color or a mask in the page's color. The Files
sample (`repo/scenes/samples/Files`) does both: its folders take the accent's
`bg-[#…]`, and its thumbnails' rounded corners, masked in the page's color, are
square where the theme's tiles are.

How: the JSX walker (`js_runtime/jsx.nim`) reads `look` instead of keeping it
as an attribute and hands the element to `ui/theme.nim`'s `role`, as the Nim
UIs do; `themeSource` is the layout's `theme` during its pass
(`interpreter.layoutTheme`), on the Pi, the ESP32 and in the browser alike.
On the ESP32-S3 image the walker's part is about 0.4 KB and `app.frame.theme`
0.1 KB of flash (2026-11-16).

## Text and fonts

Text is the frame's default face (Ubuntu) unless `font-*` names another. A
frame finds families and bold or italic faces among the fonts in its assets
folder (`fonts/`), as SVG `<text>` does: on an ESP32 that is its SD card,
where every TrueType file is read where it lies (docs/esp32-fonts.md), and
`font-[File-Name.ttf]` names one file. A bold weight no face has is drawn as
its outline thickened. A layout keeps up to 128 family names. Emoji draw in
colour where the frame's fonts folder has the emoji font (Noto Color Emoji):
a colour glyph is a picture, so each is an `<image>` at the pen in the same
tree as the glyph paths, drawn by the same pass, its box damage like any
element's, kept at the size drawn in pixie's colour glyph cache
(docs/esp32-fonts.md "Emoji"); its advance is in the layout and in
`frameos.measureText`. SVG `<text>` does the same. White space collapses as in
HTML; lines wrap at spaces.

### The glyph cache

A text is drawn a glyph at a time, and a glyph is drawn from the coverage it
had the last time it was drawn at that size and quarter-pixel offset, as
LVGL draws its pre-rasterized fonts, with pixie's own rasterizer and blends
(`pixie/paths.nim`, "The glyph cache"):

- The layout emits each glyph as a **glyph path** (pixie's `glyphPath`): the
  face, the rune, the size and the glyph's box, read from its glyf header,
  and no outline. The SVG reader makes `<text>` in one colour and without a
  stroke the same way, and pixie's `fillText` (the Text app, status
  screens, error frames) draws through the same cache.
- A fill of a glyph path at a translation and a uniform scale, in one
  colour, blended normally, is a lookup and a blit: the mask's rows go
  through the surface's own coverage store (`fillCoverage`), so RGBX, 565,
  luma and sixteen greys with their dithering are drawn as a fresh fill
  draws them. A miss reads the outline, rasterizes it through the filler a
  fill runs, trims it to the pixels it covers and keeps it at **four bits a
  pixel**; the outline is let go.
- Keyed by the face's serial (never reused, as an address would be), the
  rune, the size under the scale (1/64 px) and the offset's quarter pixel
  each way. The least recently used glyph goes first when the budget is
  full: on an ESP32 a 32nd of the memory the panel leaves the scenes
  (`memory.sceneMemoryBytes`, `glyphCacheBudgetBytes`), 64 to 128 KB on an
  8 MB board, up to 512 KB on 16 MB and 1 MB on 32 MB, where many faces
  from the SD card fill it (docs/esp32-fonts.md): the budget is a ceiling the
  cache fills and keeps, so it is what a board can spare, not what its
  panel's size suggests (a glyph's mask follows its font size; the 13.3"
  E1004 gets 78 KB, the E1003, whose layout and scene drew 69-83 KB of
  letters, 128 KB); 1 MB on a Pi's render thread, 512 KB in the browser preview,
  nothing in pixie's own tests unless they ask. It is emptied with pixie's
  coverage cache when render memory runs short. It is the render thread's
  own (`{.threadvar.}`): a value nobody else touches.
- A host that starts a **pass** per render (`newGlyphCachePass`; the
  ESP32's two render paths do) keeps what fits when a render needs more
  than the budget: a miss never puts out a glyph the same render drew, it
  draws from a mask made and let go. Plain LRU put out each glyph just
  before the render drew it again: 3 hits in 62 a render on the E1003 at
  64 KB (v2026.11.13), 44 with passes, all of them with 128 KB.
- A glyph lands at most an eighth of a pixel from where the typesetter put
  it, and its edge pixels may differ from a fresh fill by up to half a step
  of sixteen. What the cache cannot do exactly is filled from an outline
  made for that fill: a rotation or a skew, a gradient, a stroke, a mask
  blend, a glyph larger than 48 K pixels.
- The typeface no longer keeps the outline of every glyph it ever drew
  (`opentype.getGlyphPath` reads it from the font each time, about a
  microsecond on a laptop), and the layout no longer keeps a path per glyph
  and size with its flattened shapes.
- The built-in face itself is read where it lies: an indexed font in the
  program's read-only data, its tables searched in place and a glyph's
  outline inflated from its block only on a glyph-cache miss
  (`docs/esp32-memory.md` "The built-in face is read where it lies").

`set debug 1` shows it on the render line: `glyphs 312/4 9K` is hits,
misses and what it holds, and the `glyph` fill kind is its blits.

It cost +8.8 KB of flash on the ESP32-S3 image (2026-11-19, against main
built the same way): the mask's making and the fill 2.9 KB, SVG `<text>` as
glyphs 1.3 KB, `fillText`'s glyph runs 0.75 KB, the LRU and its lookups
1.3 KB, glyph paths and their boxes 0.7 KB, the probe 0.3 KB, less the
layout's own glyph table.

## Not supported (yet)

Rounded clipping (a picture in a `rounded-full` box keeping its corners;
`overflow-hidden` clips to a rectangle), shadows, transforms, `z-*` (the
order is the tree's, absolute children last), group opacity (an element's opacity multiplies into each of
its paints instead of compositing the group once), letter spacing, inline
boxes with their own background or padding inside a line of text, `min-content`
/ `max-content` sizes as classes (`w-min`, `w-max`), handlers on inline text (a `<span onClick>` in a block's line; one in a
flex row is an element and works), a selection in a field (copy, paste,
select all), momentum when a scroll is flung, and focus for frames with
buttons and no glass: `docs/ui-todo.md` has the plan for those.
