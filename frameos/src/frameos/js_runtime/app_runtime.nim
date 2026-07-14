import std/[algorithm, base64, json, options, os, streams, strformat, strutils, tables]
import pixie

import frameos/apps as frameos_apps
import frameos/js_runtime/runtime
import frameos/types
import frameos/values
import frameos/utils/http_client
import frameos/utils/image
import frameos/utils/system
import frameos/js_runtime/burrito

type
  JsAppRuntime* = ref object
    category*: string
    outputType*: string
    source*: string
    settingsKeys*: seq[string]
    js*: QuickJS
    ready*: bool
    initialized*: bool
    nextImageId*: int
    images*: Table[int, Image]
    transientImageIds: seq[int]

  JsAppEvalEnv = ref object
    runtime: JsAppRuntime
    owner: AppRoot
    configJson: JsonNode
    context: ExecutionContext
    contextImageJson: JsonNode

var jsAppEnvByCtx = initTable[ptr JSContext, JsAppEvalEnv]()

proc jsFetchMaxBytes(e: JsAppEvalEnv): int =
  if e != nil:
    frameos_apps.maxHttpResponseBytes(e.owner)
  else:
    DefaultMaxHttpResponseBytes

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
    return nimStringToJS(ctx, boundedGetContent(urlStr, maxBytes = jsFetchMaxBytes(e)))
  except CatchableError as err:
    if e != nil:
      frameos_apps.logError(e.owner, "JS app fetchText failed: " & err.msg)
    return nimStringToJS(ctx, "")

proc storeTransientImageJson(runtime: JsAppRuntime, image: Image): JsonNode

const JsHttpMaxTimeoutMs = 600_000

