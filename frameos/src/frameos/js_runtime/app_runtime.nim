import std/[algorithm, base64, json, options, os, streams, strformat, strutils, tables]
import frameos/utils/memory
import pixie

import frameos/apps as frameos_apps
import frameos/js_runtime/runtime
import frameos/types
import frameos/values
import frameos/utils/http_client
import frameos/utils/app_images
import frameos/utils/image
import frameos/utils/paths
import frameos/utils/system
import frameos/js_runtime/burrito

type
  JsAppRuntime* = ref object
    category*: string
    outputType*: string
    source*: string
    ## The main module's file name (app.ts, app.tsx, ...). Imports resolve
    ## relative to it, and error locations name it.
    sourceName*: string
    ## Every file of the app by name, as the scene JSON carries it — the pool
    ## `import './x'` draws from. Held as the JsonNode rather than copied out:
    ## on a frame the scene keeps these strings alive anyway, and a second
    ## copy of every helper file is memory an ESP32 does not have.
    sources*: JsonNode
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
## The runtime behind each live interpreter, for the module loader: QuickJS
## hands the loader a context, and the app's files live on the runtime.
var jsAppRuntimeByCtx = initTable[ptr JSContext, JsAppRuntime]()

proc teardownJsRuntime(runtime: JsAppRuntime) =
  ## Close one JS app node's interpreter. Not embedded-only: JsAppRuntime has
  ## no destructor, so a runtime that merely goes out of scope leaks its whole
  ## QuickJS on every platform.
  if runtime.isNil or not runtime.ready:
    return
  if not runtime.js.context.isNil:
    if jsAppEnvByCtx.hasKey(runtime.js.context):
      jsAppEnvByCtx.del(runtime.js.context)
    if jsAppRuntimeByCtx.hasKey(runtime.js.context):
      jsAppRuntimeByCtx.del(runtime.js.context)
    clearJsSourceMaps(runtime.js.context)
  runtime.js.close()
  runtime.ready = false
  runtime.initialized = false
  runtime.images.clear()
  runtime.transientImageIds.setLen(0)

when defined(frameosEmbedded):
  # Every JS app node builds its own QuickJS runtime, and each one costs about
  # 580 KB of PSRAM: ~151 KB for the runtime itself, the rest for the prelude
  # and the compiled app source. A scene with four JS nodes — the bundled
  # Weather scene has three weatherPanels and a weatherIcons — therefore holds
  # ~2.3 MB of interpreter that only one node is ever using, on a board whose
  # whole render budget is 3.4 MB. Measured with -d:memProbe; it was the
  # single largest term in the Weather OOM, larger than the canvas.
  #
  # Nodes run one at a time, so under memory pressure we keep one live runtime
  # and rebuild the others on demand. Rebuilding re-runs the app's init(), so
  # this only happens when headroom is actually short: a Pi, the backend and a
  # roomy frame never evict and keep today's behaviour exactly.
  var liveJsRuntimes: seq[JsAppRuntime] = @[]
  var jsRuntimeStack: seq[JsAppRuntime] = @[]
  const JsEvictHeadroomBytes = 2 * 1024 * 1024

  proc evictIdleJsRuntimes(keep: JsAppRuntime) =
    let headroom = availableRenderBytes()
    if headroom <= 0 or headroom >= JsEvictHeadroomBytes:
      return
    for other in liveJsRuntimes:
      if other != keep and other.ready and not jsRuntimeStack.contains(other):
        teardownJsRuntime(other)

