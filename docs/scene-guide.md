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

- **The render flow** (`type: "appNodeEdge"`, `sourceHandle: "next"` →
  `targetHandle: "prev"`): the `render` event node, then each render or logic
  app in order. It is one straight chain: never point two `next` edges at one
  `prev`. The apps in it draw on one shared canvas, in order, so never pass the
  canvas between them through fields.
- **Values** (`type: "codeNodeEdge"`, `sourceHandle: "fieldOutput"`): a node's
  output into an app field (`targetHandle: "fieldInput/<field>"`) or into a
  code node argument (`targetHandle: "codeField/<arg>"`). Code, state and data
  nodes connect only this way, and their source handle is exactly
  `fieldOutput`, never `fieldOutput/<name>`.

Data apps (category `data`) are never in the render flow; they feed values.
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
  (`render/text`, `render/image`, `render/svg`) or write a JS app.

Apps used often: `render/image` (an image into the canvas, with `placement`
cover, contain, stretch, center…), `render/text` (wrapping text, with
`richText: "basic-caret"` for caret styling), `render/svg`, `render/gradient`
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

## Code nodes

A code node holds one JavaScript **expression** in `data.codeJS`. Wrap
several statements in an immediately called function that returns the value.

- It has exactly one output: one `codeOutputs` entry, `{ name, type }`, with
  type `string`, `json`, `integer`, `float` or `boolean`. It cannot output an
  image: to draw generated SVG, output a string into a
  `render/svg` node's `svg` field.
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

**Files.** `config.json` and `app.ts` (or `.tsx`, `.js`, `.jsx`), plus any
helper modules and `.json` data files, imported with relative paths
(`import { row } from "./lib/row"`, `import icons from "./icons.json"`). Only
the app's own files resolve: no npm packages, no `require()`, no dynamic
`import()`. JSX works only in `.tsx` / `.jsx` files. Split an app when
`app.ts` passes a few hundred lines, or when data would swamp the code. Keep
apps small: a scene carries a copy of every app it uses, and an ESP32 keeps
all its scenes in 512 KiB.

**Exports.**

- A `data` app exports `get(app, context)`, which returns the value its
  `output` names: a string, JSON, or for an image `frameos.svg(...)`,
  `frameos.image(...)` or an image from `frameos.fetchImage`. It is not in the
  render flow: wire its output into `render/image`'s `image` field or another
  node's input.
- A `logic` app in the render flow exports `run(app, context)`, for what it
  does rather than returns (state, the next sleep).
- Never make a JS app with category `render`: it draws nothing.
- `init(app)` is optional and runs each time the app's interpreter starts:
  once per scene on a Pi, before every render on an ESP32 and in a preview
  running as one.

**What the app sees.**

- `app.config`: its fields, with what the node's config and edges set.
- `app.state`: the scene's state, read by key. Write it with
  `frameos.setState(key, value)`.
- `app.frame`: the frame, read only: `width`, `height` (always set, also in
  the preview), `rotate`, `timeZone`, `assetsPath`, `debug`, and `embedded`
  (true on an ESP32, and in a preview running as one).
- `app.nodeId`, `app.nodeName`.
- `context`: this run: `event`, `payload`, and when an image is flowing
  through, `imageWidth` / `imageHeight`. That is the area being drawn into (a
  split cell, say), which can be smaller than `app.frame`.
