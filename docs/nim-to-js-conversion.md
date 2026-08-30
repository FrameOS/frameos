# Nim → JavaScript: converting compiled scenes

*The converter for legacy compiled scenes. Stage 3 of `docs/convergence-todo.md`,
in its no-frills form: one page, one public API, one CLI, one package. The two
mapping tables below are the model's instructions verbatim —
`cloud/packages/scene-convert/src/prompt.ts` carries the same rows and its test
fails when this file and the prompt disagree, so a mapping is corrected here and
in the prompt together.*

## What a compiled scene is

A scene with `settings.execution = "compiled"` — or, before it was stamped, any
scene holding content only the Nim compiler can run: a scene-local app with
`app.nim`/`config.nim` and no `app.ts` sibling, a code node with Nim in
`data.code` and nothing in `data.codeJS`, or a `source` node
(`sceneRequiresCompilation` on all three planes: `frontend/src/utils/sceneApps.ts`,
`backend/app/utils/scene_execution.py`, `cloud/packages/scene-convert/src/convert.ts`).
Such a scene forces a per-frame source build on every deploy. Converting it
makes it an interpreted scene: JavaScript in QuickJS on the frame, deployable
from the released binaries, previewable in the browser.

## Where to run it

- **Page:** https://scenes.frameos.net/nim-converter — drop a `scene.json` (one
  scene, a `scenes.json` array, or an export with `{"scenes": [...]}`), then
  **Open in the editor** — the result opens unsaved in the scene editor
  (`/my-scenes/new?from=converter`, handed over through this tab's
  sessionStorage), where it can be previewed, tweaked, installed on a frame,
  saved or downloaded — or download the JSON directly. No account needed for
  the conversion itself; saving asks for one. The UI says "convert to an
  interpreted scene": JavaScript is the how, interpreted is the what.
- **API:** `POST https://scenes.frameos.net/api/scenes/convert` with the same
  JSON body shapes (`{"scene": {...}}` or `{"scenes": [...]}`), optional
  `"dryRun": true` (deterministic pass only), optional `"openaiApiKey"` to
  pay for the model pass yourself (used for this request, never stored). No
  login; rate limited per address, and the platform's key has a daily budget —
  `429` says when to retry. `GET` on the same URL returns the usage notes.
  The reply is `{ok, scene | scenes, reports, lint, render?, model}`.
- **CLI:** `pnpm --filter @frameos-cloud/scene-convert convert scene.json --out converted.json [--openai-key …] [--dry-run]`
  — the same package offline, on your own key (`OPENAI_API_KEY`), for
  self-hosters and for the fixture suite.

## How it works

**Pass 1 — deterministic, no model.** `src/nim-expression.ts` is a small Nim
expression grammar: state reads, comparisons, arithmetic, `if`/`case`
expressions, string building, `let` bindings (emitted as an IIFE), a little
time formatting. Anything outside it throws with the position and the node
goes to pass 2. The structural fixes that need no model run first, on every
code node: an argument named `state`, `args`, `context`, `console`,
`format`, `now`, `parseTs` or `getargor` is renamed (`state` →
`stateValue`) and its edges rewritten, because the JavaScript envelope silently
refuses to declare those names (`frameos/src/frameos/js_runtime/runtime.nim`);
an edge into an argument the code uses but `codeArgs` does not declare
declares it; an edge into a name the code never uses is dropped; `codeArg/`
handles become `codeField/` (the interpreter reads only the latter); `source`
nodes are refused outright.

| Nim | JavaScript |
|---|---|
| scene.state{"a"}{"b"}.getStr / $scene.state{…} | String(state.a?.b ?? "") |
| .getInt / .getFloat / .getBool / .getStr | Number(… ?? 0) / Boolean(…) / String(… ?? "") |
| if c: a else: b (expression) | c ? a : b |
| == != and or not & $x .len .int .float mod div | === !== && || ! + String(x) .length Math.trunc() Number() % Math.trunc(a/b) |
| epochTime() / now() | now() (code node) / Date.now()/1000 (app) |
| %*x, newJString(x), parseJson(x) | x, x, JSON.parse(x) |
| x.split(","), x.strip, x.toLowerAscii, x.contains(y), x.startsWith(y), x.replace(a, b) | the String methods (.split .trim .toLowerCase .includes .startsWith; replace → .split(a).join(b)) |
| parseInt(x), parseFloat(x), $x.formatFloat(ffDecimal, n) | parseInt(x, 10), parseFloat(x), Number(x).toFixed(n) |
| times.now().format("HH:mm") and chrono patterns | format(now(), "{hour/2}:{minute/2}") — strftime letters mapped to curly tokens |