proc releaseIdleJsAppRuntimes*() =
  ## Drop every JS app interpreter that is not mid-call. Called when a render
  ## finishes.
  ##
  ## Eviction otherwise only ever runs from ensureReady — that is, when ANOTHER
  ## JS node is about to be built. Nothing on the image path triggers it, so a
  ## decode could be refused for want of memory that was sitting in idle
  ## interpreters the whole time, and a frame that sleeps for five minutes
  ## between renders sleeps holding all of them.
  ##
  ## Cheap to undo: rebuilding re-parses and re-evaluates the module, which
  ## is a few milliseconds even for the bundled 36 KB Weather app now that
  ## QuickJS parses the TypeScript itself.
  when defined(frameosEmbedded):
    for runtime in liveJsRuntimes:
      if runtime.ready and not jsRuntimeStack.contains(runtime):
        teardownJsRuntime(runtime)

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
  ## The sandbox root for this app's asset calls.
  ##
  ## Default is the frame-wide assets folder: uploaded images are a shared
  ## resource and scenes are expected to read each other's, so per-scene
  ## isolation would break the common case. Frames that would rather have the
  ## stricter model — every scene confined to its own subtree, the posture
  ## cloud/docs/cloud-frames.md describes for provider-installed scenes — set
  ## `js.assetSandbox` to "scene" in frame.json.
  let frameConfig = e.owner.frameConfig
  result = if frameConfig == nil or frameConfig.assetsPath == "": "/srv/assets"
           else: frameConfig.assetsPath
  result.removeSuffix('/')
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.assetSandbox == "scene":
    let sceneId = if e.owner.scene == nil: "" else: e.owner.scene.id.string
    if sceneId.len > 0:
      # Scene ids come from the diagram and can carry slashes ("tests/js").
      # Flatten them so one scene cannot address another's subtree.
      var safeId = ""
      for ch in sceneId:
        safeId.add(if ch in {'a'..'z', 'A'..'Z', '0'..'9', '-', '_'}: ch else: '_')
      result = result / "scenes" / safeId

proc containsPathTraversal(relPath: string): bool =
  ## True when any path *segment* is "..". A substring test would also reject
  ## innocent names like "backup..old.json".
  for segment in relPath.split({'/', '\\'}):
    if segment == "..":
      return true
  return false

proc resolveAssetPath(e: JsAppEvalEnv, relPath: string): string =
  ## Absolute path inside the assets folder, or "" when the path is empty,
  ## absolute, or escapes the folder.
  ##
  ## The containment check runs against the *real* path, not the lexical one:
  ## normalizedPath does not follow symlinks, so a link planted inside the
  ## assets folder used to be a legal way out of it.
  if relPath.len == 0 or relPath.startsWith("/") or relPath.isAbsolute() or
      containsPathTraversal(relPath):
    return ""
  let root = assetsRoot(e)
  let full = normalizedPath(root / relPath)
  if not (full == root or full.startsWith(root & "/")):
    return ""

  when not defined(frameosEmbedded):
    # Resolve the deepest ancestor that actually exists: the target itself may
    # legitimately not exist yet (a write), but everything leading to it must
    # still be inside the sandbox once symlinks are followed. Nothing exists
    # to be a symlink until the root does, so an absent root skips the check.
    if dirExists(root):
      try:
        let realRoot = expandFilename(root)
        var probe = full
        while not fileExists(probe) and not dirExists(probe):
          let parent = probe.parentDir()
          if parent == probe or parent.len < root.len:
            break
          probe = parent
        if fileExists(probe) or dirExists(probe):
          let realProbe = expandFilename(probe)
          if not (realProbe == realRoot or realProbe.startsWith(realRoot & "/")):
            return ""
      except CatchableError:
        return ""

  return full

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
        # Hidden/OS-junk entries (`.thumbs`, `.frameos`, `._IMG.jpg`,
        # `Thumbs.db`, `@eaDir`, …) never show up in an app's asset listing.
        for filePath in walkDirRecNoJunk(dir, relative = false):
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
    when defined(memProbe):
      let approx = ($configJson[keyStr]).len
      if approx > 8192:
        memProbe("      cfg." & keyStr & " ->JS src=" & $approx & "B BEFORE")
        let converted = jsonToJS(ctx, configJson[keyStr])
        memProbe("      cfg." & keyStr & " ->JS AFTER")
        return converted
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
    settingsKeys: seq[string] = @[], sourceName: string = "",
    sources: JsonNode = nil): JsAppRuntime =
  ## `sources` is the app's file map (name → contents) that `source` may
  ## import from; `sourceName` names the main module among them.
  when defined(memProbe): memProbe("  NEW JsAppRuntime " & category & " src=" & $source.len & "B")
  let mainName = if sourceName.len > 0: sourceName else: "app.ts"
  return JsAppRuntime(
    category: category,
    outputType: outputType,
    source: source,
    sourceName: mainName,
    sources: sources,
    settingsKeys: settingsKeys,
    nextImageId: 0,
    images: initTable[int, Image](),
    transientImageIds: @[]
  )

