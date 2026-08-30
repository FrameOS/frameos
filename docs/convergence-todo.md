# FrameOS convergence — stop compiling, ship binaries

*Written 2026-08-30 against `main` at `9ae6cabd`. Replaces the 2026-08-29
draft of this file, which planned the full merge (cloud becomes the backend,
backend/SSH/Remote retired). That is not what we are doing now. Companion to
`docs/convergence-brutal-analysis.md` (the diagnosis; its postscript records what was
kept from it). Read cold: each stage says what exists before it says what to
do. When an item ships, delete it.*

## The decision, in one paragraph

The **backend (Python, self-hosted) and the cloud (TypeScript, hosted) stay
two separate products.** Self-hosters keep SSH, the terminal, deploys over
SSH and FrameOS Remote. What goes is **per-frame compilation**: FrameOS is
distributed only as released binaries — the eleven Linux tarballs and the
ESP32 firmware — and the backend *installs and updates* them, it does not
build them. The thing that forces a build today is a **compiled scene**
(`settings.execution = "compiled"`: a scene-local Nim app, a Nim code node,
or a `source` node). Compiled scenes become a legacy, advanced-only path:
no new operation produces one, every surface that shows one warns, and an
**AI converter** turns them into interpreted scenes — the inline Nim code
nodes and the modified Nim apps included, or with a substitute when a Nim
idiom has no JavaScript equivalent. Converging the two implementations,
moving SSH into the cloud, retiring the backend, thin clients, Home
Assistant, the self-hosted cloud stack: all **parked**, listed at the end,
decided later. No rewrite, no refactor: every step below is a small change
to a file that exists.

## Where we are (measured, 2026-08-30)

**Compilation is already the exception, not the rule.** The backend's
compilation mode defaults to `precompiled` (`backend/app/codegen/
drivers_nim.py:8-13`; the only other value is `static`). A full deploy of an
interpreted-only frame downloads the release tarball and never runs the Nim
compiler — not for the binary, not for drivers, not even a source copy
(`backend/app/tasks/binary_builder.py:278-309`,
`precompiled_frameos.py:73-134`). Fast deploy never builds anything
(`frame_deploy_workflow.py:1254-1298`). Cloud pushes are interpreted-only by
construction (`frameLogic.ts:2779`); the ESP32 is interpreted-only by
construction. **The one branch that forces a build** is
`binary_builder.py:212-246`:

```python
compiled_scene_count = frame_compiled_scene_count(self.frame)
if compiled_scene_count > 0:
    skip_reason = f"{n} compiled scene(s) ... configured"   # → STATIC build
```

plus Buildroot's twin at `frame_deploy_workflow.py:727-756` (precompiled
skipped → `force_cross_compile`; provider `none` → hard error). Everything
else — build host, Modal, docker cross-compile, on-device fallback — exists
to serve that branch. Remove the reason and the machinery is dead weight.

**What "compiled" means, precisely.** `scene_requires_compilation()`
(`backend/app/utils/scene_execution.py:42-73`), twin
`sceneRequiresCompilation` (`frontend/src/utils/sceneApps.ts:39-58`): any
`scene.apps[*]` or app-node `data.sources` with `app.nim`/`config.nim` **and
no** `app.ts|js|tsx|jsx` sibling; any `code` node with `data.code` and no
`data.codeJS`; any `source` node. A JS sibling wins on all three planes —
the device's hub client applies the same rule when it answers
`not_interpreted` (`frameos/src/frameos/cloud/hub_client.nim:650-686`).
Explicit `settings.execution` always wins; absent means interpreted
(`scene_execution.py:1-17`, migration `c3d5e7f9a1b2`). The frontend's old
`?? 'compiled'` fallback is gone (`sceneExecution.ts:20` reads
`?? 'interpreted'`); the last inference that can still *yield* `compiled` is
`normalizeSceneExecution` (`sceneExecution.ts:44`).

**Where new Nim still comes from today** (the leaks — frontend survey):

| Leak | Where |
|---|---|
| A new code node is seeded with a Nim `code` field, never `codeJS` | `newNodePickerLogic.tsx:822`, `diagramLogic.tsx:1545-1552` |
| The code editor's language is chosen **per scene**, not per node: compiled scene ⇒ every code node is a single-line Nim textarea whose placeholder says `Rewrite to Nim: <codeJS>` | `diagramLogic.tsx:1119-1122`, `CodeNode.tsx:255-295` |
| Saving a Nim app from EditApp flips the scene to `compiled` | `editAppLogic.tsx:355-358, 434-437` |
| Installing a scene app with Nim sources (paste / node picker) flips the scene via `forceCompiled` | `sceneApps.ts:274-296`, `diagramLogic.tsx:1511, 1645`, `newNodePickerLogic.tsx:807` |
| "Fork App" copies Nim-only scene apps as Nim | `AppNode.tsx:165-173`, `diagramLogic.tsx:1380-1421` |
| `legacy/resize` and `legacy/rotate` migrations inline Nim into `data.sources` | `backend/app/utils/legacy_app_migration.py` (called from templates, frame_sync, cloud_backups) |
| Scene Settings offers `compiled` and `interpreted` as peers ("Choose between…") | `SceneSettings.tsx:79-145` |
| The SceneSource panel generates Nim for *any* scene and `nim check`s edits | `frames.py:2374-2385`, `sceneSourceLogic.tsx:133-142`, `apps.py:112-158` |

