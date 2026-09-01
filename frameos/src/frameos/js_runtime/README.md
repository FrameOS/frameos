# FrameOS JavaScript Runtime

This directory contains the JavaScript support used by the on-device FrameOS
runtime. It covers two related paths:

- Scene snippets and code nodes, compiled by `runtime.nim`.
- Repository JavaScript apps, compiled and hosted by `app_runtime.nim`.

Both paths hand the source straight to the bundled QuickJS engine. That engine
is [quickts](https://github.com/FrameOS/quickts): upstream QuickJS plus native
TypeScript erasure and JSX lowering, switched on per eval with
`JS_EVAL_FLAG_TYPESCRIPT` / `JS_EVAL_FLAG_JSX` (`burrito.quicktsFlagsFor`).
Nothing in this directory transforms source text any more; the only generated
JavaScript is the envelope a snippet is wrapped in.

## File Origins and Licenses

FrameOS is licensed under the repository license, AGPL-3.0. Most files in this
directory are FrameOS source files. `burrito.nim` is the exception: it is copied
from Burrito under MIT and modified locally. The file-level lineage is below.

### FrameOS Runtime Files

- `runtime.nim` is FrameOS code extracted from the older interpreter runtime.
  It owns the scene-snippet bridge to QuickJS: context setup, global helpers,
  state/args/context proxies, console logging, JSX runtime helpers, runtime
  value conversion, source-location registration, and cleanup.
- `app_runtime.nim` is FrameOS code for repo-provided JavaScript apps. It wraps
  an app module, exposes the `frameos` app API to QuickJS, manages app lifecycle
  calls, handles image references, and converts JS return values back to
  FrameOS values.
- `source_map.nim` is FrameOS code. It is not a standard source-map generator.
  It stores a compact generated line/column table for the snippet envelope,
  enough to rewrite a QuickJS error location back to the snippet's own line.

### The transpiler that used to be here

Until September 2026 this directory carried a native Nim port of the subset
of Sucrase FrameOS needed (`tokens.nim`, `parser.nim`, `token_processor.nim`,
`transpiler.nim`, ~4,300 lines): TypeScript erasure, JSX lowering and a
CommonJS rewrite, run on the device for every app on every render. Its token
array reached 1.4 MB for the 36 KB Weather app, which is what stopped a 13.3"
ESP32 frame rendering that scene. It was replaced by quickts, which does the
same work inside the QuickJS parser for +16 KB of code and no extra memory
(`docs/quickts.md`). The parity harness and the `native_js_transpile` CLI went
with it; `tools/js_check.nim` is what validates sources now.

### QuickJS and Burrito

The JS engine and Nim binding are outside this directory but are part of this
runtime stack:

- `burrito.nim` is copied from
  https://github.com/tapsterbot/burrito/blob/main/src/burrito/qjs.nim and then
  adjusted for FrameOS build/runtime needs. Burrito is MIT licensed with
  copyright attribution to Tapster Robotics, Inc.
- QuickJS is [quickts](https://github.com/FrameOS/quickts) (upstream plus native TypeScript/JSX parsing), downloaded/built by `frameos.nimble` as `quickjs-2026-06-04-quickts.1`.
  QuickJS is MIT licensed with copyright attribution to Fabrice Bellard and
  Charlie Gordon.

FrameOS uses Burrito as the thin Nim/QuickJS FFI layer. The code in this
directory deliberately keeps most app/snippet semantics in FrameOS code and
uses QuickJS only to execute the resulting JavaScript.

## Runtime Responsibilities

`runtime.nim` handles interpreted scene JavaScript:

- Creates one QuickJS context per interpreted scene.
- Registers Nim bridge functions exposed to JS: `getState`, `getArg`,
  `getContext`, `jsLog`, `parseTs`, `format`, and `now`.
- Installs global JS proxies for `state`, `args`, and `context`.
- Installs FrameOS classic JSX helpers:
  `__frameosJsx(...)` and `__frameosFragment`.
- Compiles code nodes, inline code snippets, and one-shot eval snippets into
  named JS functions.
- Wraps snippets in a JSON envelope so ordinary values return as strings rather
  than crossing the Nim/QuickJS boundary as arbitrary `JSValue`s.
- Coerces returned envelope JSON to FrameOS `Value` instances using expected
  output types where available.
- Logs JS compile/runtime errors through the scene logger.
- Registers compact source-location data and rewrites QuickJS error stacks back
  to app/snippet source lines and columns.
- Serializes scene JS access behind `sceneJsLock`; QuickJS contexts are not
  treated as thread-safe.

`app_runtime.nim` handles repo JavaScript apps:

- Evaluates the app's main file as a real ES module, TypeScript and JSX
  included, and publishes its namespace to the prelude.
- Exposes a `frameos` API object to JS apps, including logging, state updates,
  image operations, sleep scheduling, HTTP helpers, and context access:
  - `fetchText(url)` / `fetchJson(url)`: bounded GET requests.
  - `httpRequest(url, {method, headers, body, bodyBase64, base64, timeoutMs})`:
    bounded requests with any method/headers; returns `{status, body}` or
    `{status, bodyBase64}` when `base64: true` (required for binary responses,
    since raw bytes cannot cross the JS boundary as strings), or
    `{status: 0, error}` on transport failure.
  - `listAssets(dir)`, `assetExists(path)`, `assetSize(path)`,
    `readAsset(path, {offset, length}?)`, `writeAsset(path, base64)`,
    `appendAsset(path, base64)`, `deleteAsset(path)`: asset management scoped
    to the frame's assets folder. Full-buffer reads are capped on embedded
    targets (2MB) — read bigger files in ranged chunks or via streams.
  - `loadAssetImage(path)`: decode an asset image within display bounds
    (memory-aware, streams from disk) and return an image reference.
  - `openAssetStream(path, "r"|"w"|"a")`, `createStream(base64?)`,
    `streamRead(ref, length?)`, `streamWrite(ref, base64)`, `streamAtEnd(ref)`,
    `streamRewind(ref)`, `streamClose(ref)`: simple string/asset-file streams
    for chunked processing. Stream refs are plain JSON (`{__frameosType:
    "streamRef", id}`) held in a global capped registry, so a data app can
    return one and a downstream app can consume it.
  - `getSetting(...path)`: read `frameConfig.settings` values (API keys etc.);
    only namespaces listed in the app config's `"settings"` array are
    accessible, so access travels visibly with the scene JSON.
- Installs a QuickJS module loader so the main module can `import` the app's
  other files (see Module Loading below).
- Calls exported app lifecycle functions such as `init` and `get`.
- Tracks persistent and transient image references so overwritten dynamic image
  fields can be released.
- Leaves error locations alone: with no generated source there is nothing to
  map, and QuickJS already names the app's own file and line.

## Module Loading

An app's `sources` map is the whole module graph. `app_runtime.nim` evaluates
the main file (`app.ts`, `.tsx`, `.js` or `.jsx`) as a real ES module under
its own file name and registers a normalize/loader pair on the QuickJS
runtime (`burrito.setModuleLoader`):

- `jsAppModuleNormalize` joins `./` and `../` specifiers against the importing
  module's folder (`joinModulePath`, QuickJS's own rule) and canonicalises
  the result to the file it names (`resolveAppModule`: as written, then
  `.ts/.tsx/.js/.jsx/.json`, then `./x.js` → `x.ts`). Canonical names are
  what QuickJS keys loaded modules by, so a file evaluates once however many
  importers spell its path differently.
- `jsAppModuleLoader` compiles a script file straight from the scene JSON
  with `JS_EVAL_FLAG_COMPILE_ONLY` and the flags its extension implies
  (`quicktsFlagsFor`); a `.json` file becomes a synthetic C module whose
  default export is the parsed value. Nothing is copied or kept per file.
- Bare specifiers and files the app does not have fail with a ReferenceError
  that says so; compile and JSON errors are re-thrown with the file name and
  position in the message.
- Runtime stacks read `util.ts:5:3` in the file's own lines, because that is
  the text QuickJS parsed.

There is no package registry, no `require()`, and no dynamic `import()` (the
app runtime is synchronous and does not pump the job queue).

## What QuickJS parses

quickts handles TypeScript erasure (annotations, `interface`/`type`/`declare`,
generics, `as`/`satisfies`/`!`, class modifiers, overload signatures, type-only
imports), lowers enums, constructor parameter properties and JSX to bytecode,
and leaves everything else to the ordinary parser. The supported and
unsupported lists, and the tests behind them, live in the quickts README.

`quicktsFlagsFor(filename)` decides what a source gets: `.js`/`.mjs`/`.cjs`
nothing, `.jsx` JSX only, everything else both passes — a scene app's main
file has always had both run over it whatever it was called. Code nodes and
inline expressions always get both (`runtime.snippetEvalFlags`).

The JSX factory is the FrameOS classic runtime the prelude defines:
`__frameosJsx(type, props, ...children)` and `__frameosFragment`.

## Source Locations

App sources are parsed as-is, so a QuickJS location in an app is already a
source location. The one place FrameOS still generates JavaScript is the
envelope `buildEnvelopeFunctionWithMap` wraps around a snippet; it records a
`SourceLineMap` for that wrapper and registers it per context, and
`rewriteQuickJsLocations` rewrites `filename:line:column` in error text back
to the snippet's lines before it is logged.

## Test Coverage

Focused tests for this directory live in:

- `src/frameos/js_runtime/tests/test_js_runtime_helpers.nim`
- `src/frameos/js_runtime/tests/test_js_app_runtime.nim`
- `src/frameos/js_runtime/tests/test_scene_runtime_cleanup.nim`
- `src/frameos/js_runtime/tests/test_source_map_lines.nim`

TypeScript and JSX parsing itself is tested in the quickts repository
(`make test-quickts` there). Add a case there when a construct fails to parse.

## Maintenance Notes

- Syntax QuickJS cannot parse is a quickts change, not a FrameOS one; bump the
  pinned `quickjs-<version>` everywhere `frameos.nimble` lists.
- Keep snippet errors mapped back to snippet lines: if the envelope changes
  shape, update the map `buildEnvelopeFunctionWithMap` builds.
- Keep source attribution in this README if code is copied or closely ported
  from an upstream project.