type
  DynamicJsApp* = ref object of AppRoot
    configJson*: JsonNode
    runtime*: JsAppRuntime

proc appFile(runtime: JsAppRuntime, name: string): string =
  ## Contents of one of the app's files, "" when absent.
  if runtime.sources.isNil or runtime.sources.kind != JObject:
    return ""
  runtime.sources{name}.getStr("")

proc hasAppFile(sources: JsonNode, name: string): bool =
  not sources.isNil and sources.kind == JObject and sources.hasKey(name) and
    sources[name].kind == JString

const JsAppModuleExtensions = [".ts", ".tsx", ".js", ".jsx", ".json"]

proc resolveAppModule*(sources: JsonNode, name: string): string =
  ## The file an import specifier names, or "" when the app has no such file.
  ## `name` is already joined against the importer (`./util` from app.ts is
  ## `util`; from lib/a.ts it is `lib/util`). Tries the name as written, then
  ## the usual extensions, then the TypeScript convention of spelling
  ## `./util.js` for a file that is really `util.ts`.
  if name.len == 0:
    return ""
  if sources.hasAppFile(name):
    return name
  for ext in JsAppModuleExtensions:
    if sources.hasAppFile(name & ext):
      return name & ext
  if name.endsWith(".js"):
    let stem = name[0 ..< name.len - 3]
    for ext in [".ts", ".tsx"]:
      if sources.hasAppFile(stem & ext):
        return stem & ext
  elif name.endsWith(".jsx"):
    let stem = name[0 ..< name.len - 4]
    if sources.hasAppFile(stem & ".tsx"):
      return stem & ".tsx"
  ""

proc resolveModuleName(runtime: JsAppRuntime, name: string): string =
  ## `resolveAppModule` over this app's files, where the main module counts
  ## as a file too (a helper may import `./app` back; QuickJS then finds the
  ## already-loaded module under that name instead of asking for it again).
  if name == runtime.sourceName:
    return name
  for ext in JsAppModuleExtensions:
    if name & ext == runtime.sourceName:
      return runtime.sourceName
  resolveAppModule(runtime.sources, name)

proc joinModulePath*(baseName, name: string): string =
  ## QuickJS's own rule, in Nim: a specifier starting with `.` is taken relative
  ## to the importing module's folder (`./util` in lib/a.ts is lib/util), and
  ## anything else is left as written. A `..` that climbs above the app stays
  ## in the result, so the error can show what was asked for.
  if name.len == 0 or name[0] != '.':
    return name
  var parts: seq[string] = @[]
  let slash = baseName.rfind('/')
  if slash > 0:
    for part in baseName[0 ..< slash].split('/'):
      if part.len > 0:
        parts.add(part)
  for segment in name.split('/'):
    if segment.len == 0 or segment == ".":
      continue
    if segment == ".." and parts.len > 0 and parts[^1] != "..":
      discard parts.pop()
    else:
      parts.add(segment)
  parts.join("/")

