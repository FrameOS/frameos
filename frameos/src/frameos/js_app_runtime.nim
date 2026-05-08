import std/[base64, json, options, strformat, strutils, tables]
import pixie

import frameos/apps as frameos_apps
import frameos/js_runtime
import frameos/types
import frameos/values
import frameos/utils/http_client
import frameos/utils/image
import lib/burrito

const MaxJsFetchTextBytes = 2 * 1024 * 1024

type
  JsAppRuntime* = ref object
    category*: string
    outputType*: string
    source*: string
    js*: QuickJS
    ready*: bool
    initialized*: bool
    nextImageId*: int
    images*: Table[int, Image]
    transientImageIds: seq[int]

  JsAppEvalEnv = ref object
    runtime: JsAppRuntime
    owner: AppRoot
    context: ExecutionContext

var jsAppEnvByCtx = initTable[ptr JSContext, JsAppEvalEnv]()

proc env(ctx: ptr JSContext): JsAppEvalEnv =
  if jsAppEnvByCtx.hasKey(ctx): jsAppEnvByCtx[ctx] else: nil

proc jsUndefSentinel(ctx: ptr JSContext): JSValue {.inline.} =
  let obj = JS_NewObject(ctx)
  discard JS_SetPropertyStr(ctx, obj, "__frameosUndef", nimBoolToJS(ctx, true))
  return obj