- `frameos`: everything the app can do: fetch (`fetchJson`, `fetchText`,
  `httpRequest`, `fetchImage`), make images (`svg`, `image`), log (`log`,
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

## Images, SVG and text

`render/svg` and `frameos.svg()` use a strict renderer. Any tag outside this
list fails the whole document ("Failed to render SVG"; in a JS app, "No image
provided"): `svg` (with a `viewBox`), `g`, `path`, `rect`, `circle`,
`ellipse`, `line`, `polyline`, `polygon`, `text` / `tspan`, `linearGradient`,
`radialGradient`, `defs` (for gradients only), `title`, `desc`. Not supported:
`use`, `image`, `filter`, `mask`, `clipPath`, `pattern`, `style`,
`foreignObject`, `symbol`, `marker`.

- Gradients always have `gradientUnits="userSpaceOnUse"` (the SVG default
  fails the document), coordinates in viewBox units, and `<stop>` children
  with an `offset` from 0 to 1, a hex `stop-color` and an optional
  `stop-opacity`. Fills only: a stroke cannot use a gradient. For a
  full-screen gradient, `render/gradient` is simpler.

  ```svg
  <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="600">
    <stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e3a5f"/>
  </linearGradient>
  <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="400" cy="120" r="360">
    <stop offset="0" stop-color="#ffe08a" stop-opacity="0.8"/><stop offset="1" stop-color="#ffe08a" stop-opacity="0"/>
  </radialGradient>
  <rect width="800" height="600" fill="url(#bg)"/>
  ```
- SVG is XML. Escape every dynamic string you put in markup, text and
  attributes alike (`&` as `&amp;`, `<` as `&lt;`, `>` as `&gt;`, `"` as
  `&quot;`), through one helper: a single raw `&` fails the whole document.
- `<text>` is drawn as glyph outlines, so fill, stroke, gradients, opacity and
  transforms work on it. Supported: `x`, `y`, `dx` / `dy` (the first value),
  `font-family`, `font-size`, `font-weight`, `font-style`, `text-anchor`,
  `dominant-baseline`, and `<tspan>` children. Not supported: wrapping,
  `textPath`, `textLength`, `letter-spacing`, per-glyph positions, emoji. One
  line per `text` or `tspan`: break lines yourself.
- `render/text` wraps text and takes caret styling with
  `richText: "basic-caret"`: `^(16)` size, `^(#FF00FF)` color,
  `^(PTSans-Bold.ttf)` font, `^(underline)`, combined as `^(16,#FF0000)`,
  `^(reset)` to reset. Prefer it for paragraphs.
- Fonts: `Ubuntu-*`, `PTSans-*`, `FiraGO-*`, `CormorantGaramond-*`,
  `LiberationSans-*`, `LiberationSerif-*`, `LiberationMono-*`,
  `CascadiaMono`, `ComicRelief`, `Galindo-Regular`, `Peralta-Regular` (all
  `.ttf`), plus the fonts people upload. An SVG `font-family` matches them
  loosely ("PT Sans" finds `PTSans-Regular.ttf`); an unknown one falls back to
  the default face. On an ESP32, SVG text always uses the built-in Ubuntu
  face, whatever `font-family` says.

## Layout and color

- The same scene is installed on 800×480, 480×800, 1200×825 and 1600×1200
  panels. Work out every coordinate, size and font size from the frame (in a
  JS app `app.frame.width` / `height`, or `context.imageWidth` / `imageHeight`
  when drawing into a cell; in a code node `context.imageWidth` /
  `imageHeight`), for example `unit = Math.min(W, H) / 100`, and emit
  `<svg viewBox="0 0 W H" width="W" height="H">` with those numbers. Never
  hard-code 800×600, and never add width or height fields "just in case".
- Branch on orientation: when `H > W`, stack columns vertically.
- Keep a margin of about 4% of the shorter side, and never draw past the
  edge. Estimate a line's characters as `width / (fontSize * 0.55)`, wrap and
  truncate with an ellipsis yourself in SVG, and shrink a headline that does
  not fit. An 800×480 panel reads well at 24–48 px body text, 1600×1200 at
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
- Build output once: collect parts in one array and `join("")` at the end.
  Keep generated SVG small: round coordinates to one decimal, thin polylines
  to what the pixels can show, scale a shape with one
  `<g transform="translate(x y) scale(s)">`, and stay in the hundreds of
  elements, not thousands.
- A scene that renders every second or faster sets up its buffers in `init()`
  and updates them in place: flat arrays of numbers, fixed-size pools, no new
  objects, closures or big strings per frame, no fetch or `JSON.parse` while
  rendering, and a hard cap on particle counts. Those buffers are rebuilt on
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
| `pointerMove` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string, `buttons` integer | Pi, preview | When a pointer (a finger, a mouse, a pen) moves |
| `pointerDown` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string | Pi, preview | When a pointer button is pressed or a finger touches the panel. |
| `pointerUp` | yes |  | `x` integer, `y` integer, `button` integer, `buttons` integer, `pointerId` integer, `pointerType` string | Pi, preview | When a pointer button is released or a finger lifts |
| `pointerCancel` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | Pi, preview | When a pointer that was down is lost without a release: the queue overflowed, the device went away. |
| `mouseMove` | yes |  | `x` integer, `y` integer | Pi, preview | When a mouse moves. |
| `mouseDown` | yes |  | `button` integer | Pi, preview | When a mouse button is pressed. |
| `mouseUp` | yes |  | `button` integer | Pi, preview | When a mouse button is released. |
| `tap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | Pi, preview | A press and release in one place, within `gestures.tapMs`. |
| `doubleTap` | yes |  | `x` integer, `y` integer, `pointerId` integer, `pointerType` string | Pi, preview | A second `tap` in the same place within `gestures.doubleTapMs` of the first. |
| `longPress` | yes |  | `x` integer, `y` integer, `durationMs` integer, `pointerId` integer, `pointerType` string | Pi, preview | A pointer held in one place for `gestures.longPressMs`. |
| `swipe` | yes |  | `direction` string, `x` integer, `y` integer, `startX` integer, `startY` integer, `pointerId` integer, `pointerType` string | Pi, preview | A press and a release at least `gestures.swipeMinPx` apart, in one of four directions. |
| `wheel` | yes |  | `deltaX` integer, `deltaY` integer, `x` integer, `y` integer | Pi, preview | When a mouse wheel is scrolled. |
| `turnOn` | yes | yes |  | all | Turn the screen on |
| `turnOff` | yes | yes |  | all | Turn the screen off |
| `button` | yes |  | `pin` integer, `label` string, `role` string, `action` string, `durationMs`? integer, `heldSeconds`? integer, `wake`? boolean, `atMs`? integer, `level`? integer | all | A GPIO button, in two layers. |
| `setSceneState` |  | yes | `state`? json, `render`? boolean | all | Set the scene's public state. |
| `setCurrentScene` |  | yes | `sceneId` scene, `state`? json | all | Switch the frame to another scene. |
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
interface FrameOSStreamRef { __frameosType: "streamRef"; id: number; }

interface FrameOSApp {
  nodeId: number;
  nodeName: string;
  category: string;
  config: FrameOSAppConfig;
  state: Record<string, any>;
  frame: {
    width: number;
    height: number;
    rotate: number;
    assetsPath: string;
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
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
  /** When a mouse wheel is scrolled (not logged). Deltas are wheel notches; deltaY is positive when scrolling down (towards the user), deltaX when scrolling right. */
  wheel: { deltaX: number; deltaY: number; x: number; y: number };
  /** Turn the screen on */
  turnOn: Record<string, never>;
  /** Turn the screen off */
  turnOff: Record<string, never>;
  /** A GPIO button, in two layers. The hardware layer says what the line did, the moment it did it: `down` and `up` (with `durationMs`). The button layer says what the person meant, once that is clear, and each press is exactly one of: `press` (a short press with no second one within `doublePressMs` of its release, so it waits that long), `doublePress` (on the second down) or `longPress` (on the up of a press held at least `longPressMs`, with `durationMs` and `heldSeconds`; nothing while the key is down). A listener with no `action` filter hears `press` only. `atMs` is when the driver saw the edge, on the frame's monotonic clock: every rule is timed from it, so a press made while the panel was refreshing keeps its timing. */
  button: { pin: number; label: string; role: string; action: string; durationMs?: number; heldSeconds?: number; wake?: boolean; atMs?: number; level?: number };
  /** Set the scene's public state. This is not used for private state changes. */
  setSceneState: { state?: any; render?: boolean };
  /** Switch the frame to another scene. An optional `state` object is applied to that scene's public state. */
  setCurrentScene: { sceneId: string; state?: any };
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
  [key: string]: any;
}

declare const frameos: {
  image(spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image" };
  svg(svg: string, spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image"; svg: string };
  node(nodeId: number): FrameOSNodeRef;
  scene(sceneId: string): FrameOSSceneRef;
  color(color: string): FrameOSColorRef;
  log(...args: any[]): void;
  error(...args: any[]): void;
  setNextSleep(seconds: number): void;
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
- JS apps are data apps exporting `get` (wired into `render/image`) or logic
  apps exporting `run`.
- A JS app keeps what must outlast a render with `frameos.remember` (private)
  or `frameos.setState` (shared), never in a module variable.
- SVG uses only the supported tags, gradients use `userSpaceOnUse`, and every
  dynamic string is escaped.
- Sizes come from the frame, not from constants.
- Nothing big is embedded as an object literal or kept alive between renders.