proc jsAppModuleNormalize(ctx: ptr JSContext, baseName: cstring, name: cstring,
                          opaque: pointer): cstring {.cdecl.} =
  ## Canonicalise every specifier to the file it names, so `./counter` and
  ## `./counter.ts` from two importers are one module, evaluated once.
  var canonical = ""
  try:
    canonical = joinModulePath($baseName, $name)
    let runtime = jsAppRuntimeByCtx.getOrDefault(ctx)
    if not runtime.isNil:
      let resolved = runtime.resolveModuleName(canonical)
      if resolved.len > 0:
        canonical = resolved
  except CatchableError:
    canonical = $name
  js_strdup(ctx, canonical.cstring)

proc rethrowNamingModule(ctx: ptr JSContext, name: string) =
  ## QuickJS's compile and JSON errors carry the location only in `stack`;
  ## the message alone ("expecting '}'") would leave the author guessing
  ## which of the app's files it means. Re-throw with the file and position
  ## in the message, where the app's error log will show it.
  let exception = JS_GetException(ctx)
  defer: JS_FreeValue(ctx, exception)
  var text = toNimString(ctx, exception)
  var location = ""
  if jsIsObject(exception):
    let stackVal = JS_GetPropertyStr(ctx, exception, "stack")
    defer: JS_FreeValue(ctx, stackVal)
    location = toNimString(ctx, stackVal).strip()
    if location.contains('\n'):
      location = location.split('\n')[0].strip()
    if location.startsWith("at "):
      location = location[3 .. ^1]
    if location == "undefined":
      location = ""
  if not text.contains(name):
    text = name & ": " & text
  if location.len > 0 and not text.contains(location):
    text.add(" (" & location & ")")
  discard JS_ThrowSyntaxError(ctx, "%s", text.cstring)

proc jsAppJsonModuleInit(ctx: ptr JSContext, m: ptr JSModuleDef): cint {.cdecl.} =
  ## `import data from './x.json'`: the parsed value is the default export.
  discard JS_SetModuleExport(ctx, m, "default", JS_GetModulePrivateValue(ctx, m))
  0

proc loadAppJsonModule(ctx: ptr JSContext, name: string, text: string): ptr JSModuleDef =
  let parsed = JS_ParseJSON(ctx, text.cstring, text.len.csize_t, name.cstring)
  if JS_IsException(parsed) != 0:
    rethrowNamingModule(ctx, name)
    return nil
  result = JS_NewCModule(ctx, name.cstring, jsAppJsonModuleInit)
  if result == nil:
    JS_FreeValue(ctx, parsed)
    return nil
  discard JS_AddModuleExport(ctx, result, "default")
  discard JS_SetModulePrivateValue(ctx, result, parsed)

proc loadAppScriptModule(ctx: ptr JSContext, runtime: JsAppRuntime, name: string): ptr JSModuleDef =
  # Straight from the scene JSON: no transpile, no copy, no source map. Error
  # locations are already in this file's own lines. QuickJS keeps the compiled
  # module in its loaded-modules list, so nothing is tracked here either.
  result = compileModule(ctx, runtime.appFile(name), name, quicktsFlagsFor(name))
  if result == nil:
    rethrowNamingModule(ctx, name)

