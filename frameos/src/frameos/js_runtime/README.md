# FrameOS JavaScript Runtime

This directory contains the JavaScript support used by the on-device FrameOS
runtime. It covers two related paths:

- Scene snippets and code nodes, compiled by `runtime.nim`.
- Repository JavaScript apps, compiled and hosted by `app_runtime.nim`.

Both paths end by passing JavaScript directly to the bundled QuickJS engine. The
native transpiler therefore only removes or rewrites syntax that QuickJS cannot
run in the form FrameOS receives it. Modern JavaScript that the bundled QuickJS
accepts should pass through unchanged.

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
  It stores a compact generated line/column table that is enough to rewrite
  QuickJS compile/runtime error locations back to the original app or snippet
  source.

### Native Sucrase-Compatible Port

- `tokens.nim`, `parser.nim`, `token_processor.nim`, and `transpiler.nim` are
  FrameOS code written as a native Nim reimplementation of the subset of
  Sucrase needed by FrameOS.
- The public shape intentionally mirrors Sucrase concepts such as
  `TransformOptions`, `TransformResult`, token labels, parser annotations, and
  `TokenProcessor`-style rewriting so behavior can be compared against
  upstream Sucrase.
- The implementation is not a vendored copy of Sucrase. It is a compatibility
  slice designed for single-file FrameOS apps/snippets and for the QuickJS
  execution target.

Sucrase attribution:

- Upstream project: https://github.com/alangpierce/sucrase
- Version used for parity and dependency reference: `3.35.1` from
  `frameos/frontend/package.json` and `pnpm-lock.yaml`.
- License: MIT.
- Copyright notice used by Sucrase: `Copyright (c) 2012-2018 various
  contributors (see AUTHORS)`.
- Primary author/project maintainer attribution: Alan Pierce and Sucrase
  contributors.
- Sucrase also credits Babel/Babylon and Acorn ancestry. Babel/Babylon and
  Acorn contributors should be preserved in attribution when copying concepts
  from those parser layers through Sucrase.

The native port started from the runtime need to remove the QuickJS-hosted
Sucrase compiler bundle from devices. During development, upstream-style
fixtures were checked against npm Sucrase through
`tools/tests/test_native_js_transpiler_parity.py`, while the native CLI in
`tools/native_js_transpile.nim` exposed `script`, `module`, `tokens`, and
`parse` modes for parity tests and diagnostics.

### QuickJS and Burrito

The JS engine and Nim binding are outside this directory but are part of this
runtime stack:

- `burrito.nim` is copied from
  https://github.com/tapsterbot/burrito/blob/main/src/burrito/qjs.nim and then
  adjusted for FrameOS build/runtime needs. Burrito is MIT licensed with
  copyright attribution to Tapster Robotics, Inc.
- QuickJS is downloaded/built by `frameos.nimble` as `quickjs-2026-06-04`.
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

- Builds a CommonJS-style module wrapper around app source.
- Runs the native module transform before loading the wrapper into QuickJS.
- Exposes a `frameos` API object to JS apps, including logging, state updates,
  image operations, sleep scheduling, HTTP helpers, and context access.
- Calls exported app lifecycle functions such as `init` and `get`.
- Tracks persistent and transient image references so overwritten dynamic image
  fields can be released.
- Maps app runtime errors through the same compact source-location mechanism.

## Native Transpiler Policy

The native transpiler is intentionally smaller than Sucrase. It should support
the TypeScript/JSX/module syntax that FrameOS users paste into single-file apps
or snippets, then preserve the rest for QuickJS.

The current transform set is:

- TypeScript erasure for common annotations, type-only declarations/imports,
  interfaces, type aliases, assertions, `satisfies`, non-null assertions,
  modifiers, overloads, `declare`, abstract members, generics, constructor
  parameter properties, and enums.
- JSX lowering to the FrameOS classic runtime:
  `__frameosJsx(type, props, ...children)` and `__frameosFragment`.
- Module rewriting for app modules into the CommonJS-style `exports` object
  expected by the app wrapper.
- Modern ES preservation for syntax accepted by bundled QuickJS, including
  optional chaining, nullish coalescing, numeric separators, optional catch
  binding, regex literals, class fields, private fields, BigInt, and logical
  assignment.

The current non-goals are:

- Full Babel/Sucrase parser parity.
- React automatic JSX runtime or development metadata.
- Babel/Sucrase interop helpers unless FrameOS runtime behavior needs them.
- Lowering JavaScript that QuickJS already runs natively.
- Standard `.map` source-map file generation. Runtime diagnostics only need the
  compact line/column table in `source_map.nim`.

Backend/editor validation still uses npm Sucrase from `frameos/frontend` for
user-facing diagnostics. The device runtime no longer needs a vendored Sucrase
compiler bundle.

## Source Locations

Transpiled code is passed directly to QuickJS, so there is no consumer for a
separate source-map file during normal execution. Instead, transform functions
return a `SourceLineMap` alongside generated code.

The map records:

- Generated filename and original source filename.
- Generated line to original source line.
- Sparse generated line/column segments to original source line/column.

Runtime wrappers compose their wrapper map with the transpiler map and register
the result per QuickJS context. When QuickJS returns an error stack containing
`filename:line:column`, `rewriteQuickJsLocations` rewrites it to the original
source location before it is logged.

This is deliberately compact: it gives better compile/runtime error positions
without carrying a full source-map artifact through the runtime.

## Test Coverage

Focused tests for this directory live in:

- `src/frameos/js_runtime/tests/test_js_tokens.nim`
- `src/frameos/js_runtime/tests/test_js_parser_processor.nim`
- `src/frameos/js_runtime/tests/test_js_transpiler.nim`
- `src/frameos/js_runtime/tests/test_js_runtime_helpers.nim`
- `src/frameos/js_runtime/tests/test_js_app_runtime.nim`
- `src/frameos/js_runtime/tests/test_scene_runtime_cleanup.nim`
- `tools/tests/test_native_js_transpiler_parity.py`

The parity harness compares selected native output or runtime behavior against
npm Sucrase. Prefer adding a focused fixture there when changing tokenizer,
parser, TypeScript, JSX, or module behavior.

## Maintenance Notes

- Add transforms only for syntax QuickJS cannot execute or for TypeScript/JSX
  syntax that must be erased before QuickJS sees it.
- Keep runtime errors mapped back to original app/snippet source. If a transform
  moves user code across lines or columns, update the compact source map.
- Keep source attribution in this README if code is copied or closely ported
  from an upstream project.
- Keep npm Sucrase available for backend/editor diagnostics unless native
  diagnostics become good enough for that user-facing path.