proc jsHttpRequest(ctx: ptr JSContext, url: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Bounded HTTP request with method/headers/body. Options JSON:
  ## {method, headers: {name: value}, body, bodyBase64, base64 (return body
  ## base64-encoded, required for binary responses), timeoutMs}.
  ## Returns JSON: {status, body | bodyBase64} or {status: 0, error}.
  let e = env(ctx)
  var response = %*{"status": 0}

  let urlStr = toNimString(ctx, url)
  var options = %*{}
  try:
    options = parseJson(toNimString(ctx, optionsJson))
  except CatchableError:
    discard
  if options.isNil or options.kind != JObject:
    options = %*{}

  try:
    var body = options{"body"}.getStr("")
    if options{"bodyBase64"}.getStr("").len > 0:
      body = decode(options["bodyBase64"].getStr())
    var headers: seq[SimpleHttpHeader] = @[]
    let headersNode = options{"headers"}
    if not headersNode.isNil and headersNode.kind == JObject:
      for name, value in headersNode.pairs:
        headers.add((name, value.getStr($value)))
    let timeoutMs = clamp(options{"timeoutMs"}.getInt(DefaultFetchTimeoutMs), 1000, JsHttpMaxTimeoutMs)
    let maxSeconds = max(DefaultFetchMaxSeconds, timeoutMs.float / 1000.0 + 30.0)
    let res = boundedRequestWithHeaders(
      urlStr,
      httpMethod = options{"method"}.getStr("GET").toUpperAscii(),
      body = body,
      headers = headers,
      timeoutMs = timeoutMs,
      maxBytes = jsFetchMaxBytes(e),
      maxSeconds = maxSeconds
    )
    response["status"] = %*res.code
    if options{"base64"}.getBool(false):
      response["bodyBase64"] = %*encode(res.body)
    else:
      response["body"] = %*res.body
  except CatchableError as err:
    response["error"] = %*err.msg
    if e != nil:
      frameos_apps.logError(e.owner, "JS app httpRequest failed: " & err.msg)
  return nimStringToJS(ctx, $response)

proc assetsRoot(e: JsAppEvalEnv): string =
  result = if e.owner.frameConfig.assetsPath == "": "/srv/assets" else: e.owner.frameConfig.assetsPath
  result.removeSuffix('/')

proc resolveAssetPath(e: JsAppEvalEnv, relPath: string): string =
  ## Absolute path inside the assets folder, or "" when the path is empty,
  ## absolute, or escapes the folder.
  if relPath.len == 0 or relPath.startsWith("/") or relPath.contains(".."):
    return ""
  let root = assetsRoot(e)
  let full = normalizedPath(root / relPath)
  if full == root or full.startsWith(root & "/"):
    return full
  return ""

const EmbeddedAssetReadMaxBytes = 2 * 1024 * 1024

proc jsAssetReadMaxBytes(e: JsAppEvalEnv): int =
  ## Full-buffer asset reads triple in RAM (bytes + base64 + JS string), so
  ## embedded targets get a small cap; larger files must use ranged reads.
  when defined(frameosEmbedded):
    min(jsFetchMaxBytes(e), EmbeddedAssetReadMaxBytes)
  else:
    jsFetchMaxBytes(e)

proc writeAssetFile(e: JsAppEvalEnv, opName: string, pathStr: string,
    contents: string, append: bool): bool =
  let full = resolveAssetPath(e, pathStr)
  if full.len == 0:
    frameos_apps.logError(e.owner, "JS app " & opName & ": invalid asset path: " & pathStr)
    return false
  createDir(full.parentDir())
  let freeDiskSpace = getAvailableDiskSpace(full.parentDir())
  if freeDiskSpace != -1 and freeDiskSpace < 100 * 1024 * 1024:
    frameos_apps.logError(e.owner, "JS app " & opName & ": low disk space, asset not saved: " & pathStr)
    return false
  if append:
    var file: File
    if not file.open(full, fmAppend):
      frameos_apps.logError(e.owner, "JS app " & opName & ": cannot open asset: " & pathStr)
      return false
    defer: file.close()
    file.write(contents)
  else:
    writeFile(full, contents)
  return true

proc jsAssets(ctx: ptr JSContext, op: JSValue, path: JSValue, data: JSValue): JSValue {.nimcall.} =
  ## Asset management scoped to the frame's assets folder. Ops:
  ## list (dir -> JSON array of relative paths), exists, size,
  ## read (options JSON {offset, length} -> base64), write/append (path, base64),
  ## delete, image (-> imageRef decoded within display bounds).
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let opStr = toNimString(ctx, op)
  let pathStr = toNimString(ctx, path)

  try:
    case opStr
    of "list":
      let root = assetsRoot(e)
      let dir = if pathStr.len == 0: root else: resolveAssetPath(e, pathStr)
      var files: seq[string] = @[]
      if dir.len > 0 and dirExists(dir):
        for filePath in walkDirRec(dir, relative = false):
          if "/.thumbs/" in filePath or "/.frameos/" in filePath:
            continue
          files.add(filePath[(root.len + 1)..^1])
      files.sort()
      let arr = newJArray()
      for file in files:
        arr.add(%*file)
      return jsonToJS(ctx, arr)
    of "exists":
      let full = resolveAssetPath(e, pathStr)
      return nimBoolToJS(ctx, full.len > 0 and fileExists(full))
    of "size":
      let full = resolveAssetPath(e, pathStr)
      if full.len == 0 or not fileExists(full):
        return nimIntToJS(ctx, -1)
      return nimFloatToJS(ctx, getFileSize(full).float)
    of "read":
      let full = resolveAssetPath(e, pathStr)
      if full.len == 0 or not fileExists(full):
        return jsNull(ctx)
      var options = %*{}
      let optionsStr = toNimString(ctx, data)
      if optionsStr.len > 0:
        try:
          options = parseJson(optionsStr)
        except CatchableError:
          discard
      if options.isNil or options.kind != JObject:
        options = %*{}
      let fileSize = getFileSize(full)
      let offset = max(0, options{"offset"}.getInt(0))
      let readMax = jsAssetReadMaxBytes(e)
      var length = options{"length"}.getInt(int(fileSize) - offset)
      length = min(length, int(fileSize) - offset)
      if length <= 0:
        return nimStringToJS(ctx, "")
      if length > readMax:
        frameos_apps.logError(e.owner,
          "JS app readAsset: " & pathStr & " slice is " & $length &
          " bytes, over the " & $readMax & " byte limit; read it in chunks" &
          " with {offset, length}")
        return jsNull(ctx)
      var file: File
      if not file.open(full):
        return jsNull(ctx)
      defer: file.close()
      file.setFilePos(offset)
      var contents = newString(length)
      let bytesRead = file.readBuffer(addr contents[0], length)
      contents.setLen(bytesRead)
      return nimStringToJS(ctx, encode(contents))
    of "write", "append":
      let contents = decode(toNimString(ctx, data))
      return nimBoolToJS(ctx, writeAssetFile(e, opStr & "Asset", pathStr, contents, opStr == "append"))
    of "delete":
      let full = resolveAssetPath(e, pathStr)
      if full.len == 0 or not fileExists(full):
        return nimBoolToJS(ctx, false)
      removeFile(full)
      return nimBoolToJS(ctx, true)
    of "image":
      let full = resolveAssetPath(e, pathStr)
      if full.len == 0 or not fileExists(full):
        return jsNull(ctx)
      let image = readImageWithDisplayBounds(full)
      if image.isNil:
        return jsNull(ctx)
      return jsonToJS(ctx, e.runtime.storeTransientImageJson(image))
    else:
      frameos_apps.logError(e.owner, "JS app assets: unknown operation: " & opStr)
      return jsUndefSentinel(ctx)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app assets " & opStr & " failed: " & err.msg)
    if opStr in ["write", "append", "delete", "exists"]:
      return nimBoolToJS(ctx, false)
    return jsNull(ctx)

## Streams let apps pass around and process data bigger than memory allows in
## one piece: a data app can return a streamRef (it travels between nodes as
## plain JSON), and the consumer reads it chunk by chunk. Backed by simple
## string streams or files inside the assets folder. The registry is global so
## refs resolve across app runtimes; it is capped, evicting (and closing) the
## oldest stream, so forgotten handles cannot pile up.
const MaxOpenJsStreams = 64
const DefaultJsStreamChunkBytes = 65536

var jsStreamsGlobal = initOrderedTable[int, Stream]()
var jsNextStreamId = 0

proc registerJsStream(stream: Stream): JsonNode =
  while jsStreamsGlobal.len >= MaxOpenJsStreams:
    for id in jsStreamsGlobal.keys:
      try:
        jsStreamsGlobal[id].close()
      except CatchableError:
        discard
      jsStreamsGlobal.del(id)
      break
  inc jsNextStreamId
  jsStreamsGlobal[jsNextStreamId] = stream
  return %*{"__frameosType": "streamRef", "id": jsNextStreamId}

proc jsStreamById(options: JsonNode): Stream =
  let id = options{"id"}.getInt(0)
  if id != 0 and jsStreamsGlobal.hasKey(id):
    return jsStreamsGlobal[id]
  return nil

proc jsStreams(ctx: ptr JSContext, op: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Ops: openAsset {path, mode: r|w|a} -> streamRef, create {base64} -> streamRef,
  ## read {id, length} -> base64 ("" at end), write {id, base64}, atEnd {id},
  ## close {id}. Read sizes are capped like readAsset; loop for more.
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let opStr = toNimString(ctx, op)
  var options = %*{}
  try:
    options = parseJson(toNimString(ctx, optionsJson))
  except CatchableError:
    discard
  if options.isNil or options.kind != JObject:
    options = %*{}

  try:
    case opStr
    of "openAsset":
      let pathStr = options{"path"}.getStr("")
      let mode = options{"mode"}.getStr("r")
      let full = resolveAssetPath(e, pathStr)
      if full.len == 0:
        frameos_apps.logError(e.owner, "JS app openAssetStream: invalid asset path: " & pathStr)
        return jsNull(ctx)
      if mode == "r":
        if not fileExists(full):
          return jsNull(ctx)
        let stream = newFileStream(full, fmRead)
        if stream.isNil:
          return jsNull(ctx)
        return jsonToJS(ctx, registerJsStream(stream))
      elif mode in ["w", "a"]:
        createDir(full.parentDir())
        let freeDiskSpace = getAvailableDiskSpace(full.parentDir())
        if freeDiskSpace != -1 and freeDiskSpace < 100 * 1024 * 1024:
          frameos_apps.logError(e.owner, "JS app openAssetStream: low disk space: " & pathStr)
          return jsNull(ctx)
        let stream = newFileStream(full, if mode == "a": fmAppend else: fmWrite)
        if stream.isNil:
          return jsNull(ctx)
        return jsonToJS(ctx, registerJsStream(stream))
      else:
        frameos_apps.logError(e.owner, "JS app openAssetStream: unknown mode: " & mode)
        return jsNull(ctx)
    of "create":
      var contents = ""
      if options{"base64"}.getStr("").len > 0:
        contents = decode(options["base64"].getStr())
      return jsonToJS(ctx, registerJsStream(newStringStream(contents)))
    of "read":
      let stream = jsStreamById(options)
      if stream.isNil:
        return jsNull(ctx)
      let length = clamp(options{"length"}.getInt(DefaultJsStreamChunkBytes), 1, jsAssetReadMaxBytes(e))
      return nimStringToJS(ctx, encode(stream.readStr(length)))
    of "write":
      let stream = jsStreamById(options)
      if stream.isNil:
        return nimBoolToJS(ctx, false)
      stream.write(decode(options{"base64"}.getStr("")))
      return nimBoolToJS(ctx, true)
    of "atEnd":
      let stream = jsStreamById(options)
      if stream.isNil:
        return nimBoolToJS(ctx, true)
      return nimBoolToJS(ctx, stream.atEnd())
    of "rewind":
      let stream = jsStreamById(options)
      if stream.isNil:
        return nimBoolToJS(ctx, false)
      stream.setPosition(0)
      return nimBoolToJS(ctx, true)
    of "close":
      let id = options{"id"}.getInt(0)
      if id == 0 or not jsStreamsGlobal.hasKey(id):
        return nimBoolToJS(ctx, false)
      try:
        jsStreamsGlobal[id].close()
      finally:
        jsStreamsGlobal.del(id)
      return nimBoolToJS(ctx, true)
    else:
      frameos_apps.logError(e.owner, "JS app streams: unknown operation: " & opStr)
      return jsUndefSentinel(ctx)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app streams " & opStr & " failed: " & err.msg)
    if opStr in ["write", "close", "rewind", "atEnd"]:
      return nimBoolToJS(ctx, false)
    return jsNull(ctx)

proc jsGetSetting(ctx: ptr JSContext, pathJson: JSValue): JSValue {.nimcall.} =
  ## Read a value from frameConfig.settings, e.g. getSetting("openAI", "apiKey").
  ## Only namespaces the app declares in its config.json "settings" list are
  ## accessible; the declaration travels with the scene so access is auditable.
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  var path: JsonNode
  try:
    path = parseJson(toNimString(ctx, pathJson))
  except CatchableError:
    return jsUndefSentinel(ctx)
  if path.isNil or path.kind != JArray or path.len == 0:
    return jsUndefSentinel(ctx)

  let namespace = path[0].getStr()
  if namespace.len == 0 or namespace notin e.runtime.settingsKeys:
    frameos_apps.logError(e.owner,
      "JS app getSetting: settings namespace \"" & namespace &
      "\" is not declared in the app config's \"settings\" list")
    return jsUndefSentinel(ctx)

  frameos_apps.ensureEmbeddedServiceSettings(e.owner)
  var node = e.owner.frameConfig.settings
  for part in path.items:
    if node.isNil:
      return jsUndefSentinel(ctx)
    node = node{part.getStr()}
  if node.isNil:
    return jsUndefSentinel(ctx)
  return jsonToJS(ctx, node)

proc jsGetAppMeta(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  case toNimString(ctx, key)
  of "nodeId":
    return nimIntToJS(ctx, e.owner.nodeId.int32)
  of "nodeName":
    return nimStringToJS(ctx, e.owner.nodeName)
  of "category":
    return nimStringToJS(ctx, e.runtime.category)
  else:
    return jsUndefSentinel(ctx)

proc jsGetAppConfig(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)
  let configJson = if e.configJson.isNil: %*{} else: e.configJson
  let keyStr = toNimString(ctx, key)
  if configJson.kind == JObject and configJson.hasKey(keyStr):
    return jsonToJS(ctx, configJson[keyStr])
  return jsUndefSentinel(ctx)

proc jsGetAppState(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)
  let state = e.owner.scene.state
  let keyStr = toNimString(ctx, key)
  if not state.isNil and state.kind == JObject and state.hasKey(keyStr):
    return jsonToJS(ctx, state[keyStr])
  return jsUndefSentinel(ctx)

proc jsGetAppFrame(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  case toNimString(ctx, key)
  of "width":
    return nimIntToJS(ctx, e.owner.frameConfig.width.int32)
  of "height":
    return nimIntToJS(ctx, e.owner.frameConfig.height.int32)
  of "rotate":
    return nimIntToJS(ctx, e.owner.frameConfig.rotate.int32)
  of "assetsPath":
    return nimStringToJS(ctx, e.owner.frameConfig.assetsPath)
  of "timeZone":
    return nimStringToJS(ctx, e.owner.frameConfig.timeZone)
  else:
    return jsUndefSentinel(ctx)

proc jsGetAppContext(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  case toNimString(ctx, key)
  of "event":
    return nimStringToJS(ctx, e.context.event)
  of "hasImage":
    return nimBoolToJS(ctx, e.context.hasImage)
  of "payload":
    if e.context.payload.isNil:
      return jsNull(ctx)
    return jsonToJS(ctx, e.context.payload)
  of "loopIndex":
    return nimIntToJS(ctx, e.context.loopIndex.int32)
  of "loopKey":
    return nimStringToJS(ctx, e.context.loopKey)
  of "nextSleep":
    return nimFloatToJS(ctx, e.context.nextSleep)
  of "image":
    if e.context.hasImage and not e.context.image.isNil:
      if e.contextImageJson.isNil:
        e.contextImageJson = e.runtime.storeTransientImageJson(e.context.image)
      return jsonToJS(ctx, e.contextImageJson)
    return jsUndefSentinel(ctx)
  of "imageWidth":
    if e.context.hasImage and not e.context.image.isNil:
      return nimIntToJS(ctx, e.context.image.width.int32)
    return jsUndefSentinel(ctx)
  of "imageHeight":
    if e.context.hasImage and not e.context.image.isNil:
      return nimIntToJS(ctx, e.context.image.height.int32)
    return jsUndefSentinel(ctx)
  else:
    return jsUndefSentinel(ctx)

proc jsGetAppKeys(ctx: ptr JSContext, scope: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsonToJS(ctx, %*[])

  var keys: seq[string] = @[]
  case toNimString(ctx, scope)
  of "config":
    let configJson = if e.configJson.isNil: %*{} else: e.configJson
    if configJson.kind == JObject:
      for key in configJson.keys:
        keys.add(key)
  of "state":
    let state = e.owner.scene.state
    if not state.isNil and state.kind == JObject:
      for key in state.keys:
        keys.add(key)
  of "frame":
    keys = @["width", "height", "rotate", "assetsPath", "timeZone"]
  of "context":
    keys = @["event", "hasImage", "payload", "loopIndex", "loopKey", "nextSleep"]
    if e.context.hasImage and not e.context.image.isNil:
      keys.add("image")
      keys.add("imageWidth")
      keys.add("imageHeight")
  else:
    discard

  let arr = newJArray()
  for key in keys:
    arr.add(%*key)
  return jsonToJS(ctx, arr)

proc newJsAppRuntime*(category: string, outputType: string, source: string,
    settingsKeys: seq[string] = @[]): JsAppRuntime =
  return JsAppRuntime(
    category: category,
    outputType: outputType,
    source: source,
    settingsKeys: settingsKeys,
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
  var settingsKeys: seq[string] = @[]
  let settingsNode = config{"settings"}
  if not settingsNode.isNil and settingsNode.kind == JArray:
    for key in settingsNode.items:
      if key.kind == JString and key.getStr().len > 0:
        settingsKeys.add(key.getStr())
  let runtime = newJsAppRuntime(category, outputType, source, settingsKeys)
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
  runtime.js.registerFunction("jsHttpRequest", jsHttpRequest)
  runtime.js.registerFunction("jsAssets", jsAssets)
  runtime.js.registerFunction("jsStreams", jsStreams)
  runtime.js.registerFunction("jsGetSetting", jsGetSetting)
  runtime.js.registerFunction("jsGetAppMeta", jsGetAppMeta)
  runtime.js.registerFunction("jsGetAppConfig", jsGetAppConfig)
  runtime.js.registerFunction("jsGetAppState", jsGetAppState)
  runtime.js.registerFunction("jsGetAppFrame", jsGetAppFrame)
  runtime.js.registerFunction("jsGetAppContext", jsGetAppContext)
  runtime.js.registerFunction("jsGetAppKeys", jsGetAppKeys)
  discard runtime.js.eval("""
  "use strict";
  const __jsReplacer = (k, v) =>
    (typeof v === 'bigint') ? { __bigint: v.toString() } : v;
  globalThis.__frameosStringify = (v) => JSON.stringify(v, __jsReplacer);
  const __frameosUnwrap = (v) => (v && v.__frameosUndef === true) ? undefined : v;
  const __frameosProxy = (scope, getter) => new Proxy({}, {
    get(_, k) { return (typeof k === "string") ? __frameosUnwrap(getter(k)) : undefined; },
    has(_, k) { return typeof k === "string" && jsGetAppKeys(scope).includes(k); },
    ownKeys() { return jsGetAppKeys(scope); },
    getOwnPropertyDescriptor(_, k) {
      return (typeof k === "string" && jsGetAppKeys(scope).includes(k))
        ? { enumerable: true, configurable: true }
        : undefined;
    },
  });
  const __frameosAppConfig = __frameosProxy("config", jsGetAppConfig);
  const __frameosAppState = __frameosProxy("state", jsGetAppState);
  const __frameosAppFrame = __frameosProxy("frame", jsGetAppFrame);
  globalThis.__frameosContext = __frameosProxy("context", jsGetAppContext);
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
    httpRequest: (url, options) => JSON.parse(
      jsHttpRequest(String(url || ""), JSON.stringify(options || {}, __jsReplacer)) || "{}"
    ),
    listAssets: (dir) => __frameosUnwrap(jsAssets("list", String(dir || ""), "")) || [],
    assetExists: (path) => __frameosUnwrap(jsAssets("exists", String(path || ""), "")) === true,
    assetSize: (path) => __frameosUnwrap(jsAssets("size", String(path || ""), "")) ?? -1,
    readAsset: (path, options) => __frameosUnwrap(jsAssets(
      "read", String(path || ""), options ? JSON.stringify(options) : ""
    )) ?? null,
    writeAsset: (path, base64) => __frameosUnwrap(jsAssets("write", String(path || ""), String(base64 || ""))) === true,
    appendAsset: (path, base64) => __frameosUnwrap(jsAssets("append", String(path || ""), String(base64 || ""))) === true,
    deleteAsset: (path) => __frameosUnwrap(jsAssets("delete", String(path || ""), "")) === true,
    loadAssetImage: (path) => __frameosUnwrap(jsAssets("image", String(path || ""), "")) ?? null,
    openAssetStream: (path, mode) => __frameosUnwrap(jsStreams("openAsset",
      JSON.stringify({ path: String(path || ""), mode: String(mode || "r") }))) ?? null,
    createStream: (base64) => __frameosUnwrap(jsStreams("create",
      JSON.stringify({ base64: String(base64 || "") }))) ?? null,
    streamRead: (ref, length) => __frameosUnwrap(jsStreams("read",
      JSON.stringify({ id: (ref && ref.id) || ref, length }))) ?? null,
    streamWrite: (ref, base64) => __frameosUnwrap(jsStreams("write",
      JSON.stringify({ id: (ref && ref.id) || ref, base64: String(base64 || "") }))) === true,
    streamAtEnd: (ref) => __frameosUnwrap(jsStreams("atEnd",
      JSON.stringify({ id: (ref && ref.id) || ref }))) === true,
    streamRewind: (ref) => __frameosUnwrap(jsStreams("rewind",
      JSON.stringify({ id: (ref && ref.id) || ref }))) === true,
    streamClose: (ref) => __frameosUnwrap(jsStreams("close",
      JSON.stringify({ id: (ref && ref.id) || ref }))) === true,
    getSetting: (...path) => __frameosUnwrap(jsGetSetting(
      JSON.stringify(path.flat().map((p) => String(p)))
    )),
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
  globalThis.__frameosAppInstance = __frameosWrapApp({
    get nodeId() { return __frameosUnwrap(jsGetAppMeta("nodeId")); },
    get nodeName() { return __frameosUnwrap(jsGetAppMeta("nodeName")); },
    get category() { return __frameosUnwrap(jsGetAppMeta("category")); },
    config: __frameosAppConfig,
    state: __frameosAppState,
    frame: __frameosAppFrame,
  });
  function __frameosExports() {
    if (globalThis.__frameosModule && globalThis.__frameosModule.default) {
      return globalThis.__frameosModule.default;
    }
    return globalThis.__frameosModule || {};
  }
  function __frameosInvoke(name) {
    const mod = __frameosExports();
    const fn = mod && mod[name];
    return typeof fn === "function"
      ? fn(globalThis.__frameosAppInstance, globalThis.__frameosContext)
      : undefined;
  }
  """ & sceneJsPrelude)
  let filename = "<frameos:app:" & runtime.category & ":" & runtime.outputType & ">"
  let transformed = transpileModuleSourceWithMap(runtime.source, filename)
  try:
    discard runtime.js.eval(transformed.code, filename)
  except CatchableError as error:
    raise newException(JSException, error.msg.mapJsErrorText(transformed.sourceMap))
  registerJsSourceMap(runtime.js.context, transformed.sourceMap)
  runtime.ready = true

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
    var data = spec.getStr()
    if data.startsWith("data:"):
      return decodeDataUrl(data)
    if data.startsWith("<svg") or data.startsWith("<?xml") or data.contains("<svg"):
      let image = decodeSvgWithFallback(data, defaultImageWidth(owner, context, %*{}), defaultImageHeight(owner, context, %*{}))
      if image.isSome:
        return image.get()
      # SVG has no dimensions probe; keep the unbounded fallback for it.
      return decodeImageWithFallback(data)
    return decodeImageWithDisplayBounds(data)

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
      let image = decodeSvgWithFallback(spec["svg"].getStr(), defaultImageWidth(owner, context, spec), defaultImageHeight(owner, context, spec))
      if image.isSome:
        return image.get()
      return nil
    if spec.hasKey("dataUrl"):
      return decodeDataUrl(spec["dataUrl"].getStr())
    if spec.hasKey("base64"):
      var decoded = spec["base64"].getStr().decode()
      # SVG has no dimensions probe; everything else decodes bounded.
      if decoded.len > 5 and (decoded.startsWith("<?xml") or decoded.startsWith("<svg")):
        return decodeImageWithFallback(decoded)
      return decodeImageWithDisplayBounds(decoded)
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

proc toValue(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, payload: JSValueConst, expectedType: string): Value =
  let ctx = runtime.js.context

  if jsIsUndefined(payload) or jsIsNull(payload):
    if expectedType.len > 0:
      return valueFromJsonByType(newJNull(), expectedType)
    return VNone()

  if expectedType == "image" or jsIsObject(payload) or JS_IsArray(ctx, payload) != 0:
    return runtime.toValue(owner, context, jsValueToJson(ctx, payload), expectedType)

  if expectedType.len > 0:
    if expectedType in ["string", "text"]:
      return VString(toNimString(ctx, payload))
    return valueFromJsonByType(jsValueToJson(ctx, payload), expectedType)

  if jsIsString(payload):
    return VString(toNimString(ctx, payload))
  if jsIsBool(payload):
    return VBool(toNimBool(ctx, payload))
  if jsIsNumber(payload):
    let f = toNimFloat(ctx, payload)
    if f >= low(int64).float64 and f <= high(int64).float64:
      let i = f.int64
      if i.float64 == f:
        return VInt(i)
    return VFloat(f)
  if jsIsBigInt(ctx, payload):
    try:
      return VInt(toNimInt64Ext(ctx, payload))
    except CatchableError:
      return VString(toNimString(ctx, payload))

  runtime.toValue(owner, context, jsValueToJson(ctx, payload), expectedType)

proc invoke(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext, fnName: string): JSValue =
  ensureReady(runtime)
  let ctx = runtime.js.context
  let fnNameValue = nimStringToJS(ctx, fnName)
  defer: JS_FreeValue(ctx, fnNameValue)

  jsAppEnvByCtx[ctx] = JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)
  result =
    try:
      callGlobalFunction(ctx, "__frameosInvoke", [fnNameValue])
    finally:
      if jsAppEnvByCtx.hasKey(ctx):
        jsAppEnvByCtx.del(ctx)

  if JS_IsException(result) != 0:
    let details = mappedJsExceptionDetails(ctx)
    frameos_apps.logError(owner, &"JS app {fnName} failed: " & details.message)
    if details.stack.len > 0:
      frameos_apps.log(owner, %*{
        "event": "jsApp:error",
        "nodeId": owner.nodeId.int,
        "nodeName": owner.nodeName,
        "stack": details.stack
      })
    JS_FreeValue(ctx, result)
    return jsNull(ctx)

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
  let payload = runtime.invoke(owner, configJson, context, "init")
  JS_FreeValue(runtime.js.context, payload)
  runtime.initialized = true

proc get*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext): Value =
  runtime.init(owner, configJson)
  try:
    let payload = runtime.invoke(owner, configJson, context, "get")
    defer: JS_FreeValue(runtime.js.context, payload)
    return toValue(runtime, owner, context, payload, runtime.outputType)
  finally:
    runtime.clearTransientImages()

proc run*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext) =
  runtime.init(owner, configJson)
  try:
    let payload = runtime.invoke(owner, configJson, context, "run")
    defer: JS_FreeValue(runtime.js.context, payload)
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