proc jsAppModuleLoader(ctx: ptr JSContext, moduleName: cstring, opaque: pointer): ptr JSModuleDef {.cdecl.} =
  ## QuickJS calls this for every `import` the app's modules make. Modules are
  ## the app's own files and nothing else: there is no package registry on a
  ## frame, so a bare specifier fails the same way a missing file does.
  let name = $moduleName
  try:
    let runtime = jsAppRuntimeByCtx.getOrDefault(ctx)
    if runtime.isNil:
      discard JS_ThrowReferenceError(ctx, "could not load module '%s'", name.cstring)
      return nil
    let resolved = resolveAppModule(runtime.sources, name)
    if resolved.len == 0:
      discard JS_ThrowReferenceError(ctx, "%s",
        ("Cannot import '" & name & "': it is not one of this app's files. Import the app's own " &
         "files with a relative path (./helper, ./data.json); npm packages are not available.").cstring)
      return nil
    if resolved.endsWith(".json"):
      return loadAppJsonModule(ctx, resolved, runtime.appFile(resolved))
    return loadAppScriptModule(ctx, runtime, resolved)
  except CatchableError as error:
    discard JS_ThrowInternalError(ctx, "%s", ("Could not load module '" & name & "': " & error.msg).cstring)
    return nil

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
  of fkSpool:
    # Same as valueToJS: a JS app is opaque, so the bytes materialize on the
    # way in.
    return %* value.sp.materialize()
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
  of fkImageSpool, fkNone:
    # A spooled image is a cache-internal tier; the interpreter materializes
    # it to fkImage before any app — JS included — can see the value.
    return newJNull()

const JsAppSourceNames = ["app.ts", "app.js", "app.tsx", "app.jsx"]

proc jsAppSourceNameFromSources*(sources: JsonNode): string =
  ## Which of the candidate files the source came from. The extension decides
  ## whether the JSX pass runs at all: TypeScript itself only treats `<x>` as
  ## JSX in .tsx/.jsx — in a .ts file it is a type assertion. Running the JSX
  ## walk there is both wasted work (about half of a transform: 12 ms of the
  ## 24 ms a 36 KB app takes on a host, and it is the slowest stage on an
  ## ESP32) and the wrong reading of the syntax.
  if sources.isNil or sources.kind != JObject:
    return ""
  for filename in JsAppSourceNames:
    if sources.hasKey(filename) and sources[filename].kind == JString:
      return filename
  return ""

proc jsAppSourceFromSources*(sources: JsonNode): string =
  if sources.isNil or sources.kind != JObject:
    return ""
  for filename in JsAppSourceNames:
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
  let runtime = newJsAppRuntime(category, outputType, source, settingsKeys,
                                jsAppSourceNameFromSources(sources), sources)
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

proc releaseJsAppRuntime*(app: AppRoot) =
  ## Close a JS app node's interpreter as its scene is torn down.
  ##
  ## Scene cleanup has to call this explicitly. Dropping the app object is not
  ## enough — JsAppRuntime owns raw QuickJS pointers and has no destructor —
  ## and on embedded `liveJsRuntimes` holds a reference to every runtime it has
  ## ever readied, so nothing about dropping the scene makes one collectable.
  ## The cost is per NODE, not per scene: the bundled Weather scene builds four
  ## (~148 KB of PSRAM each, measured with -d:memProbe), so a frame cycling
  ## between two JS scenes used to shed a few hundred KB per switch and reboot
  ## itself after about seven.
  if not (app of DynamicJsApp):
    return
  let runtime = DynamicJsApp(app).runtime
  if runtime.isNil:
    return
  when defined(frameosEmbedded):
    # Never pull the rug from under a runtime that is mid-call; scene teardown
    # runs between renders, so this is belt-and-braces.
    if jsRuntimeStack.contains(runtime):
      return
    let live = liveJsRuntimes.find(runtime)
    if live >= 0:
      liveJsRuntimes.delete(live)
  teardownJsRuntime(runtime)

proc setDynamicJsAppField*(app: AppRoot, field: string, value: Value) =
  let dynamicApp = DynamicJsApp(app)
  if dynamicApp.configJson.isNil or dynamicApp.configJson.kind != JObject:
    dynamicApp.configJson = %*{}
  let nextValue = dynamicApp.runtime.jsAppValueToJson(value)
  if dynamicApp.configJson.hasKey(field):
    dynamicApp.runtime.releaseReplacedImageRef(dynamicApp.configJson[field], nextValue)
  dynamicApp.configJson[field] = nextValue