**What silently breaks today.** A Nim `data.code` without `codeJS` is fed
verbatim to QuickJS (`js_runtime/runtime.nim:143` "prefer codeJS, fall
back to code"): it either happens to parse as JS or logs
`interpreter:code:compile` and raises — and `not_interpreted` does **not**
catch it, only lint or a render does. The wasm preview runs a compiled scene
as if it were interpreted with no notice (`livePreviewLogic.tsx:655`,
`FrameImage.tsx:228-229`). A code-node argument named `state`, `args`,
`context`, `console`, `format`, `now`, `parseTs` or `getargor` is **not
declared** by the envelope (`runtime.nim:288-294`), so `state == "heat"`
compares the scene-state proxy, not the input.

**What the converter can stand on** (cloud AI survey):

- `runAppChat()` (`cloud/apps/auth-web/src/lib/ai/app-chat.ts:143`) — one
  Responses call, one tool `write_app_files` (`{files: {name: contents}}`),
  sources map in, sources map out, no DB. The shape of a per-app port.
- `patch_scene` (`ai/tools.ts:542`) rewrites `apps[k].sources` with
  `null` deleting a file; `edit_app_source` (`:599`) targets `codeJS` only.
- `lintScenes` / `lintJsAppSource` / `lintCodeNodeJs` / `lintAppImports`
  (`ai/scene-lint.ts:1076, 367, 273, 350`); `lintJsAppSource` rejects
  `category: "render"` for scene-local apps (they draw nothing — the
  working pattern is a data app returning `frameos.svg()` into
  `render/image`).
- `HeadlessRenderer` (`ai/eval/render-check.ts:291`) + `judgeRender`
  (`evals/lib/judge.ts:45`); `evals/build-todo-scenes.ts` is the loop
  (agent → lint → render → judge → retry ≤ N → publish) to copy.
- Credentials: `resolveAiCredentials` (`ai/api-key.ts:44`) — account key
  first (`accountSettings openAI.backendApiKey`), else the platform
  `OPENAI_API_KEY` gated by `FRAMEOS_AI_SHARED_KEY_ACCESS`. Model
  `gpt-5.5`. Detached turns: `ai/turn-runner.ts` (15-min ceiling, in-memory).
- Import: `POST /api/account/scenes` takes raw `{name, scenes:[…]}`
  (`app/api/account/scenes/route.ts:110`); `PUT …/[sceneId]/content` saves
  a version; `rebuildZipWithScenes` (`lib/store.ts:485`) swaps `scenes.json`
  inside a zip keeping the cover.
- Backend → cloud: `cloud_request()` (`backend/app/utils/cloud_link.py:
  159-183`), bearer link token, scopes at `:28-35` with an
  `approval_required` dance for new ones (`:225-232`). The backend already
  has an OpenAI key (`settings.openAI.backendApiKey`, used by
  `apps.py:63-105`, `utils/ai_scene.py`, `utils/ai_app.py`).

**The JS target, corrected.** `app.state` *is* the scene state and
`frameos.setState()` writes it (`app_runtime.nim:199-201, 661`) — the
"apps do not see scene state" line in `docs/js-apps-and-code-nodes.md` is
wrong and gets fixed in Stage 3. A code node's `state` global is a proxy
over `getState(k)` for **any** key (`runtime.nim:787`), declared or not.
The bridge has `httpRequest`, the asset/stream calls and `getSetting`
(`app_runtime.nim:1208-1290`) but `src/generated/ai-context.json`
`jsTypeDeclarations` (and `frontend/src/utils/appTypeDeclarations.ts`)
omit them — a port that uses them fails the type check while the runtime is
fine. The transpiler erases TS and lowers JSX, everything else is QuickJS:
template literals, `?.`, `??`, classes and regex all work; `async`/Promises
parse but never resolve (nothing pumps the job queue); no `import *`, no
`export *`, no `import()`; `Date` has no time-zone data anywhere.

**Corpus.** `repo/` contains zero `.nim` sources; `e2e/scenes/` has one
Nim-only code node (`dataCodeFloat.json`). Real compiled scenes live on
users' backends — `~/Downloads/vannituba-scene.json` (worked through
below) is the reference, and the converter's fixture set has to be built
from scenes like it, not from the repo.

## "Compile the scenes separately and link them after?" — no

It was built and deleted. `drivers_nim.py:16-32`: until 2026-08-16 there
were `shared` (every driver **and every compiled scene** as its own `.so`)
and `shared-scenes` (scenes as one `scenes.so`) modes. Both handed Nim refs
(`FrameScene`, `JsonNode`, render contexts) across the `.so` boundary in
both directions, every library carried its own ORC runtime, and a ref
allocated by one and decref'd by the other crashed the host once ORC
considered its type cyclic — the same hazard that turned v2026.8.17–.23
into a crash loop on every HDMI frame when the pixie fork's `Image` grew a
`root` field (`frameos/src/frameos/driver_abi.nim`). Drivers survive as
`.so`s only because their ABI is five C-typed calls and JSON-over-`cstring`
(`drivers.nim:129-235`), with no version symbol at all. A scene ABI would be
the whole app surface. Doing it properly means a C ABI for scenes — which
is what the interpreter + QuickJS already is. So: no scene `.so`. Compiled
scenes keep the `static` build as their only runtime, marked legacy, until
Stage 5 removes it.

