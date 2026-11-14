<!-- The scene-writing guide. People read it here; the scene AI and the app AI
on FrameOS Cloud and on the self-hosted backend read it in their prompts, and
both MCP servers serve it as `scene_guide`. After editing, run
`python3 frameos/tools/generate_scene_guide.py`: it refreshes the generated
regions below and the copies in backend/app/utils/scene_guide_gen.py and
cloud/apps/auth-web/src/lib/ai/scene-guide.gen.ts (the backend tests run its
--check). Write it for whoever has never seen a scene, and keep it to rules
that hold on every device. -->

# Writing FrameOS scenes

A FrameOS scene is a JSON graph that draws one screen. The same scene runs on
a Raspberry Pi with an HDMI or e-ink panel, on an ESP32 with a few MB of
memory, and in the editor's preview in a browser. These rules hold on all of
them.

## A scene

A scenes file is a JSON array of scenes. Each scene is
`{ id, name, nodes, edges, fields, settings, apps?, customEvents? }`:

- `id`: a unique string, kept stable across edits. `name`: shown to people.
- `settings.execution` is always `"interpreted"`.
- `settings.refreshInterval`: seconds between renders, the scene's default
  cadence. Never below 3600 when the scene calls a paid API (an image or text
  model) unless the person asked for it.
