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
the box that changed repainted (`utils/svg_frames.nim`).

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

## Elements

| Element | What it is |
|---|---|
| `svg` | A drawing. At the root, the whole image; inside a UI, a leaf whose `viewBox` is fitted into its box (centered, whole; `preserveAspectRatio="none"` stretches), sized by its classes, else its `width`/`height`, else its viewBox. `currentColor` in it is the text color. |
| `img` | A picture: `src` is what `frameos.fetchImage` (its result, or its `image`) or `frameos.loadAssetImage` returned. `object-cover` / `object-contain` / `object-fill` (the default, as in CSS). One size given, the other follows the picture's aspect. |
| `span`, `b`, `strong`, `i`, `em`, `u`, `s`, `small`, `a`, `code`, `label`, `mark` | Inline: in a block they flow with the text around them and only their text classes count (color, size, weight, ...). In a flex or grid container they are items, like any element. |
| `br` | A line break. |
| anything else | A box: `div`, `p`, `h1`, `section`, `layout`, ... No tag has a default style (Tailwind's preflight). |

Text is any string or number child; `null`, `undefined`, `true` and `false`
draw nothing, and arrays (`items.map(...)`) and fragments are flattened, as
in React. Function props starting with `on` are handlers ([Events](#events)).

**White space at the edges of JSX text is dropped** (quickts trims every
text run, where Babel and TypeScript keep the spaces inside a line), so
`{count} items` draws "42items" and `March <b>12</b>` "March12". Put the
space inside an expression until quickts is fixed: `{`${count} items`}`,
`{'March '}<b>12</b>`, or lay the two out with `gap`.

`e2e/scenes/jsx*.json` are fifteen interfaces built this way (a dashboard,
an agenda, a month, a departure board, a photo card, a forecast, a status
board, an energy chart, a front page, a word clock, a recipe, a player,
the DVD frame), snapshotted by CI like every scene fixture. The
`jsxSquare*` ones are eleven made for a 480x480 touch screen (the SenseCAP
Indicator), each snapshotted after the taps its `e2eEvents` make: a home
panel's switches, a calculator, a to-do list, a player, tabs, a color
picker, a counter, a forecast's days, and an analog clock, a word clock and
the DVD frame with their `at` field pinning the time.

In an `<svg>`, React's camelCase attribute names are read as SVG's
(`strokeWidth` is `stroke-width`), except SVG's own camelCase ones
(`viewBox`, `gradientUnits`, `gradientTransform`, `preserveAspectRatio`);
`style={{ fill: "red" }}` becomes a style attribute; `<image href={ref}>`
takes an image ref like `img`.

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
  `items-*`, `self-*` and `auto` margins. An item with a set size does not
  shrink below it (CSS's automatic minimum); one without can shrink to
  nothing, as with `min-w-0`.
- **`grid grid-cols-N`**: equal columns, items in order, `col-span-N`; each
  row as tall as its tallest item (a grid is laid out as a wrapping row whose
  items are as wide as the columns they span).
- **`absolute`**: placed against its parent's padding box with `inset-*`,
  `top-*`, `right-*`, `bottom-*`, `left-*` (every box is a containing block,
  so `relative` changes nothing), drawn after the in-flow children.
- `gap-*` and `space-x/y-*` space the children of any container.
- Lengths: Tailwind's 4 px scale (`p-2` = 8 px), `px`, fractions (`w-1/2`),
  `full`, `screen`, `auto`, and brackets: `w-[37px]`, `[2rem]`, `[50%]`,
  `[10vw]` / `[10vh]` (of the image).

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
- **Variants**: `sm:`, `md:`, `lg:`, `xl:`, `2xl:` test the image's width
  (640, 768, 1024, 1280, 1536 px), `portrait:` and `landscape:` its shape;
  `hover:`, `active:` and `group-hover:` the pointer ([Events](#events)).
  Every other variant (`focus:`, `dark:`) never applies on a frame.

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
  finger, pen or mouse), **`onDoubleClick`** on a `doubleTap`,
  **`onLongPress`** on a `longPress`, **`onPointerDown`** / **`onPointerUp`**
  on the raw press and release, **`onPointerMove`** as the pointer moves.
  The handler gets the event's payload plus `type`, `localX` and `localY`
  (from the element's corner): `onClick={(e) => ...}`. The innermost element
  with a handler for the event takes it, so a tap on a label inside a card
  runs the card's `onClick`.
- **A press is captured**, as a browser captures a touch: the innermost
  element with an `onPointerDown` or `onPointerMove` under the press gets
  that pointer's `pointerMove`s and its `pointerUp` until it lifts, inside
  its box or not, and no other element hears them. `localX` / `localY` stay
  from its corner, so they go negative or past its width: a slider clamps
  them. A move with no press goes to the element under it. A drag renders at
  the frame's render rate, with the newest position (the ESP32 coalesces a
  finger's moves while a render runs).

  ```tsx
  const setLevel = (e) => { level = Math.max(0, Math.min(100, Math.round(e.localX / 4))) }
  <div className="h-8 w-[400px] rounded-full bg-white/10" onPointerDown={setLevel} onPointerMove={setLevel}>
    <div className={`h-8 w-[${level * 4}px] rounded-full bg-sky-500`} />
  </div>
  ```
- **The frame renders again after a handler**, whatever it did: a handler
  changes what the next `get()` returns (a module variable, `frameos.setState`,
  `frameos.remember`), and the picture follows.
- **`hover:`** applies while the pointer is over the element, **`active:`**
  while it is pressed on it, **`group-hover:`** while the pointer is over an
  ancestor with the class `group`. A change renders again. A finger that
  lifts is over nothing, so on a touch screen `hover:` lasts for the press.
- **Renders cost what they cost on the panel.** On an LCD, a HyperPixel or
  the browser preview a click answers at once; on e-paper it answers in a
  refresh, and `hover:` / `active:` are a refresh each: keep them for
  screens that redraw in a blink.
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

## Text and fonts

Text is the frame's default face (Ubuntu) unless `font-*` names another. A
Raspberry Pi frame finds families and bold or italic faces among the fonts in
its assets folder (`fonts/`), as SVG `<text>` does; an ESP32 has one face,
and draws a bold weight as its outline thickened. White space collapses as in
HTML; lines wrap at spaces.

## Not supported (yet)

Clipping (`overflow-hidden`, so a picture in a `rounded-full` box keeps its
corners), shadows, transforms, `z-*` (the order is the tree's, absolute
children last), group opacity (an element's opacity multiplies into each of
its paints instead of compositing the group once), letter spacing, inline
boxes with their own background or padding inside a line of text, `min-content`
sizing, handlers on inline text (a `<span onClick>` in a block's line; one in a
flex row is an element and works), and focus for frames with buttons and no
glass: `docs/ui-todo.md` has the plan for those.
