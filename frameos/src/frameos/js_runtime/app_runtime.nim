import std/[algorithm, base64, json, monotimes, options, os, streams, strformat, strutils, tables, times]
import frameos/utils/memory
import pixie
import pixie/fileformats/svg

import frameos/apps as frameos_apps
import frameos/js_runtime/runtime
import frameos/js_runtime/run_budget
import frameos/types
import frameos/values
import frameos/utils/http_client
import frameos/utils/app_images
import frameos/utils/asset_colors
import frameos/utils/dither
import frameos/utils/exif
import frameos/utils/image
import frameos/utils/svg_frames
import frameos/utils/canvas_log
import frameos/utils/paths
import frameos/utils/system
import frameos/js_runtime/burrito
import frameos/js_runtime/jsx
import frameos/ui/layout
import frameos/ui/events
import frameos/render_scale

type
  JsAssetGrant* = enum
    ## What the app's config.json `permissions` let its asset calls do. An app
    ## asks, and asking for nothing gets nothing; the scene's tags are the
    ## union of its apps' (docs/scene-guide.md "Assets"). Scenes stored before
    ## the lists existed got them written in by the control planes (backend
    ## migration 5e2a9c71d4b8, the cloud's read-time stamp). "files" is Local
    ## Image's (a Nim app): for a JS app, which has no absolute paths, it reads
    ## like "assets".
    agOwnFolder  ## none of assets/files/assets-write, or no list: the scene's own <assets>/scenes/<sceneId>/
    agRead       ## "assets" or "files": read the frame's folder, never change it
    agReadWrite  ## "assets-write": read and write the frame's folder

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
    assetGrant*: JsAssetGrant
    js*: QuickJS
    ready*: bool
    initialized*: bool
    nextImageId*: int
    images*: Table[int, Image]
    jsxMemo*: JsxMemo ## the nodes of memo()'s elements (js_runtime/jsx.nim)
    # The last tree get() returned, for a render only the pointer asked for
    # (hover:, active:): laid out again with the new pointer, get() not run,
    # as a browser restyles :hover without React rendering again.
    lastJsx: SvgNode
    lastJsxConfig: JsonNode
    lastJsxAt: MonoTime
    transientImageIds: seq[int]
    keptImageIds: seq[int]
    canvases: seq[tuple[key: string, id: int]]
      ## `frameos.canvas(key, ...)`: the pictures the app draws into, kept
      ## like the ones above until the interpreter goes (MaxCanvases at most).
      ## `fetchImage(url, {keep: true})`'s pictures, oldest first: they stay
      ## for later renders until `frameos.releaseImage` or the interpreter
      ## goes (MaxKeptImages at most).
    ## `frameos.remember` / `recall`: values the app keeps between renders, as
    ## JSON text. Held here and not in the interpreter because an ESP32 tears
    ## every idle interpreter down after a render (releaseIdleJsAppRuntimes),
    ## and module state goes with it; this survives until the scene does.
    memory*: Table[string, string]
    memoryBytes*: int
    ## A script evaluated after the prelude and before the main module: the
    ## test harness (app_tests.nim). Empty for an app on a frame.
    extraPrelude*: string

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
## The runtimes with a call in progress, outermost first: a JS app can run
## another node, which can be another JS app. A call lasts until the caller
## has freed the last value it got back (`get` reads its payload after JS
## returns). Eviction must never pull one out from under its call, and after
## an out-of-memory abort what is still here is what the abort jumped out of
## (abandonMidCallJsAppRuntimes).
var jsRuntimeStack: seq[JsAppRuntime] = @[]

template midCall(runtime: JsAppRuntime, body: untyped) =
  jsRuntimeStack.add(runtime)
  try:
    body
  finally:
    if jsRuntimeStack.len > 0 and jsRuntimeStack[^1] == runtime:
      discard jsRuntimeStack.pop()

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
  for canvas in runtime.canvases:
    unregisterCanvas(runtime.images.getOrDefault(canvas.id, nil))
  runtime.images.clear()
  runtime.transientImageIds.setLen(0)
  runtime.keptImageIds.setLen(0)
  runtime.canvases.setLen(0)

var liveJsRuntimes: seq[JsAppRuntime] = @[]
  ## Every interpreter built and not yet released, on every platform: the
  ## single-scene host (an ESP32, the editor's preview) drops the idle ones
  ## after each render unless the frame keeps them (settleIdleJsAppRuntimes),
  ## and an ESP32 also evicts them under memory pressure.

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
  proc evictIdleJsRuntimes(keep: JsAppRuntime) =
    let headroom = availableRenderBytes()
    if headroom <= 0 or headroom >= RenderMemoryShortBytes:
      return
    for other in liveJsRuntimes:
      if other != keep and other.ready and not jsRuntimeStack.contains(other):
        teardownJsRuntime(other)

proc releaseIdleJsAppRuntimes*() =
  ## Drop every JS app interpreter that is not mid-call. The single-scene host
  ## calls it after every render (single_scene_host.renderScene) on an ESP32,
  ## and in the editor's preview while it runs as one (runsAsEmbedded): there
  ## an app's module variables last one render and its init() runs on every
  ## one, and what must last longer goes through `frameos.remember`. The
  ## preview does it so that an app leaning on module state shows it in the
  ## editor, not on the frame. A Pi keeps its interpreters for the scene's
  ## life and never calls this.
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
  for runtime in liveJsRuntimes:
    if runtime.ready and not jsRuntimeStack.contains(runtime):
      teardownJsRuntime(runtime)

proc hasIdleJsAppRuntimes(): bool =
  for runtime in liveJsRuntimes:
    if runtime.ready and not jsRuntimeStack.contains(runtime):
      return true
  false

proc idleJsAppRuntimesHoldPictures(): bool =
  ## Whether an idle interpreter keeps pictures (fetchImage's `keep`).
  for runtime in liveJsRuntimes:
    if runtime.ready and not jsRuntimeStack.contains(runtime) and
        (runtime.keptImageIds.len > 0 or runtime.canvases.len > 0):
      return true
  false

proc settleIdleJsAppRuntimes*(keep: bool): bool =
  ## After a render on the single-scene host. `keep` (an ESP32 that does not
  ## deep-sleep): the idle interpreters stay for the next render while there
  ## is room, and it calls into them instead of building QuickJS and compiling
  ## the prelude and the app again — ~170 ms of a SenseCAP Indicator frame,
  ## a Pi's behaviour, down to the headroom keepIdleInterpreters asks for.
  ## Released otherwise (a deep-sleeping frame wakes to a fresh boot anyway),
  ## and released later when a decode is short of memory
  ## (utils/memory.renderMemoryReleaseHook). Apps still must not count on
  ## module variables outliving a render: `frameos.remember` is the way.
  ## An interpreter that keeps pictures stays down to the lower floor after
  ## a decode too: they would only be decoded again. Whether they were kept.
  if keep and hasIdleJsAppRuntimes() and
      keepIdleInterpreters(holdingPictures = idleJsAppRuntimesHoldPictures()):
    return true
  releaseIdleJsAppRuntimes()
  false

proc liveJsAppRuntimeBytes*(): int =
  ## What the live JS app interpreters hold, for the memory a kept scene
  ## costs (the ESP32's `render:animation` line). Walks every interpreter's
  ## heap: for a once-in-a-while log line, not per frame.
  for runtime in liveJsRuntimes:
    if runtime.ready:
      result += runtime.js.heapBytes()

when defined(frameosEmbedded):
  proc releaseKeptJsAppRuntimes(): bool {.nimcall, raises: [].} =
    ## utils/memory's release hook: render memory is short, so the
    ## interpreters a frame kept between renders go, as releasing them after
    ## every render used to guarantee.
    if not hasIdleJsAppRuntimes():
      return false
    try:
      releaseIdleJsAppRuntimes()
    except CatchableError:
      discard
    true

  renderMemoryReleaseHook = releaseKeptJsAppRuntimes

proc abandonMidCallJsAppRuntimes*(): tuple[count, bytes: int] =
  ## After an out-of-memory abort (single_scene_host.recoverAbortedRun): drop
  ## the interpreters the abort jumped out of (QuickJS.abandon says why they
  ## can be neither run nor freed). The `finally` in `invoke` that pops them
  ## never ran, so left alone they stayed "mid-call" for good and were never
  ## released. The next render builds the app a new one and runs its init()
  ## again; `frameos.remember` values are Nim data and carry over.
  for runtime in jsRuntimeStack:
    if runtime.isNil or not runtime.ready:
      continue  # already dropped: a runtime re-entered further up the chain
    let ctx = runtime.js.context
    if not ctx.isNil:
      jsAppEnvByCtx.del(ctx)
      jsAppRuntimeByCtx.del(ctx)
      clearJsSourceMaps(ctx)
    result.bytes += runtime.js.abandon()
    inc result.count
    runtime.ready = false
    runtime.initialized = false
    runtime.images.clear()
    runtime.transientImageIds.setLen(0)
  jsRuntimeStack.setLen(0)

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