- `settings.backgroundColor`: the hex color every render starts from. Set it.
- `fields`: the scene's state fields (see [Fields and state](#fields-and-state)).
- `apps`: JavaScript apps the scene carries with it (see [JS apps](#js-apps)).
- `customEvents`: events of the scene's own (see [Events](#events)).

When you change an existing scene, keep its id, its node ids and everything
you were not asked to touch exactly as it was, and keep its fields so the
values people saved still apply. Change the minimum that does what was asked.

## Nodes

Every node is `{ id, type, data }`. Positions are optional.

| type | `data` | what it does |
|---|---|---|
| `event` | `{ keyword }` | Starts a flow when the event happens. Every scene has one `render` event node; the render flow starts there. |
| `app` | `{ keyword, config, cache? }` | Runs an app. `keyword` is a catalog app (`render/text`) or a key of the scene's `apps` map. |
| `code` | `{ codeJS, codeArgs?, codeOutputs?, cache? }` | One JavaScript expression (see [Code nodes](#code-nodes)). |
| `state` | `{ keyword, value }` | Outputs the scene field named `keyword`; `value` is its default, as a string. |
| `dispatch` | `{ keyword, config }` | Sends an event when the flow reaches it: `render` for another render, `setSceneState`, `setCurrentScene` or a custom event. `config` is the event's payload. A node of its own, never an app keyword like `dispatch/render`. |
| `scene` | `{ keyword, config }` | Draws another scene, by its id, inside this one (usually in a `render/split` cell). |

`cache` on an app or code node is
`{ enabled, inputEnabled, durationEnabled, duration }`: keep the output until
the inputs change (`inputEnabled`), until `duration` seconds have passed
(`durationEnabled`), or both. Cache every network fetch on a sensible
schedule.

## Edges

Every edge is `{ id, source, target, sourceHandle, targetHandle, type }`, and
both ends must be nodes of the scene. There are two kinds:

- **Flows** (`type: "appNodeEdge"`, `sourceHandle: "next"` →
  `targetHandle: "prev"`): every `event` node starts one, and the frame runs
  its nodes in order. The render flow starts at the `render` event node and
  holds the render and logic apps that draw; a flow from another event
  (`button`, `tap`, a custom event) holds logic apps and `dispatch` nodes. A
  flow is one straight chain: never point two `next` edges at one `prev`. The
  apps in the render flow draw on one shared canvas, in order, so never pass
  the canvas between them through fields.
- **Values** (`type: "codeNodeEdge"`, `sourceHandle: "fieldOutput"`): a node's
  output into an app field (`targetHandle: "fieldInput/<field>"`) or into a
  code node argument (`targetHandle: "codeField/<arg>"`). Code, state and data
  nodes connect only this way, and their source handle is exactly
  `fieldOutput`, never `fieldOutput/<name>`.

Data apps (category `data`) are never in a flow; they feed values.
Images are values too: to show one, put a `render/image` app in the render
flow and wire the image into its `image` field. Never put a data app that
makes an image straight into the render flow, and never keep an image in
state.

A field of type `node` (`logic/ifElse`'s `thenNode` and `elseNode`,
`render/split`'s `render_functions`) is an edge, never config:
`sourceHandle: "field/<name>"` on the app → `targetHandle: "prev"` on the node
it runs. A split's cells are `field/render_functions[row][col]`, counted from
1 and within its `rows` × `columns`; a cell runs a render app or a `scene`
node. A `scene` node takes the embedded scene's state on
`fieldInput/<stateField>`.

## Apps

An app node's `keyword` must be an app that exists: look each one up in the
app catalog before you use it, with its exact field names, types and options.

- `config` keys are field names of that app, and every value is a string:
  `"12"`, `"true"`, `"#ff0000"`. A `select` field takes one of its options'
  values.
- A required field without a default is set in `config` or fed by an edge. An
  image field (`render/image`'s `image`) is always fed by an edge.
- Outputs are typed. An image goes only into an image field; text and JSON go
  only into other fields; a float goes into a float field and an integer into
  an integer field.
- Catalog apps with a `repo/apps/<folder>/<name>` keyword are JavaScript app
  templates, not keywords a frame knows. A scene uses one by copying it into
  its own `apps` map under `<name>`, with the template's `name`, `category`,
  `description`, `fields`, `output` and `sources`, and
  `"origin": "repo/apps/<folder>/<name>"`; its nodes then use `keyword: "<name>"`.
  The editor and the scene AI do this for you; anything else that writes scene
  JSON does it itself.
- Prefer an app that exists to one you write. Weather, photos, calendars,
  the time, AI text and images, home sensors and charts all have catalog apps,
  tested on every kind of frame: search the catalog for the subject before
  writing a JS app or a code node, and to change a scene, add the app that does
  the new part rather than rewriting an app that is already there.
- When no app fits, build the logic from code nodes and generic apps
  (`render/text`, `render/image`), and draw what the scene works out (a dial,
  a grid, a chart of its own, a dashboard) with a `.tsx` JS app that returns
  JSX (see [Drawing with JSX](#drawing-with-jsx)).

Apps used often: `render/image` (an image into the canvas, with `placement`
cover, contain, stretch, center…), `render/text` (wrapping text, with
`richText: "basic-caret"` for caret styling), `render/svg` (fixed SVG markup
someone pasted, never markup a scene builds), `render/gradient`
(`startColor`, `endColor`, `angle`), `render/color`, `render/split` (`rows`,
`columns`, cells as above), `data/clock` (the time as a string; its `format`
options are its own, not the code-node tokens), `data/downloadUrl` (a URL's
body as text), `data/parseJson`, `logic/setAsState` (a value into state,
`stateKey` plus `valueString` or `valueJson`) and `logic/ifElse`. For a chart,
copy the `repo/apps/image/chart` JS app into the scene: line, bar or area, from
a `data` field, wired into `render/image`. `render/color` and `render/gradient`
fill the whole canvas and hide whatever was drawn before them, so they go first
in the render flow.

## Fields and state

The scene's state is a JSON object every node can read. `fields` declares the
part people can see and change:
`{ name, type, label?, description?, value, options?, access?, persist?, required?, role? }`.

- Types: `string`, `text`, `float`, `integer`, `boolean`, `color`, `date`,
  `json`, `node`, `scene`, `image`, `font`, `select`, `path`.
- `value` is the default, always a string (`"600"`, `"true"`, `"Brussels"`).
- `options` (select only) is a list of strings, `["dark", "light"]`, or of
  `{ "value": "dark", "label": "Dark mode" }` pairs. State and config always
  hold the value, never the label.
- `access: "public"` and `persist: "disk"` make a field something people
  customize, and it keeps their value across restarts. Prefer them for
  anything a person would want to change.
- A `state` node outputs one field: `data.keyword` is the field's name and
  `data.value` its default as a string. Use one state node per consumer, so
  the diagram stays readable.
- Every scene has a public `refreshInterval` field ("Refresh interval
  (seconds)", read as `state.refreshInterval`), whose default is
  `settings.refreshInterval`. Never add your own interval field, and never use
  `logic/nextSleepDuration` to make the cadence configurable: that app sets the
  sleep after one render only. When the interval deserves its own label
  ("Seconds per image"), declare one `float` field with
  `"role": "refreshInterval"`; its value is then the interval.
- A scene drawn inside another (a `scene` node, such as a split's panel)
  renders on its own `refreshInterval`, and in between the frame shows the
  picture it drew last time. A split made in the editor renders at most as
  often as its own interval, and waits longer when none of its panels is due
  by then. `logic/nextSleepDuration` (or `frameos.setNextSleep`) inside such a
  scene sets when that scene renders next, not the frame.

## Code nodes

A code node holds one JavaScript **expression** in `data.codeJS`. Wrap
several statements in an immediately called function that returns the value.

- It has exactly one output: one `codeOutputs` entry, `{ name, type }`, with
  type `string`, `json`, `integer`, `float` or `boolean`. It cannot output an
  image, and it never builds SVG markup as a string: a drawing is a `.tsx`
  JS app returning JSX ([Drawing with JSX](#drawing-with-jsx)). A code node
  can work out the numbers and text that app draws and feed them into its
  fields.
- An argument exists only when it is declared in `data.codeArgs`
  (`{ name, type }`) and fed by an edge into `codeField/<name>`. Arguments are
  constant bindings: `const lat = Number(lat)` is an error, write
  `const latNum = Number(lat)`. Never name one `state`, `args`, `context`,
  `console`, `parseTs`, `format` or `now`: the code would see the global.
- The only globals are `state.<field>`, the arguments, `context` (`event`,
  `payload`, `loopIndex`, `loopKey`, `hasImage`, and `imageWidth` /
  `imageHeight`, the canvas being drawn on, undefined outside a render),
  `console.log/warn/error`, and three time helpers: `now()` (seconds since the
  epoch), `format(ts, pattern)` (text in the frame's time zone) and
  `parseTs(pattern, text)` (seconds).
- There is no `frameos` object, no `fetch` and no HTTP in a code node. Fetch
  with a data app (`data/downloadUrl`, `data/parseJson`…) and wire its output
  into an argument. `Math`, `JSON` and `Date` work, but take local time from
  `format(now(), …)`.

`format()` and `parseTs()` patterns use curly tokens, and letters outside the
braces are copied as they are (`"HH:mm"` prints `HH:mm`):

| token | output |
|---|---|
| `{year/4}` `{year/2}` | `2026` / `26` |
| `{month/2}` `{month}` | `08` / `8` |
| `{month/n}` `{month/n/3}` | `August` / `Aug` |
| `{day/2}` `{day}` | `05` / `5` |
| `{hour/2}` `{hour}` | `09` / `9` (24 h) |
| `{hour/2/ap}` `{hour/ap}` `{am/pm}` | `09` / `9` / `am` (12 h) |
| `{minute/2}` `{second/2}` | `05` / `07` |
| `{weekday}` `{weekday/3}` `{weekday/2}` | `Monday` / `Mon` / `Mo` |

`format(now(), "{hour/2}:{minute/2}")` gives `09:05`;
`Number(format(now(), "{hour}"))` gives `9`.

## JS apps

A JS app is a small TypeScript or JavaScript module that runs on the frame in
QuickJS. A scene carries its own in the top-level `apps` map:

```json
"apps": {
  "myPanel": {
    "name": "My panel", "category": "data", "description": "…",
    "fields": [{ "name": "city", "type": "string", "value": "Brussels" }],
    "output": [{ "name": "image", "type": "image" }],
    "sources": { "config.json": "…the same name, category, fields and output…", "app.ts": "…" }
  }
}
```

and its nodes use `keyword: "myPanel"`.

**Files.** `config.json` and `app.ts` (or `.tsx`, `.js`, `.jsx`; an app that
draws is `app.tsx`), plus any
helper modules and `.json` data files, imported with relative paths
(`import { row } from "./lib/row"`, `import icons from "./icons.json"`). Only
the app's own files resolve: no npm packages, no `require()`, no dynamic
`import()`. JSX works only in `.tsx` / `.jsx` files. Split an app when
`app.ts` passes a few hundred lines, or when data would swamp the code. Keep
apps small: a scene carries a copy of every app it uses, and an ESP32 keeps
all its scenes in 512 KiB.

**Exports.** Where the app's node sits decides which function the frame
calls, and it calls no other:

- A node that feeds a field (`fieldOutput` → `fieldInput/<field>`) calls
  `get(app, context)`. That is a `data` app: `get` returns the value its
  `output` names, a string, JSON, or for an image JSX (an `<svg>` or a UI,
  from an `app.tsx`) or an image from `frameos.fetchImage`. To show an
  image, wire it into `render/image`'s `image` field.
- A node in a flow (after an event node, `next` → `prev`) calls
  `run(app, context)`. That is a `logic` app: `run` returns nothing and acts,
  with `frameos.setState`, `frameos.setNextSleep` and the like.
- So a `get()` app in a flow does nothing, and a `run()` app feeding a field
  gives an empty value. Write the one its node needs.
- A button that changes the picture is a flow of its own: the `button` event
  node, a logic app, then a `dispatch` node with `keyword: "render"`. The
  app's `app.ts` is
  `export function run(app) { frameos.setState("revealed", !app.state.revealed) }`,
  and the render flow reads `revealed` from state. `logic/setAsState` does the
  same for one value without a JS app.
- Never make a JS app with category `render`: it draws nothing.
- `init(app)` is optional and runs each time the app's interpreter starts:
  once per scene on a Pi, before every render on an ESP32 and in a preview
  running as one.
- `onEvent(app, context)` is optional and needs no wiring: it hears the events
  listed in the app's `config.json` as `"events": ["button"]`, or `["*"]` for
  everything but pointer motion. `context.event` is the name and
  `context.payload` what it carries. Return `true` to draw the scene again.
  An app that pages (the next effect, photo or page) lists `"back"` and
  `"forward"` with `"swipe"` and takes `forward` as next and `back` as
  previous: on a touch screen a swipe that starts within 24 px of the left or
  right edge, where most swipes start, never reaches it as a `swipe`; the
  frame makes it `back` (in from the left) or `forward` (in from the right).
  An app that hears only `swipe` ignores most of the swipes made on it.
- `frameos.dispatch(event, payload)` sends an event as a `dispatch` node does,
  from a JSX handler, `onEvent` or `run`. `frameos.dispatch('sceneSwitcher')`
  opens the scene list and `'sceneSettings'` the settings of the scene showing.
  Frames older than 2026.11 ignore it.

**What the app sees.**

- `app.config`: its fields, with what the node's config and edges set.
- `app.state`: the scene's state, read by key. Write it with
  `frameos.setState(key, value)`.
- `app.frame`: the frame, read only: `width`, `height` (always set, also in
  the preview), `rotate`, `timeZone`, `assetsPath`, `debug`, `embedded`
  (true on an ESP32, and in a preview running as one), and `batteryPercent`
  (0 to 100) and `wifiRssi` (dBm), which are undefined wherever the frame
  cannot tell (a Pi, the preview, an ESP32 with no battery or off Wi-Fi), so
  draw them only when they are numbers.
- `app.nodeId`, `app.nodeName`.
- `context`: this run: `event`, `payload`, and when an image is flowing
  through, `imageWidth` / `imageHeight`. That is the area being drawn into (a
  split cell, say), in scene pixels and already turned with the frame, so an
  app never reads `app.frame.rotate` to size anything. An app that returns an
  image also gets `targetWidth` / `targetHeight`, the size that image will be
  drawn at (an image node's box), and `targetFit`, the consumer's placement:
  ask a picture source for that size, else the canvas's (the gallery app
  does), never for `app.frame`'s.
- `frameos`: everything the app can do: fetch (`fetchJson`, `fetchText`,
  `httpRequest`, `fetchImage`), make images (JSX; `svg` only for markup
  fetched or read from an asset, never markup the app builds), log (`log`,
  `error`), keep values (`setState`, `remember`, `recall`), read the account's
  keys (`getSetting`, only for namespaces the app's `config.json` lists under
  `settings`), set the next sleep (`setNextSleep`, this render only), and
  read and write frame assets and streams. The exact signatures are in the
  [JS API reference](#js-api-reference).
- `Date` reads local time in the frame's time zone. There are no `format`,
  `now` or `parseTs` here: those belong to code nodes.

**Where an app keeps its values.** Three places, the same on every device:

| the value | goes in | lasts |
|---|---|---|
| what the rest of the scene should see: a position a button changes, a photo's metadata | `frameos.setState(key, value)`, read back as `app.state[key]` | the scene's state: every node reads it, state nodes see changes, a declared field can persist and show in the frame's controls |
| the app's own, needed on the next render: a fetched list, a position | `frameos.remember(key, value)`, read back with `frameos.recall(key)` | until the scene unloads, private to the node; JSON, at most 512 KB per node on an ESP32; `remember` answers `false` when it does not fit, and `null` forgets |
| scratch for this render: lookup tables built when the module loads, intermediate results | module-level variables | one render |

An ESP32 starts every render with a fresh module, so a counter in a module
variable shows the first photo forever. A Pi keeps its modules longer, but an
app must not count on it. The editor's preview runs as an ESP32 when its memory
limit is set to an ESP32 board or it previews an ESP32 frame, and as a Pi
otherwise, so an app can be tried both ways. An animation works out each frame
from the clock (`Date.now()`), not from the frame before.

**Errors.** Throw. An error thrown from `get()` fails the node: it is logged
with its source line, an image field gets the message painted, and the next
render tries again. `frameos.fetchImage` never throws; it answers
`{ image: null, error }`, and the app throws with a message of its own.

**Photos.** `frameos.fetchImage(url, { headers, saveAsset })` downloads and
decodes natively, and the bytes never enter the JS heap. Return its `image`.
Use it for every photo, and `httpRequest` only for the JSON around it.
Its image lasts one render. A JSX UI that shows a photo across renders
(a tap, a hover, its interval) keeps it instead:
`frameos.fetchImage(url, { keep: true, width, height })` decodes it at that
size and the ref stays valid until `frameos.releaseImage(ref)` or the
interpreter goes (8 at most). Hold the ref in a module variable and fetch
again when it is gone: an ESP32 short of memory drops the interpreter, and
the picture with it.
A picture the app draws into itself is a canvas:
`frameos.canvas(key, width, height, color)`, drawn into with
`frameos.draw(canvas, <line .../>)` (any SVG, as JSX or markup) and shown with
`<img src={canvas}>`. A frame repaints only what was drawn, a box around each
stroke: give strokes `strokeLinecap="round"` and `strokeLinejoin="round"`,
whose box is half the width around the line (a miter join's is wider). It
lasts as long as the interpreter: when `canvas.fresh` is true, draw the
record you keep in `frameos.remember` into it again.

**8-bit palette mode.** A picture the app works out cell by cell (a fire, a
plasma, pixel art) is returned from `get()` as `frameos.pixels(cells, palette,
{ width, height, pixelSize })` (FrameOS 2026.11.8+): `cells` a `Uint8Array` (or
`Uint8ClampedArray`) of `width` x `height` bytes, rows top to bottom, each an
index into `palette`, up to 256 `0xRRGGBB` numbers (an Array or a
`Uint32Array`), every cell a `pixelSize` square; `width` and `height` default to
the frame's size over `pixelSize`, and an index past the palette is black. It
goes straight into the panel's buffer, no canvas and no JSX, and only the cells
whose index or color changed since the last frame are written. So there are two
ways to animate. Change cells: simulate at the frame's size over `pixelSize` and
hand the same array over every frame. Or change only the palette, as 8-bit
games did: draw the picture once with ranges of colors laid out the way things
move (down a waterfall, out from where a drop lands, up a flame) and rotate each
range every frame, worked out from `Date.now()` so it keeps its pace at any
frame rate; a frame then costs a palette, and only the cycling cells are
written. The cells live as long as the interpreter: keep them in a module
variable and make them again when it is gone. On an ESP32 every bytecode counts
(~0.25 µs each): keep per-cell and per-particle loops to locals and typed arrays
(no `Math.*`, method or property lookups inside them), take random numbers from
a table rather than a call, skip rows that cannot change, read `app.config` once
per render (each read crosses into the runtime), and offer a coarser
`pixelSize` there (`app.frame.embedded`). A module's top-level code runs every
time the interpreter starts, so an app of several effects builds each one's
tables (palettes, lookup tables) when that effect first runs, not at import:
built at import, the Pixel toys' palettes were 2.2 s of the scene's start. The
Pixel toys and Color cycling samples are worked examples.

**Assets and permissions.** Asset paths are relative to the frame's assets
folder (`app.frame.assetsPath`, `/srv/assets` by default): uploaded photos,
fonts, what other scenes saved. What an app may do there is its own
config.json's `"permissions"` list:

- `"assets"`: read the assets folder (`listAssets`, `readAsset`,
  `loadAssetImage`, a stream opened with `"r"`, ...).
- `"assets-write"`: also write and delete in it (`writeAsset`,
  `appendAsset`, `deleteAsset`, a stream opened with `"w"` or `"a"`).
- `"files"` and `"shell"` belong to built-in apps: Local Image reads any
  folder, the screenshot and camera apps run processes.

Saving the scene fills a JavaScript app's list from its code, so you rarely
write it. The frame gives the app exactly that list: with neither `"assets"`
nor `"assets-write"`, its asset calls live in a folder of its own,
`scenes/<sceneId>/`; with `"assets"` alone, its writes are refused. An app
with no list asks for nothing, and a list written by hand is replaced on the
next save. A scene asks for what its apps ask for, nothing more, and every
surface shows it as tags ("reads assets folder", "writes assets folder",
"reads all files", "runs shell commands", and "uses OpenAI key" for each
settings namespace an app reads). Installing a scene is the approval of its
tags, and an update says which ones it adds, so ask for what the app needs
and no more.
`fetchImage({ saveAsset })` is the frame caching a download, not the app
using the folder: it needs no permission. (Frames before FrameOS 2026.10.16
ignore the lists.)

**Local network.** On a cloud-managed frame, scenes reach addresses on the
frame's own network (a Home Assistant at `homeassistant.local`, a NAS,
anything at `192.168.x.x`) only while its local network access is on. That is
a frame setting the owner turns on, not something an app or a scene asks for.
With it off, such a request fails with "Local network access is off for this
frame". A scene that needs a local service says so in its description, so the
owner knows to turn it on. Standalone and self-hosted frames are not limited.

**Big responses.** A response body becomes a JS string. When the app needs
only what follows some marker in a large page, pass
`httpRequest(url, { find: "marker", findLength: 400 })`: the body stays native
and the answer is `{ status, found }`, the text at each occurrence.

**Newer than some frames.** `frameos.remember` / `recall`, `httpRequest`'s
`find`, `fetchImage`'s `exif`, `app.frame.embedded` / `debug`, and a throw
painting its message all need FrameOS 2026.10.13; a frame on an older release
lacks them. A scene meant for such frames keeps to the rest.

**Code style.** Normal formatting, one statement per line, descriptive names,
short comments where the logic is not obvious. People open and edit this code
in the editor, so never minify it.

## Drawing with JSX

Anything a scene draws that it works out itself (a clock face, a grid of
dots, a chart of its own, a weather panel, a dashboard) is a JS app whose main
file is `app.tsx`: a `data` app with an `image` output whose `get()` returns
JSX, wired into `render/image`'s `image` field. The frame reads the JSX
straight into its drawing: no markup is built or parsed, nothing needs
escaping, and on an LCD only what changed is drawn again. Never build SVG
markup as a string (template literals, `join("")`, an escape helper) for
`frameos.svg()` or `render/svg`: it is slower on every render, and one stray
`&` blanks the picture. JSX needs FrameOS 2026.10.21 or later; older frames
draw nothing.

A picture made of shapes (a dial, a grid, a chart, a map, art) is an `<svg>`,
drawn as it is with the tags and rules in
[Images, SVG and text](#images-svg-and-text). Attributes take expressions,
React's names work (`strokeWidth`, `strokeLinecap`, `fillRule`, `fontSize`,
`textAnchor`, `stopColor`), and so do function components, `.map()` and
fragments:

```tsx
export function get(app, context) {
  const W = context.imageWidth ?? app.frame.width
  const H = context.imageHeight ?? app.frame.height
  const r = Math.min(W, H) * 0.42
  const now = new Date()
  const minutes = now.getMinutes()
  const hours = (now.getHours() % 12) + minutes / 60
  const hand = (turns: number, length: number, width: number) => (
    <line
      x1={W / 2}
      y1={H / 2}
      x2={W / 2 + Math.sin(turns * 2 * Math.PI) * length}
      y2={H / 2 - Math.cos(turns * 2 * Math.PI) * length}
      stroke="#111827"
      strokeWidth={width}
      strokeLinecap="round"
    />
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      <rect width={W} height={H} fill="#f8fafc" />
      <circle cx={W / 2} cy={H / 2} r={r} fill="none" stroke="#111827" strokeWidth={r * 0.03} />
      {Array.from({ length: 12 }, (_, i) => (
        <circle
          cx={W / 2 + Math.sin((i * Math.PI) / 6) * r * 0.85}
          cy={H / 2 - Math.cos((i * Math.PI) / 6) * r * 0.85}
          r={r * 0.03}
          fill="#111827"
        />
      ))}
      {hand(hours / 12, r * 0.5, r * 0.06)}
      {hand(minutes / 60, r * 0.75, r * 0.04)}
      <text x={W / 2} y={H / 2 + r * 0.45} fontSize={r * 0.12} textAnchor="middle" fill="#334155">
        {app.config.city}
      </text>
    </svg>
  )
}
```

Anything else is a UI laid out with Tailwind classes: text, cards, lists,
anything that wraps or lines up. Prefer it to placing text in an `<svg>` by
hand; it can hold `<svg viewBox>` icons and pictures of its own:

```tsx
export function get(app, context) {
  return (
    <div className="flex flex-col justify-between p-8 bg-slate-900 text-white">
      <div className="text-7xl font-bold">{new Date().toTimeString().slice(0, 5)}</div>
      <div className="grid grid-cols-3 gap-4">
        {(app.state.rooms ?? []).map((room) => (
          <div className="rounded-xl bg-white/10 p-4">
            <div className="text-sm uppercase text-slate-400 truncate">{room.name}</div>
            <div className="text-4xl font-semibold text-emerald-400">{room.temp}°</div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- The outer element fills the image; lengths are pixels of it (`p-2` is
  8 px), so scale with `text-[5vh]`, `w-[30vw]` and the `md:` / `lg:`
  breakpoints (image width 768 / 1024 px) or `portrait:` / `landscape:`.
- A UI reads its classes and nothing else: a `style` prop is ignored outside
  an `<svg>`, so padding, margins and font sizes set there never show. Put a
  size worked out in code in a bracket class,
  ``className={`p-[${pad}px] text-[${size}px]`}``.
- `<Scene id="other" someField="x" />` draws another scene of the frame there,
  sized by the UI (it takes the room left unless its classes say otherwise),
  its props set as that scene's state. It renders on its own
  `refreshInterval`, straight into the canvas when nothing is drawn over it, so
  a slow scene costs nothing on the renders in between and a tile that is due
  redraws alone.
  In a layout, `app.frame.sceneName` is the name of the scene it wraps.
  `<yield />` marks where a layout's content goes: a hole the content draws
  straight into, which is as fast as no layout. Keep it opaque, with nothing
  drawn over it and no scrolling box around it, or the frame has to composite
  a picture of the content instead. A split with a content panel cannot be a
  layout (see Layouts below).
- A big frame draws a .tsx app's JSX larger by itself: at render scale 2
  (automatic on a 4K screen on HDMI, or set on the frame) the app is told
  its canvas is half the size (`context.imageWidth`, `app.frame.width`) and
  what it returns is drawn sharp at full size. Design for the size you are
  told; `app.frame.scale` says the factor. A position from outside the app
  is in panel pixels (a pointer's `x` / `y` kept in state): divide it by
  `app.frame.scale` before drawing it. A scene can set its own
  `settings.renderScale` (1 keeps every pixel).
- Layout: block (stacked), `flex` / `flex-col` with `gap`, `grow`, `flex-1`,
  `justify-*`, `items-*`, `flex-wrap`; `grid grid-cols-N` with `col-span-N`;
  `absolute` with `inset-*` / `top-*` (against the parent). Sizes `w-*`,
  `h-*`, `size-*`, `max-w-*`, padding and margins (`mx-auto`).
- Unlike a browser, a flex item without a set size can shrink to nothing,
  and its text then wraps a character per line. In a row, give the parts that
  must keep their width (a number, a label, an icon, a badge) `shrink-0` or a
  `w-*`, and the long text `flex-1`.
- Paint: `bg-*`, `text-*`, `border-*` from Tailwind's palette, `/50`
  opacity, `bg-[#hex]`, `bg-gradient-to-r from-* via-* to-*`, `border`,
  `rounded-*`, `opacity-*`.
- Text: `text-xs` .. `text-9xl`, `font-bold` and the other weights,
  `italic`, `underline`, `uppercase`, `text-center`, `leading-*`,
  `truncate`, `line-clamp-N`. Lines wrap at the box's width by themselves.
- `<img src={...}>` takes what `frameos.fetchImage` or
  `frameos.loadAssetImage` returned, with `object-cover` or
  `object-contain`; an `<svg viewBox>` inside a UI is an icon sized by its
  classes, drawn in the text color where it says `currentColor`.
- White space works as in React: `{count} items` draws "42 items", and
  indenting children adds nothing.
- Handlers: `onClick` (a tap, by finger or mouse), `onDoubleClick`,
  `onLongPress`, `onPointerDown`, `onPointerUp`, given `{x, y, localX,
  localY, width, height, type}`: `width` / `height` are the element's
  size, so a slider is `localX / width` along at any frame size. Change what the next `get()` returns (a module variable,
  `frameos.setState`) and the frame renders again by itself. `hover:`,
  `active:` and `group-hover:` (inside a `group`) follow the pointer. Each is
  a render: on e-paper a tap answers in a refresh, so keep hover: and
  active: for LCDs.
- Every render builds the whole tree again, and what did not change is
  taken back laid out and drawn: an LCD repaints only what changed. For a
  card repeated in a list, `memo(Card)` (as React's) skips running it while
  its props are the same; pass it values (`<Card i={i} on={on[i]} />`) and
  make its `onClick` inside it, since a function made anew each render is
  never equal.
- Fields: `<input value={v} onChange={(e) => { v = e.target.value }} />`
  and `<textarea>`, controlled as in React (`placeholder`, `type="password"`
  or `"number"`, `onKeyDown` with `e.key`; `focus:` and `placeholder:`
  classes). A tap gives a field the keyboard: on a touch screen with none
  of its own, a US keyboard on the screen under the UI. Always pass `value`.
- Select boxes: `<select value={v} placeholder="…" onChange={(e) => { v =
  e.target.value }}><option value="a">A</option></select>`. The list opens
  above or below it, stays on the screen and scrolls; style the chosen one
  through the `<option>`'s own `className`, and use it when the choices are
  many (a few fit better as buttons on a touch screen).
- Lists longer than the screen: give the box a height (`flex-1` in a
  column, `h-*`, `max-h-*`) and `overflow-y-auto`, and a finger (or a wheel)
  scrolls it; no paging needed on an LCD. `overflow-hidden` clips.
- Not there: rounded clipping, shadows, transforms, `z-*`, momentum when a
  list is flung, text selection. `docs/jsx-ui.md` has the full list.

## Layouts

A layout is what goes around the other scenes of a frame: a status bar with the
clock, a taskbar, a border. When someone asks for a layout, or for anything that
should stay around every scene, build a layout, not a split and not a copy of
their scene with a bar added.

A layout is one scene, and it has to be exactly this: `"isLayout": true` in its
`settings`, an `event` node for `render`, one `render/image` node, and one
`app.tsx` app feeding that node's `image` that returns JSX with a `<yield />`
where the wrapped scene goes. `<yield />` is written in lower case. Anything else
is refused when it is saved.

```tsx
export function get(app) {
  const now = new Date()
  // Nothing changes until the minute does.
  frameos.setNextSleep(60 - now.getSeconds())
  return (
    <div className="flex flex-col w-full h-full bg-black text-white">
      <div className="flex items-center h-[9vh] px-[3vw] text-[4vh]" onClick={() => frameos.dispatch('sceneSwitcher')}>
        <span className="flex-1 truncate">{app.frame.sceneName}</span>
        <span>{`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`}</span>
      </div>
      <yield />
    </div>
  )
}
```

- Give the app no fields it does not need. The scene's public `fields` are the
  layout's settings; the person sets them for each scene that wears it.
- Set `refreshInterval` to 1 and use `frameos.setNextSleep` as above: the bar
  draws once a minute, and only what is due redraws.
- Size the bar in `vh` and `vw`, so it fits every panel.
- `<yield />` must stay opaque, with nothing drawn over it and no scrolling box
  around it, or the frame has to composite a picture of the scene at a real cost.
- `app.frame.sceneName` is the name of the scene it wraps. `app.frame.wifiRssi`
  and `app.frame.batteryPercent` are undefined on a frame that cannot tell: check
  first and draw nothing then.
- Handlers open the frame's own screens: `frameos.dispatch('sceneSwitcher')` the
  scene list, `frameos.dispatch('sceneSettings')` the settings of the scene
  showing, and `frameos.dispatch('sceneSettings', {page: 'frame'})` the frame's.
- A layout stays up around those built-in screens too. To give them the whole
  panel, start `get` with `if (app.frame.systemScene) return <yield />`.
- A layout on its own has nothing to wrap, so its `<yield />` is an empty area in
  a render. That is correct, not a blank to fix.
- A layout is in no scene list and is never shown by itself. It goes on a scene
  under that scene's picture, or for all of them in the frame's Settings under
  Layouts. Tell the person that once it is built.

## Images, SVG and text

An `<svg>` from JSX, `render/svg` and `frameos.svg()` all use a strict
renderer. Any tag outside this list fails the whole drawing ("Failed to render
SVG"; in a JS app, "No image provided"): `svg` (with a `viewBox`), `g`,
`path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text` /
`tspan`, `linearGradient`, `radialGradient`, `defs` (for gradients only),
`title`, `desc`. Not supported: `use`, `image`, `filter`, `mask`, `clipPath`,
`pattern`, `style`, `foreignObject`, `symbol`, `marker`.

- Gradients always have `gradientUnits="userSpaceOnUse"` (the SVG default
  fails the drawing), coordinates in viewBox units, and `<stop>` children
  with an `offset` from 0 to 1, a hex `stopColor` and an optional
  `stopOpacity`. Fills only: a stroke cannot use a gradient. For a
  full-screen gradient, `render/gradient` is simpler.

  ```tsx
  <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
      <stop offset="0" stopColor="#0f172a" />
      <stop offset="1" stopColor="#1e3a5f" />
    </linearGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx={W / 2} cy={H * 0.2} r={H * 0.6}>
      <stop offset="0" stopColor="#ffe08a" stopOpacity="0.8" />
      <stop offset="1" stopColor="#ffe08a" stopOpacity="0" />
    </radialGradient>
    <rect width={W} height={H} fill="url(#bg)" />
    <rect width={W} height={H} fill="url(#glow)" />
  </svg>
  ```
- Text in JSX is drawn as written: `{name}` needs no escaping. Markup is
  XML: an SVG string that came from elsewhere (`render/svg`,
  `frameos.svg()`) fails whole on a single raw `&`.
- `<text>` is drawn as glyph outlines, so fill, stroke, gradients, opacity and
  transforms work on it. Supported: `x`, `y`, `dx` / `dy` (the first value),
  `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `textAnchor`,
  `dominantBaseline` (`font-family` and so on in markup), and `<tspan>`
  children. Not supported: wrapping, `textPath`, `textLength`,
  `letterSpacing`, per-glyph positions, emoji. One line per `text` or
  `tspan`: break lines yourself, or set the text in a UI, which wraps it.
- `render/text` wraps text and takes caret styling with
  `richText: "basic-caret"`: `^(16)` size, `^(#FF00FF)` color,
  `^(PTSans-Bold.ttf)` font, `^(underline)`, combined as `^(16,#FF0000)`,
  `^(reset)` to reset. Use it for a paragraph over a picture another app drew.
- Fonts: `Ubuntu-*`, `PTSans-*`, `FiraGO-*`, `CormorantGaramond-*`,
  `LiberationSans-*`, `LiberationSerif-*`, `LiberationMono-*`,
  `CascadiaMono`, `ComicRelief`, `Galindo-Regular`, `Peralta-Regular` (all
  `.ttf`), plus the fonts people upload. A `fontFamily` matches them
  loosely ("PT Sans" finds `PTSans-Regular.ttf`); an unknown one falls back to
  the default face. On an ESP32, text always uses the built-in Ubuntu
  face, whatever the family says.

## Layout and color

- The same scene is installed on 800×480, 480×800, 1200×825 and 1600×1200
  panels. Work out every coordinate, size and font size from the canvas
  (`context.imageWidth` / `imageHeight` in a JS app and in a code node: the
  area being drawn into, already turned with the frame, a cell's when drawing
  into a cell), for example `unit = Math.min(W, H) / 100`, and return
  ``<svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>`` with those
  numbers. Never hard-code 800×600, and never add width or height fields
  "just in case".
- Branch on orientation: when `H > W`, stack columns vertically.
- Keep a margin of about 4% of the shorter side, and never draw past the
  edge. A UI wraps and truncates text by itself (`truncate`,
  `line-clamp-N`); inside an `<svg>`, estimate a line's characters as
  `width / (fontSize * 0.55)`, wrap and truncate with an ellipsis yourself,
  and shrink a headline that does not fit. An 800×480 panel reads well at 24–48 px body text, 1600×1200 at
  40–80 px.
- Frames are color e-ink (a Spectra 6 panel dithers to black, white, red,
  yellow, green and blue), black-and-white e-ink, or HDMI and LCD panels.
  Unless asked for monochrome, design with color, but calmly: soft gradients
  of two related tones, deep or muted colors (navy, teal, forest, plum,
  terracotta, ochre, charcoal, warm off-white), and one accent color for the
  key figure. Never put pure primaries side by side or use them as large
  fills. Keep text-to-background contrast high so it survives dithering.

## Small frames

The scene that runs on a Raspberry Pi with hundreds of MB also gets installed
on an ESP32, where a few MB hold the canvas, the JS heap (at most 8 MB per
scene), the fonts and the network. Write every code node and JS app for that
device. What counts is what stays alive and how much a render allocates, not
terse code:

- Parsed objects cost 10–20× their JSON text; strings cost about 1×. Never
  embed big object or array literals (GeoJSON, coordinate lists, lookup
  tables): ship such data as compact strings, SVG path `d` strings or
  delimited text split when needed.
- Keep only what you draw. Take the fields you need out of a fetched payload
  at once, cut lists to what fits on screen before mapping over them, ask an
  API for fewer rows and fields when it allows, and never keep whole responses
  in module variables, `remember` or state.
- Build a drawing as JSX, with `.map()` over the data, never as a string.
  Keep it small: round coordinates to one decimal, thin polylines to what the
  pixels can show, scale a shape with one
  `<g transform={`translate(${x} ${y}) scale(${s})`}>`, and stay in the
  hundreds of elements, not thousands.
- A scene that renders every second or faster sets up its buffers in `init()`
  and updates them in place: flat arrays of numbers, fixed-size pools, no new
  objects, closures or big strings per frame beyond the JSX it returns, no
  fetch or `JSON.parse` while rendering, and a hard cap on particle counts.
  `memo(Component)` hands back the part of the drawing that did not change. Those buffers are rebuilt on
  every render on an ESP32, so positions come from the clock.
- The runtime stops a script after 20 seconds of JavaScript on an ESP32 (30
  on a Pi), and a render or an event after 90 seconds in all (120 on a Pi, 60
  in the preview), HTTP included.

## Events

An `event` node starts a flow when its event happens; a `dispatch` node sends
one. A scene listens for the events in the table below with an `event` node
whose `keyword` is the event's name, and its flow reads the event's payload as
`context.payload` (in a JS app, `context.payload` too). A scene can also send
and listen for events of its own: any other name is a custom event, declared
in the scene's `customEvents` as `{ name }` (at most 63 characters). A
schedule or the cloud may send one only when its declaration lists them in
`origins`: `{ "name": "nextPage", "origins": ["schedule"] }`.

A scene with pages or a set of pictures listens for `back` and `forward`
rather than a custom event or a swipe of its own: a touch screen's swipe in
from the left or the right edge is one of them on every frame (as a phone's
back gesture), and a key may be bound to them. They never change the scene.

<!-- BEGIN GENERATED: events -->
| event | an `event` node hears it | a `dispatch` node sends it | `context.payload` | where | what |
|---|---|---|---|---|---|
| `init` | yes |  |  | all | Once per scene, when it is first loaded and its apps are ready — before its first open and render. |
| `render` | yes | yes |  | all | Render the scene. |
| `open` | yes |  | `sceneId` scene | all | Every time the scene becomes the frame's current scene: at boot, and whenever the frame switches to it, including switching back. |
| `close` | yes |  |  | all | When the frame switches away from the scene to another one. |
| `keyDown` | yes |  | `code` string, `key` string, `repeat` boolean, `shift` boolean, `ctrl` boolean, `alt` boolean, `meta` boolean, `linuxCode`? integer | Pi, preview | When a key is pressed on a keyboard (or held: `repeat`). |
| `keyUp` | yes |  | `code` string, `key` string, `shift` boolean, `ctrl` boolean, `alt` boolean, `meta` boolean, `linuxCode`? integer | Pi, preview | When a key is released on a keyboard |
| `textInput` | yes |  | `text` string | Pi, preview | Text a key press produced under the frame's keyboard layout, one event per printable key (Ctrl/Alt/Meta chords produce none). |
| `pointerMove` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string, `buttons` integer | all | When a pointer (a finger, a mouse, a pen) moves |
| `pointerDown` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string | all | When a pointer button is pressed or a finger touches the panel. |
| `pointerUp` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string | all | When a pointer button is released or a finger lifts |
| `pointerCancel` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | all | When a pointer that was down is lost without a release: the queue overflowed, the device went away. |
| `mouseMove` | yes |  | `x` integer, `y` integer | all | When a mouse moves. |
| `mouseDown` | yes |  | `button` integer | all | When a mouse button is pressed. |
| `mouseUp` | yes |  | `button` integer | all | When a mouse button is released. |
| `tap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | all | A press and release in one place, within `gestures.tapMs`. |
| `doubleTap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | all | A second `tap` in the same place within `gestures.doubleTapMs` of the first. |
| `longPress` | yes |  | `x` integer, `y` integer, `durationMs` integer, `pointerId` integer, `pointerType` string | all | A pointer held in one place for `gestures.longPressMs`. |
| `swipe` | yes |  | `direction` string, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | all | A press and a release at least `gestures.swipeMinPx` apart, in one of four directions. |
| `edgeSwipe` | yes |  | `edge` string, `direction` string, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | all | A finger or a pen that went down within `gestures.edgePx` of an edge of the screen and moved at least `gestures.swipeMinPx` away from it, as on a phone: `edge` is where it started, `direction` the way it went. |
| `wheel` | yes |  | `deltaX` integer, `deltaY` integer, `x` integer, `y` integer | Pi, preview | When a mouse wheel is scrolled. |
| `turnOn` | yes | yes |  | all | Turn the screen on |
| `turnOff` | yes | yes |  | all | Turn the screen off |
| `toggleScreen` |  | yes |  | all | Turn the screen off when it is on, and on when it is off. |
| `gpio` | yes |  | `pin` integer, `label` string, `role` string, `action` string, `durationMs`? integer, `wake`? boolean, `claimed`? boolean, `atMs`? integer, `level`? integer | all | A GPIO button going `down` or `up`, the moment it happens. |
| `button` | yes |  | `pin` integer, `label` string, `role` string, `action` string, `durationMs`? integer, `wake`? boolean, `atMs`? integer | all | A GPIO button pressed: a `press`, a `doublePress` or a `longPress`, one event per press. |
| `setSceneState` |  | yes | `state`? json, `render`? boolean | all | Set the scene's public state. |
| `setCurrentScene` |  | yes | `sceneId`? scene, `direction`? string, `state`? json | all | Switch the frame to another scene: the one `sceneId` names, or with `direction` the `next` / `prev` one in the frame's scene list (the control plane's order, wrapping around; one of the two is required). |
| `sceneSwitcher` |  | yes | `swap`? boolean | all | Show the scene switcher (`scenes.switcher`, docs/scene-switcher.md): every scene on the frame as a tile with its title, in the frame's scene list order, to tap or to pick with the buttons. |
| `sceneSettings` |  | yes | `page`? string | all | Show the scene's settings (`scenes.settings`, docs/scene-settings.md): the public fields of the scene showing, as a form to change and save. |
| `back` | yes |  |  | all | Go back, as a phone's back gesture does: what that is is the scene's (the photo or the page before; the scene switcher turns its page back, the scene settings close unsaved), and a scene that does not listen for it stays as it is. |
| `forward` | yes |  |  | all | Go forward, the other way from `back`: the next photo or page (the scene switcher turns its page on). |
<!-- END GENERATED: events -->

## JS API reference

What a JS app sees, exactly as the editor's type checker declares it. Code
nodes see none of this (see [Code nodes](#code-nodes)).

<!-- BEGIN GENERATED: js-api -->
```ts
type FrameOSJson = null | boolean | number | string | FrameOSJson[] | { [key: string]: FrameOSJson };

interface FrameOSAppConfig {
  [key: string]: any;
}

interface FrameOSImageSpec {
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  svg?: string;
  dataUrl?: string;
  base64?: string;
  [key: string]: any;
}

interface FrameOSImageRef {
  __frameosType: "imageRef";
  id: number;
  width: number;
  height: number;
}
/** What frameos.canvas returns: an image ref an img's src takes, that frameos.draw and frameos.clear draw into. */
interface FrameOSCanvasRef extends FrameOSImageRef {
  canvas: string;
  version: number;
  fresh: boolean;
}

interface FrameOSNodeRef {
  __frameosType: "node";
  nodeId: number;
}

interface FrameOSSceneRef {
  __frameosType: "scene";
  sceneId: string;
}

interface FrameOSColorRef {
  __frameosType: "color";
  color: string;
}
interface FrameOSStreamRef { __frameosType: "streamRef"; id?: number; spool?: string; }

/**
 * What JSX makes in an app (.tsx): get() can return it as its image. An <svg>
 * is drawn as it is; any other element is a UI laid out with Tailwind classes
 * (className="flex items-center gap-2 p-4 bg-slate-900 text-white") —
 * docs/jsx-ui.md has what is supported. <img src={...}> takes the image
 * frameos.fetchImage or frameos.loadAssetImage returned.
 */
interface FrameOSElement { type: string; props: Record<string, any>; }
/** What a handler gets: the pointer event, and where in the element it was. */
interface FrameOSUiEvent {
  type: "tap" | "doubleTap" | "longPress" | "swipe" | "pointerDown" | "pointerUp" | "pointerMove" | "change" | "keyDown";
  x: number;
  y: number;
  localX: number;
  localY: number;
  /** The element's size, in scene pixels: localX / width is how far along it the pointer is, at any frame size. Absent before 2026.10.22. */
  width?: number;
  height?: number;
  pointerId?: number;
  pointerType?: "mouse" | "touch" | "pen";
  /** A swipe's way: "left", "right", "up" or "down". */
  direction?: "left" | "right" | "up" | "down";
  /** onChange of an <input> or <textarea>: its text now (also as target.value, as in React). */
  value?: string;
  target?: { value: string };
  /** onKeyDown of a field: the key ("a", "Enter", "Backspace"). */
  key?: string;
  [key: string]: any;
}
interface FrameOSElementProps {
  className?: string;
  children?: any;
  src?: FrameOSImageRef | { image: FrameOSImageRef | null } | null;
  /** A tap on the element; the frame renders again after it. */
  onClick?: (event: FrameOSUiEvent) => void;
  onDoubleClick?: (event: FrameOSUiEvent) => void;
  onLongPress?: (event: FrameOSUiEvent) => void;
  onPointerDown?: (event: FrameOSUiEvent) => void;
  onPointerUp?: (event: FrameOSUiEvent) => void;
  /** The pointer moved: over the element, or anywhere while a press it took is held (captured until the release). */
  onPointerMove?: (event: FrameOSUiEvent) => void;
  /** A swipe that began on the element, with its direction; one in from the screen edge is the frame's. */
  onSwipe?: (event: FrameOSUiEvent) => void;
  /** <input> and <textarea>: the text shown (keep it in a variable, set it in onChange), a hint while empty, and the kind of field. */
  value?: string | number;
  placeholder?: string;
  type?: "text" | "password" | "number";
  /** Every edit of a field, with its text now: e.value, or e.target.value. onInput is the same. Absent before 2026.10.22. */
  onChange?: (event: FrameOSUiEvent) => void;
  onInput?: (event: FrameOSUiEvent) => void;
  /** A key typed into a field (on the screen's keyboard or a real one), before it is applied: e.key. */
  onKeyDown?: (event: FrameOSUiEvent) => void;
  [attribute: string]: any;
}
/**
 * <Scene id="..." /> draws another scene of this frame, at the place and size the UI
 * gives it (flex-1 unless the classes say). Other props are that scene's state. It renders on its
 * own schedule. FrameOS 2026.11.5+.
 */
declare const Scene: string;
/**
 * <yield />: where a layout shows the scene it wraps (docs/scene-layouts.md).
 * FrameOS 2026.11.5+.
 */
declare namespace JSX {
  type Element = FrameOSElement;
  interface ElementChildrenAttribute { children: {}; }
  interface IntrinsicElements { [tag: string]: FrameOSElementProps; }
}
/**
 * memo(Component), as React's: called with props shallow-equal to its last
 * call at the same place (its turn among this render's calls, or its key),
 * the component does not run and the frame takes that element's layout and
 * drawing back as they were. A function made anew each render
 * (onClick={() => ...}) is never equal: pass values, make handlers inside.
 */
declare function memo<P extends Record<string, any>>(component: (props: P) => any): (props: P & { key?: string | number }) => any;

interface FrameOSApp {
  nodeId: number;
  nodeName: string;
  category: string;
  config: FrameOSAppConfig;
  state: Record<string, any>;
  frame: {
    /** The panel's width; for a .tsx or .jsx app, divided by the render scale. */
    width: number;
    /** The panel's height; for a .tsx or .jsx app, divided by the render scale. */
    height: number;
    rotate: number;
    assetsPath: string;
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
    /** The render scale that applies to the scene. A .tsx or .jsx app's sizes are the panel's
     * divided by it, and its JSX is drawn that many times larger (FrameOS 2026.10.22+; undefined before). */
    scale?: number;
    /** A panel that shows a change only in a refresh, as e-paper and a monochrome OLED do. An app that follows
     * a finger waits for it to lift there (FrameOS 2026.11.5+; undefined before). */
    paper?: boolean;
    /** Whether the panel shows colors (an LCD, an HDMI screen, a four-, six- or seven-ink e-paper). False on
     * a black-and-white or grey panel, where a scene reads better drawn in high contrast (FrameOS 2026.11.6+;
     * undefined before, so treat undefined as color). */
    color?: boolean;
    /** The name of the scene showing. A layout's app gets the name of the scene it wraps (FrameOS 2026.11.5+;
     * undefined before). */
    sceneName?: string;
    /** True in a layout's app while it wraps a built-in scene (the scene list, the settings). Returning a bare <yield />
     * then gives that scene the whole panel (FrameOS 2026.11.5+; undefined before). */
    systemScene?: boolean;
    /** The battery's charge from 0 to 100, on an ESP32 frame with a battery. Undefined elsewhere, so check
     * before drawing it (FrameOS 2026.11.5+; undefined before). */
    batteryPercent?: number;
    /** The Wi-Fi signal in dBm, about -50 strong and -85 weak, on an ESP32 frame that is connected. Undefined
     * elsewhere, so check before drawing it (FrameOS 2026.11.5+; undefined before). */
    wifiRssi?: number;
  };
  initialized?: boolean;
  log(...args: any[]): void;
  logError(...args: any[]): void;
  [key: string]: any;
}

/** What each built-in scene event carries in `context.payload` (docs/events.md). */
interface FrameOSEventPayloads {
  /** Once per scene, when it is first loaded and its apps are ready — before its first open and render. */
  init: Record<string, any>;
  /** Render the scene. Triggered according to the frame's refresh interval, or when explicitly requested. */
  render: Record<string, any>;
  /** Every time the scene becomes the frame's current scene: at boot, and whenever the frame switches to it, including switching back. */
  open: { sceneId: string };
  /** When the frame switches away from the scene to another one. Carries no payload. */
  close: Record<string, never>;
  /** When a key is pressed on a keyboard (or held: `repeat`). `code` is the physical key (`KeyA`, `ArrowLeft`), `key` what it means under the frame's keyboard layout (`a`, `A`, `Enter`). */
  keyDown: { code: string; key: string; repeat: boolean; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean; linuxCode?: number };
  /** When a key is released on a keyboard */
  keyUp: { code: string; key: string; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean; linuxCode?: number };
  /** Text a key press produced under the frame's keyboard layout, one event per printable key (Ctrl/Alt/Meta chords produce none). Made by the dispatcher from `keyDown`; a preview forwards the browser's `beforeinput`. */
  textInput: { text: string };
  /** When a pointer (a finger, a mouse, a pen) moves (not logged) */
  pointerMove: { x: number; y: number; pointerId: number; pointerType: string; buttons: number };
  /** When a pointer button is pressed or a finger touches the panel (not logged). The position is on every pointer event. */
  pointerDown: { x: number; y: number; button: number; buttons: number; pointerId: number; pointerType: string };
  /** When a pointer button is released or a finger lifts (not logged) */
  pointerUp: { x: number; y: number; button: number; buttons: number; pointerId: number; pointerType: string };
  /** When a pointer that was down is lost without a release: the queue overflowed, the device went away. A scene holding a drag lets go. */
  pointerCancel: { x: number; y: number; pointerId: number; pointerType: string };
  /** When a mouse moves (not logged). An alias of `pointerMove` with its old payload. */
  mouseMove: { x: number; y: number };
  /** When a mouse button is pressed (not logged). An alias of `pointerDown` with its old payload. */
  mouseDown: { button: number };
  /** When a mouse button is released (not logged). An alias of `pointerUp` with its old payload. */
  mouseUp: { button: number };
  /** A press and release in one place, within `gestures.tapMs`. Made by the dispatcher from `pointerDown` / `pointerUp` on every host. */
  tap: { x: number; y: number; pointerId: number; pointerType: string };
  /** A second `tap` in the same place within `gestures.doubleTapMs` of the first. The first tap is delivered too. */
  doubleTap: { x: number; y: number; pointerId: number; pointerType: string };
  /** A pointer held in one place for `gestures.longPressMs`. Delivered while it is still held where the host ticks the dispatcher, on release otherwise; no `tap` follows it. */
  longPress: { x: number; y: number; durationMs: number; pointerId: number; pointerType: string };
  /** A press and a release at least `gestures.swipeMinPx` apart, in one of four directions. */
  swipe: { direction: string; x: number; y: number; startX: number; startY: number; pointerId: number; pointerType: string };
  /** A finger or a pen that went down within `gestures.edgePx` of an edge of the screen and moved at least `gestures.swipeMinPx` away from it, as on a phone: `edge` is where it started, `direction` the way it went. The frame takes that touch: the scene hears no pointerDown, pointerMove or pointerUp of it, so a slider under it stays as it was. A touch there that lifts, holds or moves along the edge instead is the scene's after all, with its pointerDown a little late. Not a mouse. */
  edgeSwipe: { edge: string; direction: string; x: number; y: number; startX: number; startY: number; pointerId: number; pointerType: string };
  /** When a mouse wheel is scrolled (not logged). Deltas are wheel notches; deltaY is positive when scrolling down (towards the user), deltaX when scrolling right. */
  wheel: { deltaX: number; deltaY: number; x: number; y: number };
  /** Turn the screen on */
  turnOn: Record<string, never>;
  /** Turn the screen off */
  turnOff: Record<string, never>;
  /** Turn the screen off when it is on, and on when it is off. The scene hears the `turnOn` or `turnOff` it became. */
  toggleScreen: Record<string, never>;
  /** A GPIO button going `down` or `up`, the moment it happens. `up` says how long it was held. */
  gpio: { pin: number; label: string; role: string; action: string; durationMs?: number; wake?: boolean; claimed?: boolean; atMs?: number; level?: number };
  /** A GPIO button pressed: a `press`, a `doublePress` or a `longPress`, one event per press. */
  button: { pin: number; label: string; role: string; action: string; durationMs?: number; wake?: boolean; atMs?: number };
  /** Set the scene's public state. This is not used for private state changes. */
  setSceneState: { state?: any; render?: boolean };
  /** Switch the frame to another scene: the one `sceneId` names, or with `direction` the `next` / `prev` one in the frame's scene list (the control plane's order, wrapping around; one of the two is required). An optional `state` object is applied to that scene's public state. */
  setCurrentScene: { sceneId?: string; direction?: string; state?: any };
  /** Show the scene switcher (`scenes.switcher`, docs/scene-switcher.md): every scene on the frame as a tile with its title, in the frame's scene list order, to tap or to pick with the buttons. While it or the scene settings show, go back to the scene they were opened from instead. The frame's event map binds it to a swipe in from the bottom edge on a touch screen. */
  sceneSwitcher: { swap?: boolean };
  /** Show the scene's settings (`scenes.settings`, docs/scene-settings.md): the public fields of the scene showing, as a form to change and save. While it or the scene switcher shows, go back to the scene they were opened from (without saving) instead. The frame's event map binds it to a swipe in from the top edge on a touch screen. */
  sceneSettings: { page?: string };
  /** Go back, as a phone's back gesture does: what that is is the scene's (the photo or the page before; the scene switcher turns its page back, the scene settings close unsaved), and a scene that does not listen for it stays as it is. It never switches the scene. The frame's event map binds it to a swipe in from the left edge on a touch screen. */
  back: Record<string, never>;
  /** Go forward, the other way from `back`: the next photo or page (the scene switcher turns its page on). It never switches the scene. The frame's event map binds it to a swipe in from the right edge on a touch screen. */
  forward: Record<string, never>;
}

interface FrameOSContext {
  /** The name of the event this run is handling. */
  event: keyof FrameOSEventPayloads | (string & {});
  /** That event's payload. */
  payload: any;
  /** Index of the current iteration inside a loop. */
  loopIndex: number;
  /** Key of the current iteration inside a loop. */
  loopKey: string;
  /** Whether the run carries a canvas. */
  hasImage: boolean;
  /** Seconds until the next render. */
  nextSleep: number;
  /** The canvas, when there is one. */
  image?: FrameOSImageRef;
  /** Width of the canvas. In scene pixels, of the canvas this run draws on (a cell's inside render/split); absent when the run has none. */
  imageWidth?: number;
  /** Height of the canvas. In scene pixels, of the canvas this run draws on (a cell's inside render/split); absent when the run has none. */
  imageHeight?: number;
  /** Width the image this app returns will be drawn at, in scene pixels: the decode target the interpreter addressed to this node (the frame, a split cell, or the bounds of a consumer that cannot draw it straight in). Absent when nothing is addressed to the node. An app that fetches a picture asks its source for this size, not app.frame's (2026.10.24+). */
  targetWidth?: number;
  /** Height of that target, in scene pixels; absent with targetWidth (2026.10.24+). */
  targetHeight?: number;
  /** How the consumer places the image into that target: its placement (cover, contain, stretch, center, ...). Absent with targetWidth, and when the consumer's bounds rather than a target were addressed (2026.10.24+). */
  targetFit?: string;
  [key: string]: any;
}

/** The typed arrays frameos.ops takes. */
type FrameOSTypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array;
/** An 8-bit palette frame's cells: one byte each, an index into its palette. */
type FrameOSPixelCells = Uint8Array | Uint8ClampedArray;
/** Up to 256 colors as 0xRRGGBB numbers. */
type FrameOSPalette = number[] | Uint32Array;
declare const frameos: {
  image(spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image" };
  /** SVG markup that came from elsewhere (a download, an asset) as an image. A drawing the app makes is JSX returned from a .tsx app's get(), never markup built as a string. */
  svg(svg: string, spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image"; svg: string };
  node(nodeId: number): FrameOSNodeRef;
  scene(sceneId: string): FrameOSSceneRef;
  color(color: string): FrameOSColorRef;
  log(...args: any[]): void;
  error(...args: any[]): void;
  setNextSleep(seconds: number): void;
  /** Sends an event as a dispatch node does: render, setCurrentScene, setSceneState, sceneSwitcher, sceneSettings or a
   * custom event of the scene's. An event a scene may not send is logged and dropped (FrameOS 2026.11.5+). */
  dispatch(event: string, payload?: Record<string, any>): void;
  fetchText(url: string): string;
  fetchJson(url: string): any;
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      base64?: boolean;
      timeoutMs?: number;
      find?: string;
      findLength?: number;
      findLimit?: number;
    }
  ): { status: number; body?: string; bodyBase64?: string; found?: string[]; error?: string };
  fetchImage(
    url: string,
    options?: {
      headers?: Record<string, string>;
      saveAsset?: { name: string; extension?: string; mode?: "auto" | "always" };
      exif?: boolean;
      // The image's color profile (a .frameos.json sidecar's colors object); null = none, clears the last palette.
      colors?: { [key: string]: any } | null;
      // Keep the picture for later renders (a JSX gallery's photo, drawn again without a download) until
      // frameos.releaseImage(ref) or the interpreter goes; 8 at most. Never the consumer's target.
      keep?: boolean;
      // With keep: the size to decode it at, in the canvas's pixel format (a host decodes at the picture's own size).
      width?: number;
      height?: number;
      fit?: "cover" | "contain";
    }
  ): {
    image: FrameOSImageRef | null;
    width?: number;
    height?: number;
    error?: string;
    savedAs?: string;
    exif?: Record<string, any>;
    exifSummary?: string;
  };
  /** Lets a picture fetchImage kept ({ keep: true }) go. False for one that was not kept, or is gone. */
  releaseImage(image: FrameOSImageRef | { image: FrameOSImageRef | null } | null): boolean;
  /**
   * The app's canvas called key: a picture it draws into and shows as an img's src. Made and filled with
   * color (white) the first time, or when the size changes; the same picture every render while the interpreter
   * lives (4 at most). Its fresh is true the render it was made: draw your record into it again then.
   */
  canvas(key: string, width: number, height: number, color?: string): FrameOSCanvasRef | null;
  /** Draws SVG (JSX: <line>, <circle>, <path>, <polyline>, <g>, an <svg viewBox>; or markup) into a canvas, over what is there. */
  draw(canvas: FrameOSCanvasRef, content: FrameOSElement | string): boolean;
  /** Fills a canvas with color (white by default). */
  clear(canvas: FrameOSCanvasRef, color?: string): boolean;
  /**
   * The 8-bit palette mode, to return from get() (FrameOS 2026.11.8+): width x height cells, a byte each, rows top to
   * bottom, each an index into palette (up to 256 0xRRGGBB colors; past its end, black) drawn as a pixelSize square.
   * Written straight into the panel's buffer with no canvas and no JSX, rewriting only the cells whose index or color
   * changed since the last frame: animate the cells, or only the palette (color cycling). width and height default to
   * the frame's size over pixelSize.
   */
  pixels(cells: FrameOSPixelCells, palette: FrameOSPalette, options?: { width?: number; height?: number; pixelSize?: number }): unknown;
  /**
   * Whole typed arrays at a time, at native speed (FrameOS 2026.11.8+): a per-cell pass in one call instead of a
   * loop of bytecodes. Each element is read and stored by its array's kind (Uint8Clamped clamps, other integers
   * wrap, Float32 is a float, a number b is a Float32 too); BigInt, Float16 and Float64 arrays are refused (false).
   * start and end are elements. Check for it (if (frameos.ops)) to run on older FrameOS too.
   */
  ops: {
    /** dst[i] = table[src[i]]: a fade, a palette remap. An index past the table leaves dst[i] as it is. */
    map(dst: FrameOSTypedArray, src: FrameOSTypedArray, table: FrameOSTypedArray, start?: number, end?: number): boolean;
    /** dst[i] = a[i] + b[i], or + b when b is a number. */
    add(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    sub(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    mul(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    /**
     * A 3x3 integer kernel (9 weights, row by row) over a grid width wide, shifted right by shift; the edges are left
     * as they are, so a dst whose edges must hold still holds nothing else (write other values to another array).
     * dst can be src only when the centre alone weighs: it reads cells it has written.
     */
    convolve(dst: FrameOSTypedArray, src: FrameOSTypedArray, width: number, kernel: number[], shift?: number): boolean;
  };
  listAssets(dir?: string): string[];
  assetExists(path: string): boolean;
  assetSize(path: string): number;
  readAsset(path: string, options?: { offset?: number; length?: number }): string | null;
  writeAsset(path: string, base64: string): boolean;
  appendAsset(path: string, base64: string): boolean;
  deleteAsset(path: string): boolean;
  loadAssetImage(path: string): FrameOSImageRef | null;
  openAssetStream(path: string, mode?: "r" | "w" | "a"): FrameOSStreamRef | null;
  createStream(base64: string): FrameOSStreamRef | null;
  streamRead(stream: FrameOSStreamRef | number, length: number): string | null;
  streamWrite(stream: FrameOSStreamRef | number, base64: string): boolean;
  streamAtEnd(stream: FrameOSStreamRef | number): boolean;
  streamRewind(stream: FrameOSStreamRef | number): boolean;
  streamClose(stream: FrameOSStreamRef | number): boolean;
  /**
   * Reads text a line at a time without ever holding it whole (FrameOS 2026.11.6+): a string, a stream, or a
   * field whose config.json entry has "capabilities": { "byteIter": {} }, which gets a downloaded body as a stream
   * however large it is. Lines not starting with one of `only` are read past natively and cost nothing. Closed when
   * the call that opened it returns.
   */
  openLines(
    source: FrameOSStreamRef | string,
    options?: {
      /** A line starting with a space or tab continues the one before (iCal, vCard, mail headers). */
      unfold?: boolean;
      /** Strip whitespace off both ends. */
      trim?: boolean;
      /** Keep only the lines starting with one of these. */
      only?: string[];
      /** Bytes; a longer line is cut. 65536 by default. */
      maxLength?: number;
    }
  ): FrameOSStreamRef | null;
  /** The next line of an openLines reader, or null at the end. */
  nextLine(stream: FrameOSStreamRef | number): string | null;
  /** The lines up to the next one starting with stop (which only must keep), joined with newlines, stop left out;
   * null when the text ends first. One call for a whole record, the cheap way through a long feed. */
  nextBlock(stream: FrameOSStreamRef | number, stop: string): string | null;
  /** A time zone's canonical name and its UTC offsets: changes is [start, offset, start, offset, ...] in seconds,
   * empty on a frame without that zone's data (FrameOS 2026.11.6+). */
  timeZone(name: string): { name: string; changes: number[] };
  getSetting(...path: string[]): any;
  setState(key: string, value: FrameOSJson): void;
  /** Keep a value for this node between renders (FrameOS 2026.10.13+). null forgets it. */
  remember(key: string, value: FrameOSJson): boolean;
  recall(key: string): FrameOSJson | undefined;
};

/** console.log and friends log like frameos.log; warn says so; error goes to the error log (FrameOS 2026.10.16+). */
declare const console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};
```
<!-- END GENERATED: js-api -->

## Checklist

- `settings.execution` is `"interpreted"`, and one `render` event node starts
  one straight render flow.
- Every app keyword exists, every `config` key is one of its fields, and
  every select value is one of its options.
- `node` fields are edges from `field/<name>`, never config.
- Every code node argument is declared in `codeArgs` and fed by an edge.
- Images go only into image fields; nothing keeps an image in state.
- Time formats in code nodes use `{hour/2}`-style tokens.
- A JS app whose node feeds a field is a `data` app exporting `get`; one whose
  node sits in a flow, after any event node, is a `logic` app exporting `run`.
- A JS app keeps what must outlast a render with `frameos.remember` (private)
  or `frameos.setState` (shared), never in a module variable.
- A drawing is JSX from an `app.tsx` app, never SVG markup built as a
  string; its `<svg>` uses only the supported tags, and gradients use
  `userSpaceOnUse`.
- Sizes come from the frame, not from constants.
- Nothing big is embedded as an object literal or kept alive between renders.
