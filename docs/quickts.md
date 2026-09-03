# quickts: TypeScript and JSX parsed natively by QuickJS

**Repository: <https://github.com/FrameOS/quickts>** — upstream QuickJS
(release 2026-06-04) plus one commit. The README there is the reference for
what is supported, what is not, how it is wired in and how to merge new
QuickJS releases. This page is the FrameOS side: why it exists, what it
measured, and how FrameOS is wired to it.

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

## How FrameOS uses it

Done 2026-09-02. The moving parts, for the next time the version changes:

- **One source tarball, one version string.** Release `2026-06-04-quickts.1`
  is the git tag `v2026-06-04-quickts.1` in the quickts repo, published as
  `quickjs-2026-06-04-quickts.1.tar.xz` (unpacks to `quickjs-<version>/`,
  Bellard's layout) both as a GitHub release asset and mirrored at
  `https://archive.frameos.net/source/vendor/` with
  `tools/prebuilt-deps/r2_put_source.py`. Every fetcher reads the mirror:
  `frameos.nimble` (`build_quickjs`), `frameos/tools/install_prebuilt_quickjs.py`
  (default version), `frameos/tools/build_wasm.sh`, the root `Dockerfile`,
  `tools/prebuilt-deps/build.sh` + `Dockerfile.quickjs`, and
  `backend/app/tasks/frame_deploy_helpers.py` (`DEFAULT_QUICKJS_VERSION`, the
  on-device source-build fallback). The component is still called `quickjs`
  everywhere -- it *is* QuickJS -- so nothing keyed on that name moved.
- **Prebuilt libraries for all 15 targets** (`tools/prebuilt-deps/manifest.json`,
  `archive.frameos.net/prebuilt-deps/<target>/quickjs-2026-06-04-quickts.1.tar.gz`)
  were rebuilt from the tarball and uploaded; the archives now ship
  `quickts*.h` next to `quickjs.h`. The older `quickjs-2026-06-04` archives
  stay under their versioned keys, so checkouts with the old manifest keep
  working. `ubuntu-26.04-amd64` cannot be built under QEMU on an arm64 Mac
  (`tar: Cannot mkdir: Function not implemented`); build that one natively on
  monster and rsync the component directory back before `r2_sync.py upload`.
- **ESP32 and WASM** compile `frameos/quickjs/quickjs.c` from source, so they
  picked quickts up with the tarball; the root `Dockerfile` now copies the
  three `quickts*.h` headers into `/app/frameos/quickjs` alongside it. On
  xtensa (`-Os`) `quickjs.o` grows by 13.2 KB against the ~80-90 KB the Nim
  transpiler took.
- **The runtime asks for the passes per eval.** `burrito.nim` has
  `JS_EVAL_FLAG_TYPESCRIPT` / `JS_EVAL_FLAG_JSX` and `quicktsFlagsFor(name)`:
  `.js`/`.mjs`/`.cjs` get nothing, `.jsx` gets JSX, everything else gets both
  (a scene app's main file always had both passes run over it whatever it was
  called, and JSX can only claim a `<` that would otherwise be a syntax
  error). `eval`, `compileModule` and `evalModuleNamespace` take the flags;
  `app_runtime.nim` evaluates `runtime.source` straight from the scene JSON
  and the module loader compiles imported files the same way; code nodes and
  inline expressions use `runtime.snippetEvalFlags`.
- **Deleted:** `transpiler.nim`, `tokens.nim`, `parser.nim`,
  `token_processor.nim`, their tests, `tools/native_js_transpile.nim` and
  the Sucrase parity harness -- ~4,900 lines. `source_map.nim` keeps only
  what the snippet envelope needs. No line maps exist for apps any more;
  QuickJS reports the app's own file and line.
- **Editor validation** (`backend/app/utils/js_apps.py`) runs
  `frameos/tools/js_check.nim`, which links the same QuickJS and compiles the
  file with the same flags, instead of transpile + `node --check`. Built on
  first use, or `FRAMEOS_JS_CHECK` points at one; the Docker image builds it.

## Merging upstream QuickJS later

`git fetch upstream && git merge upstream/master`, then `make test` and
`make test-quickts`. The change is insertions into a handful of parser
functions, so upstream edits elsewhere merge cleanly and an edit inside a
hooked function shows up as an ordinary conflict beside a marked block. As a
check, the six upstream commits that landed after the 2026-06-04 release
merged without conflict and pass every test. The repo carries an
`upstream-master` branch tracking Bellard's master for reference.