**Pass 2 — the model, per app and per leftover code node.** One Responses call
with a single forced tool (`deliver_conversion`: `files` for an app, `codeJS`
for a code node, or `unsupported` with the reason). The model sees the sources,
the node's wiring (chain position or the field it feeds, the consumers), the
scene's fields and the state keys other nodes use, the app sandbox's type
declarations when the caller has them, and the table below. A chain app exports
`run(app, context)` (category `logic`); an app that feeds a field exports
`get(app, context)` (category `data`). A Nim **render** app has no drawing twin:
it becomes a data app returning `frameos.svg(...)` and the converter inserts a
`render/image` node into its chain slot, wired from the app's `fieldOutput`.
`src/lint.ts` checks each answer (the export the runtime will call, no
`format()`/`now()` in apps, no async, no npm imports, no statements in a code
node) and feeds problems back for up to three attempts.

| Nim | JavaScript |
|---|---|
| self.appConfig.x, self.log/logError/error | app.config.x, app.log/app.logError/frameos.error |
| self.scene.state{"k"} / self.scene.state["k"] = %*v | app.state.k / frameos.setState("k", v) |
| self.frameConfig.renderWidth/renderHeight/assetsPath/timeZone | app.frame.width/height/assetsPath/timeZone |
| context.hasImage, context.image.width/height, context.nextSleep = s | context.hasImage, context.imageWidth/imageHeight, frameos.setNextSleep(s) |
| boundedRequestWithHeaders, utils/http_client | frameos.httpRequest(url, {method, headers, body, timeoutMs, base64}), frameos.fetchJson/fetchText |
| self.saveAsset, readFile/writeFile under assets | frameos.writeAsset, frameos.readAsset |
| downloadImage (remote) / (local) | a data/downloadImage node wired in / frameos.loadAssetImage |
| rand() / Option[T] / raise newException / strformat | Math.random() / undefined + ?. / throw new Error / template literal |
| pixie newImage, fill, draw, fillPath, strokePath, drawText, typeset, newFont, rgb() | an SVG string via frameos.svg(): <rect>, <path>, <text> with font-family/font-size, #rrggbb |
| renderError(...) | return an SVG with the message, or frameos.error() |
| scaleAndDrawImage, decodeImageWithDisplayBounds | frameos.image({dataUrl|base64, width, height}) and let the runtime scale |
| times.now().format, chrono | NO equivalent in an app — feed a data/clock or a format() code node into a field |
| runShellWithParentStreams, EXIF, dither, blake2b, files outside assets, frameConfig.debug, decode-target hints | NO equivalent — do not fake it; report it as unsupported |

For every "no equivalent" the model must say so through `unsupported` — never a
stub. The node then carries `data.needsConversion = {reason, source, at}`, the
report lists it under `needsManualPort`, and the scene stays `compiled`.

**The Nim does not survive.** `data.code` is removed the moment `data.codeJS`
is written and `app.nim`/`config.nim` the moment `app.ts` is; a scene that
already carried both loses the leftover Nim the same way (reported as
`already_javascript`). A converted scene carries no Nim at all — the original
file is the backup. Only Nim that nothing replaced (`needsManualPort`) stays,
so the scene still says what is missing. The converter stamps
`settings.convertedFrom = {execution, at, tool, model}` so a later cleanup can
find every converted scene.

**Verification on the cloud.** After conversion the route runs the full
structural linter (`lintScenes`) and, when the wasm runtime is installed, one
headless render of each converted scene; both come back in the reply as
`lint` and `render`, advisory — the converted JSON is returned either way.

## The report

```json
{
  "sceneId": "…", "sceneName": "…",
  "executionBefore": "compiled", "executionAfter": "interpreted",
  "items": [
    {"kind": "code", "nodeId": "…", "status": "converted", "via": "deterministic", "nim": "…", "js": "…"},
    {"kind": "arg", "nodeId": "…", "status": "renamed", "from": "state", "to": "stateValue", "reason": "…"},
    {"kind": "edge", "edgeId": "…", "nodeId": "…", "status": "dropped", "handle": "codeField/arg", "reason": "…"},
    {"kind": "app", "id": "…", "name": "Heat timer", "status": "converted", "via": "model", "category": "logic", "files": ["app.ts"], "attempts": 1}
  ],
  "needsModel": [], "needsManualPort": [],
  "modelCalls": 1, "usage": {"inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0}, "model": "gpt-5.5"
}
```

`needsModel` is non-empty only after a run without a key (the page and the API
without a platform key, `--dry-run`): pass 1 did what it could and the rest is
listed. Fixture #1 (`fixtures/vannituba.json`, five Nim code nodes and one Nim
app) converts with zero model calls for the code nodes and one for the app.

## Fixtures

`cloud/packages/scene-convert/fixtures/`: `dataCodeFloat.json` (fixture #0, the
e2e suite's one Nim-only code node) and `vannituba.json` (fixture #1). Every
compiled scene a user asks to convert is a candidate for the set — with
permission, secrets stripped.