## Worked example: `vannituba-scene.json`

One scene, `execution: "compiled"`, 19 nodes: built-ins (`data/haSensor`,
`logic/setAsState`, `logic/ifElse` ×2, `render/text` ×2, `render/image`
×2, `data/unsplash` ×2, `data/clock`), two `state` nodes on a `font` field,
**five Nim code nodes** and **one scene-local Nim app** ("Heat timer",
`app.nim` 1,350 chars + `config.json`, category `boilerplate`, in the
prev/next chain between `setAsState` and `ifElse`). What each becomes:

| Node | Nim | JS | Rule |
|---|---|---|---|
| code `37255a86` | `$scene.state{"water_heater"}{"state"}.getStr` | `String(state.water_heater?.state ?? "")` | state chain → optional chain; `.getStr` → `?? ""`; `$` → `String()` |
| code `5bf6d3cd` | `scene.state{"heatTimer"}.getStr` | `String(state.heatTimer ?? "")` | same |
| code `2d164791`, `91949e79` | `state == "heat"` with arg `state` | `heaterState === "heat"` with arg `heaterState` | **arg renamed**: `state` is reserved (`runtime.nim:290`); edges `codeField/state` → `codeField/heaterState` rewritten |
| code `964cf503` | `if state == "heat": -40 else: 0` | `heaterState === "heat" ? -40 : 0` | `if/else` expression → ternary; same rename |
| app `dfacd0d4` Heat timer | `proc run(self, context)` reading `self.scene.state{…}`, writing `self.scene.state["k"] = %*v`, `epochTime()`, `strformat`-free string building | `export function run(app, context)` reading `app.state.…`, writing `frameos.setState("k", v)`, `Date.now()/1000`, template literal; `config.json` category → `logic` | logic app in the chain keeps its place; `run` is the export the runtime calls (`repo/apps/code/jsLogic/app.ts`) |

Also present: two edges into `codeField/arg` / `codeArg/arg` that name no
declared argument — stale, tolerated by `compileCodeFn` (it adds every
inbound key as an arg), dropped by the converter. Nothing here needs the AI
except the app, and the deterministic pass would get every code node. The
result is fully interpreted, previews in wasm, deploys precompiled. This
scene is fixture #1.

The converted app, for the record (what the AI must produce):

```ts
export function run(app: FrameOSApp, context: FrameOSContext): void {
  const heating = app.state.water_heater?.state === 'heat'
  let heatStart = Number(app.state.heatStart ?? 0)
  if (heating && heatStart === 0) { heatStart = Date.now() / 1000; frameos.setState('heatStart', heatStart) }
  if (!heating && heatStart !== 0) { heatStart = 0; frameos.setState('heatStart', 0) }
  if (heatStart === 0) { frameos.setState('heatTimer', ''); return }
  const left = 30 * 60 - (Date.now() / 1000 - heatStart)
  if (left < 0) { frameos.setState('heatTimer', 'Still HOT'); return }
  const m = Math.trunc(left / 60), s = Math.trunc(left) % 60
  frameos.setState('heatTimer', `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`)
}
```

## Stage 1 — Stop producing new Nim (frontend, small, first)

Goal: after this stage no click in the editor creates a compiled scene; a
compiled scene can still be edited, but new nodes in it are JavaScript.

**Shipped 2026-08-30 (branch `convergence-stage-1`, stacked on
`nim-converter`).** Every box below is ticked; the per-app converter
button and "Fork App through the converter" wait for the editor hook-up.