proc jsAppLogMessage(payload: JsonNode): string =
  ## `frameos.log(...args)` / `app.log(...args)` arrive as the JSON array of
  ## their arguments. Join them the way console.log does: strings as they are,
  ## anything else as compact JSON. The array itself used to be the message,
  ## so every line read `["Showing Immich asset ..."]`.
  if payload.kind != JArray:
    return $payload
  var parts: seq[string] = @[]
  for arg in payload:
    parts.add(if arg.kind == JString: arg.getStr() else: $arg)
  parts.join(" ")

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
      # console.warn: a log line that says so, since the logger has no level of its own for it.
      let prefix = if lvl == "warn": "warning: " else: ""
      if lvl == "error":
        frameos_apps.logError(e.owner, jsAppLogMessage(payload))
      else:
        frameos_apps.log(e.owner, prefix & jsAppLogMessage(payload))
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

const JsAppMemoryMaxBytes* = when defined(frameosEmbedded): 512 * 1024 else: 16 * 1024 * 1024
  ## What one node may keep with `frameos.remember`, all keys together.

proc jsRemember(ctx: ptr JSContext, key: JSValue, valueJson: JSValue): JSValue {.nimcall.} =
  ## Keep a JSON value for this node across renders and interpreter restarts.
  ## null or undefined forgets the key. False when it would not fit.
  let e = env(ctx)
  if e == nil or e.runtime.isNil:
    return nimBoolToJS(ctx, false)
  let memoryKey = toNimString(ctx, key)
  if memoryKey.len == 0:
    return nimBoolToJS(ctx, false)
  let valueStr = toNimString(ctx, valueJson)
  let runtime = e.runtime
  let previous = runtime.memory.getOrDefault(memoryKey, "")
  if valueStr.len == 0 or valueStr == "null":
    if runtime.memory.hasKey(memoryKey):
      runtime.memoryBytes -= memoryKey.len + previous.len
      runtime.memory.del(memoryKey)
    return nimBoolToJS(ctx, true)
  let replaced = if runtime.memory.hasKey(memoryKey): memoryKey.len + previous.len else: 0
  let after = runtime.memoryBytes - replaced + memoryKey.len + valueStr.len
  if after > JsAppMemoryMaxBytes:
    frameos_apps.logError(e.owner, "frameos.remember(\"" & memoryKey & "\") refused: " & $after &
      " bytes would exceed this node's " & $JsAppMemoryMaxBytes & " byte limit")
    return nimBoolToJS(ctx, false)
  runtime.memory[memoryKey] = valueStr
  runtime.memoryBytes = after
  nimBoolToJS(ctx, true)

