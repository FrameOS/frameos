# Pure JS scenes: `settings.execution == "js"`

A scene has one of three execution modes:

| mode | what the scene is | editor |
|---|---|---|
| `interpreted` (default) | a node graph (`nodes`, `edges`, `fields`) the frame walks | the diagram |
| `compiled` (legacy) | a node graph compiled to Nim on the backend | the diagram |
| `js` | **one JavaScript/TypeScript module** that draws the frame itself | a code editor |

A pure JS scene has no diagram. It keeps the parts of a scene everything
else already understands — `id`, `name`, `settings` (refresh interval,
background color), `fields` (the public state the control panel, the cloud
and schedules show) — and replaces the graph with `sources`:

```json
{
  "id": "…", "name": "Big clock",
  "settings": { "execution": "js", "refreshInterval": 60, "backgroundColor": "#ffffff" },
  "fields": [{ "name": "label", "type": "string", "value": "", "access": "public" }],
  "nodes": [], "edges": [],
  "sources": {
    "scene.ts": "import { pad } from './util'\nexport function render(scene, canvas) { … }",
    "util.ts": "export const pad = …"
  }
}
```

`nodes` and `edges` stay present and empty so every listing, duplicate,
diff and count keeps working. `sources` is the same file map a scene-local
JS app carries (`docs/js-apps-and-code-nodes.md`, "More than one file"):
`scene.ts` is the entry, relative imports resolve inside the map, `.json`
files import as data, `config.json` may list the `settings` namespaces the
scene reads with `getSetting`. TypeScript and JSX are parsed by the frame's
QuickJS (quickts), so there is no build step.

The five bundled examples live under `repo/scenes/samples/JS *` — a clock,
a weather board, a captioned photo, Conway's Life and a price sparkline.
Each folder holds the module as real files next to a `scene.json`;
`frameos/tools/pack_js_scenes.py` writes the `scenes.json` the frame reads
(and `--check` keeps the two in step).

## The module

```ts
import type { Scene, Canvas } from "frameos"   // types only; erased on the frame

export function init(scene: Scene) { … }                       // once, when the scene is built
export function render(scene: Scene, canvas: Canvas) { … }     // every render
export function onEvent(scene: Scene, event: string, payload: any) { … }  // everything else
```

- `init` runs once per scene instance, after the state is seeded from
  `fields` and the persisted state. Allocate what the scene keeps here.
- `render` draws the whole frame. The canvas arrives filled with
  `settings.backgroundColor` and at the scene's resolution (the panel,
  rotated); whatever is on it when `render` returns is shown. It is only
  valid during that call: a canvas kept in a variable throws on the next
  use, because the frame's canvas belongs to the host between renders.
- `onEvent` hears every other event the scene is sent — `open`, `close`,
  `buttonPress`, `keyDown`, `setSceneState` (after the state was applied),
  custom events — with the payload from `docs/events.md`. Input events are
  only built for a scene that exports it.

Module-level variables survive between renders on every host: the
runtime is pinned for the scene's life, so a scene that animates keeps its
particles in a typed array and never re-parses. The JS heap is the scene's
working memory; `frame.json` `js.memoryLimitMb` (8 MB on an ESP32) bounds
it, and the same deadlines and dispatch budget the node graph gets apply
("What the runtime will not let a scene do" in
`docs/js-apps-and-code-nodes.md`).

Errors go to the frame log (`jsScene:loadError` for a module that does not
parse, `jsApp:error` with a stack for a throw inside `render`), and a scene
whose module fails to load renders the error on the panel instead of a
blank frame.

## `scene`

Everything a scene-local JS app's `frameos` object has, plus the scene's
own: `fetchText`, `fetchJson`, `httpRequest`, the asset and stream calls,
`getSetting`, `setState`, `setNextSleep`, `log`, `error`, and

| member | what it is |
|---|---|
| `scene.state` | the scene's state. Read `scene.state.city`; write `scene.state.count = 1` (or `setState`). Public fields reach the control panel, persisted fields survive a restart, `state.refreshInterval` is the cadence. |
| `scene.frame` | `{ width, height, rotate, timeZone, assetsPath }` |
| `scene.id`, `scene.name`, `scene.timeZone`, `scene.backgroundColor`, `scene.refreshInterval` | |
| `scene.event`, `scene.payload` | the event the current run is for |
| `scene.now()` | seconds since the epoch |
| `scene.format(ts, pattern)`, `scene.parseTs(pattern, text)` | the curly-token time helpers from code nodes, in the frame's time zone |
| `scene.dispatch(event, payload)` | send an event (`setSceneState`, `setCurrentScene`, a custom event…) through the dispatcher, same budget and origin rules as a dispatch node |
| `scene.newImage(width, height)` | an offscreen RGBA canvas the scene owns. Draw on it like any canvas, `canvas.draw(it, x, y)` to composite, `it.free()` when done (collection frees it too). Refused when the frame cannot afford it. |
| `scene.loadImage(source, { width, height, fit })` | decode a picture into a new offscreen canvas of that size, for pictures reused across renders; `null` when it fails |
| `scene.setNextSleep(seconds)` | sleep this long after this render instead of the interval, once |

## `canvas`

A `Canvas` is a rectangle of pixels: the frame's render surface, a `cell`
of it, or an offscreen image. `canvas.width`, `canvas.height`,
`canvas.format` (`"rgbx"`, or `"rgb565"` on the largest ESP32 panels).
Colors are `"#rgb"`, `"#rrggbb"`, `"#rrggbbaa"`, a CSS color name, or a
number `0xRRGGBB` (opaque, and the spelling that allocates nothing).
Coordinates are pixels, fractions allowed and antialiased.

