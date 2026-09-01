# quickts: TypeScript and JSX parsed natively by QuickJS

**Repository: <https://github.com/FrameOS/quickts>** — upstream QuickJS
(release 2026-06-04) plus one commit. The README there is the reference for
what is supported, what is not, how it is wired in and how to merge new
QuickJS releases. This page is the FrameOS side: why it exists, what it
measured, and what switching to it involves.

## Why

Scene apps ship TypeScript, and every frame transpiles it itself:
~4,300 lines of Nim (`transpiler.nim`, `tokens.nim`, `parser.nim`,
`token_processor.nim`, most of `source_map.nim`), 80–90 KB of flash, and a
token array that reached **1.4 MB for the 36 KB Weather app** — which is what
stopped the E1004 rendering that scene (`docs/todo.md`, "Get the TypeScript
transpiler off the device").

quickts removes the transpiler instead of moving it. The QuickJS parser
erases type syntax as it consumes tokens and lowers the three constructs
that need code (enums, constructor parameter properties, JSX) straight into
bytecode. There is no generated source, so there is no source map either:
errors point at the original `.ts` line.

## What it costs, measured

Pristine QuickJS 2026-06-04 versus quickts, arm64 clang, the 36 KB Weather
app (`tests/quickts/samples/weather_panel.ts` in the repo):

| | pristine | quickts |
|---|---|---|
| `quickjs.o` `__text`, `-Os` | 482,460 B | 498,220 B (**+15.8 KB**, +3.3%) |
| parse, flags off | 0.649 ms | 0.650 ms |
| parse, flags on | — | 0.685 ms (**+4%**) |
| peak parser heap | 159,452 B | 159,764 B (**+312 B**) |

Against the transpiler's 80–90 KB of flash and up to 1.4 MB of RAM. The
+312 bytes is a pointer and a count on each `JSFunctionDef`; the parser
otherwise allocates nothing extra, because types go through its own
one-token window.

## What it covers

Everything the Nim transpiler does, plus the things it did not: overload
signatures, abstract members, `declare` fields, `new X<T>` without
parentheses, instantiation expressions, `export type *`, typed `catch` and
`for` bindings, generic object-literal methods, `export default abstract
class`. The repo's `tests/quickts/cases/` has 14 self-checking files, each
also verified to be valid TypeScript with `tsc`.

Parses **1,026 of the 1,027** `.ts`/`.tsx` files in this repository (671
TypeScript + 356 React TSX); the holdout is `import './index.css'`, which is
qjsc following an import into a stylesheet. Runs all three Weather scene
apps straight from `.ts`. QuickJS's own test suite passes unchanged with
both passes on, and a bytecode diff over plain JavaScript compiled with the
passes off and on is byte-identical.

Not supported, each with an `xfail/` file that must keep failing:
decorators (QuickJS has none), value-carrying `namespace`s (rejected with a
clear error, never silently erased), the `accessor` keyword, `import x =
require()` / `export =`, the legacy `<T>value` assertion. And one
divergence shared with `tsc`: with the pass on, `f < a > (b)` is the generic
call `f<a>(b)`. It cannot affect `.js` sources, where the pass is off.

## Switching FrameOS to it

Not done yet; this is the list.

1. **Fetch quickts instead of the Bellard tarball.** `frameos.nimble`'s
   `build_quickjs` task and `tools/prebuilt-deps/Dockerfile.quickjs` both
   `curl` `quickjs-2026-06-04.tar.xz` and run `make`; point them at a
   FrameOS/quickts release tarball (tag one first) and re-run the
   prebuilt-deps pipeline for every target in `manifest.json`. The ESP32 and
   WASM builds compile `frameos/quickjs/quickjs.c` from source and need
   nothing but the new tree. The `res = -tm.tm_gmtoff / 60;` guard in
   `embedded/esp32/components/frameos_quickjs/CMakeLists.txt` is untouched.
2. **Set the flags.** `burrito.nim`: add `JS_EVAL_FLAG_TYPESCRIPT = 1 shl 8`
   and `JS_EVAL_FLAG_JSX = 1 shl 9`, and a flags parameter on `eval` /
   `evalModuleNamespace` / the multi-file module loader from PR #410, mapped
   from the source name the way `quickts_eval_flags()` does it. `.ts` and
   `.tsx` app files and code nodes get the flags; `.js` files must not.
3. **Stop transpiling.** `transpileAppSource` becomes a no-op; code nodes
   (`compileCodeFn`, `compileInlineFn`, the eval helper in `runtime.nim`)
   pass the envelope straight to `eval` with the flags. The line-map
   composition in those paths reduces to the envelope's constant offset.
4. **Delete** `transpiler.nim`, `tokens.nim`, `parser.nim`,
   `token_processor.nim` and the transform-related parts of
   `source_map.nim`, with their tests. The `imports` transform is already
   dead code — `evalModuleNamespace` lets QuickJS parse the module form.
5. **Keep one release of overlap** for scenes already on frames, per
   `docs/convergence-todo.md`: shipped `.ts` keeps working because the new
   runtime parses it directly, so the overlap is about the *runtime* being
   new, not the payload.

The JSX factory names default to `__frameosJsx` / `__frameosFragment`, the
ones `js_runtime/runtime.nim` already defines, so the scene runtime is
unchanged.

## Merging upstream QuickJS later

`git fetch upstream && git merge upstream/master`, then `make test` and
`make test-quickts`. The change is insertions into a handful of parser
functions, so upstream edits elsewhere merge cleanly and an edit inside a
hooked function shows up as an ordinary conflict beside a marked block. As a
check, the six upstream commits that landed after the 2026-06-04 release
merged without conflict and pass every test. The repo carries an
`upstream-master` branch tracking Bellard's master for reference.
