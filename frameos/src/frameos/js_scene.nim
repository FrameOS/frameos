## Pure JavaScript scenes: `settings.execution == "js"`.
##
## A JS scene has no node graph. It is one module (`sources["scene.ts"]`,
## with whatever it imports from the same map) that exports:
##
##   export function init(scene)                 // once, when the scene is built
##   export function render(scene, canvas)       // every render: draw the frame
##   export function onEvent(scene, event, payload)  // every other event
##
## `scene` is the scene's own handle (state, frame, fetch, assets, time
## helpers, dispatch — see the prelude below and docs/pure-js-scenes.md);
## `canvas` is the frame's render surface (js_runtime/canvas_api.nim).
##
## The module runs in a JS *app* runtime (js_runtime/app_runtime.nim): the
## same QuickJS, module loader, sandbox, budgets and `frameos.*` bridge a
## scene-local app gets, so a scene author learns one API. What differs is
## the lifetime: the runtime is pinned for the scene's life, so module-level
## state survives between renders on every host — the JS heap is the
## scene's working memory, and the heap ceiling (`frame.json` `js.memoryLimitMb`)
## bounds it.
##
## This module sits below interpreter.nim: the interpreter's registry,
## `init`, `runEvent` and `render` dispatch here when a scene is a JS one,
## so every host — the Linux runner, the ESP32, the wasm preview — picks the
## mode up through the one code path they already share.

import std/[json, options, sequtils, strutils, tables, times]
import pixie, chrono
import frameos/types
import frameos/apps as frameos_apps
import frameos/channels
import frameos/cloud/scene_guard
import frameos/events
import frameos/refresh_interval
import frameos/values
import frameos/js_runtime/app_runtime
import frameos/js_runtime/burrito
import frameos/js_runtime/canvas_api
import frameos/js_runtime/run_budget
import frameos/js_runtime/runtime as jsRuntime
from frameos/utils/image import renderErrorInto

export canvas_api.liveCanvasHandleCount

type
  ExportedJsScene* = ref object of ExportedInterpretedScene
    ## `nodes`/`edges` stay empty; what the scene IS lives in `sources`.
    sources*: JsonNode
    mainName*: string
    settingsKeys*: seq[string]

  JsSceneApp = ref object of AppRoot
    ## The owner the app runtime attributes logs and budgets to.

  JsFrameScene* = ref object of FrameScene
    exported*: ExportedJsScene
    runtime*: JsAppRuntime
    owner: AppRoot
    publicStateFields*: seq[StateField]
    stateFieldTypes: Table[string, string]
    exportsChecked: bool
    hasOnEvent: bool
    hasRender: bool
    ## The module did not load (syntax error, missing file). Shown on the
    ## canvas instead of a blank frame, and retried on the next render.
    loadError*: string

const JsSceneMainCandidates = ["scene.ts", "scene.tsx", "scene.js", "scene.jsx", "index.ts", "index.js"]

## The scene a QuickJS context is running for, for the bindings below (they
## are plain nimcall procs: no closure, no environment but the context).
var activeScenes = initTable[ptr JSContext, JsFrameScene]()

proc activeScene(ctx: ptr JSContext): JsFrameScene =
  if activeScenes.hasKey(ctx): activeScenes[ctx] else: nil

# --------------------------------------------------------------------------
# Bindings the scene gets on top of the app bridge
# --------------------------------------------------------------------------

proc sceneTimeZone(scene: JsFrameScene): string =
  if not scene.isNil and not scene.frameConfig.isNil:
    let configured = scene.frameConfig.timeZone.strip()
    if configured.len > 0:
      return configured
  "UTC"

proc jsSceneNow(ctx: ptr JSContext): JSValue {.nimcall.} =
  nimFloatToJS(ctx, epochTime())