- [x] New code nodes seed `codeJS: ''`, not `code` — `newNodePickerLogic.tsx:
  822`, `diagramLogic.tsx:1551`. In a compiled scene that is still correct:
  `code` with a `codeJS` sibling is interpretable, and the compiled codegen
  ignores `codeJS`, so the node simply does nothing until converted — say so
  in the node ("JavaScript code node in a compiled scene: runs after
  conversion").
- [x] Code editor language **per node**: `codeNodeLanguage` moved from
  `diagramLogic` to `appNodeLogic` and is a function of the node — `nim` only when
  `data.code` is set and `data.codeJS` is not. `CodeNode.tsx:255-295`: the
  Nim textarea gets a "legacy Nim — convert" chip and loses the
  `Rewrite to Nim:` placeholder (`:291`); the Monaco editor is the default.
- [x] `normalizeSceneExecution` (`sceneExecution.ts`) stops inferring
  `compiled`: an explicit value wins, otherwise `interpreted`. Scenes that
  *require* compilation and have no explicit value keep working because the
  backend twin `infer_scene_execution` (`scene_execution.py:96-98`) still
  stamps them at save — change it in the same PR to stamp `interpreted` and
  rely on the Stage 2 banner instead. (The migration already stamped every
  existing row explicitly, so this only affects pasted/imported JSON.)
- [x] The two silent flips to `compiled` become explicit
  (`confirmSceneBecomesCompiled` in `sceneExecution.ts`, called from
  `editAppLogic` and the three `forceCompiled` call sites; the message names
  the converter page): `editAppLogic.tsx` (`requiresCompiledOnSave`) and
  `sceneApps.ts` (`forceCompiled`). Keep the behaviour, add a confirm ("This makes the scene
  compiled — it will need a source build on every deploy. Convert it to
  JavaScript instead?") with the converter as the primary button once
  Stage 3 exists; until then the confirm alone.
- [x] "Fork App" on a Nim-only scene app (`AppNode.tsx`) stays; the
  "Legacy Nim" chip (`isLegacyNimApp`) is on the original and the fork alike.
  Forking *through* the converter waits for the editor hook-up (Stage 3c).
- [x] `legacy_app_migration.py`: `legacy/resize` and `legacy/rotate` stop
  inlining Nim — the node keeps keyword and config and gets
  `data.needsConversion` (neither maps onto `render/image`: both replace the
  canvas mid-chain). Map them onto `render/image` scaling modes where the built-in
  covers it; where it does not, emit a `code`-less node with a
  `data.needsConversion` note that the converter (Stage 3) picks up. No new
  compiled scene may be *manufactured* by a migration.
- [x] Scene Settings (`SceneSettings.tsx`): one Select, inside
  `AdvancedSection` always; the `compiled` option reads "Compiled (legacy —
  needs a source build on every deploy)". The inline copy at `:79-111` and
  the tooltip "Choose between compiled and interpreted execution modes" go.
- [x] `frameos/src/apps/README.md` (created) and `docs/js-apps-and-code-nodes.md`:
  one paragraph each — Nim apps are the built-in catalog, not a thing users
  write; JavaScript is the loadable format. Fix the "apps do not see scene
  state" sentence (they do: `app.state`, `frameos.setState`).

Exit: a fresh scene cannot be made compiled without an explicit confirm;
`grep -n "Rewrite to Nim" frontend/src` returns nothing.

## Stage 2 — Warn everywhere a compiled scene shows up

Goal: a user with compiled scenes sees, on every surface that touches them,
that they are on a legacy path and where the exit is. The exit button is
Stage 3's; this stage wires the places, with a "coming soon" until then.

**Shipped 2026-08-30 (branch `convergence-stage-2`, stacked on stage 1).**
The exit everywhere is `openNimConverterWithScene` (copy the scene JSON,
open scenes.frameos.net/nim-converter) until the converter is called from
the editor itself. Every box below is ticked; what each left open is noted.

- [x] **Frame list and dashboard.** `GET /api/frames` gains
  `compiled_scene_count` (from `frame_compiled_scene_count`,
  `precompiled_frameos.py:46-51` — already computed for the deploy plan,
  never persisted, no schema change). `FramesHome.tsx:1120`,
  `FrameDashboardSurface.tsx:519-525` show it as an amber chip; the
  existing `CompiledSceneTag.tsx` copy changes from "All changes require a
  full FrameOS recompilation" to "Legacy compiled scene — needs a source
  build on every deploy. Convert to JavaScript."
- [x] **Deploy drawer** (`frameDeployUtils.ts`;
  640-647`): "precompiled release skipped (N compiled scenes configured)"
  becomes the headline of the plan, amber, with the count and the names, and
  "Convert" as the recommended action ahead of "Full deploy". The
  recommendation copy "changes that require rebuilding FrameOS" gains
  "(legacy path)".
- [x] **Scene surfaces.** `SceneWorkspace.tsx` sidebar tag,
  `Diagram.tsx:574` header chip, `WorkspaceSceneDropDown.tsx` (no compiled
  awareness today) gets a "Convert to JavaScript…" item shown only for
  compiled scenes; `SceneSettings.tsx:146-159`'s warning box ("This compiled
  scene will not work in interpreted mode") becomes the converter's home:
  same box, primary button.
- [x] **EditApp** `ReadOnlyNimAppNotice` (`EditApp.tsx`): keep for
  catalog apps ("built-in, edit on GitHub"); for a *scene-local* Nim app the
  notice says "Legacy Nim app — convert to JavaScript" with the per-app
  button. `AppsWorkspace.tsx:430-440, 706-713` same wording.
- [x] **Preview honesty.** `LivePreviewModal.tsx`, `FrameImage.tsx`
  (`wasmSceneRenderCheck.ts` untouched — it only runs for interpreted
  scenes' render checks): when `sceneRequiresCompilation(scene)`
  the preview shows a banner "Preview runs the interpreter; this scene's Nim
  code nodes / Nim apps are not executed here" instead of a silently wrong
  image. Templates already do this (`Template.tsx:138, 238-246`).
- [x] **Cloud.** (`compiledSceneNames` in `store.ts`; refused with
  `scene_requires_compilation` at publish — every create path funnels
  through `validateSceneZip` — and in `buildScenesPayloadForFrame` at
  assign; both `logWarn` a counter.) `publishStoreScene` / `assignScenesToFrame` never checked
  interpretability, and `not_interpreted` appears in no web app — port
  `sceneRequiresCompilation` to `cloud/apps/auth-web/src/lib/` and refuse at
  publish/assign with a message that names the converter (the cloud side of
  Stage 3b). Count refusals.
- [x] **Settings.** (`NewFrame` has no compilation select; the deploy
  drawer's is already under an advanced toggle, and the buildroot
  "installation mode" select labels `static` as legacy.) `Settings.tsx` build-environment section (build host,
  Modal, docker cross-compile, toolchain digests) moves under "Advanced:
  legacy source builds" with the same amber note. `NewFrame.tsx` hides
  `compilationMode` unless the advanced toggle is on; the default stays
  `precompiled`.
- [x] **Announce.** (README + `docs/todo.md`; there is no release-notes
  file — the next release's notes carry the same paragraph.) README, release notes, `docs/todo.md`: compiled scenes
  are deprecated; the converter ships before the date; date = one release
  after Stage 3 lands. The "Both control planes" rule in `docs/todo.md`
  **stands** (the earlier draft repealed it; this plan does not).

Exit: every surface in the table above renders the chip for
`vannituba-scene.json` loaded on a dev backend, and the cloud refuses to
assign it with a message that says why.

## Stage 3 — The converter

Goal: one click turns a compiled scene into an interpreted one. Nim code
nodes and scene-local Nim apps are ported; what cannot be ported gets a
substitute built from catalog nodes, or a clear per-node "needs a manual
port" with the reason. We pay when it runs on the cloud; a self-hoster can
bring their own OpenAI key or run it offline.

**Shipped 2026-08-30, the no-frills cut (branch `nim-converter`,
`docs/nim-to-js-conversion.md` is the reference):**
`cloud/packages/scene-convert` (pass 1 grammar + structural fixes, pass 2
via one forced tool, the small lint loop, render-app → data-app +
`render/image` substitution, `settings.convertedFrom`, fixtures #0 and #1);
`POST /api/scenes/convert` — public, no login, per-address limits, the
platform key behind an hourly/daily budget, `openaiApiKey` to pay yourself,
full `lintScenes` + one server-side wasm render in the reply;
`scenes.frameos.net/nim-converter` (drop/paste → download, "Save to my
scenes" when signed in) linked from "My scenes"; the CLI
(`pnpm --filter @frameos-cloud/scene-convert convert`). `vannituba`
converts with zero model calls for its code nodes and one for the app, and
renders headless. Still open below: the MCP tool, the backend route, the
judge-against-baseline loop, detached jobs, the frontend hooks (3c's
per-app buttons, "Fork App" through the converter), 3d's declaration
fixes.

### 3a. Conversion drops the Nim

Decided 2026-08-30 while testing the converter (it replaces the earlier
"additive and reversible" design): the converted scene carries **no Nim**.
`data.code` goes when `data.codeJS` is written, `app.nim`/`config.nim` go
when `app.ts` is, and a scene that already had both loses its leftover Nim
too. Two reasons: the editor cannot tell "Nim with a JS sibling" from "Nim
app" (`hasCompiledAppSource` vs `hasCompiledNimAppSource` — fixed in Stage 1
as well), and nothing downstream needs the old code — the original file is
the backup. Only Nim that nothing replaced (`needsManualPort`) stays, so the
scene still says what is missing. `settings.convertedFrom = { execution:
"compiled", at, tool, model }` is still stamped so Stage 5 can find every
converted scene.

### 3b. Two passes, one package

A new package `cloud/packages/scene-convert` (TypeScript, so the cloud, the
CLI and later the SPA share it; depends on `scene-lint.ts` and the
`generated/ai-context.json` declarations, no Next.js):

**Pass 1 — deterministic, no model.** A small Nim-expression grammar for
code nodes, covering what code nodes actually contain (state reads,
comparisons, arithmetic, ternaries, string building, time):

| Nim | JS |
|---|---|
| `scene.state{"a"}{"b"}.getStr` / `$scene.state{…}` | `String(state.a?.b ?? "")` |
| `.getInt` / `.getFloat` / `.getBool` / `.getStr` on any chain | `Number(… ?? 0)` / `Boolean(…)` / `String(… ?? "")` |
| `if c: a else: b` (expression) | `c ? a : b` |
| `==` `!=` `and` `or` `not` `&` `$x` `.len` `.int` `.float` `mod` `div` | `===` `!==` `&&` `\|\|` `!` `+` `String(x)` `.length` `Math.trunc()` `Number()` `%` `Math.trunc(a/b)` |
| `epochTime()` / `now()` | `now()` (code node) / `Date.now()/1000` (app) |
| `%*x`, `newJString(x)`, `parseJson(x)` | `x`, `x`, `JSON.parse(x)` |
| `x.split(",")`, `x.strip`, `x.toLowerAscii`, `x.contains(y)`, `x.startsWith(y)`, `x.replace(a, b)` | the `String` methods |
| `parseInt(x)`, `parseFloat(x)`, `$x.formatFloat(ffDecimal, n)` | `parseInt(x, 10)`, `parseFloat(x)`, `Number(x).toFixed(n)` |
| `times.now().format("HH:mm")` and `chrono` patterns | `format(now(), "{hour/2}:{minute/2}")` — strftime letters mapped to curly tokens; unknown letters → AI |

Plus the structural fixes that need no model: rename code-node args that
collide with the reserved envelope names (`runtime.nim:290`) and rewrite
their edge handles; drop edges whose handle names no declared arg; refuse
`source` nodes outright ("nothing can run them — rebuild this part with
nodes"); strip `codeArgs` types the JS side does not use. Anything the
grammar does not accept falls through to pass 2 with the parse position.

**Pass 2 — the model, per app and per leftover code node.** One
`runAppChat`-style call with `write_app_files`, given: the app's
`config.json` + `app.nim`; the node's config and its in/out edges (what
feeds it, what consumes its output, whether it sits in the prev/next chain
or feeds a field); the scene's `fields` and state keys other nodes read;
the **mapping table** below as the system prompt's core; the JS type
declarations (fixed first — see 3d); the SVG subset rules; the
constraints: synchronous only, no npm, `category: "render"` scene-local apps
draw nothing so a Nim render app becomes a **data app returning
`frameos.svg()`** and the converter inserts a `render/image` node after it
and rewires the edges; a chain app exports `run`, a field app exports `get`.

The mapping table the prompt carries (from the 40 built-ins, by frequency):

| Nim | JS |
|---|---|
| `self.appConfig.x`, `self.log/logError/error` | `app.config.x`, `app.log/app.logError/frameos.error` |
| `self.scene.state{"k"}` / `self.scene.state["k"] = %*v` | `app.state.k` / `frameos.setState("k", v)` |
| `self.frameConfig.renderWidth/renderHeight/assetsPath/timeZone` | `app.frame.width/height/assetsPath/timeZone` |
| `context.hasImage`, `context.image.width/height`, `context.nextSleep = s` | `context.hasImage`, `context.imageWidth/imageHeight`, `frameos.setNextSleep(s)` |
| `boundedRequestWithHeaders`, `utils/http_client` | `frameos.httpRequest(url, {method, headers, body, timeoutMs, base64})`, `frameos.fetchJson/fetchText` |
| `self.saveAsset`, `readFile`/`writeFile` under assets | `frameos.writeAsset`, `frameos.readAsset` |
| `downloadImage` (remote) / (local) | a `data/downloadImage` node wired in / `frameos.loadAssetImage` |
| `rand()` / `Option[T]` / `raise newException` / `strformat` | `Math.random()` / `undefined` + `?.` / `throw new Error` / template literal |
| pixie `newImage`, `fill`, `draw`, `fillPath`, `strokePath`, `drawText`, `typeset`, `newFont`, `rgb()` | an SVG string via `frameos.svg()`: `<rect>`, `<path>`, `<text>` with `font-family`/`font-size`, `#rrggbb` |
| `renderError(...)` | return an SVG with the message, or `frameos.error()` |
| `scaleAndDrawImage`, `decodeImageWithDisplayBounds` | `frameos.image({dataUrl\|base64, width, height})` and let the runtime scale |
| `times.now().format`, `chrono` | **no equivalent in an app** — feed a `data/clock` or a `format()` code node into a field |
| `runShellWithParentStreams`, EXIF, dither, blake2b, files outside assets, `frameConfig.debug`, decode-target hints | **no equivalent** — the model must not fake it |

For every "no equivalent" the model has two outs and must pick one and say
which: (a) **substitute** — replace the app with catalog nodes that do the
job (`data/clock` + `render/text` for a custom clock; `data/downloadImage`
+ `render/image` for a fetch-and-draw; `logic/setAsState` for a state
writer), which is a `patch_scene`-shaped graph edit the converter applies;
(b) **leave it** — the node gets `data.needsConversion = {reason, nimLines}`
and the scene stays `compiled`, with the report listing exactly which node
and why. Never a silent stub.

**Verify, then loop.** `lintScenes` + `lintJsAppSource` + `lintCodeNodeJs`
+ `lintAppImports` on the rewritten scene; then `HeadlessRenderer.render()`
with the scene's state seeded from the frame's last known state when the
job has one; logs and errors go back into the next attempt like
`build-todo-scenes.ts` does; `judgeRender` against a **baseline** when there
is one — the frame's current image if the scene was active
(`/api/frames/{id}/image` on the backend, uploaded with the job), or a
screenshot the user drops in; without a baseline the judge scores blankness
and errors only. Three attempts, then report. The job's output is `{scene,
report: {converted: [...], substituted: [...], needsManualPort: [...],
renderScore, attempts}}`.

### 3c. Where it runs, and who pays

Recommendation: **the converter is a cloud service, and the same package is
a CLI.** The AI loop, lint, headless renderer and judge already live in the
cloud; nothing of that exists in Python, and porting it is the rewrite this
plan refuses.

- [x] **Cloud route** `POST /api/scenes/convert` — shipped synchronous and
  public (see above): `{scene | scenes, openaiApiKey?, dryRun?, render?}`,
  no session needed, `maxDuration = 300`. Key order is request key →
  signed-in account key (same-origin only) → platform key gated by
  `FRAMEOS_SCENE_CONVERT_SHARED_KEY_ACCESS` (default on) with
  `FRAMEOS_SCENE_CONVERT_PER_ADDRESS_PER_HOUR` (6) and
  `FRAMEOS_SCENE_CONVERT_PER_DAY` (200) budgets; a `scene_convert` PostHog
  event per request. **Still to do:** `baselineImage`/`frameState`, the
  `scenes:convert` link scope for backends, detached jobs with a progress
  stream (a scene with many apps can outlive one request), nginx's
  `proxy_read_timeout` checked against the 300 s.
- [ ] **MCP tool** `scene_convert` in `packages/mcp` (same body).
- [x] **On scenes.frameos.net**: shipped as `app/nim-converter/page.tsx`
  (public, not under `my-scenes`): drop or paste JSON, one button, the
  report, "Open in the editor" (the result, unsaved, in `/my-scenes/new`
  via a sessionStorage hand-off), a download, "Save to my scenes" when
  signed in. **Still to do:** zip input.
- [x] **CLI** `pnpm --filter @frameos-cloud/scene-convert convert scene.json
  --openai-key … --out converted.json [--dry-run] [--types ai-context.json]`.
  **Still to do:** `--baseline`.
- [x] **Backend route** `POST /api/frames/{id}/scenes/{scene_id}/convert` —
  shipped (Stage 1 branch) as a stateless forward to the cloud's public
  converter: body `{scene?}` (the editor's unsaved copy wins), the
  operator's `openAI.backendApiKey` forwarded when set, the cloud's reply
  passed through; the editor applies the result in place
  (`frameLogic.convertSceneToInterpreted`, chips on Nim code nodes and Nim
  apps). **Still to do:** `via: "cli"`, writing back to `frame.scenes`
  server-side ("Convert all"), baseline image/state. The original wording:
  `{via: "cloud" | "cli", openaiApiKey?}`. `cloud` = `cloud_request()`
  with the link token (scope approval dance once), forwarding the frame's
  current image and state as baseline; `cli` = shell out to the package
  through `utils/process` when `node` is on the host (documented,
  optional). Result is written back to `frame.scenes` in place (additive,
  3a); the deploy plan re-evaluates; a settings key `openAI.backendApiKey`
  already exists to forward when the user chooses to pay themselves.
  "Convert all" on a frame runs it per scene and collects the reports.

### 3d. Fix the model's view of the runtime first

- [ ] `scripts/generate-ai-context.mjs` and `frontend/src/utils/
  appTypeDeclarations.ts`: add `httpRequest`, the asset and stream calls,
  `getSetting`, `app.state`, `context.imageWidth/imageHeight` to the
  declarations; regenerate `ai-context.json`. Without this every port that
  fetches or reads an asset fails the type check.
- [ ] `docs/js-apps-and-code-nodes.md`: the `app.state` correction; the
  reserved code-node names; the "render-category scene apps draw nothing"
  rule stated as a rule, not a note.
- [ ] `docs/nim-to-js-conversion.md`: the two mapping tables above are
  maintained *there* and loaded into the prompt at build time — one source,
  like `docs/cloud-frames-contract.json` is for the verbs.

### 3e. Fixtures and exit criteria

- [x] `cloud/packages/scene-convert/fixtures/`: `vannituba` and
  `dataCodeFloat` are in, with pass-1 expectations in `convert.test.ts`. Then
  every compiled scene we can get from users who ask for the conversion
  (with permission, stripped of secrets), each with the expected pass-1
  output and, where a baseline exists, the image. The e2e
  `dataCodeFloat.json` Nim node is fixture #0.
- Exit: `vannituba` converts with **zero** model calls for its code nodes
  and one for the app, renders in headless wasm without errors, and deploys
  to a Pi with `will_attempt_precompiled = true`; the cloud refuses the
  original and accepts the converted scene; the CLI produces the same
  output as the route for the same input and key.

## Stage 4 — Binaries by default, source builds behind a door

Goal: after this stage the backend compiles Nim only when a user with a
compiled scene explicitly asks for the legacy path, and never for a fresh
frame. Nothing is deleted yet.

- [ ] `binary_builder.py:212-246`: when `compiled_scene_count > 0` the plan
  no longer silently resolves to `STATIC`. It resolves to **precompiled
  with a warning** ("N compiled scenes will not run — convert them, or
  enable the legacy source build for this frame") unless the frame has
  `<mode>.legacySourceBuild = true` (new key on `rpios` / `buildroot`, off
  by default, only visible in the advanced section). Existing frames that
  have compiled scenes get the key set to `true` by a migration so nothing
  breaks on upgrade; the Stage 2 chip tells them it is on.
- [ ] Buildroot (`frame_deploy_workflow.py:727-756`): same key gates
  `force_cross_compile`; with the key off, a Buildroot frame is always
  precompiled — which is what every SD-image frame already is.
- [ ] `frame_bootstrap.py:191, 452` (the curl installer): keep installing the
  release; the "compiled scene(s) still require a full deploy" line points
  at the converter.
- [ ] `frameos setup` / `scripts/frameos-setup.sh` and the HA add-on docs:
  "install a release" is the only documented path; the from-source build
  paragraph moves to `docs/legacy-source-builds.md` with the date.
- [ ] CI: the per-frame compile paths (`frameos-cross.yml` driver-variant
  builds, the `make cross-%` matrix) go behind `workflow_dispatch` — still
  runnable, no longer on every PR. The release job, the cross-toolchain
  image job and the driver-library build (they build *the* binary) stay on
  PRs.
- [ ] Telemetry: `deploy_finished` gains `build_kind: precompiled | static |
  on_device`; the number of `static` builds per week is the metric this
  whole plan is judged by. Target before Stage 5: zero for a full release
  cycle, except frames with `legacySourceBuild`.

Exit: a fresh frame of any kind — Pi image, x86, Buildroot SD card, curl
install, ESP32 — never triggers a Nim compile, with or without a build
environment configured; `precompiled_skip_reason` is never "compiled scenes"
for a frame without the legacy key.

## Stage 5 — Delete the compiler (after the deprecation date)

Goal: the repo no longer contains a way to compile a scene or build a
per-frame binary. Ordered so `main` stays releasable at every step. This
stage does **not** touch SSH, the terminal, deploys, Remote, image
builders, HA, virtual frames or thin clients.

- [ ] Data first: every scene with `settings.convertedFrom` loses its Nim
  siblings (`data.code`, `app.nim`, `config.nim`) in a backend migration;
  every scene still `compiled` is stamped `interpreted` with the Stage 3
  `needsConversion` notes on its Nim nodes — it renders whatever the
  interpreter can and logs the rest. The cloud already has no such scenes.
- [ ] Backend: `codegen/` (4,367 LOC — keep `release_drivers_nim.py` and
  `drivers_nim.py`'s driver half, which the release job uses),
  `binary_builder.py`'s source-build branch, `utils/cross_compile.py` (1,261),
  `build_executor.py`, `build_host.py`, `modal_sandbox.py`,
  `prebuilt_deps.py`, `utils/scene_execution.py`'s compiled half, the
  `legacySourceBuild` key, `frames.py:2374-2385` `/scene_source`,
  `apps.py:112-158` `validate_nim`, settings `buildHost` / `modalSandbox` /
  `buildEnvironment` / toolchain digests. `_frame_deployer.py:380-436`
  (codegen writes into the source tree) goes; the deployer copies a
  release and its drivers, nothing else.
- [ ] Runtime: `frameos/src/scenes/` (the codegen slot), `scenes.nim`'s
  `compiledScenes` + `registerCompiledScene` (`frameos/src/frameos/scenes.
  nim:32-57`, `interpreter.nim:353-356`), `js_app_runtime.nim`,
  `src/system/index/scene.nim` repointed at the dynamic scene options.
  `make cross-%` for per-frame builds, `generate_driver_sources.py
  --config frame.json`, `build_driver_libraries.py --only-if-shared`.
  **Keep** `bin/cross release`, `nimc.Makefile`, the toolchain image, the
  release job.
- [ ] Frontend: `SceneSource/` (209), the execution Select and
  `sceneExecution.ts`, `CompiledSceneTag.tsx`, the Nim textarea in
  `CodeNode.tsx`, `EditApp.tsx`'s Nim branches, `frameDeployUtils.ts`'s
  precompiled-skip logic, Settings' legacy build section, `NewFrame.tsx`'s
  `compilationMode`. `sceneRequiresCompilation` survives as a lint ("this
  scene carries Nim that nothing runs") on both planes.
- [ ] Exit: `grep -rn "write_scene_nim\|compilationMode\|nim check\|
  legacySourceBuild" backend frontend frameos` returns nothing outside
  `docs/`; CI has no job that compiles Nim on a user's behalf.

## Parked — decided later, not by this plan

Each of these was in the 2026-08-29 draft; they are removed from scope, not
rejected. The order they were written in is roughly the order they would
come back.

- **Implementation convergence** (cloud absorbs adoption, the canonical
  `/api/frames/:id/{ping,state,states}` routes, `/api/apps` from the bundled
  catalog, `get_scenes` verb, settings parity). The contract
  (`docs/cloud-frames-contract.json`) stays the seam if and when.
- **SSH / terminal / Remote in the cloud.** Stays backend-only; the "cloud
  has no shell verbs, on purpose" rule in `docs/todo.md` stands.
- **Retiring `backend/`**, the self-hosted cloud stack (single-origin mode,
  compose bundle, versioned migrations), the HA add-on's future.
- **Thin clients** (ESP32-C3, Pico, hub-rendered FOSB) and **virtual
  frames**: untouched by this plan; `/embedded/render` keeps working.
- **Porting the 40 Nim built-ins to JS** and giving the JS bridge drawing /
  text / dither primitives. The converter's "no equivalent" column is the
  list of what such primitives would unlock; each one that ships shrinks
  it.
- **Dropping `frameos_remote` from releases**, `driverSpecs` at runtime,
  shipping all drivers per frame: release-hygiene items, not blockers.
- **Version-skew feature table** for interpreter semantics (browser wasm =
  `main`, frame = last release).
- **Hardware-in-the-loop bench.** Still the right thing; not gated on
  anything here, and nothing here is gated on it — Stages 1–4 change no
  device code.

## What this plan does not do

- It does not merge the backend into the cloud, or the other way round.
- It does not add a scene `.so` mechanism (see above — it was tried).
- It does not port a single built-in app; converted scenes keep referencing
  the catalog by keyword, which the interpreter dispatches into the binary
  (`interpreter.nim:137-160`).
- It does not touch the ESP32, which has never compiled a scene.