| call | draws |
|---|---|
| `clear(color)` | fills everything |
| `fillRect(x, y, w, h, color)` | a rectangle; opaque integer rects take a direct row fill |
| `strokeRect(x, y, w, h, color, width)` | its outline |
| `fillRoundedRect(x, y, w, h, radius, color)` | |
| `fillCircle(cx, cy, r, color)`, `strokeCircle(cx, cy, r, color, width)` | |
| `fillEllipse(cx, cy, rx, ry, color)` | |
| `line(x1, y1, x2, y2, color, width, { cap })` | `cap`: `"butt"` `"round"` `"square"` |
| `fillPath(d, color, { x, y, scale, rotate, evenOdd, blend })` | an SVG path string, placed and scaled; the way to draw icons |
| `strokePath(d, color, width, { x, y, scale, rotate, cap, join, dash })` | |
| `polyline(points, color, width, { close, cap, join })` | `points` is `[x0, y0, x1, y1, …]`: a plain array or any typed array, read in place |
| `fillPolygon(points, color)` | |
| `text(text, x, y, opts)` → `{ width, height }` | `opts`: `font` (a file in the frame's fonts folder; default Ubuntu), `size`, `color`, `width` (wrap and align box), `height`, `align` `"left"` `"center"` `"right"`, `valign` `"top"` `"middle"` `"bottom"`, `wrap`, `fit` (shrink the size until the text fits `width`×`height`), `lineHeight`, `underline`, `strikethrough` |
| `measureText(text, opts)` → `{ width, height }` | the same layout without drawing |
| `image(source, { x, y, width, height, fit, blend })` → `boolean` | a picture from an `http(s)://` URL, a `data:` URL, a path under the frame's assets folder, or another canvas. `fit`: `"cover"` (default) `"contain"` `"stretch"` `"center"`. Decodes **into** the rectangle: no native-size intermediate, on any host. False (and a `jsScene:imageError` log line) when it fails. |
| `svg(text, { x, y, width, height })` → `boolean` | rasterises an SVG into the rectangle (the strict renderer of `render/svg`) |
| `gradient(x, y, w, h, { from, to, colors, angle })` | a linear gradient written pixel by pixel; `angle` as in CSS (180 top→bottom, 90 left→right); `colors` for more than two stops |
| `cell(x, y, w, h)` → `Canvas` | a window onto the same pixels. Everything drawn on it is clipped to the rectangle and lands in the parent. Zero copy: this is how a dashboard is laid out. |
| `draw(canvas, x, y, { blend, width, height })` | composites another canvas (an offscreen image) here |
| `setPixel(x, y, color)`, `getPixel(x, y)` → `0xRRGGBB` | |
| `pixels()` → `Uint8Array` / `Uint16Array` | the canvas memory itself (premultiplied RGBA, or packed 5/6/5), zero copy, for this run only; not available on a cell |
| `free()` | release an offscreen image now |

`blend` where accepted: `"normal"` `"overwrite"` `"multiply"` `"screen"`
`"darken"` `"lighten"` `"mask"`.

## Why it is cheap

The point of the mode is that a scene can be exact about memory, which a
graph of apps handing images to each other cannot. Everything above draws
straight into the frame's canvas:

- draw calls read their arguments off the QuickJS stack — numbers, strings,
  typed arrays in place — never through JSON;
- shapes and text go through pixie's solid fill, which rasterises coverage
  row by row and allocates nothing the size of the target;
- `cell` is a pixie *view*: a stride and an origin, no buffer;
- `image` and `svg` decode into the rectangle they are drawn in (the same
  into-target decoders `render/image` and `render/split` use), so a 24 MP
  photo costs its compressed body plus decoder rows;
- `gradient` writes pixels directly in the canvas's own format — no mask,
  no paint image, no strips;
- the only allocations the scene makes are the ones it asks for
  (`newImage`, `loadImage`), and it can free them.

What this does not change: the ESP32 still has about 7 MB of PSRAM for
everything, fonts and the TLS stack included (`docs/esp32-memory.md`).
"Write for the smallest frame" in `docs/js-apps-and-code-nodes.md` applies
word for word — ship big data as strings, keep only what you draw, and set
up per-frame state once in `init`.

## Where the mode is wired

- **Runtime** (all hosts): `frameos/src/frameos/js_scene.nim` builds the
  registry entry (`buildJsSceneExport`), initialises, renders and runs
  events; the interpreter's `init` / `render` / `runEvent` dispatch there,
  so the Linux runner, the ESP32 host and the wasm preview need nothing
  else. The canvas binding is `js_runtime/canvas_api.nim`. Tests:
  `src/frameos/tests/test_js_scene.nim`.
- **Scene JSON**: `FrameSceneSettings.execution` and
  `FrameSceneInput.sources` (`types.nim`). `setup.nim` keeps js scenes in
  `scenes.json.gz`; the hub guard and the admin API already pass node-less
  scenes through.
- **Backend / frontend / cloud**: "runs from JSON" is `interpreted` *or*
  `js` — `scene_runs_from_json` (`backend/app/utils/scene_execution.py`),
  `sceneRunsFromJson` (`frontend/src/utils/sceneExecution.ts`); the
  shared rule corpus is `docs/scene-execution-fixtures.json`.