proc jsSceneFormat(ctx: ptr JSContext, tsVal: JSValue, fmt: JSValue): JSValue {.nimcall.} =
  let ts = toNimFloat(ctx, tsVal).Timestamp
  let fmtStr = toNimString(ctx, fmt)
  try:
    nimStringToJS(ctx, format(ts, fmtStr, tzName = sceneTimeZone(activeScene(ctx))))
  except CatchableError as e:
    raise newException(ValueError, "format failed: " & e.msg)

proc jsSceneParseTs(ctx: ptr JSContext, fmt: JSValue, text: JSValue): JSValue {.nimcall.} =
  let fmtStr = toNimString(ctx, fmt)
  let txtStr = toNimString(ctx, text)
  try:
    nimFloatToJS(ctx, chrono.parseTs(fmtStr, txtStr).float64)
  except CatchableError as e:
    raise newException(ValueError, "parseTs failed: " & e.msg)

proc jsSceneNewImage(ctx: ptr JSContext, w: JSValue, h: JSValue): JSValue {.nimcall.} =
  ## An offscreen image the scene owns until `free()` or collection.
  let scene = activeScene(ctx)
  if scene.isNil:
    raise newException(ValueError, "no scene is running")
  let image = allocateSceneImage(toNimInt(ctx, w).int, toNimInt(ctx, h).int)
  newCanvasObject(ctx, image, scene.frameConfig, scene.logger, owned = true, transient = false)

proc jsSceneDispatch(ctx: ptr JSContext, event: JSValue, payloadJson: JSValue): JSValue {.nimcall.} =
  ## `scene.dispatch(event, payload)`: the same door a dispatch node uses,
  ## with the same budget and the same origin rules — scene code is
  ## untrusted, so it may drive scenes and state and nothing more.
  let scene = activeScene(ctx)
  let name = toNimString(ctx, event).strip()
  if scene.isNil or name.len == 0:
    return jsUndefined(ctx)
  var payload: JsonNode
  try:
    payload = parseJson(toNimString(ctx, payloadJson))
  except CatchableError:
    payload = %*{}
  if payload.isNil or payload.kind != JObject:
    payload = %*{}
  if not originMayEmit(eoScene, name, scene.customEventOrigins.getOrDefault(name)):
    scene.logger.log(%*{"event": "jsScene:dispatch:ignored", "sceneId": scene.id.string,
      "eventName": name, "reason": "origin"})
    return jsUndefined(ctx)
  case takeDispatchBudget()
  of dvAllowed:
    sendEvent(name, payload, eoScene)
  of dvRefusedFirst:
    scene.logger.log(%*{"event": "jsScene:dispatch:ignored", "sceneId": scene.id.string,
      "eventName": name, "reason": "dispatchBudget", "budget": dispatchBudgetTotalNow()})
  of dvRefused:
    discard
  jsUndefined(ctx)

