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
- `settings.icon` (optional): a small picture of the scene for the lists that
  show it without its picture (the frame's scene switcher, desktop layouts,
  the editor's lists). ONE SVG path `d` string in a `0 0 24 24` box, at most
  1024 characters, starting with `M`, filled (nonzero) with the color of the
  text around it: no colors, strokes, transforms or other elements. A solid
  icon from a 24 px icon set (Material Design Icons, say) fits as it is, for
  example `"M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"` for a house. Anything else is
  ignored, and the lists keep their own placeholder.
- `settings.category` (optional): the scene's category by its name, which a
  desktop layout groups its list of scenes by. Pick one of the store's:
  `"Photos"` (the owner's photos or a photo service), `"Art & galleries"` (a
  collection of artwork the scene carries), `"Clocks & time"` (clocks, timers,
  the year at a glance), `"Calendars & agendas"`, `"Weather"` (real
  forecasts), `"Home & dashboards"` (a smart home, data, charts, maps, stats
  from a service), `"Games"`, `"Fun & animations"` (comics, toys,
  animations), `"Notes & tools"` (to-dos, notes, drawing, practical tools),
  `"AI & generative"` (made by an AI service), `"Demos & examples"` (a demo,
  made-up data or a building block); a layout's is `"Multi app layouts"`,
  `"Single app layouts"` or `"Device layouts"` (one made for a device, which
  `settings.devices` names: `["seeed_reterminal_sticky"]`). Write the name exactly. Which screen a scene is for
  is no category: the store reads that from the scene itself (a
  `refreshInterval` under a second needs a fast screen).
- `settings.needs` (optional): what the scene needs of a frame, when the store
  would read it wrong from the scene: a list of `"fast"` (a fast screen),
  `"touch"` (taps or a mouse), `"keys"` (a keyboard), `"buttons"` (the frame's
  buttons). Leave it out and the store works it out (a `refreshInterval`
  under a second is `"fast"`). Set it when the scene adapts: a game that
  animates on an LCD and turns into a slow puzzle on e-paper says
  `["touch", "keys", "buttons"]`.
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
`columns`, cells as above), `data/downloadUrl` (a URL's
body as text), `data/parseJson`, `logic/setAsState` (a value into state,
`stateKey` plus `valueString` or `valueJson`) and `logic/ifElse`. For the
time as text, copy the `repo/apps/text/clock` JS app into the scene: its
`format` takes the code-node tokens (`{hour/2}:{minute/2}`,
`{weekday} {day} {month/n}`). For a chart,
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
- `settings.backgroundColor` is what shows wherever nothing is drawn: the bars
  around a photo shown whole (`contain`) on a screen of another shape. To let
  people pick it, declare one `color` field with `"role": "backgroundColor"`;
  its value is then the background. Never paint the bars yourself with a
  full-screen `render/color` before the image: the background costs nothing
  when the picture covers the screen, a fill always does.
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
  (true on an ESP32, and in a preview running as one), `fast` (false where
  each change costs a refresh, as on e-paper today: animate, follow a finger
  and show presses only where it is true), `paper` (true on a panel that
  draws in inks, e-paper: few colors, greys dithered, so draw solid colors
  there; it says the look, `fast` says the speed) and `color` (false on a
  black and white or grey panel), which say the frame's panel the same way in `get()`,
  `init()`, `onEvent`, a handler and after an `await`, and `batteryPercent`
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

**One interpreter a scene.** A scene's JS apps run in one interpreter, with
its code nodes. Each app's module scope is its own (its imports, its
module-level variables; two nodes of the same app are two modules), but
`globalThis` and the built-ins belong to the scene: never keep a value on
`globalThis` or change a built-in (`Array.prototype`, `JSON`, `Date`), or
another app in the scene or a code node sees it. FrameOS 2026.11.12 and
later; before, each app had an interpreter of its own.

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
interpreter goes (8 at most, or up to 48 thumbnails with no more pixels
than eight 480x480 photos). Hold the ref in a module variable and fetch
again when it is gone: an ESP32 short of memory drops the interpreter, and
the picture with it. `frameos.loadAssetImage(path, { keep: true, width,
height })` does the same for a file in the assets folder.
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
  `appendAsset`, `deleteAsset`, `makeAssetFolder`, a stream opened with
  `"w"` or `"a"`).
- `"files"` and `"shell"` belong to built-in apps: Local Image reads any
  folder, the screenshot and camera apps run processes.
- `"frame"`: `frameos.frame`, what the frame's own settings page reads and
  does (its Wi-Fi, rotation and scale, render, restart, reboot), and only
  while the owner allows the
  settings on the frame's screen. The Terminal sample is the worked example
  (docs/terminal.md).

Saving the scene fills a JavaScript app's list from its code, so you rarely
write it. The frame gives the app exactly that list: with neither `"assets"`
nor `"assets-write"`, its asset calls live in a folder of its own,
`scenes/<sceneId>/`; with `"assets"` alone, its writes are refused. An app
with no list asks for nothing, and a list written by hand is replaced on the
next save. A scene asks for what its apps ask for, nothing more, and every
surface shows it as tags ("reads files", "writes files", "reads & writes files",
"reads all files", "runs shell commands", "changes frame settings", and
"uses OpenAI key" for each
settings namespace an app reads). Installing a scene is the approval of its
tags, and an update says which ones it adds, so ask for what the app needs
and no more.
`fetchImage({ saveAsset })` is the frame caching a download, not the app
using the folder: it needs no permission. (Frames before FrameOS 2026.10.16
ignore the lists.)

**Files and text.** `writeAsset(path, data)` and `appendAsset` take base64;
with `{ text: true }` they write the string itself as UTF-8, so text needs no
encoding: `frameos.writeAsset("notes/today.md", text, { text: true })`, and
`readAsset(path, { text: true })` reads it back. `deleteAsset` deletes a file,
or a folder once it is empty (false while anything is in it; never
recursive). For bytes, `btoa` / `atob` and a UTF-8 `TextEncoder` /
`TextDecoder` are there as on the web.

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
Every answer has the response's `headers`, names in lower case: a request
with `headers: { Range: "bytes=0-65535" }` learns the file's whole size from
`headers["content-range"]` (`bytes 0-65535/8388608`).