proc ensureReady(runtime: JsAppRuntime, frameConfig: FrameConfig) =
  if runtime.ready:
    return

  when defined(frameosEmbedded):
    # Reclaim the other nodes' interpreters before building this one.
    evictIdleJsRuntimes(runtime)
    if not liveJsRuntimes.contains(runtime):
      liveJsRuntimes.add(runtime)

  when defined(memProbe): memProbe("    newQuickJS BEFORE")
  runtime.js = newQuickJS(sceneJsConfig(frameConfig))
  when defined(memProbe): memProbe("    newQuickJS AFTER")
  jsAppRuntimeByCtx[runtime.js.context] = runtime
  runtime.js.setModuleLoader(jsAppModuleLoader, jsAppModuleNormalize)
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
  # Named after the real file so `./helper` resolves beside it and error
  # locations read `app.ts:12:3`.
  let filename = runtime.sourceName
  when defined(memProbe): memProbe("      prelude done, module src=" & $runtime.source.len & "B BEFORE")

  # Evaluate the source as a real ES module — TypeScript and JSX included,
  # the bundled QuickJS parses both — and publish its namespace where the
  # prelude's __frameosExports() looks for it. Nothing is generated, so error
  # locations are the app's own lines and no line map is kept.
  let ctx = runtime.js.context
  var namespace: JSValue
  try:
    namespace = runtime.js.evalModuleNamespace(runtime.source, filename, quicktsFlagsFor(filename))
  except CatchableError as error:
    raise newException(JSException, mapJsErrorText(ctx, error.msg))
  let globalObj = JS_GetGlobalObject(ctx)
  let installed = JS_SetPropertyStr(ctx, globalObj, "__frameosModule", namespace)
  JS_FreeValue(ctx, globalObj)
  if installed < 0:
    raise newException(JSException, "Could not install the app module: " & filename)
  when defined(memProbe): memProbe("      module eval AFTER")
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
      let (svgWidth, svgHeight) = boundedRequestedDimensions(
        defaultImageWidth(owner, context, %*{}), defaultImageHeight(owner, context, %*{}))
      let image = decodeSvgWithFallback(data, svgWidth, svgHeight)
      if image.isSome:
        return image.get()
      # Bounded by the SVG's declared size (decodeImageWithDisplayBounds
      # parses it), never rasterized at whatever viewBox it asks for.
      return decodeImageWithDisplayBounds(data)
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
      when defined(memProbe): memProbe("    svg decode src=" & $spec["svg"].getStr().len & "B BEFORE")
      # The spec's width/height are scene-requested: bounded like a decode.
      let (svgWidth, svgHeight) = boundedRequestedDimensions(
        defaultImageWidth(owner, context, spec), defaultImageHeight(owner, context, spec))
      # The same `intoTarget` handshake as the plain-canvas branch below: an
      # SVG panel is the common shape for a JS render app, and rasterizing it
      # into the target the planner offered is what keeps a full-size second
      # image off the heap.
      # Rasterize into whatever target was offered, including the live canvas.
      #
      # On a target the chain owns (freshly transparent) this is bit-identical
      # to rendering standalone and drawing the result. On the live canvas it
      # is equal only in exact arithmetic: compositing each path onto existing
      # content rounds differently at every path than compositing onto
      # transparency does before one final blend. Source-over is associative,
      # 8-bit is not, and a six-colour dither turns a one-unit nudge near a
      # threshold into a flipped cell.
      #
      # Measured on a 7.3" PhotoPainter, that difference is 2.8% of pixels, of
      # which 5,417 flip one way and 5,415 flip back — the grain rearranges and
      # the mean colour over the changed area is identical. Weighed against
      # 1.48MB of PSRAM and 5.2s per render on a frame with ~6.6MB free, the
      # call was to take the memory (docs/value-pipeline.md).
      let (offeredWidth, offeredHeight) = owner.offeredDecodeTargetSize(context)
      if offeredWidth == svgWidth and offeredHeight == svgHeight:
        let (svgTarget, _) = owner.takeDecodeTarget(context)
        if not svgTarget.isNil and renderSvgIntoTarget(spec["svg"].getStr(), svgTarget):
          when defined(memProbe): memProbe("    svg decode AFTER (into target)")
          return svgTarget
      let image = decodeSvgWithFallback(spec["svg"].getStr(), svgWidth, svgHeight)
      when defined(memProbe): memProbe("    svg decode AFTER")
      if image.isSome:
        return image.get()
      let reason = svgDecodeError(spec["svg"].getStr(), svgWidth, svgHeight)
      frameos_apps.logError(owner, "JS app returned an SVG that failed to render: " &
        (if reason.len > 0: reason else: "unknown error") & " — check for unescaped & < > \" in text, unsupported tags (defs, use, image, filter, mask, clipPath, style, radialGradient) and gradients without gradientUnits=\"userSpaceOnUse\"")
      return nil
    if spec.hasKey("dataUrl"):
      return decodeDataUrl(spec["dataUrl"].getStr())
    if spec.hasKey("base64"):
      var decoded = spec["base64"].getStr().decode()
      # decodeImageWithDisplayBounds bounds an SVG by its declared size too.
      return decodeImageWithDisplayBounds(decoded)
    let (width, height) = boundedRequestedDimensions(
      defaultImageWidth(owner, context, spec), defaultImageHeight(owner, context, spec))
    # The consumer's half of `intoTarget`, for a JS app that asked for a plain
    # canvas: when the planner offered this node a target of exactly the size
    # we were about to allocate, draw into that instead. The JS drawing calls
    # composite onto it exactly as they would onto a fresh canvas that was
    # afterwards drawn over the same pixels — which is why this is sound, and
    # why it is limited to this branch. An SVG, a data URL or an
    # explicitly-sized image is a different picture, and leaves the target
    # unclaimed for the interpreter to discard.
    var image: Image = nil
    let hasFill = spec.hasKey("color")
    var fillColor: Color
    if hasFill:
      fillColor = colorWithOpacity(spec)
    # A fill is a SET, not a composite. On a target the chain owns it lands on
    # fresh transparency, exactly like on the canvas we were about to allocate;
    # on the live render canvas it is only equivalent when the color is opaque
    # — a semi-transparent fill would replace the scene's pixels where the
    # materialized path composites over them.
    let fillSafe = not hasFill or fillColor.a >= 1.0 or context.decodeTargetIsOwned()
    let (offeredWidth, offeredHeight) = owner.offeredDecodeTargetSize(context)
    if fillSafe and offeredWidth == width and offeredHeight == height:
      let (target, _) = owner.takeDecodeTarget(context)
      image = target
    if image.isNil:
      image = newImage(width, height)
    if hasFill:
      image.fill(fillColor)
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
  ensureReady(runtime, owner.frameConfig)
  let ctx = runtime.js.context
  let fnNameValue = nimStringToJS(ctx, fnName)
  defer: JS_FreeValue(ctx, fnNameValue)

  jsAppEnvByCtx[ctx] = JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)
  # A JS app can run another node, which can be another JS app, so track the
  # whole call chain — an ancestor mid-call must never be evicted underneath.
  when defined(frameosEmbedded): jsRuntimeStack.add(runtime)
  when defined(memProbe): memProbe("    js invoke " & fnName & " BEFORE")
  result =
    try:
      callGlobalFunction(ctx, "__frameosInvoke", [fnNameValue])
    finally:
      if jsAppEnvByCtx.hasKey(ctx):
        jsAppEnvByCtx.del(ctx)
      when defined(frameosEmbedded):
        if jsRuntimeStack.len > 0 and jsRuntimeStack[^1] == runtime:
          discard jsRuntimeStack.pop()
      when defined(memProbe): memProbe("    js invoke " & fnName & " AFTER")

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
