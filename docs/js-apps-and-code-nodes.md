# JavaScript in scenes: code nodes and scene-local JS apps

Interpreted scenes run two kinds of JavaScript on the frame, in two different
sandboxes. They look alike in the editor and behave differently at run time;
most "it renders nothing / prints the format string" reports come from mixing
them up.

## Code nodes

A code node holds one JavaScript **expression** in `data.codeJS` (wrap
multi-statement logic in an IIFE). It has exactly one output (`codeOutputs[0]`)
and connects to other nodes only with `codeNodeEdge` edges: arguments arrive on
`targetHandle: "codeField/<name>"` and must also be declared in
`data.codeArgs` as `{ name, type }`; the result leaves on
`sourceHandle: "fieldOutput"`.

Globals available inside a code node — and nothing else:

| global | what it is |
|---|---|
| `state.<field>` | the scene's state fields (declare them in the scene's `fields`), plus `state.refreshInterval` — see [the refresh interval](#the-refresh-interval-is-a-state-field) |
| `<arg>` | every declared `codeArgs` entry, by name |
| `context` | `{ event, payload, loopIndex, loopKey, hasImage, imageWidth, imageHeight }` — `imageWidth` / `imageHeight` are the canvas this run draws on, in scene pixels (a cell's inside `render/split`), and `undefined` when it has none (`hasImage` is false: any event but `render`) |
| `console.log/warn/error` | goes to the frame log |
| `now()` | seconds since epoch (number) |
| `format(ts, pattern)` | formats a timestamp in the frame's time zone |
| `parseTs(pattern, text)` | parses text into seconds since epoch |

Argument names are checked against those globals: a `codeArgs` entry named
`state`, `args`, `context`, `console`, `getargor`, `parseTs`, `format` or
`now` (case-insensitive) is **not declared** — the code sees the global of
that name instead of the input, silently. Name the argument something else
(`heaterState`, not `state`); the converter renames such arguments and their
edges for you.

There is **no `frameos` object, no `fetch`, no HTTP** in a code node. Fetch
data with a data app (`data/downloadUrl`, `data/parseJson`, `data/xmlToJson`,
…) and wire its `fieldOutput` into a code node argument. Standard JavaScript
(`Math`, `JSON`, `Date`) works, but `Date` has no time-zone data — derive
local time from `format(now(), …)`.

### Time patterns

`format()` and `parseTs()` use **curly tokens**. Letters outside braces are
copied verbatim, so `"HH:mm"` prints the text `HH:mm`.

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

Examples: `format(now(), "{hour/2}:{minute/2}")` → `09:05`;
`format(now(), "{weekday}, {month/n} {day}")` → `Monday, August 24`;
`Number(format(now(), "{hour}"))` → `9`. For a plain clock, the `data/clock`
app is simpler than a code node.

## Scene-local JS apps

A scene can bundle its own apps in its top-level `apps` map:

```json
"apps": {
  "myPanel": {
    "name": "My panel", "category": "data", "description": "…",
    "fields": [{ "name": "city", "type": "string", "value": "Brussels" }],
    "output": [{ "name": "image", "type": "image" }],
    "sources": { "config.json": "…", "app.ts": "…" }
  }
}
```

A `select` field lists its choices in `options`, either as plain strings
(`["dark", "light"]`) or as `{ "value": "dark", "label": "Dark mode" }` pairs
when the label shown should differ from the value stored in config or state.

App nodes then use `keyword: "myPanel"`. Inside `app.ts` the app sees
`app.config` (its fields), `app.state`, `app.frame` (`width`, `height`,
`rotate`, `timeZone`, and from 2026.10.13 `debug` and `embedded`, true on an
ESP32-class runtime), `context` (`imageWidth`/`imageHeight` when an image
is flowing through), and the `frameos` helpers — the full bridge, as the
type declarations (`frontend/src/utils/appTypeDeclarations.ts`,
`cloud/apps/auth-web/scripts/generate-ai-context.mjs`) list it:
`frameos.fetchJson(url)`, `frameos.fetchText(url)`,
`frameos.httpRequest(url, {method, headers, body, bodyBase64, base64,
timeoutMs, find, findLength, findLimit})` (see [Big pages](#big-pages)), `frameos.fetchImage(url, {headers, saveAsset})` (see
[Photos from the network](#photos-from-the-network)), `frameos.svg(svg,
spec)`, `frameos.image(spec)`,
`frameos.log()`, `frameos.error()`, `frameos.setState()`,
`frameos.setNextSleep()`, `frameos.getSetting("namespace", "key")` (only
namespaces the app's `config.json` declares under `settings`),
`frameos.remember(key, value)` / `frameos.recall(key)` (see below), the asset
calls `listAssets`, `assetExists`, `assetSize`, `readAsset`, `writeAsset`,
`appendAsset`, `deleteAsset`, `loadAssetImage`, and the stream calls
`openAssetStream`, `createStream`, `streamRead`, `streamWrite`,
`streamAtEnd`, `streamRewind`, `streamClose` (base64 in and out).
`app.state` **is** the scene's state — read any
key from it, write with `frameos.setState(key, value)` and state nodes see the
change. What an app does **not** have are the code-node time helpers
(`format`, `now`, `parseTs`); take such values in through a field fed by a
code node or `data/clock`. `Date` reads local time in the frame's zone,
like Nim's `now()` (the process zone on a Pi, the frame's time zone setting
on an ESP32).

JavaScript is the format apps are written in. The Nim apps under
`frameos/src/apps/` are the built-in catalog that ships inside the FrameOS
binary (`render/text`, `data/clock`, …) — not something a scene carries or a
user edits. A scene that still holds Nim sources or Nim code nodes is a
legacy *compiled* scene; `docs/nim-to-js-conversion.md` is the way out.

### Photos from the network

A JS app that shows a photo from an API (the Immich app,
`repo/apps/image/immich`, is the worked example) does the JSON half with
`httpRequest` and the picture with **`frameos.fetchImage(url, options)`**.
The runtime downloads and decodes the image natively and hands JS an image
reference; the bytes never enter the JS heap. The app returns that reference
as its output:

```ts
const photo = frameos.fetchImage(`${server}/api/assets/${id}/thumbnail?size=preview`, {
  headers: { 'x-api-key': apiKey },
  saveAsset: { name: 'IMG_001', extension: 'jpg', mode: 'auto' },
})
if (!photo.image) throw new Error(`Error fetching image from Immich: ${photo.error}`)
return photo.image
```

- `options.headers` go on the request, like `httpRequest`.
- The result is `{ image, width, height }` or `{ image: null, error }`
  (an HTTP status, a transport failure, a body that is not an image). It
  never throws, so the app decides what to say (and throws it, see below).
- `options.saveAsset` keeps the downloaded file as a frame asset, the way
  the built-in photo apps do (`saved/<app>/<name>.<md5>.<ext>`; `mode:
  "auto"` honours the frame's save-assets setting, `"always"` saves
  regardless). The extension is reduced to a short alphanumeric suffix.
  Frames without storage (ESP32) never save and report no `savedAs`.
- `options.exif: true` adds `exif` (an object: `make`, `model`, `iso`,
  GPS, …, plus everything exiftool reports where the host has it) and
  `exifSummary` (one line, e.g. "Canon EOS · f/2.8") read from the
  downloaded bytes. Like `savedAs`, an ESP32 reports neither. FrameOS
  2026.10.13 and later.
- The URL may be a `data:` URL. That is how an app shows an image an API
  returned as base64 (OpenAI's `b64_json`):
  `frameos.fetchImage(`data:image/png;base64,${b64}`)`. It decodes into the
  offered canvas like a download, and from 2026.10.13 `saveAsset` and `exif`
  work on it on hosts too.
- On an ESP32 the decode streams straight into the canvas the `render/image`
  node offered, with the node's `placement` (cover, contain or stretch), so a
  1440 px Immich preview needs its compressed body plus a few rows, not a
  full-resolution RGBA buffer. Any other placement decodes bounded by the
  target's size and lets `render/image` place the result. On a Pi the decode
  is at native resolution and the consumer scales.

### When something goes wrong

Throw. An error thrown out of `get()` fails the node the way a raising
built-in app does: the message is logged with its source line, an image
field gets the message painted (natively, into the canvas on an ESP32, so an
app needs no error panel of its own), a code node that reads the value gets
the zero value of its arg's type, and the node cache keeps nothing, so the
next render tries again. That is what the photo apps do for a missing key or
a failed download. (Before 2026.10.13 the consumer got `null` instead, and a
cached node kept it.)

Keep apps small: a scene carries a copy of every app it uses (its
`config.json` twice: as keys and as a file), an ESP32 stores all its scenes
in 512 KiB, and the active scene's sources are parsed on every render. No
comment blocks, no helpers used once, short config hints.

### Where an app keeps its values

Three places, the same rule on every device:

| the value | goes in | lasts |
|---|---|---|
| what the rest of the scene should see: a position a button changes, the photo's metadata | `frameos.setState(key, value)`, read back as `app.state[key]` | the scene's state: every node reads it, state nodes see changes, declared fields can persist and show in the frame's controls |
| the app's own, needed on the next render: a fetched photo list, a position | `frameos.remember(key, value)`, read back with `frameos.recall(key)` | until the scene unloads (not across a restart); private to the node |
| scratch for this render: lookup tables built when the module loads, intermediate results | module-level variables | one render |

Module-level variables last as long as the app's interpreter, and an ESP32
drops every idle interpreter after each render to give the next decode the
memory, so the next render starts with a fresh module and runs `init()`
again. The editor's preview does the same, so an app that keeps a counter in
a module variable shows its first photo forever in the editor too, not only
on the frame. A Pi keeps its interpreters for the scene's life, to stay fast,
but an app must not count on that.

`remember` values are JSON, at most 512 KB per node on an ESP32. `remember`
answers `false` when a value would not fit, and `null` forgets the key. The
Google Photos app keeps its album's photo list and its position this way.
Scene state is shared by the whole scene, so a private value kept there
collides with a second copy of the app and sits where everything else reads
it. FrameOS 2026.10.13 and later.

An animation works out each frame from the clock (`Date.now()`) rather than
adding to a position kept between frames: the store's DVD bounce scene
computes where the logo is from the time, so a fresh module draws the same
picture.

### Big pages

A response body becomes a JS string, and on an ESP32 a 1 MB page with one
non-Latin-1 character is 2 MB of JS heap, twice over while the reply is
parsed: over the 4 MB an ESP32 app runtime gets. When the app only needs
what follows some marker, pass `find`: `frameos.httpRequest(url, {find:
'https://lh3.googleusercontent.com/', findLength: 400})` keeps the body
native and answers `{status, found}`, the text at each occurrence (marker
included, `findLength` bytes, default 512; `findLimit` occurrences, default
1000). On a non-2xx status `body` holds the first KB, so the error stays
readable. The Google Photos app reads its 1.2 MB share page this way.
FrameOS 2026.10.13 and later.

### More than one file

`sources` can hold helper modules and data next to `app.ts`, and `app.ts`
imports them with relative paths:

```json
"sources": {
  "config.json": "…",
  "app.ts": "import { panel } from './panel'\nimport icons from './icons.json'\nexport function get(app) { return panel(app, icons) }",
  "panel.tsx": "export const panel = (app, icons) => <image width={app.frame.width} … />",
  "icons.json": "{ \"sun\": \"<svg …>\" }"
}
```

- `./name` resolves to `name.ts`, `name.tsx`, `name.js`, `name.jsx` or
  `name.json` (also `./name.js` for a `name.ts`, as TypeScript allows);
  `../` climbs folders inside the app (`lib/util.ts` → `../data.json`).
- A `.json` file's parsed value is its default export.
- JSX is lowered only in `.tsx`/`.jsx` files; `import { x, type T }` erases
  the type specifier.
- Only the app's own files resolve. There are no npm packages, no
  `require()`, and no dynamic `import()`.
- Each file is evaluated once per app, however many files import it, and
  errors name the file and line they came from (`util.ts:5`).

### The export that runs

| category | export the runtime calls | how the node is wired |
|---|---|---|
| `data` / `logic` | `export function get(app, context)` → returns the `output` value (string, json, or `frameos.svg`/`frameos.image` for an image) | `codeNodeEdge` from `fieldOutput` into another node's `fieldInput/<field>` (e.g. `render/image`'s `image`) |

`export function init(app)` is optional and runs each time the app's
interpreter starts: once per scene on a Pi, before every render on an ESP32
and in the preview (see [Where an app keeps its values](#where-an-app-keeps-its-values)).
Do **not** give a
scene-local app `category: "render"`: as of Aug 2026 such an app placed in the
prev/next chain draws nothing and logs nothing. The pattern that works is a
**data app whose `get()` returns `frameos.svg(...)`**, wired into a
`render/image` node — that is how the Weather sample's `weatherPanel` works.

## The refresh interval is a state field

How often a scene renders is part of its state, so the person running the
scene can change it without opening the editor:

- Every scene has a public state field **`refreshInterval`**, labelled
  "Refresh interval (seconds)" and listed **last** wherever the scene's options
  are shown: the frame's own control panel (`/c`), the admin UI, the backend,
  the cloud, schedules, split-screen panel options and the live preview. A scene does not declare it; its
  default is `settings.refreshInterval`.
- Read it as `state.refreshInterval` (code nodes, state nodes) or
  `app.state.refreshInterval` (JS apps). Write it like any other state —
  `frameos.setState("refreshInterval", 60)` or a `logic/setAsState` node — and
  the next sleep uses the new value. A `setSceneState` / `setCurrentScene`
  payload, a schedule's state and a control panel all do the same thing.
- A scene that wants its own wording, or its own place in the list, marks
  **one** numeric field with `"role": "refreshInterval"`:

  ```json
  { "name": "seconds", "label": "Seconds per image", "type": "float", "value": "600",
    "access": "public", "persist": "disk", "role": "refreshInterval" }
  ```

  That field then *is* the interval (its `value` is the scene's default and
  wins over `settings.refreshInterval`) and no implicit `refreshInterval`
  field is added. It stays where the scene put it: declaring the field is how
  an author decides where the control goes and what it is called, and with
  `"access": "private"` that people get no control at all. A `float` or
  `integer` field literally named `refreshInterval` is taken over the same way
  without a role. (A `refreshInterval` field of any other type is left alone —
  the scene is using the name for something else — and then there is no
  interval control; the linter warns.)
- Anything that is not a positive number falls back to the scene's default.
- A `persist: "disk"` field (and, on the ESP32, every public field) reaches
  the state file only once it has left its declared default; back on the
  default it is dropped again. A value still on the default would otherwise
  pin it: the file is read before the defaults, so a redeploy that changes
  the default (`settings.refreshInterval`, a `seconds` field, an album id)
  would never reach a frame that had rendered the scene once.

There is no need to wire a state node into `logic/nextSleepDuration` to make
the cadence configurable. That app (and `frameos.setNextSleep()`) is a
**one-time override**: it sets how long to sleep after *this* render and
leaves the refresh interval alone, so the render after that is back on the
interval. Use it for the odd cycle — the interval is 3600, but sleep 900 now
so refreshes line up with the hour — not as the scene's cadence.

The rules live in `frameos/src/frameos/refresh_interval.nim` (runtime),
`frontend/src/utils/refreshInterval.ts` (every control surface),
`frameos/wasm/src/refreshInterval.ts` (the preview package) and
`backend/app/utils/refresh_interval.py` (compiled scenes, virtual frames).

## SVG that the frame can draw

`render/svg` (and `frameos.svg(...)` in JS apps) go through a strict renderer.
Any unsupported tag fails the **whole** document — `render/svg` prints
"Failed to render SVG", a JS app's image comes back empty ("No image
provided"). Supported: `svg` (with a `viewBox`), `g`, `path`, `rect`,
`circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`/`tspan`,
`linearGradient`, `radialGradient`, `defs` (only the gradients in it are
read), `title`, `desc`. Not supported: `use`, `image`, `filter`, `mask`,
`clipPath`, `pattern`, `style`, `foreignObject`, `symbol`, `marker`.

Gradients must be in user space (`gradientUnits="userSpaceOnUse"`;
`objectBoundingBox`, the SVG default, fails the document). Coordinates are
viewBox units or percentages of the viewBox, stop offsets 0..1 or
percentages, `stop-opacity` and `gradientTransform` work, and the gradient
may sit at the top level or inside `<defs>`. A radial gradient's `fx`/`fy`
and `spreadMethod` are ignored (centred, padded). Fills only: `stroke` cannot
reference a gradient.

```svg
<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="600">
  <stop offset="0" stop-color="#0f172a"/>
  <stop offset="1" stop-color="#1e3a5f"/>
</linearGradient>
<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="400" cy="120" r="360">
  <stop offset="0" stop-color="#ffe08a" stop-opacity="0.8"/>
  <stop offset="1" stop-color="#ffe08a" stop-opacity="0"/>
</radialGradient>
<rect width="800" height="600" fill="url(#bg)"/>
<rect width="800" height="600" fill="url(#glow)"/>
```

Frames on firmware older than the pixie `radialGradient` pin (2026-08-25)
fail the whole document on `<radialGradient>`, `<defs>` gradients,
`gradientTransform` and percentages — the linear form above is the one that
works everywhere.

— placed directly under `<svg>` (never in `<defs>`), numeric coordinates in
viewBox units, numeric stop offsets 0–1, no percentages, no
`gradientTransform`. For a whole-screen gradient the `render/gradient` app
(`startColor`, `endColor`, `angle`) is the simpler choice.

## What the runtime will not let a scene do

Scene JS is untrusted on every frame — it is anyone's store scene at worst
and your own typo at best — and it runs on the thread that draws the panel.
Four ceilings turn "this frame never renders again" into one logged scene
error. All of them are set in `frame.json` under `js`; `-1` or an absent key
keeps the build's default, `0` disables the ceiling.

| Key | Default | What it bounds |
|---|---|---|
| `executionTimeoutMs` | 30 000 (Pi), 20 000 (ESP32) | Interpreter time per entry into JS. The clock stops while a native binding (`httpRequest`, an asset read) runs, so a slow fetch is not mistaken for a runaway loop. |
| `renderDeadlineMs` | 120 000 (Pi), 90 000 (ESP32), 60 000 (preview) | Wall-clock time per render or event, native calls **included**. Every HTTP request made during the run is capped to what is left of it; the script is stopped when it passes. This is what a tarpit URL costs a scene: one render, not the watchdog window. |
| `memoryLimitMb` | 256 (Pi), 8 (ESP32) | JS heap **per scene**, shared by the scene's code-node context and every JS app node's runtime. One node hoarding the heap fails with `out of memory`; the frame's other scenes are unaffected. |
| `dispatchBudget` | 64 | Events a single render or event may fire through dispatch nodes. A handler that dispatches its own event is an unbounded chain; past the budget the run's dispatches are dropped, once with an `interpreter:dispatch:ignored` log line (`reason: dispatchBudget`). The ESP32, which runs events synchronously, also refuses events nested more than four deep. |

## Write for the smallest frame

The scene that runs on a Raspberry Pi with hundreds of MB also gets installed
on an ESP32, where a few MB of PSRAM hold the canvas, the JS heap (the 8 MB
`memoryLimitMb` above is a ceiling, not what is free), fonts and the network
stack. A scene that ignores this renders in the preview and fails with
`out of memory` on the device. What matters is what stays alive and how much a
render allocates — not terse code:

- **Parsed objects cost 10–20× their JSON text** (boxed numbers, nested
  arrays); strings cost about 1×. Do not embed big object or array literals
  (GeoJSON, coordinate lists, lookup tables). Ship such data as compact
  strings — precomputed SVG path `d` strings, delimited text split on demand.
  A world map as a 260 KB GeoJSON literal held 4.3 MB of heap and never
  rendered; as 68 KB of path strings it renders in 3.5 s.
- **Keep only what you draw.** Pull the fields you need out of a fetched
  payload straight away, slice lists to what fits on screen *before* mapping
  over them, ask the API for fewer rows and fields when it lets you, and do
  not park whole responses in module-level variables or `app.state`.
- **Build output once.** Collect parts in one array and `join("")` at the end
  rather than growing strings in nested loops or chaining
  `map`/`filter`/`concat` copies of a large array. Keep generated SVG small:
  round coordinates to one decimal, thin polylines to what the pixel grid can
  show, scale a shape with one `<g transform="translate(x y) scale(s)">`
  instead of recomputing its points, and stay in the hundreds of elements.
- **Scenes that re-render every second or faster** set their buffers up in
  `init()` and update them in place: flat arrays of numbers and fixed-size
  pools, no new objects, closures or big strings per frame, no fetch or
  `JSON.parse` in the render path, and a hard cap on particle counts. Those
  buffers are scratch (an ESP32 and the preview build them again every
  render), so positions come from the clock, not from the previous frame.

## Checklist before shipping a scene

- Every `data.config` key is a field of the app; select values are one of the options.
- Node-typed fields (`logic/ifElse` `thenNode`/`elseNode`, `render/split`
  `render_functions[row][col]`) are edges (`sourceHandle: "field/<name>"` →
  `targetHandle: "prev"`), never config.
- Every code node argument is both declared in `codeArgs` and fed by an edge.
- Images flow only into image fields; text/json only into non-image fields.
- Time formatting uses `{hour/2}`-style tokens.
- Scene-local JS apps are data apps exporting `get`, wired into `render/image`.
- SVG uses only the supported tags; gradients are top-level `linearGradient` with `userSpaceOnUse`.
- Nothing big is embedded as an object literal or kept alive between renders (see "Write for the smallest frame").
- A JS app keeps what must outlast a render with `frameos.remember` (private) or `frameos.setState` (shared), never in a module variable.