**Newer than some frames.** `frameos.remember` / `recall`, `httpRequest`'s
`find`, `fetchImage`'s `exif`, `app.frame.embedded` / `debug`, and a throw
painting its message all need FrameOS 2026.10.13; a frame on an older release
lacks them. A scene meant for such frames keeps to the rest. `httpRequest`'s
`headers`, `{ text: true }` writes, deleting a folder, and `btoa` / `atob` /
`TextEncoder` / `TextDecoder` need FrameOS 2026.11.12.

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
- Give a scene the window size it looks best at in `settings.windowSize`,
  `"WxH"` (`"480x480"` for a square music player or clock, `"480x800"` for a
  tall list, `"800x480"` for a wide dashboard): a desktop layout (Windows 98,
  macOS...) opens the scene's window at that size. It changes nothing else.
- **The desktop's look: `look`.** A desktop layout (Windows 98, macOS,
  BeOS, Classic Mac, NeXTSTEP, Commander, Tiling) gives a theme, and an
  element with `look="<role>"` takes that desktop's colors, borders and
  corners for the role in place of its own classes. With no desktop, or a
  theme without that role, it keeps its classes, so always write its own
  look as usual; an element without `look` keeps its own everywhere. Use it
  for the standard parts of a tool meant to sit in a desktop window (a file
  browser, a form, settings, a list): `look="page"` on the root, `"bar"` for
  its header, `"button"`, `"primary"` (the one that does it), `"selected"`
  (a lit toggle or tab), `"field"` on an `<input>`, `"option"` (a row that
  lights when pressed) and `"picked"` (the chosen row), `"switch"` /
  `"switchOn"` with `"knob"` / `"knobOn"`, `"muted"` (quieter text),
  `"accent"`, `"card"`, `"tile"` / `"tileLit"`, `"keyboard"` / `"key"` /
  `"keyMod"` / `"keyLit"`. Leave it off a scene with a designed look of its
  own (a clock face, a game, a photo, a dashboard's colors) and off any
  element that must keep its colors. `look` is not `role`: `role` themes
  nothing. `app.frame.theme` is the theme itself (role to classes,
  undefined with none), for an SVG's fill. The Files and Theme roles
  samples are the worked examples.
- Layout: block (stacked), `flex` / `flex-col` with `gap`, `grow`, `flex-1`,
  `justify-*`, `items-*`, `flex-wrap`; `grid grid-cols-N` with `col-span-N`;
  `absolute` with `inset-*` / `top-*` (against the parent). Sizes `w-*`,
  `h-*`, `size-*`, `max-w-*`, padding and margins (`mx-auto`).
- As in a browser, a flex item does not shrink below its content (its
  text's height in a column, its longest word in a row): a column with more
  than fits overflows at the bottom rather than squashing its items over
  each other. Give a long list `flex-1 overflow-y-auto` so it scrolls, and
  an item that should give way `min-h-0` / `min-w-0` or `overflow-hidden`
  (a `truncate` text already does). In a row, give the long text `flex-1`.
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
  active: for LCDs. `cursor-pointer`, `cursor-text`, `cursor-move`,
  `cursor-ew-resize` and the other CSS cursor names set the mouse cursor over
  an element where a frame has a mouse (`cursor-resize` on a window frame:
  the arrows of the edge or corner under it). Where `app.frame.fast` is false, take a drag whole as
  `onSwipe` (`direction`, `startX`/`startY` to `x`/`y`) and two fingers as
  `onPinch` (`scale`, below 1 drawn together; `startX`/`startY` the point
  between them at the start, `x`/`y` at the end): one event, one refresh.
- Every render builds the whole tree again, and what did not change is
  taken back laid out and drawn: an LCD repaints only what changed. For a
  card repeated in a list, `memo(Card)` (as React's) skips running it while
  its props are the same; pass it values (`<Card i={i} on={on[i]} />`) and
  make its `onClick` inside it, since a function made anew each render is
  never equal.
- What a tap changes can be a `signal(v)` (FrameOS 2026.11.14+): a `memo()`'d
  component that reads `x.value` is subscribed, and a handler that only sets
  signals redraws just those components, without running `get()`. A grid
  holds one signal per cell (`const lit = cells.map(() => signal(false))`,
  `<Cell i={i} />` reading `lit[i].value`), the status line one of its own.
  The rule: a handler that sets a signal changes nothing else the picture
  reads (a module variable it changes there shows only at the next whole
  render); keep a value that must last through `frameos.remember` as before.
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
- Links: `<a href="https://…">` (or `mailto:`, `tel:`) opens on a tap: a
  frame shows its QR code over the UI for a phone to scan (tap to close), the
  browser preview opens a tab. Other schemes (`javascript:`) do nothing, an
  `onClick` on the `<a>` replaces it, and in running text the whole run of
  text holding the link is its target. Style it yourself (`underline`).
- Lists longer than the screen: give the box a height (`flex-1` in a
  column, `h-*`, `max-h-*`) and `overflow-y-auto`, and a finger (or a wheel)
  scrolls it; no paging needed on an LCD. A frame's next and prev buttons
  walk what there is to press in it and turn it a page at a time, so it
  reads on a frame with buttons alone (e-paper) too. `overflow-hidden` clips.
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
- `app.frame.eventMap` is what the frame's keys and swipes do whatever scene
  shows (`{event, match, emit, as}` rules: a `button` rule's `match` names the
  key's `label` and its `action`, `longPress` for a hold). A layout that labels
  the keys beside the glass reads it, and keeps a default for a frame that has
  none (the preview).
- Handlers open the frame's own screens: `frameos.dispatch('sceneSwitcher')` the
  scene list, `frameos.dispatch('sceneSettings')` the settings of the scene
  showing, and `frameos.dispatch('sceneSettings', {page: 'frame'})` the frame's.
- A layout stays up around those built-in screens too. To give them the whole
  panel, start `get` with `if (app.frame.systemScene) return <yield />`.
- The keyboard on the screen of a field in the wrapped scene (or the layout's
  own) is the frame's: on a small screen it takes the bottom of the panel and
  the layout is laid out above it, on a desktop of windows it floats over every
  window. To give the scene all the room it leaves while someone types, return
  a bare `<yield />` when `app.frame.typing` is true.
- A layout on its own has nothing to wrap, so its `<yield />` is an empty area in
  a render. That is correct, not a blank to fix.
- On a frame that runs scenes side by side (a Pi, an ESP32), `app.frame.scenes`
  lists its scenes (`{id, name}`, and `windowSize`, `"WxH"`, where a scene says
  the size its window should open at, `icon`, its `settings.icon`, where it
  has one: draw it as `<svg viewBox="0 0 24 24" className="w-6 h-6"><path d={icon}
  fill="currentColor" /></svg>`, and `category`, its `settings.category`, a name
  such as `"Photos"`, where it has one: group a list of scenes by it, those
  without one last under Other) and `app.frame.sceneId` is the one wrapped.
  There a layout's `<Scene id={...} />` (no other props: with props it is a copy
  they set, as anywhere) is that scene itself, running in its own rectangle
  beside the wrapped one, so a layout can be a desktop of windows or tiles. Keep
  the scene with the focus in `<yield />`, bring another forward with
  `frameos.dispatch('setCurrentScene', {sceneId})`, and keep which are open in
  `frameos.setState`. The frame's settings and scene list come forward
  the same way, as `app.frame.sceneId` `system/sceneSettings` (the frame's page)
  / `system/sceneSettings#<scene id>` (that scene's settings, one a scene) /
  `system/sceneSwitcher` (`app.frame.systemScene` true): give
  them a window too, and close it when the
  focus leaves one without your layout moving it (it went back by itself).
  Anything with a handler drawn over a `<Scene>` takes the pointer there, and a
  press it took keeps its tap. A handler on the `<Scene>` itself
  (`<Scene id={id} onPointerDown={() => focus(id)} />`) is the layout's, not a
  prop (it makes no copy): it runs when a press reaches that scene, which has the
  press all the same, so one press both works the scene and gives it the focus. A menu drawn over a box that closes it on a press
  needs an `onPointerDown` of its own (an empty one will do), or the box takes
  the press. Where `app.frame.scenes` is undefined (an ESP32, an editor's
  preview), draw the one scene.
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
  `letterSpacing`, per-glyph positions. One line per `text` or
  `tspan`: break lines yourself, or set the text in a UI, which wraps it.
  Emoji draw in colour (as pictures: no fill or stroke on them) where the
  frame has the emoji font, in a UI's text and `render/text` too; without it
  they draw nothing (a gap), so never let an emoji carry meaning a
  word should.
- `render/text` wraps text and takes caret styling with
  `richText: "basic-caret"`: `^(16)` size, `^(#FF00FF)` color,
  `^(PTSans-Bold.ttf)` font, `^(underline)`, combined as `^(16,#FF0000)`,
  `^(reset)` to reset. Use it for a paragraph over a picture another app drew.
- Fonts: `Ubuntu-*`, `PTSans-*`, `FiraGO-*`, `CormorantGaramond-*`,
  `LiberationSans-*`, `LiberationSerif-*`, `LiberationMono-*`,
  `CascadiaMono`, `ComicRelief`, `Galindo-Regular`, `Peralta-Regular` (all
  `.ttf`), plus the fonts people upload. A `fontFamily` matches them
  loosely ("PT Sans" finds `PTSans-Regular.ttf`); an unknown one falls back to
  the default face. On an ESP32 the fonts are the ones on its SD card, read
  a page at a time, so naming several costs it little; a board without a
  card has only the built-in Ubuntu face.

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
| `pointerMove` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string, `buttons` integer, `points`? json | all | When a pointer (a finger, a mouse, a pen) moves. |
| `pointerDown` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string, `shift`? boolean, `ctrl`? boolean, `alt`? boolean, `meta`? boolean | all | When a pointer button is pressed or a finger touches the panel. |
| `pointerUp` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string | all | When a pointer button is released or a finger lifts |
| `pointerCancel` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | all | When a pointer that was down is lost without a release: the queue overflowed, the device went away. |
| `mouseMove` | yes |  | `x` integer, `y` integer | all | When a mouse moves. |
| `mouseDown` | yes |  | `button` integer | all | When a mouse button is pressed. |
| `mouseUp` | yes |  | `button` integer | all | When a mouse button is released. |
| `tap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string, `shift`? boolean, `ctrl`? boolean, `alt`? boolean, `meta`? boolean | all | A press and release in one place, within `gestures.tapMs`. |
| `doubleTap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | all | A second `tap` in the same place within `gestures.doubleTapMs` of the first. |
| `longPress` | yes |  | `x` integer, `y` integer, `durationMs` integer, `pointerId` integer, `pointerType` string | all | A pointer held in one place for `gestures.longPressMs`. |
| `swipe` | yes |  | `direction` string, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | all | A press and a release at least `gestures.swipeMinPx` apart, in one of four directions. |
| `pinch` | yes |  | `scale` float, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | all | Two fingers (or pens) down together that moved, when the first of them lifts: `scale` is how far apart they are then over how far apart they were when the second went down (above 1 spread out, below 1 drawn together), `startX` / `startY` the point between them then and `x` / `y` the point between them now. |
| `edgeSwipe` | yes |  | `edge` string, `direction` string, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | all | A finger or a pen that went down within `gestures.edgePx` of an edge of the screen and moved at least `gestures.swipeMinPx` away from it, as on a phone: `edge` is where it started, `direction` the way it went. |
| `wheel` | yes |  | `deltaX` float, `deltaY` float, `x` integer, `y` integer | Pi, preview | When a mouse wheel is scrolled. |
| `turnOn` | yes | yes |  | all | Turn the screen on |
| `turnOff` | yes | yes |  | all | Turn the screen off |
| `toggleScreen` |  | yes |  | all | Turn the screen off when it is on, and on when it is off. |
| `gpio` | yes |  | `pin` integer, `label` string, `role` string, `action` string, `durationMs`? integer, `wake`? boolean, `claimed`? boolean, `atMs`? integer, `level`? integer | all | A GPIO button going `down` or `up`, the moment it happens. |
| `button` | yes |  | `pin` integer, `label` string, `role` string, `action` string, `durationMs`? integer, `wake`? boolean, `atMs`? integer | all | A GPIO button pressed: a `press`, a `doublePress`, a `triplePress` or a `longPress`, one event per press. |
| `setSceneState` |  | yes | `state`? json, `render`? boolean | all | Set the scene's public state. |
| `setCurrentScene` |  | yes | `sceneId`? scene, `direction`? string, `state`? json | all | Switch the frame to another scene: the one `sceneId` names, or with `direction` the `next` / `prev` one in the frame's scene list (the control plane's order, wrapping around; one of the two is required). |
| `sceneSwitcher` |  | yes | `swap`? boolean | all | Show the scene switcher (`scenes.switcher`, docs/scene-switcher.md): every scene on the frame as a tile with its title, in the frame's scene list order, to tap or to pick with the buttons. |
| `sceneSettings` |  | yes | `page`? string | all | Show the scene's settings (`scenes.settings`, docs/scene-settings.md): the public fields of the scene showing, as a form to change and save. |
| `back` | yes |  |  | all | Go back, as a phone's back gesture does: what that is is the scene's (the photo or the page before; the scene switcher moves its highlight a screenful back, the scene settings close unsaved), and a scene that does not listen for it stays as it is. |
| `forward` | yes |  |  | all | Go forward, the other way from `back`: the next photo or page (the scene switcher moves its highlight a screenful on). |
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

/** One scene of the store, as the listing for frames serves it (/api/store/device/scenes). */
interface FrameOSStoreScene {
  id: string;
  name: string;
  category: string | null;
  /** The store's newest version. */
  version: number;
  by: string;
  /** The description, cut to a line or two. */
  about: string;
  /** The cover as a path on the store's host ("/api/store/scenes/<id>/image?version=N"): prefix the store's url. Null without one. */
  image: string | null;
}
/** What frameos.code("read") says: the code editor's host (docs/code-editor.md). */
interface FrameOSCodeFacts {
  /** The action running ("ask", "save"), else "". One at a time. */
  busy: string;
  /** The last action's refusal ("no_plane", "needs_owner", "ai_unavailable", "panel_locked", ...), else "". */
  error: string;
  /** The last action that worked ("ask", "save"), else "". */
  done: string;
  /** The AI's last scene, read whole with frameos.code("draft"); null without one. */
  draft: { id: string; name: string; summary: string } | null;
  /** An AI can be asked: the frame has a control plane. */
  ask: boolean;
  /** A scene can be saved here. */
  save: boolean;
  /** The browser preview's host: it reads scenes and saves or asks nothing. */
  previewOnly?: boolean;
}
/** What frameos.transfer("read") says: files between the assets and the computer showing the frame. */
interface FrameOSTransferFacts {
  /** Files can be picked on the computer and added (op "upload"). */
  upload: boolean;
  /** A file can be saved to the computer (op "download"). */
  download: boolean;
  /** "upload" or "download" while the person at the computer has not answered yet, else "". */
  busy: string;
  /** The last one that worked ("upload", "download"), else "". */
  done: string;
  /** How many files the last one moved. */
  count: number;
  /** Why the last one did not: "cancelled", "too_big", "failed", else "". */
  error: string;
  /** Moves by one at every answer: compare it with the last you saw to know one came. */
  seq: number;
}
/** What frameos.store() says: the scene store as this frame's host knows it (docs/scene-store.md). */
interface FrameOSStore {
  /** The store this frame browses: its cloud provider, else FrameOS Cloud. The app fetches its listing for frames
   * from it (/api/store/device/scenes?version=...): a page of FrameOSStoreScene at a time. */
  url: string;
  /** This frame's FrameOS: the listing offers only what runs on it. */
  version: string;
  /** The action running ("install", "preview", "update", "remove", "discard"), else "". One at a time. */
  busy: string;
  /** The last action's refusal ("offline", "too_many_scenes", "panel_locked", ...), else "". */
  error: string;
  /** The last action that worked, else "": "uptodate" for an update with nothing newer. */
  done: string;
  /** Every scene on the frame that came from the store: its id here, its store scene and the version it is. */
  installed: { id: string; store: string; v: number }[];
  /** The store scene this frame previews, until it is installed or discarded. */
  preview: { store: string; id: string; name: string } | null;
  /** A scene not from the store may be removed too (a frame with no control plane). */
  removeAny: boolean;
  /** The browser preview's host: Preview, Show and Discard only, and "preview_only" for install, update and remove. Absent on a frame. */
  previewOnly?: boolean;
}
/** What frameos.frame("read") says: the facts the frame page shows (docs/scene-settings.md "The frame page"). */
interface FrameOSFrameFacts {
  /** Absent where there is no network to set from the frame (the browser preview). */
  wifi?: {
    /** "connected", "connecting", "notFound", "auth", "hotspot", "unset" or "off". */
    state: string;
    ssid: string;
    ip?: string;
    /** The signal in dBm, while connected. */
    rssi?: number;
    /** The setup hotspot's name, while it is up. */
    hotspot?: string;
    /** The networks in range by name, from the last scan. */
    networks: string[];
    scanning: boolean;
    /** A password is saved. */
    password: boolean;
  };
  rotate: number;
  renderScale: number;
  battery?: { percent: number };
  /** The control plane that manages the frame, when one does. */
  managedBy?: string;
  version?: string;
  /** The device commands this host runs besides render and reboot ("restart" on a Raspberry Pi). */
  actions: string[];
  /** What the last apply could not do. */
  note?: string;
}

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
  type: "tap" | "doubleTap" | "longPress" | "swipe" | "pinch" | "pointerDown" | "pointerUp" | "pointerMove" | "change" | "keyDown";
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
  /** A swipe's start; a pinch's point between its fingers when the second went down (x, y: when the first lifted). */
  startX?: number;
  startY?: number;
  /** A pinch's spread: how far apart the fingers ended over how far apart they began (below 1 drawn together). Absent before 2026.11.10. */
  scale?: number;
  /** A pointerMove that stands for moves no handler heard (they came while the frame was busy): where those were, x, y, x, y, ... oldest first, from the element's corner as localX and localY. A drawing keeps them all. Absent when there were none, and before 2026.11.15. */
  points?: number[];
  /** onChange of an <input> or <textarea>: its text now (also as target.value, as in React). */
  value?: string;
  target?: { value: string };
  /** onKeyDown of a field: the key ("a", "Enter", "Backspace"). */
  key?: string;
  [key: string]: any;
}
interface FrameOSElementProps {
  className?: string;
  /**
   * The desktop's look for a role of its theme: "page", "bar", "button", "primary", "selected", "field", "option",
   * "picked", "switch", "switchOn", "knob", "knobOn", "muted", "accent", "card", "tile", "tileLit", "keyboard", "key",
   * "keyMod", "keyLit" (docs/jsx-ui.md "Themes"). Where a layout around the scene gives a theme (a desktop and its
   * windows), the role's colors, borders and corners take the place of the element's own; with none, or a role the
   * theme leaves out, it keeps its classes. An element without it always keeps its own; role is not used for this
   * (FrameOS 2026.11.10+; ignored before).
   */
  look?: string;
  children?: any;
  src?: FrameOSImageRef | { image: FrameOSImageRef | null } | null;
  /** A tap on the element; the frame renders again after it. */
  onClick?: (event: FrameOSUiEvent) => void;
  onDoubleClick?: (event: FrameOSUiEvent) => void;
  onLongPress?: (event: FrameOSUiEvent) => void;
  /** A press on the element. Like onPointerMove and onPointerUp, returning false asks for no render: what it did shows with the next one (2026.11.15+; a render after every one before). */
  onPointerDown?: (event: FrameOSUiEvent) => boolean | void;
  onPointerUp?: (event: FrameOSUiEvent) => boolean | void;
  /** The pointer moved: over the element, or anywhere while a press it took is held (captured until the release). e.points has where it passed since the move before. Return false to keep the frame from rendering for it, as a drawing does on e-paper between pieces of a stroke. */
  onPointerMove?: (event: FrameOSUiEvent) => boolean | void;
  /** A swipe that began on the element, with its direction; one in from the screen edge is the frame's. */
  onSwipe?: (event: FrameOSUiEvent) => void;
  /** Two fingers that began on the element moved, as one event when the first lifts: e.scale, e.startX/startY, e.x/y. Neither finger is a tap or a swipe then. Absent before 2026.11.10. */
  onPinch?: (event: FrameOSUiEvent) => void;
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
/**
 * signal(value): a value a memo()'d component reads through .value, which
 * subscribes it. A handler that sets signals and nothing else the picture
 * reads redraws only the components that read them, without running get()
 * (docs/jsx-ui.md "Signals"). .peek() reads without subscribing. One
 * signal per list item, not one every item compares with.
 * FrameOS 2026.11.14+.
 */
interface Signal<T> { value: T; peek(): T; }
declare function signal<T>(value: T): Signal<T>;

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
    /** The places the asset calls reach, each with the name to show it by. The assets folder ("assets", the
     * default) and, on an ESP32 with a TF card in, its internal storage ("internal") beside it. Pass an id as
     * the storage option of the asset calls that read, and of makeAssetFolder and deleteAsset (FrameOS 2026.11.11+;
     * undefined before; writeAsset, appendAsset and streams reach the assets folder alone). */
    storages?: { id: "assets" | "internal"; name: string }[];
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
    /** The render scale that applies to the scene. A .tsx or .jsx app's sizes are the panel's
     * divided by it, and its JSX is drawn that many times larger (FrameOS 2026.10.22+; undefined before). */
    scale?: number;
    /** Whether a change shows as soon as it is drawn (an LCD, an HDMI screen). False where each change costs a
     * refresh, as on e-paper today. Follow a finger, animate and show presses only where it is true, and wait
     * for a finger to lift where it is false (FrameOS 2026.11.10+; undefined before, where paper is its
     * opposite, so read app.frame.fast ?? !app.frame.paper). The same in get(), init(), onEvent, a handler
     * and after an await. */
    fast?: boolean;
    /** Whether the panel draws in inks, as e-paper (and a monochrome OLED) does, with few colors, greys
     * dithered and nothing faint, so draw solid colors there. It says how the panel looks. Whether a change
     * costs a refresh is fast, which a fast e-paper would say true with paper true (FrameOS 2026.11.5+;
     * undefined before; until 2026.11.10 it stood for both, and an ESP32 said true on an LCD outside get()). */
    paper?: boolean;
    /** Whether the panel shows colors (an LCD, an HDMI screen, a four-, six- or seven-ink e-paper). False on
     * a black-and-white or grey panel, where a scene reads better drawn in high contrast (FrameOS 2026.11.6+;
     * undefined before, so treat undefined as color). The same in every phase, as fast. */
    color?: boolean;
    /** Whether only the circle inside the panel's square shows and takes touches, as on the HyperPixel 2.1 Round
     * and the Waveshare ESP32-S3-Touch-AMOLED-1.75. The corners are drawn but never seen, so an app that draws the
     * whole panel keeps its text and buttons inside the circle, or inside the square inside it (FrameOS
     * 2026.11.15+; undefined before, so treat undefined as square). */
    round?: boolean;
    /** The name of the scene showing. A layout's app gets the name of the scene it wraps (FrameOS 2026.11.5+;
     * undefined before). */
    sceneName?: string;
    /** True in a layout's app while it wraps a built-in scene (the scene list, the settings). Returning a bare <yield />
     * then gives that scene the whole panel (FrameOS 2026.11.5+; undefined before). */
    systemScene?: boolean;
    /** True in a layout's app while the scene it wraps has the keyboard on the screen up. The keyboard is the
     * frame's then, at the bottom of the panel with the layout laid out above it (on a desktop, a window over the
     * others); returning a bare <yield /> gives the scene all the room it leaves (FrameOS 2026.11.14+; undefined before). */
    typing?: boolean;
    /** True in a layout's app while the scene it wraps shows only because a built-in scene (the scene list, the
     * settings) went back to it on its own, by its Close or Cancel or its timeout. A desktop then opens no window
     * again for a scene that was closed or put away; a scene picked in the list is not one (FrameOS 2026.11.14+;
     * undefined before, and whenever it is false). */
    wentBack?: boolean;
    /** The battery's charge from 0 to 100, on an ESP32 frame with a battery. Undefined elsewhere, so check
     * before drawing it (FrameOS 2026.11.5+; undefined before). */
    batteryPercent?: number;
    /** The Wi-Fi signal in dBm, about -50 strong and -85 weak, on an ESP32 frame that is connected. Undefined
     * elsewhere, so check before drawing it (FrameOS 2026.11.5+; undefined before). */
    wifiRssi?: number;
    /** The id of the scene showing; a layout's app gets the id of the scene it wraps, the one its <yield />
     * shows (FrameOS 2026.11.8+; undefined before). */
    sceneId?: string;
    /** The frame's scenes, { id, name } in its scene list's order, layouts left out, on a frame that runs
     * scenes side by side (a Raspberry Pi, an ESP32). There a layout's <Scene id> is that scene itself,
     * running in its window while another has the focus, so a layout can be a desktop of windows. Undefined
     * where one scene runs at a time (the preview of one scene) (FrameOS 2026.11.8+; undefined before).
     * windowSize is a scene's own size for a new window, "WxH" (its settings.windowSize), where it says
     * one (FrameOS 2026.11.10+). icon is the scene's icon, where it has one (its settings.icon): one SVG
     * path in a 0 0 24 24 box, drawn as <svg viewBox="0 0 24 24"><path d={icon} fill="currentColor" /></svg>
     * (FrameOS 2026.11.10+). category is the scene's category by its name ("Photos", "Clocks & time"; its
     * settings.category), where it has one, to group a list of scenes by, those without one last as Other
     * (FrameOS 2026.11.10+). */
    scenes?: { id: string; name: string; windowSize?: string; icon?: string; category?: string }[];
    /** The built-in scenes (the scene list, a scene's settings, the frame's page) the focus left for another
     * window without their going back, so still open beside the scene showing, their page and edits as they were.
     * A desktop keeps such a one's window and closes it once it is gone from here, on a frame that runs scenes
     * side by side (FrameOS 2026.11.14+; undefined before, and where scenes run one at a time). */
    keptOpen?: string[];
    /** How many of those scenes may run at once, the one in front included, where that is limited (2 on an
     * ESP32 with 8 MB of PSRAM, 1 beside a 13.3-inch colour panel's canvas, 4 with more). A desktop opening
     * one more closes the one that had the focus longest ago. Undefined where there is no limit (a Raspberry
     * Pi) (FrameOS 2026.11.8+; undefined before). */
    windows?: number;
    /** The theme of the desktop around the scene, its roles' classes (a string, or a list of boxes one inside the
     * other), for what look cannot color, as an SVG's fill in the accent's color. Undefined with no desktop or one in
     * its own look (FrameOS 2026.11.10+; undefined before). */
    theme?: Record<string, string | string[]>;
    /** The frame's event map, what its keys and swipes do whatever scene shows (docs/events.md "Event map"), each
     * rule { event, match, emit?, as? }: a button rule matches { label, action } ("press", "doublePress",
     * "triplePress", "longPress"), an edgeSwipe rule { edge }. For a layout that labels the keys beside the glass. Undefined where
     * the frame has none (the preview of a scene) (FrameOS 2026.11.14+; undefined before). */
    eventMap?: { event: string; match?: Record<string, any>; emit?: string; as?: Record<string, any> }[];
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
  /** Render the scene. Triggered according to the scene's refresh interval, or when explicitly requested. */
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
  /** When a pointer (a finger, a mouse, a pen) moves (not logged). A move that stands for others the scene did not hear (they came while it was busy) lists where those were in `points`, x, y, x, y, ... oldest first, in the units of `x` and `y`. */
  pointerMove: { x: number; y: number; pointerId: number; pointerType: string; buttons: number; points?: any };
  /** When a pointer button is pressed or a finger touches the panel (not logged). The position is on every pointer event. A modifier key held on a keyboard (Linux, the preview) adds `shift`, `ctrl`, `alt` or `meta` as true. */
  pointerDown: { x: number; y: number; button: number; buttons: number; pointerId: number; pointerType: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean };
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
  /** A press and release in one place, within `gestures.tapMs`. Made by the dispatcher from `pointerDown` / `pointerUp` on every host. A modifier key held adds `shift`, `ctrl`, `alt` or `meta` as true, as on `pointerDown`. */
  tap: { x: number; y: number; pointerId: number; pointerType: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean };
  /** A second `tap` in the same place within `gestures.doubleTapMs` of the first. The first tap is delivered too. */
  doubleTap: { x: number; y: number; pointerId: number; pointerType: string };
  /** A pointer held in one place for `gestures.longPressMs`. Delivered while it is still held where the host ticks the dispatcher, on release otherwise; no `tap` follows it. */
  longPress: { x: number; y: number; durationMs: number; pointerId: number; pointerType: string };
  /** A press and a release at least `gestures.swipeMinPx` apart, in one of four directions. */
  swipe: { direction: string; x: number; y: number; startX: number; startY: number; pointerId: number; pointerType: string };
  /** Two fingers (or pens) down together that moved, when the first of them lifts: `scale` is how far apart they are then over how far apart they were when the second went down (above 1 spread out, below 1 drawn together), `startX` / `startY` the point between them then and `x` / `y` the point between them now. The two make no `tap`, `longPress` or `swipe` of their own. One event for the whole gesture, as a `swipe` is for a drag: what e-paper and a frame rendered on its plane zoom by. */
  pinch: { scale: number; x: number; y: number; startX: number; startY: number; pointerId: number; pointerType: string };
  /** A finger or a pen that went down within `gestures.edgePx` of an edge of the screen and moved at least `gestures.swipeMinPx` away from it, as on a phone: `edge` is where it started, `direction` the way it went. The frame takes that touch: the scene hears no pointerDown, pointerMove or pointerUp of it, so a slider under it stays as it was. A touch there that lifts, holds or moves along the edge instead is the scene's after all, with its pointerDown a little late. Not a mouse. */
  edgeSwipe: { edge: string; direction: string; x: number; y: number; startX: number; startY: number; pointerId: number; pointerType: string };
  /** When a mouse wheel is scrolled (not logged). Deltas are wheel notches, and a trackpad's fractions of one; deltaY is positive when scrolling down (towards the user), deltaX when scrolling right. */
  wheel: { deltaX: number; deltaY: number; x: number; y: number };
  /** Turn the screen on */
  turnOn: Record<string, never>;
  /** Turn the screen off */
  turnOff: Record<string, never>;
  /** Turn the screen off when it is on, and on when it is off. The scene hears the `turnOn` or `turnOff` it became. */
  toggleScreen: Record<string, never>;
  /** A GPIO button going `down` or `up`, the moment it happens. `up` says how long it was held. */
  gpio: { pin: number; label: string; role: string; action: string; durationMs?: number; wake?: boolean; claimed?: boolean; atMs?: number; level?: number };
  /** A GPIO button pressed: a `press`, a `doublePress`, a `triplePress` or a `longPress`, one event per press. */
  button: { pin: number; label: string; role: string; action: string; durationMs?: number; wake?: boolean; atMs?: number };
  /** Set the scene's public state. This is not used for private state changes. */
  setSceneState: { state?: any; render?: boolean };
  /** Switch the frame to another scene: the one `sceneId` names, or with `direction` the `next` / `prev` one in the frame's scene list (the control plane's order, wrapping around; one of the two is required). An optional `state` object is applied to that scene's public state. */
  setCurrentScene: { sceneId?: string; direction?: string; state?: any };
  /** Show the scene switcher (`scenes.switcher`, docs/scene-switcher.md): every scene on the frame as a tile with its title, in the frame's scene list order, to tap or to pick with the buttons. While it or the scene settings show, go back to the scene they were opened from instead; over a scene's settings with `swap`, and always on a desktop, open the list in their place. The frame's event map binds it to a swipe in from the bottom edge on a touch screen. */
  sceneSwitcher: { swap?: boolean };
  /** Show the scene's settings (`scenes.settings`, docs/scene-settings.md): the public fields of the scene showing, as a form to change and save. While it or the scene switcher shows, go back to the scene they were opened from (without saving) instead; on a desktop, over the switcher, open the settings of the scene it was opened from. The frame's event map binds it to a swipe in from the top edge on a touch screen. */
  sceneSettings: { page?: string };
  /** Go back, as a phone's back gesture does: what that is is the scene's (the photo or the page before; the scene switcher moves its highlight a screenful back, the scene settings close unsaved), and a scene that does not listen for it stays as it is. It never switches the scene. The frame's event map binds it to a swipe in from the left edge on a touch screen. */
  back: Record<string, never>;
  /** Go forward, the other way from `back`: the next photo or page (the scene switcher moves its highlight a screenful on). It never switches the scene. The frame's event map binds it to a swipe in from the right edge on a touch screen. */
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
  /** The scene store as this frame knows it (docs/scene-store.md): null where there is no store (the browser
   * preview, a frame rendered on its control plane, one whose owner turned the settings on its screen off) and
   * before FrameOS 2026.11.8. Read it every render: what an action did shows up here. */
  store(): FrameOSStore | null;
  /** Asks the frame's host: preview {store, name}, install {store, name, show?: false to stay on this scene}, update
   * {store}, remove {store}, discard. It runs off the render and this scene renders again when it is done (see
   * store().busy). False where there is no host (FrameOS 2026.11.8+). */
  storeAction(action: "preview" | "install" | "update" | "remove" | "discard", args?: Record<string, any>): boolean;
  /** The frame page's facts and powers (docs/terminal.md), for an app whose config.json permissions include "frame"
   * (saving the scene adds it when the code calls this; installing the scene is the owner's yes), and only while the
   * frame's settings are allowed on its screen: it throws otherwise. "read" is what the page shows, null where there is
   * none (FrameOS 2026.11.8+). */
  frame(op: "read"): FrameOSFrameFacts | null;
  /** What the page's Save sets: a network (wifiSsid, with wifiPassword or "" for an open one or the saved one), rotate
   * (0, 90, 180, 270), renderScale (0 automatic, up to 4), and on an ESP32 the clock ("YYYY-MM-DD HH:MM"). A refusal
   * shows as note in the next "read". */
  frame(
    op: "apply",
    changes: { wifiSsid?: string; wifiPassword?: string; rotate?: number; renderScale?: number; clock?: string }
  ): boolean;
  /** What the page's buttons do: render (every panel drawn again), restart (FrameOS, where actions has it), reboot,
   * scan for the networks in range (in "read" once wifi.scanning is false), and on an ESP32 checkUpdate and
   * installUpdate. */
  frame(op: "action", action: "render" | "restart" | "reboot" | "scan" | "checkUpdate" | "installUpdate"): boolean;
  /** The frame's scenes as it holds them and its control plane's scene AI (docs/code-editor.md), for an app whose
   * config.json permissions include "code" (saving the scene adds it when the code calls this), and only while the
   * frame's settings are allowed on its screen: it throws otherwise. "read" is the host's facts, null without a host
   * (FrameOS 2026.11.11+). */
  code(op: "read"): FrameOSCodeFacts | null;
  /** A scene as the frame holds it (its scenes.json object), or null. */
  code(op: "source", sceneId: string): Record<string, any> | null;
  /** The AI's last scene, or null. */
  code(op: "draft"): Record<string, any> | null;
  /** Asks the plane's AI for a scene: a change to the scene given, else a new one. It runs off the render and this scene
   * renders again when it is done (read().busy, then read().draft). Nothing is saved. */
  code(op: "ask", args: { prompt: string; scene?: Record<string, any> }): boolean;
  /** Puts the scene on the frame (replacing one of its id), shown unless show is false. A save from the frame may not
   * ask for permissions or settings the saved scene did not have (error "needs_owner"). */
  code(op: "save", args: { scene: Record<string, any>; show?: boolean }): boolean;
  /** Forgets the draft and the last error. */
  code(op: "clear"): boolean;
  /** Files between the assets and the computer the frame is shown on: the browser preview has it, a frame never (null
   * there, and before FrameOS 2026.11.14). "read" is what the host can do and the last answer. */
  transfer(op: "read"): FrameOSTransferFacts | null;
  /** Asks the person at the computer for files and puts them into dir ("" the top) of the assets, storage as in the
   * asset calls; a name that is there gets " (2)". It returns at once, and this scene renders again when the files
   * are in (read().done, read().count): list the folder again then. Needs "assets-write" for the frame's folder. */
  transfer(op: "upload", args: { dir?: string; storage?: string }): boolean;
  /** Saves the asset at path to the computer; renders again when it is saved (read().done). */
  transfer(op: "download", args: { path: string; storage?: string }): boolean;
  /** How tall each text is, in pixels, set in className's text classes (font-*, text-*, leading-*) into width, as a
   * <textarea> sets its text: wrapped at spaces, spaces kept, an empty text one line. For a list whose rows are text
   * that wraps (a code editor's lines), measured before they are laid out (FrameOS 2026.11.12+). */
  measureText(texts: string[], options: { className?: string; width: number }): number[];
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
      /** Writes a JSON reply's first string field of this name, base64, decoded into an asset (the app's "assets-write"
       * rules) and leaves that field empty in body: a picture an API returns inline (OpenAI's image generation
       * result) never becomes a JS string, which on an ESP32 it would not fit as. The reply says saved, or
       * saveError; a runtime before FrameOS 2026.11.12 ignores the option and returns the body whole. */
      saveBase64Field?: { field: string; path: string };
      /** Puts an asset's bytes, base64, into the body where marker is (a picture uploaded from its file, the same
       * way). With no such asset or marker the request is not sent (FrameOS 2026.11.12+; ignored before). */
      bodyAsset?: { marker: string; path: string };
    }
  ): {
    status: number;
    /** The response's headers, names in lower case, a repeated one joined with ", " (headers["content-range"]:
     * "bytes 0-65535/8388608"). As many as fit 2 KB on an ESP32 (FrameOS 2026.11.12+; undefined before). */
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    found?: string[];
    error?: string;
    saved?: { path: string; bytes: number };
    saveError?: string;
  };
  fetchImage(
    url: string,
    options?: {
      headers?: Record<string, string>;
      saveAsset?: { name: string; extension?: string; mode?: "auto" | "always" };
      exif?: boolean;
      // The image's color profile (a .frameos.json sidecar's colors object); null = none, clears the last palette.
      colors?: { [key: string]: any } | null;
      // Keep the picture for later renders (a JSX gallery's photo, drawn again without a download) until
      // frameos.releaseImage(ref) or the interpreter goes; 8 at most, or up to 48 small ones (a grid of
      // thumbnails, no more pixels than eight 480x480 photos). Never the consumer's target.
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
  /** Every file below dir, as paths in the assets folder; with shallow, the folder's own entries, a folder's
   * ending in "/" (FrameOS 2026.11.8+). */
  listAssets(dir?: string, options?: { shallow?: boolean; storage?: "assets" | "internal" }): string[];
  assetExists(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  assetSize(path: string, options?: { storage?: "assets" | "internal" }): number;
  /** The file's bytes as base64, or with text as a string (UTF-8, without the halves of characters a slice cuts at its
   * ends). entry reads that member of a ZIP file instead (an EPUB's chapter, inflated by the frame a window at a
   * time): offset and length are then the member's, and a file that is not a ZIP, or has no such member, is null.
   * A slice over the frame's limit (2 MB on an ESP32) is null: read it in parts with offset and length
   * (entry and text: FrameOS 2026.11.11+). inflate reads the slice as a zlib (or raw deflate) stream and gives what
   * it holds (a PDF's FlateDecode stream; a damaged one is null), and bytes gives any
   * read as a Uint8Array (inflate and bytes: FrameOS 2026.11.14+). */
  readAsset(
    path: string,
    options: { offset?: number; length?: number; inflate?: boolean; bytes: true; entry?: string; storage?: "assets" | "internal" }
  ): Uint8Array | null;
  readAsset(
    path: string,
    options?: { offset?: number; length?: number; text?: boolean; inflate?: boolean; entry?: string; storage?: "assets" | "internal" }
  ): string | null;
  /** Writes the file: data is base64, or with text the string itself, written as UTF-8 (text: FrameOS 2026.11.12+;
   * before, the string is read as base64). */
  writeAsset(path: string, data: string, options?: { text?: boolean }): boolean;
  /** Adds to the end of the file, as writeAsset writes it. */
  appendAsset(path: string, data: string, options?: { text?: boolean }): boolean;
  /** Deletes a file, or a folder when it is empty: false for a folder with anything in it, and never the storage's
   * own folder (folders: FrameOS 2026.11.12+; false before). */
  deleteAsset(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  /** One folder, inside a folder that is there: true when it was made, false when it was there already or refused
   * (a name starting with a dot, one the listing hides, an app without "assets-write") (FrameOS 2026.11.10+). */
  makeAssetFolder(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  /** An image file of the assets folder. With width and height it is decoded at that size (a JPEG scaled as it
   * decodes) and keep holds it for later renders, as fetchImage's options do (FrameOS 2026.11.8+). With neither,
   * the picture an app returns is decoded straight into the canvas it is drawn on where the runtime offers one,
   * as fetchImage's is: a full-screen photo never costs a second canvas (FrameOS 2026.11.12+). */
  loadAssetImage(
    path: string,
    options?: {
      keep?: boolean;
      width?: number;
      height?: number;
      fit?: "cover" | "contain";
      /** A picture inside a ZIP file (an EPUB's illustration or cover), as readAsset's entry (FrameOS 2026.11.11+). */
      entry?: string;
      /** With entry and a size: the colour under the picture's transparent parts (FrameOS 2026.11.11+). */
      background?: string;
      /** A picture at a slice of the file (a PDF's JPEG), decoded at the size asked; with inflate the slice is
       * compressed (FrameOS 2026.11.14+). */
      offset?: number;
      length?: number;
      inflate?: boolean;
      /** With a size: the slice is raw samples instead (a PDF image's), scaled as they come: colors 1 (grey, or
       * indexed with a palette of hex RGB), 3 (RGB) or 4 (CMYK), 1 to 16 bits each, rows padded to a byte, predictor
       * 2 (TIFF) or 10 and up (PNG), invert to read each sample the other way (FrameOS 2026.11.14+). */
      pixels?: { width: number; height: number; colors?: 1 | 3 | 4; bits?: number; predictor?: number; palette?: string; invert?: boolean };
      /** With pixels or offset: another slice of grey samples, the picture's opacity (a PDF's soft mask), put over
       * background (FrameOS 2026.11.14+). */
      mask?: { offset: number; length: number; inflate?: boolean; pixels: { width: number; height: number; bits?: number; predictor?: number; invert?: boolean } };
      /** Which of app.frame.storages the path is in (FrameOS 2026.11.11+). */
      storage?: "assets" | "internal";
    }
  ): FrameOSImageRef | null;
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

/** A binary string (each char a byte, 0-255) as base64; throws for a char above 255 (FrameOS 2026.11.12+). */
declare function btoa(data: string): string;
/** base64 as a binary string, whitespace ignored, the padding optional; throws for anything else (FrameOS 2026.11.12+). */
declare function atob(data: string): string;
/** A string's UTF-8 bytes: new TextEncoder().encode("ü") (FrameOS 2026.11.12+). */
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
/** UTF-8 bytes as a string, U+FFFD for what is not UTF-8, a leading BOM dropped; UTF-8 only: another label
 * ("latin1") throws a RangeError (FrameOS 2026.11.12+). */
interface TextDecoder {
  readonly encoding: string;
  decode(input?: ArrayBuffer | ArrayBufferView | null): string;
}
/** Ignored: a frame's TextDecoder is never fatal and always drops a BOM. */
interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}
declare var TextDecoder: { prototype: TextDecoder; new (label?: string, options?: TextDecoderOptions): TextDecoder };

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
- A JS app keeps nothing on `globalThis` and changes no built-in: the scene's
  other apps and its code nodes share them.
- A drawing is JSX from an `app.tsx` app, never SVG markup built as a
  string; its `<svg>` uses only the supported tags, and gradients use
  `userSpaceOnUse`.
- Sizes come from the frame, not from constants.
- Nothing big is embedded as an object literal or kept alive between renders.