proc jsAppLog(ctx: ptr JSContext, level: JSValue, payloadJson: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let lvl = toNimString(ctx, level)
  let payloadStr = toNimString(ctx, payloadJson)
  try:
    let payload = parseJson(payloadStr)
    if payload.kind == JObject:
      var logPayload = payload
      logPayload["event"] = %*("jsApp:" & lvl)
      if not logPayload.hasKey("nodeId"):
        logPayload["nodeId"] = %* e.owner.nodeId.int
      if not logPayload.hasKey("nodeName"):
        logPayload["nodeName"] = %* e.owner.nodeName
      e.owner.scene.logger.log(logPayload)
    else:
      if lvl == "error":
        frameos_apps.logError(e.owner, $payload)
      else:
        frameos_apps.log(e.owner, $payload)
  except CatchableError:
    if lvl == "error":
      frameos_apps.logError(e.owner, payloadStr)
    else:
      frameos_apps.log(e.owner, payloadStr)
  return jsUndefSentinel(ctx)

proc jsSetNextSleep(ctx: ptr JSContext, seconds: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e != nil:
    e.context.nextSleep = toNimFloat(ctx, seconds)
  return jsUndefSentinel(ctx)

proc jsSetState(ctx: ptr JSContext, key: JSValue, valueJson: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let stateKey = toNimString(ctx, key)
  if stateKey.len == 0:
    return jsUndefSentinel(ctx)

  let valueStr = toNimString(ctx, valueJson)
  try:
    if e.owner.scene.state.isNil:
      e.owner.scene.state = %*{}
    e.owner.scene.state[stateKey] = parseJson(valueStr)
  except CatchableError:
    e.owner.scene.state[stateKey] = %*valueStr

  return jsUndefSentinel(ctx)

proc jsFetchText(ctx: ptr JSContext, url: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  let urlStr = toNimString(ctx, url)
  if urlStr.len == 0:
    return nimStringToJS(ctx, "")

  try:
    return nimStringToJS(ctx, boundedGetContent(urlStr, maxBytes = MaxJsFetchTextBytes))
  except CatchableError as err:
    if e != nil:
      frameos_apps.logError(e.owner, "JS app fetchText failed: " & err.msg)
    return nimStringToJS(ctx, "")

proc newJsAppRuntime*(category: string, outputType: string, source: string): JsAppRuntime =
  return JsAppRuntime(
    category: category,
    outputType: outputType,
    source: source,
    nextImageId: 0,
    images: initTable[int, Image](),
    transientImageIds: @[]
  )

type
  DynamicJsApp* = ref object of AppRoot
    configJson*: JsonNode
    runtime*: JsAppRuntime

proc storeImageJson(runtime: JsAppRuntime, image: Image): JsonNode =
  if image.isNil:
    return newJNull()
  inc runtime.nextImageId
  runtime.images[runtime.nextImageId] = image
  return %*{
    "__frameosType": "imageRef",
    "id": runtime.nextImageId,
    "width": image.width,
    "height": image.height
  }

proc storeTransientImageJson(runtime: JsAppRuntime, image: Image): JsonNode =
  result = runtime.storeImageJson(image)
  if result.kind == JObject:
    runtime.transientImageIds.add(result["id"].getInt())

proc clearTransientImages(runtime: JsAppRuntime) =
  for id in runtime.transientImageIds:
    if runtime.images.hasKey(id):
      runtime.images.del(id)
  runtime.transientImageIds.setLen(0)

proc imageRefId(node: JsonNode): Option[int] =
  if node.isNil or node.kind != JObject:
    return none(int)
  if node{"__frameosType"}.getStr() != "imageRef":
    return none(int)
  if not node.hasKey("id") or node["id"].kind != JInt:
    return none(int)
  return some(node["id"].getInt())

proc releaseReplacedImageRef(runtime: JsAppRuntime, oldNode: JsonNode, newNode: JsonNode) =
  let oldId = imageRefId(oldNode)
  if oldId.isNone:
    return
  let newId = imageRefId(newNode)
  if newId.isSome and newId.get() == oldId.get():
    return
  if runtime.images.hasKey(oldId.get()):
    runtime.images.del(oldId.get())

proc jsAppValueToJson(runtime: JsAppRuntime, value: Value): JsonNode =
  case value.kind
  of fkString, fkText:
    return %* value.s
  of fkFloat:
    return %* value.f
  of fkInteger:
    return %* value.i
  of fkBoolean:
    return %* value.b
  of fkColor:
    return %* value.col.toHtmlHex
  of fkJson:
    return value.j
  of fkImage:
    return runtime.storeImageJson(value.img)
  of fkNode:
    return %* value.nId.int
  of fkScene:
    return %* value.sId.string
  of fkNone:
    return newJNull()

proc jsAppSourceFromSources*(sources: JsonNode): string =
  if sources.isNil or sources.kind != JObject:
    return ""
  for filename in ["app.ts", "app.js", "app.tsx", "app.jsx"]:
    if sources.hasKey(filename) and sources[filename].kind == JString:
      return sources[filename].getStr()
  return ""

proc hasJsAppSource*(sources: JsonNode): bool =
  jsAppSourceFromSources(sources).len > 0

proc outputTypeFromConfig(config: JsonNode): string =
  if config.isNil or config.kind != JObject:
    return ""
  if config{"category"}.getStr().toLowerAscii() == "render":
    return "image"
  let output = config{"output"}
  if not output.isNil and output.kind == JArray and output.len > 0:
    return output[0]{"type"}.getStr()
  return ""

proc runtimeConfigFromNode(config: JsonNode, nodeConfig: JsonNode): JsonNode =
  result = %*{}
  var fieldTypes = initTable[string, string]()
  let fields = config{"fields"}
  if not fields.isNil and fields.kind == JArray:
    for field in fields.items:
      if field.kind != JObject:
        continue
      let name = field{"name"}.getStr()
      let fieldType = field{"type"}.getStr()
      if name.len == 0:
        continue
      if fieldType.len > 0:
        fieldTypes[name] = fieldType
      if field.hasKey("value"):
        if fieldType.len > 0:
          result[name] = valueToJson(valueFromJsonByType(field["value"], fieldType))
        else:
          result[name] = field["value"]

  if not nodeConfig.isNil and nodeConfig.kind == JObject:
    for key, value in nodeConfig.pairs:
      if fieldTypes.hasKey(key):
        result[key] = valueToJson(valueFromJsonByType(value, fieldTypes[key]))
      else:
        result[key] = value

proc configFromSources(sources: JsonNode): JsonNode =
  if sources.isNil or sources.kind != JObject or not sources.hasKey("config.json"):
    return %*{}
  try:
    result = parseJson(sources["config.json"].getStr("{}"))
    if result.isNil or result.kind != JObject:
      return %*{}
  except CatchableError:
    return %*{}

proc initDynamicJsApp*(keyword: string, node: DiagramNode, scene: FrameScene, sources: JsonNode): AppRoot =
  let source = jsAppSourceFromSources(sources)
  if source.len == 0:
    raise newException(ValueError, "Missing JavaScript app source for keyword: " & keyword)
  let config = configFromSources(sources)
  let category = config{"category"}.getStr().toLowerAscii()
  let outputType = outputTypeFromConfig(config)
  let runtime = newJsAppRuntime(category, outputType, source)
  return DynamicJsApp(
    nodeId: node.id,
    nodeName: node.data{"name"}.getStr(keyword),
    scene: scene,
    frameConfig: scene.frameConfig,
    configJson: runtimeConfigFromNode(config, node.data{"config"}),
    runtime: runtime
  )

proc isDynamicJsApp*(app: AppRoot): bool =
  app of DynamicJsApp

proc setDynamicJsAppField*(app: AppRoot, field: string, value: Value) =
  let dynamicApp = DynamicJsApp(app)
  if dynamicApp.configJson.isNil or dynamicApp.configJson.kind != JObject:
    dynamicApp.configJson = %*{}
  let nextValue = dynamicApp.runtime.jsAppValueToJson(value)
  if dynamicApp.configJson.hasKey(field):
    dynamicApp.runtime.releaseReplacedImageRef(dynamicApp.configJson[field], nextValue)
  dynamicApp.configJson[field] = nextValue

proc ensureReady(runtime: JsAppRuntime) =
  if runtime.ready:
    return

  runtime.js = newQuickJS()
  runtime.js.registerFunction("jsAppLog", jsAppLog)
  runtime.js.registerFunction("jsSetNextSleep", jsSetNextSleep)
  runtime.js.registerFunction("jsSetState", jsSetState)
  runtime.js.registerFunction("jsFetchText", jsFetchText)
  discard runtime.js.eval("""
  "use strict";
  const __jsReplacer = (k, v) =>
    (typeof v === 'bigint') ? { __bigint: v.toString() } : v;
  const frameos = {
    image: (spec = {}) => ({ __frameosType: "image", ...spec }),
    svg: (svg, spec = {}) => ({ __frameosType: "image", svg, ...spec }),
    node: (nodeId) => ({ __frameosType: "node", nodeId }),
    scene: (sceneId) => ({ __frameosType: "scene", sceneId }),
    color: (color) => ({ __frameosType: "color", color }),
    log: (...args) => jsAppLog("log", JSON.stringify(args, __jsReplacer)),
    error: (...args) => jsAppLog("error", JSON.stringify(args, __jsReplacer)),
    setNextSleep: (seconds) => jsSetNextSleep(Number(seconds || 0)),
    fetchText: (url) => jsFetchText(String(url || "")),
    fetchJson: (url) => JSON.parse(jsFetchText(String(url || "")) || "null"),
    setState: (key, value) => jsSetState(
      String(key || ""),
      JSON.stringify(value === undefined ? null : value, __jsReplacer)
    ),
  };
  globalThis.__frameosModule = {};
  const exports = globalThis.__frameosModule;
  function __frameosWrapApp(app) {
    return Object.assign(app || {}, {
      log: (...args) => jsAppLog("log", JSON.stringify(args, __jsReplacer)),
      logError: (...args) => jsAppLog("error", JSON.stringify(args, __jsReplacer)),
    });
  }
  function __frameosExports() {
    if (globalThis.__frameosModule && globalThis.__frameosModule.default) {
      return globalThis.__frameosModule.default;
    }
    return globalThis.__frameosModule || {};
  }
  function __frameosInvoke(name) {
    try {
      const mod = __frameosExports();
      const fn = mod && mod[name];
      const value = typeof fn === "function"
        ? fn(globalThis.__frameosAppInstance, globalThis.__frameosContext)
        : undefined;
      return JSON.stringify({ ok: true, value }, __jsReplacer);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: {
          message: String(error && error.message || error),
          stack: String(error && error.stack || error),
        },
      }, __jsReplacer);
    }
  }
  """ & sceneJsPrelude)
  discard runtime.js.eval(transpileModuleSource(runtime.source, "<frameos:app:" & runtime.category & ":" & runtime.outputType & ">"))
  runtime.ready = true

proc buildAppJson(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode): JsonNode =
  result = %*{
    "nodeId": owner.nodeId.int,
    "nodeName": owner.nodeName,
    "category": runtime.category,
    "config": if configJson.isNil: %*{} else: configJson,
    "state": if owner.scene.state.isNil: %*{} else: owner.scene.state,
    "frame": {
      "width": owner.frameConfig.width,
      "height": owner.frameConfig.height,
      "rotate": owner.frameConfig.rotate,
      "assetsPath": owner.frameConfig.assetsPath,
      "timeZone": owner.frameConfig.timeZone,
    },
  }

proc buildContextJson(runtime: JsAppRuntime, context: ExecutionContext): JsonNode =
  result = %*{
    "event": context.event,
    "hasImage": context.hasImage,
    "payload": if context.payload.isNil: newJNull() else: context.payload,
    "loopIndex": context.loopIndex,
    "loopKey": context.loopKey,
    "nextSleep": context.nextSleep,
  }
  if context.hasImage and not context.image.isNil:
    result["image"] = runtime.storeTransientImageJson(context.image)
    result["imageWidth"] = %* context.image.width
    result["imageHeight"] = %* context.image.height

proc setCallGlobals(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext) =
  let appJson = buildAppJson(runtime, owner, configJson)
  let contextJson = buildContextJson(runtime, context)
  discard runtime.js.eval(
    "globalThis.__frameosAppInstance = __frameosWrapApp(Object.assign(globalThis.__frameosAppInstance || {}, " &
      $appJson & "));"
  )
  discard runtime.js.eval("globalThis.__frameosContext = " & $contextJson & ";")

proc defaultImageWidth(owner: AppRoot, context: ExecutionContext, spec: JsonNode): int =
  if spec.kind == JObject and spec.hasKey("width"):
    return valueFromJsonByType(spec["width"], "integer").asInt().int
  if context.hasImage and not context.image.isNil:
    return context.image.width
  return frameos_apps.renderWidth(owner.frameConfig)

proc defaultImageHeight(owner: AppRoot, context: ExecutionContext, spec: JsonNode): int =
  if spec.kind == JObject and spec.hasKey("height"):
    return valueFromJsonByType(spec["height"], "integer").asInt().int
  if context.hasImage and not context.image.isNil:
    return context.image.height
  return frameos_apps.renderHeight(owner.frameConfig)

proc colorWithOpacity(spec: JsonNode): Color =
  var color = parseHtmlColor(spec{"color"}.getStr("#000000"))
  let rawOpacity =
    if spec.hasKey("opacity") and spec["opacity"].kind != JNull:
      valueFromJsonByType(spec["opacity"], "float").asFloat()
    else:
      1.0
  let opacity = min(1.0, max(0.0, rawOpacity))
  color.a = opacity.float32
  return color

proc imageFromSpec(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, spec: JsonNode): Image =
  if spec.isNil or spec.kind == JNull:
    return nil

  if spec.kind == JString:
    let data = spec.getStr()
    if data.startsWith("data:"):
      return decodeDataUrl(data)
    if data.startsWith("<svg") or data.startsWith("<?xml") or data.contains("<svg"):
      let image = decodeSvgWithImageMagick(data, defaultImageWidth(owner, context, %*{}), defaultImageHeight(owner, context, %*{}))
      if image.isSome:
        return image.get()
    return decodeImageWithFallback(data)

  if spec.kind == JObject and spec{"type"}.getStr() == "image":
    let props = spec{"props"}
    if props.kind == JObject:
      var imageSpec = props
      imageSpec["__frameosType"] = %* "image"
      return imageFromSpec(runtime, owner, context, imageSpec)
    return nil

  let kind = spec{"__frameosType"}.getStr()
  case kind
  of "imageRef":
    let id = spec{"id"}.getInt()
    if runtime.images.hasKey(id):
      return runtime.images[id]
    return nil
  of "image":
    if spec.hasKey("svg"):
      let image = decodeSvgWithImageMagick(spec["svg"].getStr(), defaultImageWidth(owner, context, spec), defaultImageHeight(owner, context, spec))
      if image.isSome:
        return image.get()
      return nil
    if spec.hasKey("dataUrl"):
      return decodeDataUrl(spec["dataUrl"].getStr())
    if spec.hasKey("base64"):
      return decodeImageWithFallback(spec["base64"].getStr().decode())
    let width = max(1, defaultImageWidth(owner, context, spec))
    let height = max(1, defaultImageHeight(owner, context, spec))
    let image = newImage(width, height)
    if spec.hasKey("color"):
      image.fill(colorWithOpacity(spec))
    return image
  else:
    return nil

proc toValue(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, payload: JsonNode, expectedType: string): Value =
  if payload.isNil or payload.kind == JNull:
    if expectedType.len > 0:
      return valueFromJsonByType(newJNull(), expectedType)
    return VNone()

  if payload.kind == JObject and payload.hasKey("__frameosType"):
    case payload["__frameosType"].getStr()
    of "imageRef", "image":
      return VImage(imageFromSpec(runtime, owner, context, payload))
    of "node":
      return VNode(NodeId(payload{"nodeId"}.getInt()))
    of "scene":
      return VScene(SceneId(payload{"sceneId"}.getStr()))
    of "color":
      return VColor(parseHtmlColor(payload{"color"}.getStr("#000000")))
    else:
      discard

  if payload.kind == JObject and payload{"type"}.getStr() == "image":
    return VImage(imageFromSpec(runtime, owner, context, payload))

  if expectedType == "image":
    return VImage(imageFromSpec(runtime, owner, context, payload))
  if expectedType.len > 0:
    return valueFromJsonByType(payload, expectedType)

  case payload.kind
  of JString:
    return VString(payload.getStr())
  of JBool:
    return VBool(payload.getBool())
  of JInt:
    return VInt(payload.getInt())
  of JFloat:
    return VFloat(payload.getFloat())
  of JObject, JArray:
    return VJson(payload)
  else:
    return VNone()

proc invoke(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext, fnName: string): JsonNode =
  ensureReady(runtime)
  setCallGlobals(runtime, owner, configJson, context)
  jsAppEnvByCtx[runtime.js.context] = JsAppEvalEnv(runtime: runtime, owner: owner, context: context)
  let response =
    try:
      runtime.js.eval(&"""__frameosInvoke("{fnName}")""")
    finally:
      if jsAppEnvByCtx.hasKey(runtime.js.context):
        jsAppEnvByCtx.del(runtime.js.context)

  let parsed = parseJson(response)
  if not parsed{"ok"}.getBool():
    frameos_apps.logError(owner, &"JS app {fnName} failed: " & parsed{"error"}{"message"}.getStr())
    if parsed{"error"}{"stack"}.getStr().len > 0:
      frameos_apps.log(owner, %*{
        "event": "jsApp:error",
        "nodeId": owner.nodeId.int,
        "nodeName": owner.nodeName,
        "stack": parsed{"error"}{"stack"}.getStr()
      })
    return newJNull()
  return parsed{"value"}

proc init*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode) =
  if runtime.initialized:
    return
  let context = ExecutionContext(
    scene: owner.scene,
    event: "init",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )
  discard runtime.invoke(owner, configJson, context, "init")
  runtime.initialized = true

proc get*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext): Value =
  runtime.init(owner, configJson)
  try:
    let payload = runtime.invoke(owner, configJson, context, "get")
    return toValue(runtime, owner, context, payload, runtime.outputType)
  finally:
    runtime.clearTransientImages()

proc run*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext) =
  runtime.init(owner, configJson)
  try:
    let payload = runtime.invoke(owner, configJson, context, "run")
    if runtime.category == "render":
      let value = toValue(runtime, owner, context, payload, "image")
      if value.kind == fkImage and not value.asImage().isNil:
        context.image.draw(value.asImage())
  finally:
    runtime.clearTransientImages()

proc getDynamicJsApp*(app: AppRoot, context: ExecutionContext): Value =
  let dynamicApp = DynamicJsApp(app)
  dynamicApp.runtime.get(dynamicApp, dynamicApp.configJson, context)

proc runDynamicJsApp*(app: AppRoot, context: ExecutionContext) =
  let dynamicApp = DynamicJsApp(app)
  dynamicApp.runtime.run(dynamicApp, dynamicApp.configJson, context)

proc getDynamicJsAppField*(app: AppRoot, field: string, fieldType: string): Value =
  let dynamicApp = DynamicJsApp(app)
  if dynamicApp.configJson.isNil or dynamicApp.configJson.kind != JObject:
    return valueFromJsonByType(newJNull(), fieldType)
  if not dynamicApp.configJson.hasKey(field):
    return valueFromJsonByType(newJNull(), fieldType)
  let context = ExecutionContext(
    scene: dynamicApp.scene,
    event: "field",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )
  dynamicApp.runtime.toValue(dynamicApp, context, dynamicApp.configJson[field], fieldType)