proc jsRecall(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  ## The JSON text `jsRemember` kept under the key, "" when there is none.
  let e = env(ctx)
  if e == nil or e.runtime.isNil:
    return nimStringToJS(ctx, "")
  nimStringToJS(ctx, e.runtime.memory.getOrDefault(toNimString(ctx, key), ""))

proc jsFetchText(ctx: ptr JSContext, url: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  let urlStr = toNimString(ctx, url)
  if urlStr.len == 0:
    return nimStringToJS(ctx, "")

  try:
    return nimStringToJS(ctx, boundedGetContent(urlStr, maxBytes = jsFetchMaxBytes(e)))
  except CatchableError as err:
    if e != nil:
      frameos_apps.logError(e.owner, "JS app fetchText failed: " & redactedUrlsIn(err.msg))
    return nimStringToJS(ctx, "")

proc storeTransientImageJson(runtime: JsAppRuntime, image: Image): JsonNode
proc storeKeptImageJson(runtime: JsAppRuntime, owner: AppRoot, image: Image): JsonNode

const JsHttpMaxTimeoutMs = 600_000

when defined(testing):
  ## Test seam for `frameos.httpRequest`: when set, every request a JS app
  ## makes is answered here instead of on the network, so an app whose API
  ## host is fixed (OpenAI, Unsplash, Commons, …) runs against canned replies.
  ## Images have their own seam (app_images.contextDownloadHook). Compiled out
  ## of real builds.
  type JsHttpRequestHook* = proc(url, httpMethod, body: string,
    headers: seq[SimpleHttpHeader]): tuple[code: int, body: string]
  var jsHttpRequestHook*: JsHttpRequestHook = nil

const
  JsHttpFindDefaultLength = 512
  JsHttpFindMaxLength = 16_384
  JsHttpFindDefaultLimit = 1000
  JsHttpFindMaxLimit = 10_000
  JsHttpFindErrorBodyBytes = 1024

proc utf8Boundary(s: string, index: int): int =
  ## `index` moved back to the start of the UTF-8 sequence it falls in, so a
  ## slice ending there never splits a character.
  result = min(index, s.len)
  while result > 0 and result < s.len and (s[result].uint8 and 0xC0) == 0x80:
    dec result

proc findSnippets*(body, needle: string, length, limit: int): JsonNode =
  ## The text at each occurrence of `needle` (needle included), `length`
  ## bytes at most, for `httpRequest`'s `find`. Lets a JS app scrape a page
  ## bigger than its heap: a Google Photos share page is 1.2 MB, which as a
  ## JS string (and the JSON it rides in) is over an ESP32 runtime's 4 MB,
  ## while the photo links in it are a few KB.
  result = newJArray()
  if needle.len == 0:
    return
  var i = body.find(needle)
  while i >= 0 and result.len < limit:
    result.add(%*body[i ..< utf8Boundary(body, i + max(length, needle.len))])
    i = body.find(needle, i + needle.len)

proc jsHttpRequest(ctx: ptr JSContext, url: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Bounded HTTP request with method/headers/body. Options JSON:
  ## {method, headers: {name: value}, body, bodyBase64, base64 (return body
  ## base64-encoded, required for binary responses), timeoutMs, find,
  ## findLength, findLimit}.
  ## Returns JSON: {status, body | bodyBase64} or {status: 0, error}. With
  ## `find` the body stays native: the response carries `found` (the text
  ## at each occurrence, findLimit of them, findLength bytes each) and, for a
  ## non-2xx status, the first KB of the body so the error stays readable.
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
    # The scene's own ceiling for this request, then the run's wall-clock
    # deadline (run_budget.nim): a 600 s tarpit used to hold the render
    # thread until the systemd watchdog fired.
    let timeoutMs = capToRenderDeadline(clamp(options{"timeoutMs"}.getInt(DefaultFetchTimeoutMs), 1000, JsHttpMaxTimeoutMs))
    let maxSeconds = capToRenderDeadline(int(max(DefaultFetchMaxSeconds, timeoutMs.float / 1000.0 + 30.0) * 1000)).float / 1000.0
    let httpMethod = options{"method"}.getStr("GET").toUpperAscii()
    var code = 0
    var resBody = ""
    var answered = false
    when defined(testing):
      if jsHttpRequestHook != nil:
        (code, resBody) = jsHttpRequestHook(urlStr, httpMethod, body, headers)
        answered = true
    if not answered:
      let res = boundedRequestWithHeaders(
        urlStr,
        httpMethod = httpMethod,
        body = body,
        headers = headers,
        timeoutMs = timeoutMs,
        maxBytes = jsFetchMaxBytes(e),
        maxSeconds = maxSeconds
      )
      code = res.code
      resBody = res.body
    response["status"] = %*code
    let find = options{"find"}.getStr("")
    if find.len > 0:
      let length = clamp(options{"findLength"}.getInt(JsHttpFindDefaultLength), 1, JsHttpFindMaxLength)
      let limit = clamp(options{"findLimit"}.getInt(JsHttpFindDefaultLimit), 1, JsHttpFindMaxLimit)
      response["found"] = findSnippets(resBody, find, length, limit)
      if code < 200 or code >= 300:
        response["body"] = %*resBody[0 ..< utf8Boundary(resBody, JsHttpFindErrorBodyBytes)]
    elif options{"base64"}.getBool(false):
      response["bodyBase64"] = %*encode(resBody)
    else:
      response["body"] = %*resBody
  except CatchableError as err:
    # The request's URL is the scene's and may carry a key or a share token;
    # the client's own errors name its origin only (utils/redacted_url.nim),
    # and anything else that quotes one is cut down here, before the text
    # reaches the log or an app that draws it.
    let message = redactedUrlsIn(err.msg)
    response["error"] = %*message
    if e != nil:
      frameos_apps.logError(e.owner, "JS app httpRequest failed: " & message)
  return nimStringToJS(ctx, $response)

const DecoderFits = ["cover", "contain", "stretch"]
  ## The placements a decode can honour while it streams into a target. The
  ## planner offers a JS node the consumer's target under EVERY placement
  ## (`NaturalFit`: a generator's output is target-sized whatever the
  ## placement says), and that promise does not hold for a photo.

proc sanitizedAssetExtension(extension: string): string =
  ## `saveAsset` appends the extension verbatim to a path under the assets
  ## folder, and here it comes from scene JS. Accept only a short alphanumeric
  ## suffix: no separators, no dots.
  var ext = extension.strip().toLowerAscii()
  if ext.startsWith("."):
    ext = ext[1..^1]
  if ext.len == 0 or ext.len > 5 or not ext.allCharsInSet({'a'..'z', '0'..'9'}):
    return ".jpg"
  "." & ext

proc fetchImageColorProfile(node: JsonNode): Option[AssetColorProfile] =
  ## `fetchImage`'s `colors` option: a sidecar's inner `colors` object (what
  ## the Photos share routes send) or a whole sidecar. Never raises: anything
  ## that does not parse is no profile, like a broken sidecar.
  try:
    if node.isNil or node.kind != JObject:
      return none(AssetColorProfile)
    let inner = node{"colors"}
    if not inner.isNil and inner.kind == JObject:
      return parseAssetColorProfile(node)
    some(parseAssetColorAdjustments(node))
  except CatchableError:
    none(AssetColorProfile)

proc jsFetchImage(ctx: ptr JSContext, url: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Downloads and decodes an image natively, so the bytes never enter the JS
  ## heap: a JS app gets back an image reference it returns as its output,
  ## never the pixels. Options JSON: {headers: {name: value},
  ## saveAsset: {name, extension, mode: "auto" | "always"}, exif: bool,
  ## colors}. Returns JSON {image: imageRef | null, width, height, savedAs?,
  ## exif?, exifSummary?} or {image: null, error}. A `data:` URL decodes the
  ## same way, which is how an app shows an image an API returned as base64.
  ##
  ## This is the producer's half of the `intoTarget` handshake for a JS app
  ## (docs/value-pipeline.md). The planner offers a JS node the consumer's
  ## target with a natural fit — every placement, since a natural-size
  ## producer draws 1:1 — but a decode fits, so the target is claimed only
  ## under a fit a decoder honours (cover/contain/stretch). Under any other
  ## placement the download decodes bounded by the target's size and the
  ## offer stays unclaimed for the interpreter to discard; the consumer then
  ## places the natural-size result itself. On the ESP32 the claimed path is
  ## the socket-streaming decode straight into the canvas, the same one the
  ## built-in Nim photo apps use; hosts decode at native resolution and let
  ## the consumer scale.
  ##
  ## `saveAsset` keeps the downloaded bytes as a frame asset the way the Nim
  ## photo apps do (`saved/<app>/<name>.<md5><ext>`; "auto" honours the
  ## frame's own save-assets setting). `exif` reads the EXIF block of those
  ## bytes (exiftool where the host has it, then the built-in parser). The
  ## bytes exist only on hosts: the embedded streaming path keeps no copy, and
  ## reports no `savedAs` and no `exif`.
  ##
  ## `colors` is the image's own color profile (docs/asset-color-profiles.md),
  ## applied the way `loadAssetImage` applies a sidecar: palette override,
  ## adjustments, the graded mark. `null` says the image has none, so an
  ## earlier photo's palette override is cleared; without the key nothing
  ## about colors changes. With adjustments, `contain` does not claim the
  ## target: they must not touch the canvas around the photo.
  ##
  ## `keep: true` makes a picture the app holds: the ref stays valid for
  ## later renders (a JSX gallery's photo, drawn again after a tap without a
  ## download) until `frameos.releaseImage(ref)` or the interpreter goes,
  ## MaxKeptImages at most. A kept picture is the app's own image, never the
  ## consumer's target: `width` / `height` (and `fit`, cover or contain) say
  ## the size to decode it at, in the canvas's pixel format, so an ESP32
  ## holds a 480x480 photo in 450 KB of RGB565; without them it decodes at
  ## its own size.
  let e = env(ctx)
  var response = %*{"image": newJNull()}
  if e == nil:
    response["error"] = %*"no app context"
    return nimStringToJS(ctx, $response)

  let urlStr = toNimString(ctx, url)
  var options = %*{}
  try:
    options = parseJson(toNimString(ctx, optionsJson))
  except CatchableError:
    discard
  if options.isNil or options.kind != JObject:
    options = %*{}

  try:
    var headers: seq[SimpleHttpHeader] = @[]
    let headersNode = options{"headers"}
    if not headersNode.isNil and headersNode.kind == JObject:
      for name, value in headersNode.pairs:
        headers.add((name, value.getStr($value)))

    let owner = e.owner
    let context = e.context
    let maxBytes = frameos_apps.maxImageResponseBytes(owner)
    let (offeredWidth, offeredHeight) = owner.offeredDecodeTargetSize(context)
    let offeredFit = if context.isNil: "" else: context.decodeTargetScalingMode
    let colorsGiven = options.hasKey("colors")
    let colorProfile =
      if colorsGiven: fetchImageColorProfile(options["colors"])
      else: none(AssetColorProfile)
    let adjustColors = colorProfile.isSome and colorProfile.get().hasAdjustments()
    if colorsGiven:
      # The panel dither reads it after the render: sticky until the next
      # image or scene, as in data/localImage.
      if colorProfile.isSome and colorProfile.get().hasPaletteOverride():
        setRenderPaletteOverride(colorProfile.get().palette)
      else:
        clearRenderPaletteOverride()
    let keep = options{"keep"}.getBool(false)
    var downloaded: tuple[image: Image, data: string]
    if keep:
      let
        keepWidth = options{"width"}.getInt(0)
        keepHeight = options{"height"}.getInt(0)
      if keepWidth > 0 and keepHeight > 0:
        # The canvas's format where one is about (RGB565 on an LCD), so
        # drawing the picture later is a copy.
        let like =
          if not context.isNil and not context.decodeTargetImage.isNil: context.decodeTargetImage
          else: context.contextImage()
        let target =
          if like.isNil: newImage(keepWidth, keepHeight)
          else: newImageLike(like, keepWidth, keepHeight)
        if not like.isNil:
          target.ditherStores = like.ditherStores # as a decode into the canvas
        downloaded = downloadImageWithDataInto(urlStr, target, maxBytes = maxBytes,
          headers = headers, fit = scaledDecodeFit(options{"fit"}.getStr("cover")))
      else:
        downloaded = downloadImageWithData(urlStr, maxBytes = maxBytes, headers = headers)
    elif offeredWidth > 0 and offeredHeight > 0 and
        (offeredFit notin DecoderFits or (adjustColors and offeredFit == "contain")):
      downloaded = downloadImageWithDataBounded(urlStr, offeredWidth, offeredHeight,
        maxBytes = maxBytes, headers = headers)
    else:
      downloaded = owner.downloadImageWithDataForContext(context, urlStr,
        maxBytes = maxBytes, headers = headers)
    if downloaded.image.isNil:
      response["error"] = %*"the response was not an image this frame can decode"
      return nimStringToJS(ctx, $response)

    # A claimed target is the canvas on the ESP32: a mark an earlier image
    # left on it must not outlive that image.
    unmarkImageGraded(downloaded.image)
    if adjustColors:
      applyAssetColors(downloaded.image, colorProfile.get())
      # Explicit sliders stand; the consumer's automatic fit skips this one.
      markImageGraded(downloaded.image)

    response["image"] =
      if keep: e.runtime.storeKeptImageJson(owner, downloaded.image)
      else: e.runtime.storeTransientImageJson(downloaded.image)
    response["width"] = %*downloaded.image.width
    response["height"] = %*downloaded.image.height

    let save = options{"saveAsset"}
    if not save.isNil and save.kind == JObject and downloaded.data.len > 0:
      let mode = save{"mode"}.getStr("auto")
      if mode == "auto" or mode == "always":
        let saved = owner.saveAsset(save{"name"}.getStr("image"),
          sanitizedAssetExtension(save{"extension"}.getStr("")), downloaded.data, mode == "auto")
        if saved.len > 0:
          response["savedAs"] = %*saved

    if options{"exif"}.getBool(false) and downloaded.data.len > 0:
      var metadata = %*{}
      let exifTool = getExifMetadataFromData(downloaded.data)
      if exifTool.isSome:
        metadata["exif"] = exifTool.get()
      mergeParsedExif(metadata, downloaded.data)
      for key in ["exif", "exifSummary"]:
        if metadata.hasKey(key):
          response[key] = metadata[key]
  except CatchableError as err:
    # As in httpRequest: no URL past its origin in the text an app may draw.
    let message = redactedUrlsIn(err.msg)
    response["error"] = %*message
    frameos_apps.logError(e.owner, "JS app fetchImage failed: " & message)
  return nimStringToJS(ctx, $response)

proc assetsRoot(e: JsAppEvalEnv): string =
  ## The sandbox root for this app's asset calls: the frame-wide assets
  ## folder, or the scene's own subtree for an app that asks for no assets
  ## permission (agOwnFolder) and for every app on a frame whose
  ## `js.assetSandbox` is "scene".
  let frameConfig = e.owner.frameConfig
  result = if frameConfig == nil or frameConfig.assetsPath == "": "/srv/assets"
           else: frameConfig.assetsPath
  result.removeSuffix('/')
  if e.runtime.assetGrant == agOwnFolder or
      (frameConfig != nil and frameConfig.js != nil and frameConfig.js.assetSandbox == "scene"):
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

proc resolveAssetPath(e: JsAppEvalEnv, relPath: string, write = false): string =
  ## Absolute path inside the assets folder, or "" when the path is empty,
  ## absolute, or escapes the folder, or is a `write` from an app that asks
  ## only to read the folder (agRead). One check here rather than one per
  ## write call: every caller already handles "", and every extra exit in
  ## jsAssets repeats the cleanup of all its live strings (ESP32 flash).
  ##
  ## The containment check runs against the *real* path, not the lexical one:
  ## normalizedPath does not follow symlinks, so a link planted inside the
  ## assets folder used to be a legal way out of it.
  if relPath.len == 0 or relPath.startsWith("/") or relPath.isAbsolute() or
      containsPathTraversal(relPath) or (write and e.runtime.assetGrant == agRead):
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

const
  EmbeddedAssetReadMaxBytes = 2 * 1024 * 1024
  AssetPathRefused = ": invalid asset path, or a write the app's permissions do not include: "

proc jsAssetReadMaxBytes(e: JsAppEvalEnv): int =
  ## Full-buffer asset reads triple in RAM (bytes + base64 + JS string), so
  ## embedded targets get a small cap; larger files must use ranged reads.
  when defined(frameosEmbedded):
    min(jsFetchMaxBytes(e), EmbeddedAssetReadMaxBytes)
  else:
    jsFetchMaxBytes(e)

proc writeAssetFile(e: JsAppEvalEnv, opName: string, pathStr: string,
    contents: string, append: bool): bool =
  let full = resolveAssetPath(e, pathStr, write = true)
  if full.len == 0:
    frameos_apps.logError(e.owner, "JS app " & opName & AssetPathRefused & pathStr)
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
      let full = resolveAssetPath(e, pathStr, write = true)
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
      # The photo's own colour profile, if the Assets panel wrote one
      # (utils/asset_colors) — the same treatment data/localImage gives it.
      let colorProfile = loadAssetColorProfile(full)
      if colorProfile.isSome:
        if colorProfile.get().hasPaletteOverride():
          setRenderPaletteOverride(colorProfile.get().palette)
        else:
          clearRenderPaletteOverride()
        if colorProfile.get().hasAdjustments():
          applyAssetColors(image, colorProfile.get())
          markImageGraded(image)
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
      let full = resolveAssetPath(e, pathStr, write = mode != "r")
      if full.len == 0:
        frameos_apps.logError(e.owner, "JS app openAssetStream" & AssetPathRefused & pathStr)
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

proc jsxScale(runtime: JsAppRuntime, owner: AppRoot): float =
  ## The render scale a .tsx or .jsx app lays out for: the scene's or the
  ## frame's (render_scale.nim). 1 for any other app, which keeps the panel's
  ## pixels (a photo fetched for its size wants every one).
  # The main module is app.ts, app.js, app.tsx or app.jsx (JsAppSourceNames):
  # the last two, and only they, end in "x".
  if runtime.isNil or owner.isNil or not runtime.sourceName.endsWith('x'):
    return 1.0
  effectiveRenderScale(owner.scene, owner.frameConfig)

proc appLength(ctx: ptr JSContext, e: JsAppEvalEnv, length: int): JSValue =
  ## A canvas or panel length as the app sees it: divided by the render
  ## scale for a .tsx or .jsx app (render_scale.nim).
  nimIntToJS(ctx, scaledLength(length, e.runtime.jsxScale(e.owner)).int32)

proc jsGetAppFrame(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  case toNimString(ctx, key)
  of "width":
    # A .tsx app at render scale 2 is on a panel half the size (render_scale.nim).
    return appLength(ctx, e, e.owner.frameConfig.width)
  of "height":
    return appLength(ctx, e, e.owner.frameConfig.height)
  of "scale":
    # The render scale in effect for the scene, whatever kind of app asks.
    return nimFloatToJS(ctx, effectiveRenderScale(e.owner.scene, e.owner.frameConfig))
  of "rotate":
    return nimIntToJS(ctx, e.owner.frameConfig.rotate.int32)
  of "assetsPath":
    return nimStringToJS(ctx, e.owner.frameConfig.assetsPath)
  of "timeZone":
    return nimStringToJS(ctx, e.owner.frameConfig.timeZone)
  of "debug":
    return nimBoolToJS(ctx, e.owner.frameConfig.debug)
  of "embedded":
    # An ESP32-class runtime, or the preview running as one: no storage for
    # assets, a few MB of PSRAM. The OpenAI image app asks for a lighter
    # picture there.
    return nimBoolToJS(ctx, runsAsEmbedded())
  else:
    return jsUndefSentinel(ctx)

proc jsGetAppContext(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let keyStr = toNimString(ctx, key)
  case keyStr
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
        # The app may read or draw on the canvas: it holds the background.
        paintPendingBackground(e.context)
        e.contextImageJson = e.runtime.storeTransientImageJson(e.context.image)
      return jsonToJS(ctx, e.contextImageJson)
    return jsUndefSentinel(ctx)
  of "imageWidth":
    if e.context.hasImage and not e.context.image.isNil:
      return appLength(ctx, e, e.context.image.width)
    return jsUndefSentinel(ctx)
  of "imageHeight":
    if e.context.hasImage and not e.context.image.isNil:
      return appLength(ctx, e, e.context.image.height)
    return jsUndefSentinel(ctx)
  of "targetWidth", "targetHeight", "targetFit":
    let target = e.owner.addressedTarget(e.context)
    if target.width > 0:
      case keyStr
      of "targetWidth": return appLength(ctx, e, target.width)
      of "targetHeight": return appLength(ctx, e, target.height)
      else:
        if target.fit.len > 0:
          return nimStringToJS(ctx, target.fit)
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
    keys = @["width", "height", "rotate", "assetsPath", "timeZone", "debug", "embedded", "scale"]
  of "context":
    keys = @["event", "hasImage", "payload", "loopIndex", "loopKey", "nextSleep"]
    if e.context.hasImage and not e.context.image.isNil:
      keys.add("image")
      keys.add("imageWidth")
      keys.add("imageHeight")
    let target = e.owner.addressedTarget(e.context)
    if target.width > 0:
      keys.add("targetWidth")
      keys.add("targetHeight")
      if target.fit.len > 0:
        keys.add("targetFit")
  else:
    discard

  let arr = newJArray()
  for key in keys:
    arr.add(%*key)
  return jsonToJS(ctx, arr)

proc newJsAppRuntime*(category: string, outputType: string, source: string,
    settingsKeys: seq[string] = @[], sourceName: string = "",
    sources: JsonNode = nil, assetGrant = agOwnFolder): JsAppRuntime =
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
    assetGrant: assetGrant,
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

const MaxKeptImages = 8
  ## Pictures an app may keep at once; the oldest goes for a ninth.

proc storeKeptImageJson(runtime: JsAppRuntime, owner: AppRoot, image: Image): JsonNode =
  result = runtime.storeImageJson(image)
  if result.kind == JObject:
    runtime.keptImageIds.add(result["id"].getInt())
    if runtime.keptImageIds.len > MaxKeptImages:
      runtime.images.del(runtime.keptImageIds[0])
      runtime.keptImageIds.delete(0)
      frameos_apps.log(owner, %*{"event": "js:keptImages", "dropped": "oldest",
        "limit": MaxKeptImages})

proc releaseKeptImage(runtime: JsAppRuntime, id: int): bool =
  let at = runtime.keptImageIds.find(id)
  if at < 0:
    return false
  runtime.keptImageIds.delete(at)
  runtime.images.del(id)
  true

proc jsReleaseImage(ctx: ptr JSContext, id: JSValue): JSValue {.nimcall.} =
  ## `frameos.releaseImage(ref)`: a kept picture goes; false for any other.
  let e = env(ctx)
  if e == nil:
    return nimBoolToJS(ctx, false)
  nimBoolToJS(ctx, e.runtime.releaseKeptImage(toNimFloat(ctx, id).int))

const MaxCanvases = 4
  ## Canvases an app may draw into at once; a fifth key lets the oldest go.

proc canvasImage(runtime: JsAppRuntime, id: int): Image =
  for canvas in runtime.canvases:
    if canvas.id == id:
      return runtime.images.getOrDefault(id, nil)

proc pictureFormatLike(context: ExecutionContext): Image =
  ## An image in the canvas's pixel format, if one is about: what an app's
  ## own picture is made like, so drawing it later is a copy.
  if context.isNil: nil
  elif not context.decodeTargetImage.isNil: context.decodeTargetImage
  else: context.contextImage()

proc jsCanvas(ctx: ptr JSContext, key: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## `frameos.canvas(key, width, height, color)`: the app's canvas called
  ## `key`, made and filled with `color` (white by default) the first time,
  ## or again when the size changed. The same picture every render while
  ## the interpreter lives; `fresh` says it was just made, so the app draws
  ## its record into it again.
  let e = env(ctx)
  if e == nil:
    return nimStringToJS(ctx, "null")
  let name = toNimString(ctx, key)
  var options = newJObject()
  try:
    options = parseJson(toNimString(ctx, optionsJson))
  except CatchableError:
    discard
  let
    width = options{"width"}.getInt(0)
    height = options{"height"}.getInt(0)
  if width <= 0 or height <= 0 or width * height > 4096 * 4096:
    frameos_apps.logError(e.owner, "frameos.canvas needs a width and a height")
    return nimStringToJS(ctx, "null")
  let runtime = e.runtime
  var
    id = 0
    fresh = false
  for canvas in runtime.canvases:
    if canvas.key == name:
      let image = runtime.images.getOrDefault(canvas.id, nil)
      if not image.isNil and image.width == width and image.height == height:
        id = canvas.id
  if id == 0:
    try:
      for i in countdown(runtime.canvases.high, 0):
        if runtime.canvases[i].key == name or
            (runtime.canvases.len >= MaxCanvases and i == 0):
          unregisterCanvas(runtime.images.getOrDefault(runtime.canvases[i].id, nil))
          runtime.images.del(runtime.canvases[i].id)
          runtime.canvases.delete(i)
      let like = pictureFormatLike(e.context)
      let image = if like.isNil: newImage(width, height) else: newImageLike(like, width, height)
      if not like.isNil:
        image.ditherStores = like.ditherStores
      let color = options{"color"}.getStr("")
      image.fill(parseHtmlColor(if color.len > 0: color else: "#ffffff").rgbx)
      inc runtime.nextImageId
      id = runtime.nextImageId
      runtime.images[id] = image
      runtime.canvases.add((name, id))
      discard registerCanvas(image)
      fresh = true
    except CatchableError as err:
      frameos_apps.logError(e.owner, "frameos.canvas failed: " & err.msg)
      return nimStringToJS(ctx, "null")
  let log = canvasLogOf(runtime.images[id])
  nimStringToJS(ctx, $(%*{"__frameosType": "imageRef", "id": id, "width": width, "height": height,
    "canvas": name, "version": (if log.isNil: 0 else: log.version), "fresh": fresh}))

proc jsCanvasDraw(ctx: ptr JSContext, id: JSValue, content: JSValue): JSValue {.nimcall.} =
  ## `frameos.draw(canvas, content)`: SVG drawn into the canvas's pixels,
  ## over what is there. `content` is JSX (`<line .../>`, `<g>`, `<path>`,
  ## an `<svg viewBox>`) or SVG markup, in the canvas's pixels unless an
  ## `<svg>` says otherwise. Only the box it touches is drawn, and noted
  ## for the frames that show the canvas.
  let e = env(ctx)
  if e == nil:
    return nimBoolToJS(ctx, false)
  let image = e.runtime.canvasImage(toNimFloat(ctx, id).int)
  if image.isNil:
    return nimBoolToJS(ctx, false)
  try:
    let size = [("width", $image.width), ("height", $image.height)]
    var node: SvgNode
    if jsIsString(content):
      let markup = toNimString(ctx, content)
      node = svgRoot(if markup.strip().startsWith("<svg"): markup
        else: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" & $image.width &
          "\" height=\"" & $image.height & "\">" & markup & "</svg>")
    else:
      node = jsxNode(ctx, content, addr e.runtime.images, drawing = true)
      if node.tag != "svg":
        node = SvgNode(tag: "svg", attrs: @size, children: @[node])
    if node.attr("viewBox").len == 0 and node.attr("width").len == 0:
      for (name, value) in size:
        node.setAttr(name, value)
    let
      drawn = parseSvg(node, image.width, image.height)
      nothing = parseSvg(SvgNode(tag: "svg", attrs: @size), image.width, image.height)
      box = damage(nothing, drawn, image.width, image.height)
    if box.w <= 0 or box.h <= 0:
      return nimBoolToJS(ctx, true)
    if box.full or (box.w == image.width and box.h == image.height):
      drawn.renderInto(image)
    else:
      drawn.renderInto(image.view(box.x, box.y, box.w, box.h), box.x, box.y)
    let log = registerCanvas(image)
    log.drew(rect(box.x.float32, box.y.float32, box.w.float32, box.h.float32))
    return nimBoolToJS(ctx, true)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "frameos.draw failed: " & err.msg)
    return nimBoolToJS(ctx, false)

proc jsCanvasClear(ctx: ptr JSContext, id: JSValue, color: JSValue): JSValue {.nimcall.} =
  ## `frameos.clear(canvas, color)`: the canvas filled (white by default).
  let e = env(ctx)
  if e == nil:
    return nimBoolToJS(ctx, false)
  let image = e.runtime.canvasImage(toNimFloat(ctx, id).int)
  if image.isNil:
    return nimBoolToJS(ctx, false)
  try:
    let name = toNimString(ctx, color)
    image.fill(parseHtmlColor(if name.len > 0: name else: "#ffffff").rgbx)
    registerCanvas(image).drew(rect(0, 0, image.width.float32, image.height.float32))
    return nimBoolToJS(ctx, true)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "frameos.clear failed: " & err.msg)
    return nimBoolToJS(ctx, false)

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
      # One name may be declared more than once, each behind its own showIf
      # (openaiImage's `size` per model). The first declaration supplies the
      # default, as it does for a Nim app's loader and the editor's typings.
      if fieldTypes.hasKey(name) or result.hasKey(name):
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

proc assetGrantFromConfig*(config: JsonNode): JsAssetGrant =
  ## config.json `permissions`: exactly what the app asks for. No list, or a
  ## value that is not one, asks for nothing.
  result = agOwnFolder
  let declared = config{"permissions"}
  if not declared.isNil and declared.kind == JArray:
    for item in declared.elems:
      case item.getStr()
      of "assets-write": result = agReadWrite
      of "assets", "files": result = max(result, agRead)
      else: discard

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
                                jsAppSourceNameFromSources(sources), sources,
                                assetGrantFromConfig(config))
  return DynamicJsApp(
    nodeId: node.id,
    nodeName: node.data{"name"}.getStr(keyword),
    appKeyword: keyword,
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
  ## and `liveJsRuntimes` holds a reference to every runtime it has ever
  ## readied, so nothing about dropping the scene makes one collectable.
  ## The cost is per NODE, not per scene: the bundled Weather scene builds four
  ## (~148 KB of PSRAM each, measured with -d:memProbe), so a frame cycling
  ## between two JS scenes used to shed a few hundred KB per switch and reboot
  ## itself after about seven.
  if not (app of DynamicJsApp):
    return
  if not app.scene.isNil:
    forgetUiTarget(app.scene.id.string, app.nodeId.int)
  let runtime = DynamicJsApp(app).runtime
  if runtime.isNil:
    return
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

proc ensureReady(runtime: JsAppRuntime, frameConfig: FrameConfig, sceneId: string = "") =
  ## `sceneId` joins this runtime to the owning scene's shared heap budget
  ## (runtime.sceneHeapBudgetFor): every JS app node of a scene draws on one
  ## ceiling instead of each getting the full per-runtime limit.
  if runtime.ready:
    return

  when defined(frameosEmbedded):
    # Reclaim the other nodes' interpreters before building this one.
    evictIdleJsRuntimes(runtime)
  if not liveJsRuntimes.contains(runtime):
    liveJsRuntimes.add(runtime)

  when defined(memProbe): memProbe("    newQuickJS BEFORE")
  runtime.js = newQuickJS(sceneJsConfig(frameConfig, sceneId))
  when defined(memProbe): memProbe("    newQuickJS AFTER")
  jsAppRuntimeByCtx[runtime.js.context] = runtime
  runtime.js.setModuleLoader(jsAppModuleLoader, jsAppModuleNormalize)
  runtime.js.registerFunction("jsAppLog", jsAppLog)
  runtime.js.registerFunction("jsSetNextSleep", jsSetNextSleep)
  runtime.js.registerFunction("jsSetState", jsSetState)
  runtime.js.registerFunction("jsRemember", jsRemember)
  runtime.js.registerFunction("jsRecall", jsRecall)
  runtime.js.registerFunction("jsFetchText", jsFetchText)
  runtime.js.registerFunction("jsHttpRequest", jsHttpRequest)
  runtime.js.registerFunction("jsFetchImage", jsFetchImage)
  runtime.js.registerFunction("jsReleaseImage", jsReleaseImage)
  runtime.js.registerFunction("jsCanvas", jsCanvas)
  runtime.js.registerFunction("jsCanvasDraw", jsCanvasDraw)
  runtime.js.registerFunction("jsCanvasClear", jsCanvasClear)
  runtime.js.registerFunction("jsAssets", jsAssets)
  runtime.js.registerFunction("jsStreams", jsStreams)
  runtime.js.registerFunction("jsGetSetting", jsGetSetting)
  runtime.js.registerFunction("jsGetAppMeta", jsGetAppMeta)
  runtime.js.registerFunction("jsGetAppConfig", jsGetAppConfig)
  runtime.js.registerFunction("jsGetAppState", jsGetAppState)
  runtime.js.registerFunction("jsGetAppFrame", jsGetAppFrame)
  runtime.js.registerFunction("jsGetAppContext", jsGetAppContext)
  runtime.js.registerFunction("jsGetAppKeys", jsGetAppKeys)
  discard runtime.js.eval(static(compactJs("""
  "use strict";
  const __jsReplacer = (k, v) =>
    (typeof v === 'bigint') ? { __bigint: v.toString() } : v;
  globalThis.__frameosStringify = (v) => JSON.stringify(v, __jsReplacer);
  globalThis.__frameosSpecRest = (s) => { const r = { ...s }; delete r.svg; return r; };
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
  // What every asset and stream call below shares.
  const __frameosAsset = (op, path, data = "") => __frameosUnwrap(jsAssets(op, String(path || ""), data));
  const __frameosStream = (op, options) => __frameosUnwrap(jsStreams(op, JSON.stringify(options)));
  const __frameosStreamId = (ref) => (ref && ref.id) || ref;
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
    fetchImage: (url, options) => JSON.parse(
      jsFetchImage(String(url || ""), JSON.stringify(options || {}, __jsReplacer)) || '{"image":null}'
    ),
    releaseImage: (ref) => jsReleaseImage(Number(((ref && ref.image) || ref || {}).id || 0)) === true,
    canvas: (key, width, height, color) => JSON.parse(jsCanvas(String(key || "canvas"),
      JSON.stringify({ width: Number(width || 0), height: Number(height || 0), color: String(color || "") }))),
    draw: (canvas, content) => jsCanvasDraw(Number((canvas && canvas.id) || 0),
      (content && typeof content === "object") ? content : String(content || "")) === true,
    clear: (canvas, color) => jsCanvasClear(Number((canvas && canvas.id) || 0), String(color || "")) === true,
    listAssets: (dir) => __frameosAsset("list", dir) || [],
    assetExists: (path) => __frameosAsset("exists", path) === true,
    assetSize: (path) => __frameosAsset("size", path) ?? -1,
    readAsset: (path, options) => __frameosAsset("read", path, options ? JSON.stringify(options) : "") ?? null,
    writeAsset: (path, base64) => __frameosAsset("write", path, String(base64 || "")) === true,
    appendAsset: (path, base64) => __frameosAsset("append", path, String(base64 || "")) === true,
    deleteAsset: (path) => __frameosAsset("delete", path) === true,
    loadAssetImage: (path) => __frameosAsset("image", path) ?? null,
    openAssetStream: (path, mode) => __frameosStream("openAsset", { path: String(path || ""), mode: String(mode || "r") }) ?? null,
    createStream: (base64) => __frameosStream("create", { base64: String(base64 || "") }) ?? null,
    streamRead: (ref, length) => __frameosStream("read", { id: __frameosStreamId(ref), length }) ?? null,
    streamWrite: (ref, base64) => __frameosStream("write", { id: __frameosStreamId(ref), base64: String(base64 || "") }) === true,
    streamAtEnd: (ref) => __frameosStream("atEnd", { id: __frameosStreamId(ref) }) === true,
    streamRewind: (ref) => __frameosStream("rewind", { id: __frameosStreamId(ref) }) === true,
    streamClose: (ref) => __frameosStream("close", { id: __frameosStreamId(ref) }) === true,
    getSetting: (...path) => __frameosUnwrap(jsGetSetting(
      JSON.stringify(path.flat().map((p) => String(p)))
    )),
    setState: (key, value) => jsSetState(
      String(key || ""),
      JSON.stringify(value === undefined ? null : value, __jsReplacer)
    ),
    remember: (key, value) => jsRemember(
      String(key || ""),
      JSON.stringify(value === undefined ? null : value, __jsReplacer)
    ) === true,
    recall: (key) => {
      const kept = jsRecall(String(key || ""));
      return kept ? JSON.parse(kept) : undefined;
    },
  };
  // console.log and friends, so an app written like any other JavaScript
  // logs like frameos.log: strings as they are, the rest as JSON, one line
  // per call. warn is a log line that says so; error goes to the error log.
  const console = {
    log: frameos.log, info: frameos.log, debug: frameos.log, error: frameos.error,
    warn: (...args) => jsAppLog("warn", JSON.stringify(args, __jsReplacer)),
  };
  globalThis.__frameosModule = {};
  const exports = globalThis.__frameosModule;
  function __frameosWrapApp(app) {
    return Object.assign(app || {}, { log: frameos.log, logError: frameos.error });
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
  // A node in a flow calls run(), a node feeding a field calls get(). An app
  // without the one its node needs does nothing, so say so, once.
  const __frameosMissing = {};
  // A JSX UI's onClick (and friends), numbered by the walker (js_runtime/jsx.nim).
  globalThis.__frameosHandle = (id, event, type, localX, localY, width, height) => {
    const handler = (globalThis.__frameosHandlers || [])[id];
    if (typeof handler === "function") handler({ ...JSON.parse(event), type, localX, localY, width, height });
  };
  function __frameosInvoke(name) {
    const mod = __frameosExports();
    const fn = mod && mod[name];
    if (name === "get") globalThis.__frameosRender = (globalThis.__frameosRender | 0) + 1;
    if (typeof fn === "function") {
      return fn(globalThis.__frameosAppInstance, globalThis.__frameosContext);
    }
    if (name !== "init" && !__frameosMissing[name]) {
      __frameosMissing[name] = true;
      jsAppLog("error", JSON.stringify([name === "run"
        ? "This app has no run(), so it does nothing in a flow: a node after an event calls run(app, context), and get() only when its output feeds a field."
        : "This app has no get(), so its output is empty: a node feeding a field calls get(app, context), and run() only in a flow."]));
    }
    return undefined;
  }
  """ & sceneJsPrelude)))
  # The test harness, when this runtime runs an app's tests (app_tests.nim):
  # after the prelude so it can wrap `frameos`, before the module so the
  # module's describe() calls land in it.
  if runtime.extraPrelude.len > 0:
    discard runtime.js.eval(runtime.extraPrelude, "frameos-test-harness.js")
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

proc svgIntoOfferedTarget(owner: AppRoot, context: ExecutionContext, svg: SvgNode,
    requestedWidth, requestedHeight: int, reuse = false): Image =
  ## Rasterizes an SVG into the target the planner offered this node, when
  ## there is one of the size the scene asked for; nil when the caller should
  ## rasterize standalone.
  ##
  ## Paint the cell directly first. The target is the cell of the live
  ## canvas or the chain's scratch — it exists already, so rendering into it
  ## costs the SVG's own paths and the paint strips pixie sizes to the budget,
  ## and nothing the size of the cell. The raster bound
  ## (boundedRequestedDimensions) assumes a fresh full-size buffer, which this
  ## path never allocates, so it is not consulted here: it is what left the
  ## E1004's hourly chart at 286x229 in a 1200x960 cell (2026-09-05) — 2 MB of
  ## free PSRAM with an 848 KB largest block put the bound at the 65,536-pixel
  ## floor, the size mismatch skipped the into-target render, and a
  ## `render/image` placed with "center" drew the capped raster as-is.
  ##
  ## Only when pixie refuses the direct render (a budget refusal inside a
  ## fill) does this step down the same ladder as a decode: the bounded
  ## raster, then half and a quarter of it, each stretched onto the target.
  ## Soft beats tiny, and the render:degraded line says which frames are soft.
  let (offeredWidth, offeredHeight) = owner.offeredDecodeTargetSize(context)
  if svg.isNil or offeredWidth <= 0 or offeredHeight <= 0:
    return nil
  if offeredWidth != requestedWidth or offeredHeight != requestedHeight:
    # An offer of some other size (a planner that scaled the cell): only a
    # raster of exactly that size can claim it.
    # The bound walks the PSRAM heap on an ESP32, so it is worked out only
    # here and where the SVG is rasterized standalone, never per frame for
    # a target of the requested size.
    let (rasterWidth, rasterHeight) = boundedRequestedDimensions(requestedWidth, requestedHeight)
    if offeredWidth == rasterWidth and offeredHeight == rasterHeight:
      let (target, _) = owner.takeDecodeTarget(context)
      if not target.isNil and renderSvgIntoTarget(svg, target):
        return target
    return nil
  # The live canvas may still owe the scene's background: an SVG that begins
  # with a full-canvas opaque rect waives it (a whole pass over the canvas
  # saved), any other pays it first (renderSvgIntoTarget).
  let (target, _) = owner.takeDecodeTarget(context, deferBackground = true)
  if target.isNil:
    return nil
  var owed = takeOwedBackground(context, target)
  # An LCD's buffer that only this SVG draws repaints just what changed
  # (utils/svg_frames.nim); anything else, and a refusal there, as before.
  var rendered = renderSvgFrame(svg, target, owed, context.wholeFrame, reuse)
  if not rendered and releaseRenderMemory():
    # A kept interpreter held what the fill needed: it goes, the frame stays.
    rendered = renderSvgFrame(svg, target, owed, context.wholeFrame, reuse)
  if not rendered:
    rendered = renderSvgIntoTargetWithDegrade(svg, target, owed)
  if owed.isSome:
    # Nothing could be drawn: the consumer paints over a background.
    payBackground(target, owed.get())
  if rendered:
    return target
  nil

proc imageFromSpec(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, spec: JsonNode): Image =
  if spec.isNil or spec.kind == JNull:
    return nil

  if spec.kind == JString:
    var data = spec.getStr()
    if data.startsWith("data:"):
      return decodeDataUrl(data)
    if data.startsWith("<svg") or data.startsWith("<?xml") or data.contains("<svg"):
      let requestedWidth = defaultImageWidth(owner, context, %*{})
      let requestedHeight = defaultImageHeight(owner, context, %*{})
      let root = svgRoot(data)
      let degraded = svgIntoOfferedTarget(owner, context, root, requestedWidth, requestedHeight)
      if not degraded.isNil:
        return degraded
      let (svgWidth, svgHeight) = boundedRequestedDimensions(requestedWidth, requestedHeight)
      let image = decodeSvgWithFallback(root, svgWidth, svgHeight)
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
      let requestedWidth = defaultImageWidth(owner, context, spec)
      let requestedHeight = defaultImageHeight(owner, context, spec)
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
      # `.str`, not getStr: the markup is not copied on its way to the parser.
      let svgNode = spec["svg"]
      let root = if svgNode.kind == JString: svgRoot(svgNode.str) else: nil
      let intoTarget = svgIntoOfferedTarget(owner, context, root, requestedWidth, requestedHeight)
      if not intoTarget.isNil:
        when defined(memProbe): memProbe("    svg decode AFTER (into target)")
        return intoTarget
      let (svgWidth, svgHeight) = boundedRequestedDimensions(requestedWidth, requestedHeight)
      let image = decodeSvgWithFallback(root, svgWidth, svgHeight)
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

proc callJsxHandler(runtime: JsAppRuntime, owner: AppRoot, handler: int, name: string,
    event: JsonNode, hit: UiHit) =
  ## Runs an onClick (onLongPress, ...) of the UI's last render in its app,
  ## with the bridge set up as for get(). An interpreter released since then
  ## took its handlers with it: nothing runs, and the render that follows
  ## draws the UI afresh.
  if not runtime.ready:
    return
  let
    ctx = runtime.js.context
    configJson = if owner of DynamicJsApp: DynamicJsApp(owner).configJson else: newJObject()
  runtime.midCall:
    jsAppEnvByCtx[ctx] = JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson,
      context: ExecutionContext(scene: owner.scene, event: name, payload: event, loopKey: ".", nextSleep: -1))
    var args {.noinit.}: array[7, JSValue]
    args[0] = JS_NewInt32(ctx, handler.int32)
    args[1] = nimStringToJS(ctx, $event)
    args[2] = nimStringToJS(ctx, name)
    # localX, localY, width, height: one call for the four, where each
    # JS_NewFloat64 inlined is over 100 bytes of soft-float double on an ESP32.
    for i in 0 .. 3:
      args[3 + i] = nimFloatToJS(ctx, hit[i])
    let returned = callGlobalFunction(ctx, "__frameosHandle", args)
    for arg in args:
      JS_FreeValue(ctx, arg)
    jsAppEnvByCtx.del(ctx)
    if JS_IsException(returned) != 0:
      frameos_apps.logError(owner, "JS app handler failed: " & mappedJsExceptionDetails(ctx).message)
    JS_FreeValue(ctx, returned)

proc keepUiRegions(runtime: JsAppRuntime, owner: AppRoot, sceneId: string,
    regions: var seq[UiRegion], x, y: int, scale: float32) =
  ## What the pointer can do to the UI just drawn with its corner at x, y,
  ## `scale` canvas pixels to each of its own.
  let target = uiTarget(sceneId, owner.nodeId.int)
  target.regions = move(regions)
  target.offsetX = x.float32
  target.offsetY = y.float32
  target.scale = scale
  # Into the app that drew these regions, every render: the scene can be
  # loaded again since the last one (a switch away and back), with a new app.
  target.call = proc(handler: int, name: string, event: JsonNode, hit: UiHit) {.closure, raises: [].} =
    try:
      runtime.callJsxHandler(owner, handler, name, event, hit)
    except Exception:
      discard # a handler's failure is logged; one in the logging has nowhere to go

proc imageFromJsx(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, root: SvgNode): Image =
  ## A JSX tree an app returned: an `<svg>` drawn as it is, anything else a
  ## UI laid out at the size of the image asked for (ui/layout.nim) and drawn
  ## as the SVG that makes. The same road as `frameos.svg` from there: into
  ## the target the planner offered when there is one, repainting only what
  ## changed on an LCD, else rasterized on its own.
  ##
  ## A UI's handlers, hover: and active: classes leave regions behind for the
  ## pointer (ui/events.nim), placed where the UI lands in the canvas: the
  ## offered cell's corner, or the canvas's when the UI is the canvas's size.
  ##
  ## At render scale 2 (render_scale.nim) a UI is laid out at half the size
  ## and the `<svg width height>` that makes is drawn at the full size: pixie
  ## stretches the root to the target as vectors. An app's own `<svg>` was
  ## made for the size the app was told, so it is stretched the same way.
  let
    requestedWidth = defaultImageWidth(owner, context, %*{})
    requestedHeight = defaultImageHeight(owner, context, %*{})
    scale = runtime.jsxScale(owner)
    layoutWidth = scaledLength(requestedWidth, scale)
    layoutHeight = scaledLength(requestedHeight, scale)
    # What the pointer is divided by: the layout's rounded size, exactly. In
    # float32, as UiTarget keeps it (a double is a library call on an ESP32-S3).
    regionScale = requestedWidth.float32 / max(layoutWidth, 1).float32
    sceneId = if owner.scene.isNil: "" else: owner.scene.id.string
  var
    svg = root
    regions: seq[UiRegion]
  let target = uiTarget(sceneId, owner.nodeId.int, create = root.tag != "svg")
  if root.tag != "svg":
    try:
      svg = layoutUi(root, layoutWidth, layoutHeight, target.input, regions, target.memo)
    except CatchableError as error:
      frameos_apps.logError(owner, "JS app returned a UI that failed to lay out: " & error.msg)
      return nil
  # A UI's nodes come back from the layout where they did not change.
  let intoTarget = svgIntoOfferedTarget(owner, context, svg, requestedWidth, requestedHeight,
    reuse = root.tag != "svg")
  if not intoTarget.isNil:
    if intoTarget.width == requestedWidth and intoTarget.height == requestedHeight:
      if regions.len > 0 or not target.isNil:
        runtime.keepUiRegions(owner, sceneId, regions, intoTarget.origin mod max(intoTarget.stride, 1),
          intoTarget.origin div max(intoTarget.stride, 1), regionScale)
    return intoTarget
  let (svgWidth, svgHeight) = boundedRequestedDimensions(requestedWidth, requestedHeight)
  let image = decodeSvgWithFallback(svg, svgWidth, svgHeight)
  if image.isSome:
    let (canvasWidth, canvasHeight) =
      if context.hasImage and not context.image.isNil: (context.image.width, context.image.height)
      else: (frameos_apps.renderWidth(owner.frameConfig), frameos_apps.renderHeight(owner.frameConfig))
    if svgWidth == canvasWidth and svgHeight == canvasHeight and (regions.len > 0 or not target.isNil):
      runtime.keepUiRegions(owner, sceneId, regions, 0, 0, regionScale)
    return image.get()
  frameos_apps.logError(owner, "JS app returned JSX that failed to render: " &
    svgDecodeError(svg, svgWidth, svgHeight))
  nil

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

proc plainSpecRestFromJs(ctx: ptr JSContext, payload: JSValueConst): JsonNode =
  ## The spec's own enumerable properties but `svg`, read one at a time when
  ## each is a string, a number, a boolean, null or undefined — what
  ## `frameos.svg(markup, {width, height})` makes — exactly as the JSON
  ## round trip below reads them (undefined dropped, NaN and infinities
  ## null). nil when one is anything else, which then takes that round
  ## trip: a call into JS, a stringify and a parse, 3 ms of an animated
  ## frame on an ESP32.
  var
    tab: ptr UncheckedArray[JSPropertyEnum]
    count: uint32
  if JS_GetOwnPropertyNames(ctx, addr tab, addr count, payload,
      (JS_GPN_STRING_MASK or JS_GPN_ENUM_ONLY).cint) != 0:
    JS_FreeValue(ctx, JS_GetException(ctx))
    return nil
  defer: JS_FreePropertyEnum(ctx, tab, count)
  result = newJObject()
  for i in 0 ..< count.int:
    let name = JS_AtomToString(ctx, tab[i].atom)
    let key = toNimString(ctx, name)
    JS_FreeValue(ctx, name)
    if key == "svg":
      continue
    let value = JS_GetProperty(ctx, payload, tab[i].atom)
    try:
      if jsIsString(value):
        result[key] = %toNimString(ctx, value)
      elif jsIsBool(value):
        result[key] = %toNimBool(ctx, value)
      elif jsIsNull(value):
        result[key] = newJNull()
      elif jsIsUndefined(value):
        discard
      elif jsIsNumber(value):
        let f = toNimFloat(ctx, value)
        result[key] = if f.isNaN or f == Inf or f == NegInf: newJNull() else: jsValueToJson(ctx, value)
      else:
        return nil
    finally:
      JS_FreeValue(ctx, value)

proc svgImageSpecFromJs(ctx: ptr JSContext, payload: JSValueConst): JsonNode =
  ## A `frameos.svg(...)` spec read straight off the object: the markup is
  ## copied out as a string and only the small rest of the spec goes through
  ## JSON. Stringifying a 4 KB SVG and parsing it back cost a 480x480 frame
  ## 12 ms on an ESP32. nil when `payload` is not such a spec.
  if not jsIsObject(payload):
    return nil
  let kind = JS_GetPropertyStr(ctx, payload, "__frameosType")
  defer: JS_FreeValue(ctx, kind)
  if not jsIsString(kind) or toNimString(ctx, kind) != "image":
    return nil
  let svg = JS_GetPropertyStr(ctx, payload, "svg")
  defer: JS_FreeValue(ctx, svg)
  if not jsIsString(svg):
    return nil
  result = plainSpecRestFromJs(ctx, payload)
  if not result.isNil:
    result["svg"] = %toNimString(ctx, svg)
    return
  let rest = callGlobalFunction(ctx, "__frameosSpecRest", [payload])
  defer: JS_FreeValue(ctx, rest)
  if JS_IsException(rest) != 0:
    JS_FreeValue(ctx, JS_GetException(ctx))
    return nil
  result = jsValueToJson(ctx, rest)
  if result.kind != JObject:
    return nil
  result["svg"] = %toNimString(ctx, svg)

proc toValue(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, payload: JSValueConst, expectedType: string): Value =
  let ctx = runtime.js.context

  if jsIsUndefined(payload) or jsIsNull(payload):
    if expectedType.len > 0:
      return valueFromJsonByType(newJNull(), expectedType)
    return VNone()

  if expectedType in ["image", ""] and jsIsObject(payload):
    # JSX (`<svg>`, `<div className="flex">`) read straight off the objects
    # the prelude's __frameosJsx made. `<image>` is the plain canvas spec it
    # has always been.
    let tag = jsxTag(ctx, payload)
    if tag.len > 0 and tag != "image":
      runtime.lastJsx = jsxNode(ctx, payload, addr runtime.images, addr runtime.jsxMemo)
      return VImage(runtime.imageFromJsx(owner, context, runtime.lastJsx))

  if expectedType == "image" or jsIsObject(payload) or JS_IsArray(ctx, payload) != 0:
    let svgSpec = svgImageSpecFromJs(ctx, payload)
    if not svgSpec.isNil:
      return runtime.toValue(owner, context, svgSpec, expectedType)
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

type JsAppError* = object of CatchableError
  ## A JS app's get() threw. The message is the JS error's; the mapped stack
  ## is already logged.

proc invoke(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext, fnName: string,
    raiseOnError = false): JSValue =
  ensureReady(runtime, owner.frameConfig, if owner.scene.isNil: "" else: owner.scene.id.string)
  let ctx = runtime.js.context
  let fnNameValue = nimStringToJS(ctx, fnName)
  defer: JS_FreeValue(ctx, fnNameValue)

  jsAppEnvByCtx[ctx] = JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)
  # Callers hold the runtime on jsRuntimeStack (midCall) for as long as they
  # hold the value this returns.
  when defined(memProbe): memProbe("    js invoke " & fnName & " BEFORE")
  result =
    try:
      callGlobalFunction(ctx, "__frameosInvoke", [fnNameValue])
    finally:
      if jsAppEnvByCtx.hasKey(ctx):
        jsAppEnvByCtx.del(ctx)
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
    if raiseOnError:
      raise newException(JsAppError, details.message)
    return jsNull(ctx)

proc callAppGlobalForText*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode,
    context: ExecutionContext, fnName: string): string =
  ## Call a global JavaScript function (not a module export) in the app's
  ## context, the bridge set up as for `get`, and hand back what it returned
  ## as text. The test harness returns its report this way (app_tests.nim). A
  ## throw, or a module that does not load, is a JsAppError.
  try:
    ensureReady(runtime, owner.frameConfig, if owner.scene.isNil: "" else: owner.scene.id.string)
  except CatchableError as error:
    raise newException(JsAppError, error.msg)
  let ctx = runtime.js.context
  runtime.midCall:
    jsAppEnvByCtx[ctx] = JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)
    let payload =
      try:
        callGlobalFunction(ctx, fnName, [])
      finally:
        if jsAppEnvByCtx.hasKey(ctx):
          jsAppEnvByCtx.del(ctx)
    defer: JS_FreeValue(ctx, payload)
    if JS_IsException(payload) != 0:
      let details = mappedJsExceptionDetails(ctx)
      raise newException(JsAppError, details.message)
    return toNimString(ctx, payload)

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
  runtime.midCall:
    let payload = runtime.invoke(owner, configJson, context, "init")
    JS_FreeValue(runtime.js.context, payload)
  runtime.initialized = true

proc get*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext): Value =
  runtime.init(owner, configJson)
  if not owner.scene.isNil:
    let target = uiTarget(owner.scene.id.string, owner.nodeId.int, create = false)
    if not target.isNil and target.inputOnly:
      target.inputOnly = false
      # Only the pointer asked for this render: the last tree with the new
      # pointer, while nothing else can have changed what get() returns (the
      # same config, a render sooner than the scene's own interval).
      if not runtime.lastJsx.isNil and runtime.lastJsxConfig == configJson and
          inMilliseconds(getMonoTime() - runtime.lastJsxAt).float < owner.scene.refreshInterval * 1000:
        return VImage(runtime.imageFromJsx(owner, context, runtime.lastJsx))
  try:
    runtime.midCall:
      # A throw fails the node, as a raising Nim app does: the interpreter then
      # defaults the consumer's arg or paints the error into its image, and the
      # node cache keeps nothing. It used to hand the consumer null instead,
      # which the cache then served until it expired.
      let payload = runtime.invoke(owner, configJson, context, "get", raiseOnError = true)
      defer: JS_FreeValue(runtime.js.context, payload)
      runtime.lastJsx = nil
      result = toValue(runtime, owner, context, payload, runtime.outputType)
      if not runtime.lastJsx.isNil:
        runtime.lastJsxConfig = copy(configJson)
        runtime.lastJsxAt = getMonoTime()
      return
  finally:
    runtime.clearTransientImages()

proc run*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext) =
  runtime.init(owner, configJson)
  try:
    runtime.midCall:
      let payload = runtime.invoke(owner, configJson, context, "run")
      defer: JS_FreeValue(runtime.js.context, payload)
      if runtime.category == "render":
        let value = toValue(runtime, owner, context, payload, "image")
        if value.kind == fkImage and not value.asImage().isNil:
          let drawn = value.asImage()
          context.image.draw(drawn)
          # A render app's image lands at the origin, its own size.
          applyAutoFitToDrawn(context.image, 0, 0, min(drawn.width, context.image.width),
            min(drawn.height, context.image.height), drawn)
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
