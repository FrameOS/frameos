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
| `state.<field>` | the scene's state fields (declare them in the scene's `fields`) |
| `<arg>` | every declared `codeArgs` entry, by name |
| `context` | `{ event, payload, loopIndex, loopKey, hasImage }` |
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
`rotate`, `timeZone`), `context` (`imageWidth`/`imageHeight` when an image
is flowing through), and the `frameos` helpers — the full bridge, as the
type declarations (`frontend/src/utils/appTypeDeclarations.ts`,
`cloud/apps/auth-web/scripts/generate-ai-context.mjs`) list it:
`frameos.fetchJson(url)`, `frameos.fetchText(url)`,
`frameos.httpRequest(url, {method, headers, body, bodyBase64, base64,
timeoutMs})`, `frameos.svg(svg, spec)`, `frameos.image(spec)`,
`frameos.log()`, `frameos.error()`, `frameos.setState()`,
`frameos.setNextSleep()`, `frameos.getSetting("namespace", "key")` (only
namespaces the app's `config.json` declares under `settings`), the asset
calls `listAssets`, `assetExists`, `assetSize`, `readAsset`, `writeAsset`,
`appendAsset`, `deleteAsset`, `loadAssetImage`, and the stream calls
`openAssetStream`, `createStream`, `streamRead`, `streamWrite`,
`streamAtEnd`, `streamRewind`, `streamClose` (base64 in and out).
`app.state` **is** the scene's state — read any
key from it, write with `frameos.setState(key, value)` and state nodes see the
change. What an app does **not** have are the code-node time helpers
(`format`, `now`, `parseTs`); take such values in through a field fed by a
code node or `data/clock`. `Date` is UTC-only here as well.

JavaScript is the format apps are written in. The Nim apps under
`frameos/src/apps/` are the built-in catalog that ships inside the FrameOS
binary (`render/text`, `data/clock`, …) — not something a scene carries or a
user edits. A scene that still holds Nim sources or Nim code nodes is a
legacy *compiled* scene; `docs/nim-to-js-conversion.md` is the way out.

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

`export function init(app)` is optional and runs once. Do **not** give a
scene-local app `category: "render"`: as of Aug 2026 such an app placed in the
prev/next chain draws nothing and logs nothing. The pattern that works is a
**data app whose `get()` returns `frameos.svg(...)`**, wired into a
`render/image` node — that is how the Weather sample's `weatherPanel` works.

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