proc jsSceneMeta(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let scene = activeScene(ctx)
  if scene.isNil:
    return jsUndefined(ctx)
  case toNimString(ctx, key)
  of "id": nimStringToJS(ctx, scene.id.string)
  of "name": nimStringToJS(ctx, scene.exported.name)
  of "refreshInterval": nimFloatToJS(ctx, scene.refreshInterval)
  of "backgroundColor": nimStringToJS(ctx, scene.backgroundColor.toHtmlHex())
  of "timeZone": nimStringToJS(ctx, sceneTimeZone(scene))
  else: jsUndefined(ctx)

const sceneJsPreludeSource = """
"use strict";
(() => {
  const app = globalThis.__frameosAppInstance;
  const unwrap = (v) => (v && v.__frameosUndef === true) ? undefined : v;
  const keys = () => jsGetAppKeys("state");
  const state = new Proxy({}, {
    get(_, k) { return (typeof k === "string") ? unwrap(jsGetAppState(k)) : undefined; },
    set(_, k, v) {
      if (typeof k === "string") jsSetState(k, JSON.stringify(v === undefined ? null : v));
      return true;
    },
    has(_, k) { return typeof k === "string" && keys().includes(k); },
    ownKeys() { return keys(); },
    getOwnPropertyDescriptor(_, k) {
      return (typeof k === "string" && keys().includes(k))
        ? { enumerable: true, configurable: true, writable: true, value: unwrap(jsGetAppState(k)) }
        : undefined;
    },
  });
  // A literal, not Object.assign: assign would evaluate the getters once.
  const scene = {
    ...frameos,
    state,
    frame: app.frame,
    get id() { return unwrap(jsSceneMeta("id")); },
    get name() { return unwrap(jsSceneMeta("name")); },
    get refreshInterval() { return unwrap(jsSceneMeta("refreshInterval")); },
    get backgroundColor() { return unwrap(jsSceneMeta("backgroundColor")); },
    get timeZone() { return unwrap(jsSceneMeta("timeZone")); },
    get event() { return unwrap(jsGetAppContext("event")); },
    get payload() { return unwrap(jsGetAppContext("payload")); },
    now: () => jsSceneNow(),
    format: (ts, pattern) => jsSceneFormat(Number(ts), String(pattern ?? "")),
    parseTs: (pattern, text) => jsSceneParseTs(String(pattern ?? ""), String(text ?? "")),
    dispatch: (event, payload) => jsSceneDispatch(String(event ?? ""), JSON.stringify(payload ?? {})),
    newImage: (width, height) => jsSceneNewImage(width | 0, height | 0),
    loadImage: (source, options) => {
      const o = options || {};
      const image = jsSceneNewImage(o.width | 0, o.height | 0);
      if (!image.image(source, { fit: o.fit || "contain" })) { image.free(); return null; }
      return image;
    },
  };
  delete scene.image;
  delete scene.svg;
  delete scene.node;
  delete scene.scene;
  delete scene.color;
  globalThis.scene = scene;
  globalThis.console = globalThis.console || {};
  globalThis.console.log = (...args) => jsAppLog("log", JSON.stringify(args, __jsReplacer));
  globalThis.console.error = (...args) => jsAppLog("error", JSON.stringify(args, __jsReplacer));
  globalThis.console.warn = globalThis.console.error;
  globalThis.__frameosInvokeScene = (name, ...args) => {
    const mod = __frameosExports();
    const fn = mod && mod[name];
    return typeof fn === "function" ? fn(scene, ...args) : undefined;
  };
  globalThis.__frameosSceneHas = (name) => {
    const mod = __frameosExports();
    return typeof (mod && mod[name]) === "function";
  };
})();
"""

proc installSceneBindings(runtime: JsAppRuntime) =
  runtime.js.registerFunction("jsSceneNow", jsSceneNow)
  runtime.js.registerFunction("jsSceneFormat", jsSceneFormat)
  runtime.js.registerFunction("jsSceneParseTs", jsSceneParseTs)
  runtime.js.registerFunction("jsSceneNewImage", jsSceneNewImage)
  runtime.js.registerFunction("jsSceneDispatch", jsSceneDispatch)
  runtime.js.registerFunction("jsSceneMeta", jsSceneMeta)
  discard runtime.js.eval(sceneJsPreludeSource, "<scene-prelude>")

# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

proc jsSceneMainName*(sources: JsonNode): string =
  ## The module the runtime evaluates: `scene.ts` (or the first of the usual
  ## spellings present); "" when the scene has none.
  if sources.isNil or sources.kind != JObject:
    return ""
  for name in JsSceneMainCandidates:
    if sources.hasKey(name) and sources[name].kind == JString:
      return name
  ""

proc isJsSceneExecution*(execution: string): bool =
  execution.strip().toLowerAscii() == "js"

proc jsSceneSettingsKeys(sources: JsonNode): seq[string] =
  ## `config.json` next to `scene.ts` may declare the settings namespaces
  ## the scene reads with `getSetting` — the same opt-in a JS app makes.
  if sources.isNil or sources.kind != JObject or not sources.hasKey("config.json"):
    return @[]
  try:
    let config = parseJson(sources["config.json"].getStr("{}"))
    let settings = config{"settings"}
    if not settings.isNil and settings.kind == JArray:
      for key in settings.items:
        if key.kind == JString and key.getStr().len > 0:
          result.add(key.getStr())
  except CatchableError:
    discard

proc initJsScene*(exported: ExportedJsScene, sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene
proc runJsEvent*(self: FrameScene, context: ExecutionContext)
proc renderJsScene*(self: FrameScene, context: ExecutionContext): Image

proc buildJsSceneExport*(scene: FrameSceneInput): ExportedJsScene =
  ## The registry entry for a JS scene, shaped like an interpreted one so
  ## every listing, control panel and state reader keeps working.
  let settingsInterval = if scene.settings != nil: scene.settings.refreshInterval else: 0.0
  let backgroundColor = if scene.settings != nil: scene.settings.backgroundColor else: parseHtmlColor("#000000")
  let refresh = resolveRefreshInterval(scene.fields, settingsInterval)
  let exported = ExportedJsScene(
    name: scene.name,
    nodes: @[],
    edges: @[],
    apps: %*{},
    sources: if scene.sources.isNil: %*{} else: scene.sources,
    mainName: jsSceneMainName(scene.sources),
    settingsKeys: jsSceneSettingsKeys(scene.sources),
    stateFields: refresh.fields,
    storeOrigin: sceneOriginIsStore(scene.origin),
    customEventOrigins: declaredCustomEventOrigins(scene.customEvents),
    publicStateFields: refresh.fields.filterIt(it.access != "private"),
    persistedStateKeys: refresh.fields.filterIt(it.persist == "disk").mapIt(it.name),
    refreshIntervalKey: refresh.key,
    refreshIntervalDefault: refresh.defaultSeconds,
    refreshIntervalImplicit: refresh.implicit,
    render: renderJsScene,
    runEvent: runJsEvent,
    refreshInterval: refresh.defaultSeconds,
    backgroundColor: backgroundColor
  )
  exported.init = proc (sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
      persistedState: JsonNode): FrameScene =
    initJsScene(exported, sceneId, frameConfig, logger, persistedState)
  exported

# --------------------------------------------------------------------------
# Running the module
# --------------------------------------------------------------------------

proc checkExports(scene: JsFrameScene) =
  if scene.exportsChecked:
    return
  scene.hasOnEvent = scene.runtime.js.eval("__frameosSceneHas('onEvent')") == "true"
  scene.hasRender = scene.runtime.js.eval("__frameosSceneHas('render')") == "true"
  scene.exportsChecked = true
  if not scene.hasRender:
    scene.logger.log(%*{"event": "jsScene:noRender", "sceneId": scene.id.string,
      "error": scene.exported.mainName & " does not export a render(scene, canvas) function"})

proc ensureLoaded(scene: JsFrameScene): bool =
  ## Build the interpreter and evaluate the module. False (and `loadError`
  ## set) when the module does not load; tried again on the next run.
  try:
    scene.runtime.ensureRuntimeReady(scene.frameConfig, scene.id.string)
    activeScenes[scene.runtime.js.context] = scene
    scene.checkExports()
    scene.loadError = ""
    true
  except CatchableError as e:
    if scene.loadError != e.msg:
      scene.logger.log(%*{"event": "jsScene:loadError", "sceneId": scene.id.string, "error": e.msg})
    scene.loadError = e.msg
    scene.exportsChecked = false
    false

proc callExport(scene: JsFrameScene, context: ExecutionContext, fnName: string, extra: openArray[JSValue]) =
  if not scene.ensureLoaded():
    return
  let ctx = scene.runtime.js.context
  activeScenes[ctx] = scene
  let payload = scene.runtime.invokeWith(scene.owner, %*{}, context, "__frameosInvokeScene", fnName, extra)
  JS_FreeValue(ctx, payload)

proc applyPublicStateFromPayload(scene: JsFrameScene, payload: JsonNode) =
  if payload.isNil or payload.kind != JObject:
    return
  for field in scene.publicStateFields:
    let key = field.name
    if not payload.hasKey(key):
      continue
    var value = copy(payload[key])
    if field.fieldType == "json" and value.kind == JString:
      try:
        value = parseJson(value.getStr())
      except CatchableError:
        discard
    if value != scene.state{key}:
      scene.state[key] = value

proc resolvedRenderDeadlineMs(frameConfig: FrameConfig): int =
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.renderDeadlineMs >= 0:
    return frameConfig.js.renderDeadlineMs
  DefaultRenderDeadlineMs

proc resolvedDispatchBudget(frameConfig: FrameConfig): int =
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.dispatchBudget >= 0:
    return frameConfig.js.dispatchBudget
  DefaultDispatchBudget

proc renderInto(scene: JsFrameScene, context: ExecutionContext) =
  if not context.hasImage or context.image.isNil:
    # Same rotation contract as runner.renderSceneImage and the interpreter.
    context.image = case scene.frameConfig.rotate:
      of 90, 270: newImage(scene.frameConfig.height, scene.frameConfig.width)
      else: newImage(scene.frameConfig.width, scene.frameConfig.height)
    context.hasImage = true
  context.image.fill(scene.backgroundColor)
  if not scene.ensureLoaded():
    renderErrorInto(context.image, context.image.width, context.image.height,
      "Scene failed to load:\n" & scene.loadError)
    return
  if not scene.hasRender:
    renderErrorInto(context.image, context.image.width, context.image.height,
      scene.exported.mainName & " exports no render(scene, canvas)")
    return
  let ctx = scene.runtime.js.context
  let canvas = newCanvasObject(ctx, context.image, scene.frameConfig, scene.logger,
    owned = false, transient = true)
  try:
    scene.callExport(context, "render", [canvas])
  finally:
    JS_FreeValue(ctx, canvas)
    # The canvas is the host's again: cells and pixel views die here.
    finishCanvasRun(ctx)

proc deliverEvent(scene: JsFrameScene, context: ExecutionContext) =
  if not scene.ensureLoaded() or not scene.hasOnEvent:
    return
  let ctx = scene.runtime.js.context
  let name = nimStringToJS(ctx, context.event)
  let payload = if context.payload.isNil: jsNull(ctx) else: jsonToJS(ctx, context.payload)
  try:
    scene.callExport(context, "onEvent", [name, payload])
  finally:
    JS_FreeValue(ctx, name)
    JS_FreeValue(ctx, payload)
    finishCanvasRun(ctx)

proc runJsEventInner(scene: JsFrameScene, context: ExecutionContext) =
  case context.event
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      scene.applyPublicStateFromPayload(context.payload["state"])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{}, eoSystem)
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      scene.applyPublicStateFromPayload(context.payload["state"])
  of "render":
    scene.renderInto(context)
    return
  else:
    discard
  scene.deliverEvent(context)

proc runJsEvent*(self: FrameScene, context: ExecutionContext) =
  ## Every run of a JS scene — the same budgets the interpreter arms, so a
  ## scene that loops forever or fetches a tarpit costs one render.
  let scene = JsFrameScene(self)
  let armedHere = armRenderDeadline(resolvedRenderDeadlineMs(self.frameConfig))
  if armedHere:
    setDispatchBudget(resolvedDispatchBudget(self.frameConfig))
  try:
    runJsEventInner(scene, context)
  finally:
    self.syncRefreshInterval()
    if armedHere:
      disarmRenderDeadline()
      setDispatchBudget(0)

proc renderJsScene*(self: FrameScene, context: ExecutionContext): Image =
  runJsEvent(self, context)
  result = context.image

proc jsSceneListensTo*(scene: FrameScene, event: string): bool =
  ## Input events are built only for a scene that exports `onEvent`.
  if not (scene of JsFrameScene):
    return true
  let js = JsFrameScene(scene)
  if not js.exportsChecked:
    return true
  js.hasOnEvent

# --------------------------------------------------------------------------
# Lifetime
# --------------------------------------------------------------------------

proc initJsScene*(exported: ExportedJsScene, sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene =
  let scene = JsFrameScene(
    id: sceneId,
    isRendering: false,
    frameConfig: frameConfig,
    logger: logger,
    refreshInterval: exported.refreshInterval,
    refreshIntervalKey: exported.refreshIntervalKey,
    refreshIntervalDefault: exported.refreshIntervalDefault,
    backgroundColor: exported.backgroundColor,
    state: %*{},
    customEventOrigins: exported.customEventOrigins,
    exported: exported,
    publicStateFields: exported.publicStateFields,
  )
  scene.owner = JsSceneApp(nodeId: 0.NodeId, nodeName: "scene", appKeyword: "scene",
    scene: scene, frameConfig: frameConfig)
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      scene.state[key] = persistedState[key]
  for field in exported.stateFields:
    scene.stateFieldTypes[field.name] = field.fieldType
    if not scene.state.hasKey(field.name) and not field.value.isNil and field.value.kind != JNull:
      if field.value.kind == JString and field.value.getStr().len == 0:
        continue
      var seedValue = field.value
      if field.fieldType == "json" and seedValue.kind == JString:
        try:
          seedValue = parseJson(seedValue.getStr())
        except CatchableError:
          discard
      scene.state[field.name] = valueToJson(valueFromJsonByType(seedValue, field.fieldType))
  scene.syncRefreshInterval()

  let mainName = exported.mainName
  let source = if mainName.len > 0: exported.sources[mainName].getStr("") else: ""
  scene.runtime = newJsAppRuntime("scene", "", source, exported.settingsKeys,
    if mainName.len > 0: mainName else: "scene.ts", exported.sources)
  scene.runtime.pinned = true
  scene.runtime.onReady = installSceneBindings
  if source.len == 0:
    scene.loadError = "the scene has no scene.ts"
    logger.log(%*{"event": "jsScene:loadError", "sceneId": sceneId.string, "error": scene.loadError})
  else:
    # Load now, so a module that does not parse says so at init, and fire
    # "init" the way the interpreter does: once, with the state seeded.
    let context = ExecutionContext(scene: scene, event: "init", payload: scene.state,
      hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let armedHere = armRenderDeadline(resolvedRenderDeadlineMs(frameConfig))
    if armedHere:
      setDispatchBudget(resolvedDispatchBudget(frameConfig))
    try:
      if scene.ensureLoaded():
        scene.callExport(context, "init", [])
        finishCanvasRun(scene.runtime.js.context)
    finally:
      scene.syncRefreshInterval()
      if armedHere:
        disarmRenderDeadline()
        setDispatchBudget(0)
  logger.log(%*{"event": "initJsScene", "sceneId": sceneId.string, "main": mainName,
    "loaded": scene.loadError.len == 0})
  scene

proc cleanupJsScene*(scene: FrameScene) =
  ## Close the scene's interpreter. Nothing else holds it, so this is the
  ## only place its QuickJS is freed.
  if scene.isNil or not (scene of JsFrameScene):
    return
  let js = JsFrameScene(scene)
  if js.runtime.isNil:
    return
  if js.runtime.ready and not js.runtime.js.context.isNil:
    let ctx = js.runtime.js.context
    activeScenes.del(ctx)
    dropCanvasBuffersFor(ctx)
  releaseJsRuntime(js.runtime)
  js.runtime.onReady = nil
  js.owner = nil

proc isJsScene*(scene: FrameScene): bool =
  not scene.isNil and scene of JsFrameScene
