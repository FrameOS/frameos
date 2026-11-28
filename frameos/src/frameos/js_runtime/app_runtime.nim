import std/[algorithm, base64, json, monotimes, options, os, sequtils, streams, strformat, strutils, tables, times]
from std/posix import Stat, stat, errno, ENOENT, ENOTDIR
import frameos/utils/memory
import frameos/utils/json_depth
import pixie
import pixie/fileformats/svg

import frameos/apps as frameos_apps
import frameos/js_runtime/runtime
import frameos/js_runtime/run_budget
import frameos/types
import frameos/values
import frameos/utils/http_client
import frameos/utils/line_reader
import frameos/utils/zip_entry
import frameos/utils/file_slice
import frameos/utils/base64_field
import frameos/utils/strict_json
import frameos/spool
import frameos/layout_choice
import frameos/frame_service_keys
import lib/tz
from chrono import findTimeZone, findDstChanges, valid
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
import frameos/js_runtime/pixel_ops
import frameos/js_runtime/typed_ops
import frameos/js_runtime/jsx_native
import frameos/render_probe
when not defined(frameosEmbedded):
  from frameos/utils/frame_time import frameEpochPinned
when not defined(frameosEmbedded) and not defined(frameosWasm):
  from std/httpcore import pairs # a Pi's response headers
  import frameos/video/player # docs/video.md: ffmpeg on a Linux frame
  import frameos/panel_canvas # isPanelCanvas: a video may be a display plane there
  import frameos/spawn_guard
import frameos/js_runtime/jsx
import frameos/ui/layout
import std/hashes
import frameos/events_gen
import frameos/events
import frameos/channels
import frameos/scene_rhythm
import frameos/ui/events
import frameos/render_scale
import frameos/panel_shape
import frameos/scene_store_hooks
import frameos/scene_code_hooks
import frameos/frame_settings_hooks
import frameos/tones
when not defined(frameosEmbedded):
  import frameos/file_transfer_hooks
from frameos/ui/theme import themeSource

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

  UrlImageState = enum uiLoading, uiReady, uiFailed
  UrlImage = object
    ## An `<img src="https://…">`'s picture at one size (js_async.nim):
    ## loading, kept (`id`, a kept picture of the app's), or failed (asked
    ## again after a while).
    url: string
    width, height: int
    fit: ScaledDecodeFit
    state: UrlImageState
    at: MonoTime
    id: int
    drawn: int ## the pass (`urlPass`) it was last drawn in

  JsVideo = object
    ## `frameos.video(key, {src})` (js_video.nim): the app's video called
    ## `key`, its image ref `id` (0: it failed, `error` says why).
    key, src, storage, headers: string
    id: int
    fit: string ## the app's `fit`, else the `<img>`'s object-* class decides
    error: string
    when not defined(frameosEmbedded) and not defined(frameosWasm):
      player: VideoPlayer
      toldFallbacks: int ## the player's fallbacks to ffmpeg's own already logged
      playbackLogged: float ## when its last `video:playback` line was (js_video.nim logPlayback)
      spotAt: tuple[x, y, w, h: int] ## where its <img> was on the panel the last render (a plane's)

  JsAppRuntime* = ref object
    category*: string
    outputType*: string
    source*: string
    ## The main module's file name (app.ts, app.tsx, ...). Imports resolve
    ## relative to it, and error locations name it.
    sourceName*: string
    ## Every file of the app by name — the pool `import './x'` draws from.
    ## Held only until the module is compiled when `reload` can read them
    ## again: QuickJS keeps no source, and nor does the runtime.
    sources*: JsonNode
    ## The app's files read again (from where its scene's JSON lives, or the
    ## node's own) for an interpreter that starts again; nil keeps `source`
    ## and `sources` for good (a test harness's app).
    reload*: proc (): JsonNode
    settingsKeys*: seq[string]
    assetGrant*: JsAssetGrant
    frameGrant*: bool
      ## config.json `permissions` asks for "frame": `frameos.frame`, the frame
      ## page's facts and powers (docs/terminal.md). Installing the scene is
      ## the owner's yes to it, as to the asset permissions.
    codeGrant*: bool
      ## config.json `permissions` asks for "code": `frameos.code`, the
      ## frame's scenes' sources and the plane's scene AI (docs/code-editor.md).
    storeGrant*: bool
      ## config.json `permissions` asks for "store": `frameos.storeAction`,
      ## installing, updating and removing the frame's scenes and choosing its
      ## layout (docs/scene-store.md).
    js*: QuickJS
    ready*: bool
    initialized*: bool
    nextImageId*: int
    images*: Table[int, Image]
    jsxMemo*: JsxMemo ## the nodes of memo()'s elements (js_runtime/jsx.nim)
    sceneId: string ## the scene it draws for, to say so when it is discarded
    appKey: int ## its entry in the prelude's `__frameosApps`
    modulePrefix: string
      ## "#<appKey>/" before its files' module names in its scene's context,
      ## where other apps' `app.ts` are too; "" in a QuickJS of its own
    host: InterpretedFrameScene
      ## The scene whose context it runs in, beside the scene's program and
      ## its other JS apps (runtime.ensureSceneJs); nil: a QuickJS of its own
      ## (no interpreted scene: the app tests, a test's bare runtime).
    # The last tree get() returned, for a render only the pointer asked for
    # (hover:, active:): laid out again with the new pointer, get() not run,
    # as a browser restyles :hover without React rendering again.
    lastJsx: SvgNode
    lastJsxConfig: JsonNode
    lastJsxAt: MonoTime
    ownSleep: float
      ## The `frameos.setNextSleep` the last whole get() asked for (-1: none),
      ## and when: a render that only runs the components a handler's signals
      ## dirtied, or lays the last tree out again for the pointer, runs no
      ## get(), so it carries what is left of that wish (`keepOwnSleep`), or a
      ## reminder a tap came before would wait out the scene's interval.
    ownSleepAt: MonoTime
    transientImageIds: seq[int]
    keptImageIds: seq[int]
    canvases: seq[tuple[key: string, id: int]]
      ## `frameos.canvas(key, ...)`: the pictures the app draws into, kept
      ## like the ones above until the interpreter goes (MaxCanvases at most).
    videos: seq[JsVideo]
      ## `frameos.video(key, ...)`: its videos, playing until the interpreter
      ## goes, the key plays something else or `frameos.releaseVideo`
      ## (MaxVideos at most; js_video.nim).
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
    ## A field that declares `byteIter` and got a spooled value: the bytes
    ## stay here and the app gets a reference to open (frameos.openLines).
    spoolFields: Table[string, Spool]
    ## The line readers of the call in progress, closed when it returns.
    lineStreamIds: seq[int]
    ## `<img src="https://…">`'s pictures by url and size (js_async.nim).
    urlImages: seq[UrlImage]
    urlPass: int ## fillUrlImages's passes, one a render of the app's UI
    ## The config of the newest call into the app (its node's fields, public
    ## state included): what `app.config` reads in async code, which runs
    ## after the call that started it (js_async.nim asyncEnv).
    liveConfig: JsonNode

  JsAppEvalEnv = ref object
    ctx: ptr JSContext ## where the call runs
    runtime: JsAppRuntime
    owner: AppRoot
    configJson: JsonNode
    context: ExecutionContext
    contextImageJson: JsonNode

var currentEnv: JsAppEvalEnv
  ## The app call in progress, the innermost: whose bridge the natives are.
  ## Every interpreter is entered from one thread, and a scene's apps share
  ## its context, so the call says which app is talking, never the context.
var nextJsAppKey = 0
var accelerometerReader*: proc (x, y, z: var float): bool {.nimcall, gcsafe.}
  ## Which way gravity pulls, in g along the picture's axes as it shows now
  ## (x to its right, y to its bottom, z out of the glass), where the frame
  ## has an accelerometer (docs/accelerometer.md): the ESP32's `fos_imu_gravity`
  ## (embedded_runtime.nim), a test's stub. nil, or false, where there is none.
var boardRotation* = -1
  ## The board's rotation where the runtime draws for one that turns the
  ## picture itself (the wasm runtime's `set_frame`), else -1: what
  ## `app.frame.rotate` says, as it does on the board.
var appContexts: seq[tuple[runtime: ptr JSRuntime, context: ptr JSContext]]
  ## The scenes' contexts the app prelude and natives are in.

template withAppEnv(jsCtx: ptr JSContext, e: JsAppEvalEnv, body: untyped) =
  ## The bridge's env for one entry into an app. One app can run another
  ## (a node's get() runs a node), so the caller's env comes back after.
  let previousEnv = currentEnv
  currentEnv = e
  currentEnv.ctx = jsCtx
  try:
    body
  finally:
    currentEnv = previousEnv

proc appEntry(runtime: JsAppRuntime): JSValue =
  ## The app's entry in the prelude's `__frameosApps` (undefined when gone).
  let ctx = runtime.js.context
  let global = JS_GetGlobalObject(ctx)
  let apps = JS_GetPropertyStr(ctx, global, "__frameosApps")
  JS_FreeValue(ctx, global)
  result = if jsIsObject(apps): JS_GetPropertyUint32(ctx, apps, runtime.appKey.uint32) else: jsUndefined(ctx)
  JS_FreeValue(ctx, apps)

proc appText(runtime: JsAppRuntime, text: string): string =
  ## An error's text with the app's own file names (`app.ts:12:3`), not the
  ## module names of its scene's context.
  if runtime.modulePrefix.len == 0: text else: text.replace(runtime.modulePrefix, "")
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

type InterpreterDiscard* = object
  ## The interpreters that went while their scene stayed, since the host last
  ## asked (the last one's scene and reason).
  sceneId*, reason*: string
  heldHandlers*: bool ## a UI's onClick and friends went with one
  count*: int

var pendingDiscard {.threadvar.}: InterpreterDiscard

proc takeInterpreterDiscards*(): InterpreterDiscard =
  ## For the host to report once the render is over: the moment of a discard
  ## is a moment short of memory.
  result = move(pendingDiscard)

proc noteInterpreterDiscard(runtime: JsAppRuntime, reason: string) =
  inc pendingDiscard.count
  pendingDiscard.sceneId = runtime.sceneId
  pendingDiscard.reason = reason
  if runtime.jsxMemo.handlers > 0:
    pendingDiscard.heldHandlers = true

proc closeVideos(runtime: JsAppRuntime) {.raises: [].}

proc forgetJsApp(runtime: JsAppRuntime) =
  ## What an app held for its interpreter, let go on the Nim side: the
  ## interpreter is gone (closed already), going, or not its own.
  runtime.closeVideos()
  runtime.js = QuickJS()
  runtime.host = nil
  runtime.modulePrefix = ""
  runtime.ready = false
  runtime.initialized = false
  runtime.urlImages.setLen(0)
  for canvas in runtime.canvases:
    unregisterCanvas(runtime.images.getOrDefault(canvas.id, nil))
  runtime.images.clear()
  runtime.transientImageIds.setLen(0)
  runtime.keptImageIds.setLen(0)
  runtime.canvases.setLen(0)

proc teardownJsRuntime(runtime: JsAppRuntime) =
  ## Close one JS app node's interpreter. Not embedded-only: JsAppRuntime has
  ## no destructor, so a runtime that merely goes out of scope leaks its whole
  ## QuickJS on every platform. One in its scene's context only takes its
  ## entry out of it: the context stays with the scene (and the app's
  ## modules in it, which QuickJS keeps until the context goes).
  if runtime.isNil or not runtime.ready:
    return
  if runtime.host.isNil:
    clearJsSourceMaps(runtime.js.context)
    runtime.js.close()
    forgetJsApp(runtime)
  else:
    let ctx = runtime.js.context
    let key = JS_NewInt32(ctx, runtime.appKey.int32)
    JS_FreeValue(ctx, callGlobalFunction(ctx, "__frameosDropApp", [key]))
    JS_FreeValue(ctx, key)
    forgetJsApp(runtime)

var liveJsRuntimes: seq[JsAppRuntime] = @[]
  ## Every JS app made ready and not yet released, on every platform: the
  ## single-scene host (an ESP32, the editor's preview) drops the idle ones
  ## after each render unless the frame keeps them (settleIdleJsAppRuntimes),
  ## and an ESP32 also evicts them under memory pressure.

proc jsAppsClosing(rt: ptr JSRuntime, ctx: ptr JSContext) {.nimcall, raises: [].} =
  ## runtime.sceneJsClosing: a scene's context (or a whole runtime) goes, and
  ## the apps in it with it.
  try:
    for runtime in liveJsRuntimes:
      if runtime.ready and not runtime.host.isNil and
          (runtime.js.context == ctx or (ctx.isNil and runtime.js.runtime == rt)):
        forgetJsApp(runtime)
    for i in countdown(appContexts.high, 0):
      if appContexts[i].context == ctx or (ctx.isNil and appContexts[i].runtime == rt):
        appContexts.del(i)
  except CatchableError:
    discard

sceneJsClosing = jsAppsClosing

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
    # 0 on an ESP32 is nothing left under the reserve: as short as it gets,
    # not "unknown" (a host's), so the idle ones go then too.
    if (headroom <= 0 and not runsAsEmbedded()) or headroom >= RenderMemoryShortBytes:
      return
    for other in liveJsRuntimes:
      # Not one holding a UI's handlers: they live nowhere else, and the
      # picture on the screen would stop answering (keepIdleInterpreters).
      if other != keep and other.ready and other.host.isNil and
          not jsRuntimeStack.contains(other) and other.jsxMemo.handlers == 0:
        noteInterpreterDiscard(other, "other app")
        teardownJsRuntime(other)

proc spared(runtime: JsAppRuntime, spare: openArray[FrameScene]): bool =
  ## Whether `runtime` belongs to one of `spare`: its context's scene, or for
  ## an app with an interpreter of its own, the scene it was built for.
  for scene in spare:
    if scene.isNil:
      continue
    if not runtime.host.isNil:
      if FrameScene(runtime.host) == scene:
        return true
    elif runtime.sceneId.len > 0 and runtime.sceneId == scene.id.string:
      return true
  false

proc releaseIdleJsAppRuntimes*(reason = "", keepAnswering = false,
    spare: openArray[FrameScene] = []): bool {.discardable.} =
  ## Drop every JS app interpreter that is not mid-call. The single-scene host
  ## calls it after every render (single_scene_host.renderScene) on an ESP32
  ## that deep-sleeps, and on one that stays awake (the editor's preview
  ## running as one included) when memory is short: there an app's module
  ## variables last one render and its init() runs on every one, and what
  ## must last longer goes through `frameos.remember`. A Pi keeps its
  ## interpreters for the scene's life and never calls this.
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
  ##
  ## `reason`: why, on a frame that would rather have kept them; the host
  ## reports it. Empty for a release nobody loses by (a frame about to sleep).
  ## `keepAnswering`: not the ones holding a UI's handlers. Whether any went.
  ##
  ## Apps in their scene's context go with the whole of it, the scene's
  ## program included (evaluated again on its next run), and only when none
  ## of them is held and the program is not running.
  ##
  ## `spare`: scenes whose interpreters stay whatever the reason
  ## (settleIdleJsAppRuntimes: the scene showing and the layout it wears).
  for runtime in liveJsRuntimes:
    if not runtime.ready or runtime.spared(spare):
      continue
    let scene = runtime.host
    var held = jsRuntimeStack.contains(runtime) or (keepAnswering and runtime.jsxMemo.handlers > 0)
    if not scene.isNil and not held:
      held = sceneJsRunning(scene)
      for other in liveJsRuntimes:
        if other.host == scene and (jsRuntimeStack.contains(other) or
            (keepAnswering and other.jsxMemo.handlers > 0)):
          held = true
    if held:
      continue
    if reason.len > 0:
      noteInterpreterDiscard(runtime, reason)
    if scene.isNil:
      teardownJsRuntime(runtime)
      result = true
    elif tryCleanupSceneJs(scene): # its other apps with it: one interpreter
      result = true

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

proc idleJsAppRuntimesAnswerPointer(): bool =
  ## Whether an idle interpreter holds the handlers of a UI on the screen.
  for runtime in liveJsRuntimes:
    if runtime.ready and not jsRuntimeStack.contains(runtime) and runtime.jsxMemo.handlers > 0:
      return true
  false

proc settleIdleJsAppRuntimes*(keep: bool, resident: openArray[FrameScene] = []): bool =
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
      keepIdleInterpreters(holdingPictures = idleJsAppRuntimesHoldPictures(),
        answeringPointer = idleJsAppRuntimesAnswerPointer()):
    return true
  #
  # `resident`: the scene showing and the layout it wears, on a host that
  # keeps one scene. What runs next is the next pass of that scene, which
  # builds these same interpreters again before anything it decodes or draws
  # (an app's get() runs in them), or a switch, which drops them with the
  # scene (single_scene_host.dropScene). Letting them go now lowers no
  # render's low point: it frees memory only between renders, where the
  # reserve under the headroom is what the firmware's own buffers draw on,
  # and it costs the next render the build. A reTerminal E1004, whose
  # headroom never reaches the floors (1.66 MB at best beside its 3.84 MB
  # canvas), gave up interpreters of 157-366 KB after every render of every
  # scene with code (docs/esp32-memory.md, 2026-11-23). They stay while the
  # headroom is above that reserve. The rest (another window's, a covered
  # scene's) go by the floors as before, and a decode, a fill or a block
  # that finds memory short still releases every idle one
  # (renderMemoryReleaseHook).
  if keep and resident.len > 0 and availableRenderHeadroomBytes() > 0:
    releaseIdleJsAppRuntimes("low memory", spare = resident)
    return hasIdleJsAppRuntimes()
  releaseIdleJsAppRuntimes(if keep: "low memory" else: "")
  false

proc liveJsAppRuntimeBytes*(): int =
  ## What the live JS app interpreters hold, for the memory a kept scene
  ## costs (the ESP32's `render:animation` line). Walks every interpreter's
  ## heap: for a once-in-a-while log line, not per frame.
  ## A runtime the apps of a scene share (and its program) counts once.
  var counted: seq[ptr JSRuntime]
  for runtime in liveJsRuntimes:
    if runtime.ready and runtime.js.runtime notin counted:
      counted.add runtime.js.runtime
      result += runtime.js.heapBytes()

when defined(frameosEmbedded) or defined(frameosWasm) or defined(testing):
  proc releaseKeptJsAppRuntimes(refused: bool): bool {.nimcall, raises: [].} =
    ## utils/memory's release hook: render memory is short, so the
    ## interpreters a frame kept between renders go, as releasing them after
    ## every render used to guarantee. The preview's too, while it runs as an
    ## ESP32 under a simulated limit and keeps them as an awake one does.
    ## One holding a UI's handlers goes only for an allocation that failed.
    if not runsAsEmbedded() or not hasIdleJsAppRuntimes():
      return false
    try:
      result = releaseIdleJsAppRuntimes(
        if refused: "alloc failed" else: "picture", keepAnswering = not refused)
    except CatchableError:
      discard

  renderMemoryReleaseHook = releaseKeptJsAppRuntimes

proc abandonMidCallJsAppRuntimes*(): tuple[count, bytes: int] =
  ## After an out-of-memory abort (single_scene_host.recoverAbortedRun): drop
  ## the interpreters the abort jumped out of (QuickJS.abandon says why they
  ## can be neither run nor freed). The `finally` in `invoke` that pops them
  ## never ran, so left alone they stayed "mid-call" for good and were never
  ## released. The next render builds the app a new one and runs its init()
  ## again; `frameos.remember` values are Nim data and carry over.
  currentEnv = nil # the abort skipped the `finally` that puts the caller's back
  memoAbandon()
  for runtime in jsRuntimeStack:
    if runtime.isNil or not runtime.ready:
      continue  # already dropped: a runtime re-entered further up the chain
    noteInterpreterDiscard(runtime, "out of memory")
    if not runtime.host.isNil:
      # Its scene's context goes as the scene's program's would
      # (runtime.abandonMidCallSceneJs, right after), and the app with it.
      noteSceneJsMidCall(runtime.host)
      continue
    let ctx = runtime.js.context
    if not ctx.isNil:
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
  ## The call in progress, when it is in `ctx` (a promise job of another
  ## scene's realm, run at this call's checkpoint, gets nothing).
  if not currentEnv.isNil and currentEnv.ctx == ctx: currentEnv else: nil

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
    let payload = parseJsonBounded(payloadStr)
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

proc dispatchFromScene*(scene: FrameScene, eventName: string, payload: JsonNode, nodeId: int, during: string) =
  ## An event sent by a scene's code: a dispatch node's, or an app's
  ## `frameos.dispatch`. Scene code is untrusted (it may be anyone's store
  ## scene): it may drive scenes and state, and may not replace the installed
  ## scene set (skipping every guard the push path applies) or take the runtime
  ## down on each render. One run may fire only so many events (run_budget.nim):
  ## a handler that dispatches its own event is an unbounded chain that starves
  ## rendering on the Pi and recurses on the ESP32. Logged once per run.
  var reason = ""
  if eventName == "render" and during == "render":
    reason = "renderSelfDispatch"
  elif not originMayEmit(eoScene, eventName):
    reason = "runtimeVerb"
  else:
    case takeDispatchBudget()
    of dvAllowed:
      if eventName == "render":
        # A scene asking to be drawn again means this one, also when it sits
        # in a split and is not due (scene_rhythm.nim).
        rhythmMarkDue(scene)
      sendEvent(eventName, payload, eoScene)
    of dvRefusedFirst:
      reason = "dispatchBudget"
    of dvRefused:
      discard
  if reason.len > 0:
    scene.logger.log(%*{"event": "interpreter:dispatch:ignored", "sceneId": scene.id.string, "nodeId": nodeId,
      "eventName": eventName, "reason": reason, "budget": dispatchBudgetTotalNow()})

proc jsDispatch(ctx: ptr JSContext, event: JSValue, payloadJson: JSValue): JSValue {.nimcall.} =
  let e = env(ctx)
  if e != nil and not e.owner.scene.isNil:
    try:
      dispatchFromScene(e.owner.scene, toNimString(ctx, event), parseJsonBounded(toNimString(ctx, payloadJson)),
        e.owner.nodeId.int, e.context.event)
    except CatchableError as error:
      frameos_apps.logError(e.owner, "frameos.dispatch failed: " & error.msg)
  return jsUndefSentinel(ctx)

proc storeAsker(e: JsAppEvalEnv): string =
  if e == nil or e.owner.scene.isNil: "" else: e.owner.scene.id.string

proc storeFacts(asker: string): string =
  ## The host's facts, with the layout chosen on the frame (`layout`: "" for
  ## each scene's own, "none", or a layout's id; layout_choice.nim) put in
  ## front: the host's text is handed on as it is, never parsed here.
  let read = sceneStoreRead
  if read.isNil:
    return ""
  result = read(asker)
  if result.len > 1 and result[0] == '{':
    let rest = if result[1] == '}': "}" else: "," & result[1 .. ^1]
    result = "{\"layout\":" & escapeJson(chosenLayout()) & rest

when defined(testing):
  proc sceneStoreFactsForTests*(asker: string): string = storeFacts(asker)

proc readAccelerometer*(x, y, z: var float): bool =
  let reader = accelerometerReader
  not reader.isNil and reader(x, y, z)

proc jsAccelerometer(ctx: ptr JSContext): JSValue {.nimcall.} =
  ## `frameos.accelerometer()` (docs/accelerometer.md): "x y z" in g, or "" (null
  ## in JS) where the frame has no accelerometer. A string, not an object: one
  ## allocation a frame, read 30 times a second by an animation.
  var x, y, z: float
  if not readAccelerometer(x, y, z):
    return nimStringToJS(ctx, "")
  var answer = ""
  for i, v in [x, y, z]:
    if i > 0: answer.add ' '
    answer.addInt int(v * 1000.0)
  nimStringToJS(ctx, answer)

proc jsTone(ctx: ptr JSContext, notes: JSValue): JSValue {.nimcall.} =
  ## `frameos.tone(...)` (docs/tones.md): the notes as the prelude writes them
  ## ("hz:ms,...", "" the chime), true when something plays them.
  nimBoolToJS(ctx, playTones(toNimString(ctx, notes)))

proc jsStore(ctx: ptr JSContext): JSValue {.nimcall.} =
  ## `frameos.store()`: the scene store's facts as the host knows them now
  ## (scene_store_hooks.nim), as JSON text; "" (null in JS) with no host.
  let e = env(ctx)
  nimStringToJS(ctx, if e == nil: "" else: storeFacts(storeAsker(e)))

proc storeChooseLayout(asker, argsJson: string) =
  ## The store's `layout {id}` (docs/scene-store.md "Trying a layout"): the
  ## layout the frame's scenes wear, chosen on the frame as its settings page
  ## chooses it ("" each scene's own). The frame's own to keep, so no host is
  ## asked; the scene asking is shown again, wearing it, the way the page's
  ## Back shows the scene it came from. A layout goes on at the start of a
  ## pass, and the store asks from inside one: a switch to the scene already
  ## showing switches nothing, so a pass is asked for too, or the store wore
  ## it only once something else drew (the browser preview's Try, 2026-11-25).
  var id = ""
  try:
    id = parseJson(argsJson){"id"}.getStr()
  except CatchableError:
    return
  if id == chosenLayout():
    return
  chooseLayout(id)
  if asker.len > 0:
    sendEvent("setCurrentScene", %*{"sceneId": asker}, eoScene)
  sendEvent("render", newJObject(), eoScene)

proc jsStoreAction(ctx: ptr JSContext, action: JSValue, argsJson: JSValue): JSValue {.nimcall.} =
  ## `frameos.storeAction(action, args)`: the host starts it and redraws the
  ## scene when it is done; false with no host to ask. For an app whose
  ## permissions ask for "store" (the scenes on the frame and its layout are
  ## not any scene's to change), and only while the store is offered at all
  ## (the host's facts are "" when the settings on the frame's screen are
  ## off). `layout` is no host's: it is the frame's choice, made here.
  let e = env(ctx)
  let act = sceneStoreAction
  if act.isNil or e == nil:
    return nimBoolToJS(ctx, false)
  if not e.runtime.storeGrant:
    frameos_apps.logError(e.owner, "frameos.storeAction: this app's permissions do not include store")
    return nimBoolToJS(ctx, false)
  if storeFacts(storeAsker(e)).len == 0:
    return nimBoolToJS(ctx, false)
  let what = toNimString(ctx, action)
  if what == "layout":
    storeChooseLayout(storeAsker(e), toNimString(ctx, argsJson))
    return nimBoolToJS(ctx, true)
  act(storeAsker(e), what, toNimString(ctx, argsJson))
  nimBoolToJS(ctx, true)

proc jsFrame(ctx: ptr JSContext, op: JSValue, arg: JSValue): JSValue {.nimcall.} =
  ## `frameos.frame(op, arg)` (docs/terminal.md): the frame page's facts and
  ## powers, for an app whose permissions ask for "frame", and only while the
  ## frame offers its page (the control plane's `frame_settings_on_screen`).
  ## `arg` is JSON text for "apply", the plain string otherwise. JSON text
  ## back: "" is null, "!" and a reason is what the prelude throws. "action"
  ## sends what the page's buttons send, from the origin `panel`.
  let e = env(ctx)
  var answer = "!this app's permissions do not include frame"
  if e != nil and e.runtime.frameGrant:
    let
      what = toNimString(ctx, op)
      text = toNimString(ctx, arg)
      facts = if frameSettingsRead.isNil: nil else: frameSettingsRead()
    answer = "true"
    if facts.isNil:
      answer = if what == "read": "" else: SettingsOffCode
    elif what == "read":
      # A link code is a presence code (docs/scene-settings.md "Connecting
      # the frame"): read off the panel, never by an app that could send it on.
      facts.fields.del("link")
      answer = $facts
    elif what == "action":
      if text in [evRender, evRestart, evReboot]:
        sendEvent(text, newJObject(), eoPanel)
      elif text == "unlink":
        # Leaving the plane is decided at the panel, twice (docs/scene-settings.md
        # "Unlinking"): no app takes a frame out of its owner's hands.
        answer = "!unlink is the frame page's alone"
      elif not frameSettingsAction.isNil:
        frameSettingsAction(text)
    elif what == "apply":
      if not frameSettingsApply.isNil:
        try:
          frameSettingsApply(parseJson(text))
        except CatchableError:
          discard
    else:
      answer = "!no such operation: " & what
  nimStringToJS(ctx, answer)

proc jsCode(ctx: ptr JSContext, op: JSValue, arg: JSValue): JSValue {.nimcall.} =
  ## `frameos.code(op, arg)` (docs/code-editor.md): the frame's scenes as it
  ## holds them and the plane's scene AI, for an app whose permissions ask
  ## for "code". The host answers everything (scene_code_hooks.nim), the
  ## page being off its screen included; null without a host.
  let e = env(ctx)
  var answer = "!this app's permissions do not include code"
  if e != nil and e.runtime.codeGrant:
    let host = sceneCode
    answer = if host.isNil: "" else: host(storeAsker(e), toNimString(ctx, op), toNimString(ctx, arg))
  nimStringToJS(ctx, answer)

proc jsMeasureText(ctx: ptr JSContext, texts: JSValue, classes: JSValue, width: JSValue): JSValue {.nimcall.} =
  ## `frameos.measureText(texts, {className, width})` (docs/jsx-ui.md): each
  ## text's height as a field would set it. The texts come joined by newlines
  ## (a line holds none) and the heights go back as whole pixels between
  ## spaces: no JSON either way.
  var answer = ""
  for h in measureText(toNimString(ctx, texts).split('\n'), toNimString(ctx, classes), toNimFloat(ctx, width).float32):
    if answer.len > 0: answer.add ' '
    answer.addInt int(h + 0.5)
  nimStringToJS(ctx, answer)

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
    e.owner.scene.state[stateKey] = parseJsonBounded(valueStr)
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

when defined(testing):
  type JsHttpRequestHook* = proc(url, httpMethod, body: string,
    headers: seq[SimpleHttpHeader]): tuple[code: int, body: string]
  var jsHttpRequestHook*: JsHttpRequestHook = nil
    ## Test seam for `frameos.httpRequest` and `frameos.fetchJson`: when set,
    ## every request a JS app makes through them is answered here instead of
    ## on the network, so an app whose API host is fixed (OpenAI, Unsplash,
    ## Commons, …) runs against canned replies. Images have their own seam
    ## (app_images.contextDownloadHook). Compiled out of real builds.

proc jsFetchJson(ctx: ptr JSContext, url: JSValue): JSValue {.nimcall.} =
  ## `frameos.fetchJson`: the answer parsed straight from the bytes that came
  ## (http_client.boundedGetWhole says what the text's three copies cost).
  ## `null` for an empty answer and for a request that failed, which is
  ## logged, as `fetchText` answers ""; text that is not JSON throws, as
  ## JSON.parse did.
  let e = env(ctx)
  let urlStr = toNimString(ctx, url)
  var parsed = jsNull(ctx)
  if urlStr.len == 0:
    return parsed
  proc parse(text: cstring, len: int) =
    if len > 0:
      when defined(memProbe): memProbe("      fetchJson body=" & $len & "B BEFORE parse")
      parsed = JS_ParseJSON(ctx, text, len.csize_t, "<fetchJson>")
      when defined(memProbe): memProbe("      fetchJson AFTER parse")
  try:
    when defined(testing):
      if jsHttpRequestHook != nil:
        let (code, body) = jsHttpRequestHook(urlStr, "GET", "", @[])
        if code >= 400:
          raise newException(IOError, "HTTP " & $code)
        parse(body.cstring, body.len)
        return parsed
    boundedGetWhole(urlStr, parse, maxBytes = jsFetchMaxBytes(e))
  except CatchableError as err:
    if e != nil:
      frameos_apps.logError(e.owner, "JS app fetchJson failed: " & redactedUrlsIn(err.msg))
  parsed

proc storeTransientImageJson(runtime: JsAppRuntime, image: Image): JsonNode
proc storeKeptImageJson(runtime: JsAppRuntime, owner: AppRoot, image: Image): JsonNode

const JsHttpMaxTimeoutMs = 600_000

proc resolveAssetPath(e: JsAppEvalEnv, relPath: string, write = false, storage = ""): string
proc assetWriteTarget(e: JsAppEvalEnv, opName: string, pathStr: string, bytes: int): string
proc jsAssetReadMaxBytes(e: JsAppEvalEnv): int

when defined(testing):
  var jsHttpHookHeaders*: string
    ## The response headers the hook's answers carry, as the ESP32 glue and
    ## the wasm library hand them over: "Name: value\n" lines.

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

proc utf8Whole*(s: string, cutStart: bool): string =
  ## A slice of text without the halves of characters at its ends: a
  ## `readAsset(..., {text: true})` slice read at an offset may start inside
  ## one (cutStart), and any slice may end inside another.
  var first = 0
  if cutStart:
    while first < s.len and first < 3 and (s[first].uint8 and 0xC0) == 0x80:
      inc first
  var last = s.len
  # The lead byte of the last character, and whether its sequence fits.
  var i = s.len - 1
  while i > first and s.len - i < 4 and (s[i].uint8 and 0xC0) == 0x80:
    dec i
  if i >= first and s.len > first:
    let lead = s[i].uint8
    let need = if lead >= 0xF0: 4 elif lead >= 0xE0: 3 elif lead >= 0xC0: 2 else: 1
    if s.len - i < need:
      last = i
  if first == 0 and last == s.len: s else: s[first ..< last]

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

proc optionsArg(ctx: ptr JSContext, optionsJson: JSValue): JsonNode =
  ## A bridge call's options, handed over from JS as a JSON string: that
  ## object, or an empty one when the string is not one.
  try:
    result = parseJsonBounded(toNimString(ctx, optionsJson))
  except CatchableError:
    discard
  if result.isNil or result.kind != JObject:
    result = newJObject()

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}
proc jsText(ctx: ptr JSContext, op: JSValue, value: JSValue): JSValue {.nimcall.} =
  ## The prelude's btoa (0), atob (1), TextEncoder.encode (2) and
  ## TextDecoder.decode (3). A JS string reaches Nim as UTF-8, so a binary
  ## string's chars 0x80-0xFF are two bytes each, both ways. A ValueError is
  ## the TypeError the call throws.
  var kind: int32
  discard JS_ToInt32(ctx, addr kind, op)
  if kind == 3:
    # QuickJS decodes UTF-8, an invalid sequence as U+FFFD; a BOM is dropped.
    var (data, len) = jsBytes(ctx, value)
    if len >= 3 and data[0] == 0xEF and data[1] == 0xBB and data[2] == 0xBF:
      data = cast[ptr UncheckedArray[uint8]](addr data[3])
      len -= 3
    return JS_NewStringLen(ctx, if len > 0: cast[cstring](data) else: "", len.csize_t)
  var s = toNimStringLen(ctx, value)
  var bytes = newStringOfCap(s.len)
  var i = 0
  case kind
  of 0:
    while i < s.len:
      let c = s[i].uint8
      if c < 0x80:
        bytes.add s[i]
      elif (c == 0xC2 or c == 0xC3) and i + 1 < s.len:
        inc i
        bytes.add char(((c and 0x1F) shl 6) or (s[i].uint8 and 0x3F))
      else:
        raise newException(ValueError, "btoa: a char above 255")
      inc i
    return nimStringToJS(ctx, encode(bytes))
  of 1:
    # The web's forgiving base64: ASCII whitespace dropped, the padding
    # optional, anything else outside the alphabet refused.
    var pad = 0
    var bad = false
    for ch in s:
      case ch
      of 'A'..'Z', 'a'..'z', '0'..'9', '+', '/':
        bad = bad or pad > 0
        bytes.add ch
      of '=': inc pad
      of '\t', '\n', '\f', '\r', ' ': discard
      else: bad = true
    if bad or pad > 2 or bytes.len mod 4 == 1 or (pad > 0 and (bytes.len + pad) mod 4 != 0):
      raise newException(ValueError, "atob: not base64")
    s.setLen(0)
    for ch in decode(bytes):
      if ch.uint8 < 0x80:
        s.add ch
      else:
        s.add char(0xC0 or (ch.uint8 shr 6))
        s.add char(0x80 or (ch.uint8 and 0x3F))
    return nimStringToJS(ctx, s)
  else:
    # A lone surrogate comes out of QuickJS as its own 3 bytes (ED A0-BF ..);
    # the web encodes it as U+FFFD.
    while i + 2 < s.len:
      if s[i] == '\xED' and s[i + 1].uint8 >= 0xA0:
        s[i] = '\xEF'
        s[i + 1] = '\xBF'
        s[i + 2] = '\xBD'
      inc i
    return JS_NewArrayBufferCopy(ctx, s.cstring, s.len.csize_t)
{.pop.}

proc answerToJS(ctx: ptr JSContext, head: string, body: var string, hasBody: bool): JSValue =
  ## An HTTP answer for the prelude: `head`, its JSON without the body, as an
  ## object, and the body set on it as a JS string made from the bytes, which
  ## go once it is made. Escaped into the JSON text and parsed back out, a
  ## body was four copies at once, the two in JS two bytes a character once
  ## one is past Latin-1: 3.5 MB for a 512 KB piece of GitHub's front page,
  ## more than a reTerminal Sticky had (2026-11-24). A body with no room is
  ## the answer's error (status 0), never an exception that leaves its
  ## promise waiting.
  result = JS_ParseJSON(ctx, head.cstring, head.len.csize_t, "<answer>")
  if not hasBody or JS_IsException(result) != 0:
    return
  let text = nimStringToJS(ctx, body)
  body = ""
  if JS_IsException(text) != 0:
    JS_FreeValue(ctx, JS_GetException(ctx))
    discard JS_SetPropertyStr(ctx, result, "status", nimIntToJS(ctx, 0))
    discard JS_SetPropertyStr(ctx, result, "error", nimStringToJS(ctx, describeJsError("out of memory")))
  else:
    discard JS_SetPropertyStr(ctx, result, "body", text)

proc jsHttpRequest(ctx: ptr JSContext, url: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Bounded HTTP request with method/headers/body. Options JSON:
  ## {method, headers: {name: value}, body, bodyBase64, base64 (return body
  ## base64-encoded, required for binary responses), timeoutMs, find,
  ## findLength, findLimit}.
  ## Returns an object (answerToJS): {status, headers, body | bodyBase64} or
  ## {status: 0, error}; headers as "name: value" lines, which the prelude
  ## turns into an object (__frameosAnswer). With
  ## `find` the body stays native: the response carries `found` (the text
  ## at each occurrence, findLimit of them, findLength bytes each) and, for a
  ## non-2xx status, the first KB of the body so the error stays readable.
  let e = env(ctx)
  var response = %*{"status": 0}
  var resBody = ""
  var hasBody = false

  let urlStr = toNimString(ctx, url)
  var options = optionsArg(ctx, optionsJson)

  try:
    var body = options{"body"}.getStr("")
    if options{"bodyBase64"}.getStr("").len > 0:
      body = decode(options["bodyBase64"].getStr())
    let bodyAsset = options{"bodyAsset"}
    if not bodyAsset.isNil and bodyAsset.kind == JObject:
      # An asset's bytes, base64, where the marker is: a picture uploaded
      # without ever being a JS string.
      let marker = bodyAsset{"marker"}.getStr()
      let at = if marker.len > 0: body.find(marker) else: -1
      let full = if e != nil: resolveAssetPath(e, bodyAsset{"path"}.getStr()) else: ""
      if at < 0 or full.len == 0 or not fileExists(full) or getFileSize(full) > jsAssetReadMaxBytes(e):
        raise newException(ValueError, "bodyAsset: no such asset, or no marker in the body")
      body.delete(at ..< at + marker.len)
      body.insert(encode(readFile(full)), at)
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
    var answered = false
    var resHeaders = ""
    when defined(testing):
      if jsHttpRequestHook != nil:
        (code, resBody) = jsHttpRequestHook(urlStr, httpMethod, body, headers)
        resHeaders = jsHttpHookHeaders
        answered = true
    if not answered:
      var res = boundedRequestWithHeaders(
        urlStr,
        httpMethod = httpMethod,
        body = body,
        headers = headers,
        timeoutMs = timeoutMs,
        maxBytes = jsFetchMaxBytes(e),
        maxSeconds = maxSeconds,
        wantHeaders = true
      )
      code = res.code
      resBody = move(res.body)
      when defined(frameosEmbedded) or defined(frameosWasm):
        resHeaders = res.headers
      else:
        if not res.headers.isNil:
          for name, value in res.headers.pairs:
            resHeaders.add(name & ": " & value & "\n")
    response["status"] = %*code
    response["headers"] = %resHeaders
    let saveField = options{"saveBase64Field"}
    if code >= 200 and code < 300 and not saveField.isNil and saveField.kind == JObject and e != nil:
      # The base64 text of one JSON string field, decoded into an asset, and
      # that field left empty in the body the app gets.
      let span = jsonStringFieldSpan(resBody, saveField{"field"}.getStr())
      let path = saveField{"path"}.getStr()
      let full = if span.start >= 0: assetWriteTarget(e, "httpRequest", path, (span.stop - span.start) * 3 div 4) else: ""
      let written = if full.len > 0: writeBase64Span(resBody, span.start, span.stop, full) else: -1
      if written > 0:
        resBody.delete(span.start ..< span.stop)
        response["saved"] = %*{"path": path, "bytes": written}
      else:
        response["saveError"] = %*(if span.start < 0: "no such field in the reply" else: "could not write the asset")
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
      hasBody = true
  except CatchableError as err:
    # The request's URL is the scene's and may carry a key or a share token;
    # the client's own errors name its origin only (utils/redacted_url.nim),
    # and anything else that quotes one is cut down here, before the text
    # reaches the log or an app that draws it.
    let message = redactedUrlsIn(err.msg)
    response["error"] = %*message
    hasBody = false
    if e != nil:
      frameos_apps.logError(e.owner, "JS app httpRequest failed: " & message)
  answerToJS(ctx, $response, resBody, hasBody)

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

proc keptDecodeSize*(wantWidth, wantHeight, sourceWidth, sourceHeight: int,
    fit: ScaledDecodeFit): tuple[width, height: int] =
  ## The shape an app asked for at the source's own resolution, when that is
  ## less than the size asked: a kept picture's first step down when there
  ## is no room for the size asked (keptPictureTarget). It loses nothing of
  ## the photo, only the enlargement, which the draw then does on every
  ## render instead (a gallery's 1024x653 photo in a reTerminal E1003's
  ## 1848x1179 window: 334 KB instead of 1.09 MB). An unknown source size
  ## (0) keeps the request.
  result = (wantWidth, wantHeight)
  if sourceWidth <= 0 or sourceHeight <= 0 or wantWidth <= 0 or wantHeight <= 0:
    return
  case fit
  of fitCover, fitContain:
    # The source's scale into the box: the larger of the two axis ratios for
    # cover, the smaller for contain; past 1 it is an enlargement.
    let widthBinds = (wantWidth.int64 * sourceHeight.int64 >=
      wantHeight.int64 * sourceWidth.int64) == (fit == fitCover)
    if widthBinds:
      if wantWidth > sourceWidth:
        result = (sourceWidth,
          max(1, (wantHeight.int64 * sourceWidth.int64 div wantWidth.int64).int))
    elif wantHeight > sourceHeight:
      result = (max(1, (wantWidth.int64 * sourceHeight.int64 div wantHeight.int64).int),
        sourceHeight)
  of fitStretch:
    result = (min(wantWidth, sourceWidth), min(wantHeight, sourceHeight))
  else:
    discard # center and the anchored fits place the source 1:1

proc keptPictureBytes(like: Image, width, height: int): int =
  let pixels = width.int64 * height.int64
  int(
    if like.isNil: pixels * 4
    else:
      case like.format
      of pfRgbx: pixels * 4
      of pfRgb565: pixels * 2
      of pfGray8: pixels
      of pfGray4: ((width.int64 + 1) div 2) * height.int64)

proc keptPictureTarget(runtime: JsAppRuntime, owner: AppRoot, like: Image,
    width, height: int, atSource: tuple[width, height: int]): Image =
  ## A kept picture's image, in the canvas's format, when there is room for
  ## it beside the render's reserve (utils/memory): at the size asked, which
  ## the draw copies (scaling it on every render took the E1003 40 s); short
  ## of room the app's older kept pictures go first (a ref to one then draws
  ## nothing, and an app fetches it again), then the photo's own resolution
  ## (`atSource`) is tried when that is more than half the size asked; nil
  ## when nothing fits, and the app is told. Not smaller: blown up more than
  ## twice it is soft, and pixie's general draw (a turned picture; an `<img>`
  ## goes through drawResampled, which copies nothing) doubles it first in a
  ## full-colour copy of its own (a 511x326 photo in the E1003's window asked
  ## for 2.67 MB). The allocation itself must not fail: on an
  ## ESP32 a failed one aborts the render and leaks what it held, and two in
  ## a row restart the firmware (Gallery on a reTerminal E1003, two kept
  ## 1.09 MB photos and a third on its way, 2026-11-10).
  var sizes = @[(width, height)]
  if atSource.width * atSource.height < width * height and
      atSource.width * 2 > width and atSource.height * 2 > height:
    sizes.add atSource
  var dropped = 0
  for step, (w, h) in sizes:
    while true:
      let
        bytes = keptPictureBytes(like, w, h)
        contiguous = availableRenderBytes()
      # 0: unknown, as on a host without the numbers. On an ESP32-class
      # runtime it is nothing left under the reserve, and an allocation there
      # is an out-of-memory abort (decodeIntoTargetWithDegrade, 2026-11-16).
      if (contiguous <= 0 and not runsAsEmbedded()) or
          (bytes <= contiguous and bytes <= availableRenderHeadroomBytes()):
        if dropped > 0 or step > 0:
          frameos_apps.log(owner, %*{"event": "js:keptImages", "dropped": dropped,
            "reason": "no room", "width": w, "height": h, "askedWidth": width,
            "askedHeight": height})
        result = if like.isNil: newImage(w, h) else: newImageLike(like, w, h)
        if not like.isNil:
          result.ditherStores = like.ditherStores # as a decode into the canvas
        return
      if runtime.keptImageIds.len == 0:
        break
      runtime.images.del(runtime.keptImageIds[0])
      runtime.keptImageIds.delete(0)
      inc dropped
  frameos_apps.log(owner, %*{"event": "js:keptImages", "refused": "no room",
    "width": width, "height": height, "dropped": dropped,
    "contiguousBytes": availableRenderBytes(), "headroomBytes": availableRenderHeadroomBytes()})
  nil

proc keptTargetFor*(runtime: JsAppRuntime, owner: AppRoot, like: Image,
    width, height: int, fit: ScaledDecodeFit): DecodeTargetProc =
  ## What a kept picture of `width` x `height` decodes into, once the start
  ## of the download says the photo's own size (utils/image.nim
  ## downloadImageWithDataSizedBy): keptPictureTarget at the size asked, or
  ## at the photo's own resolution when there is no room for that.
  result = proc(sourceWidth, sourceHeight: int): Image =
    runtime.keptPictureTarget(owner, like, width, height,
      keptDecodeSize(width, height, sourceWidth, sourceHeight, fit))

proc fetchImageJson(e: JsAppEvalEnv, urlStr: string, options: JsonNode, forceKeep = false): JsonNode

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
  ## holds a 480x480 photo in 450 KB of RGB565. Short of memory the app's
  ## older kept pictures go, then the picture is decoded smaller (first at
  ## the photo's own resolution, if that is less), and with no room at all
  ## the call answers an error (keptPictureTarget). Without them it decodes
  ## at its own size.
  let e = env(ctx)
  if e == nil:
    return nimStringToJS(ctx, """{"image":null,"error":"no app context"}""")
  nimStringToJS(ctx, $fetchImageJson(e, toNimString(ctx, url), optionsArg(ctx, optionsJson)))

proc fetchImageJson(e: JsAppEvalEnv, urlStr: string, options: JsonNode, forceKeep = false): JsonNode =
  ## fetchImage's work (jsFetchImage above), also for an `<img src>` fetched
  ## in the render (js_async.nim urlImage): `keep` as the
  ## option (`forceKeep`). The answer as JSON.
  var response = %*{"image": newJNull()}
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
    let keep = forceKeep or options{"keep"}.getBool(false)
    var downloaded: tuple[image: Image, data: string]
    if keep:
      let
        keepWidth = options{"width"}.getInt(0)
        keepHeight = options{"height"}.getInt(0)
      if keepWidth > 0 and keepHeight > 0:
        # The canvas's format where one is about (RGB565 on an LCD), so
        # drawing the picture later is a copy; only when there is room, and
        # smaller when there is not (keptPictureTarget).
        let
          like =
            if not context.isNil and not context.decodeTargetImage.isNil: context.decodeTargetImage
            else: context.contextImage()
          fit = scaledDecodeFit(options{"fit"}.getStr("cover"))
        downloaded = downloadImageWithDataSizedBy(urlStr,
          e.runtime.keptTargetFor(owner, like, keepWidth, keepHeight, fit), keepWidth, keepHeight,
          maxBytes = maxBytes, headers = headers, fit = fit)
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
      return response

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
  response

proc attrFloat(node: SvgNode, name: string): float32 =
  parseFloat(node.attr(name)).float32

proc closeLineStreams(runtime: JsAppRuntime)
include frameos/js_runtime/js_async

var
  storageInternalPath* = ""
    ## The frame's internal storage beside its assets folder, where it has one
    ## (an ESP32's state partition at /srv/internal, fos_assets_flash.c; set
    ## once at boot by the firmware, embedded_runtime's
    ## fos_nim_set_storages_impl). "" on a Pi and in the browser.
  storageCardMounted* = false
    ## Whether the assets folder is a card that mounted (an ESP32's TF slot).

proc frameStorages*(): JsonNode =
  ## `app.frame.storages`: the places a JS app's asset calls reach, each with
  ## the name to show it by, the assets folder (`storage` "assets", the
  ## default) first. The internal storage is listed only where it is not the
  ## assets folder itself: an ESP32 with no card uses it for both.
  if storageInternalPath.len > 0 and storageCardMounted:
    %*[{"id": "assets", "name": "TF card"}, {"id": "internal", "name": "Internal storage"}]
  elif storageInternalPath.len > 0:
    %*[{"id": "internal", "name": "Internal storage"}]
  elif storageCardMounted:
    %*[{"id": "assets", "name": "TF card"}]
  else:
    %*[{"id": "assets", "name": "Internal storage"}]

proc assetsRoot(e: JsAppEvalEnv, storage = ""): string =
  ## The sandbox root for this app's asset calls: the frame-wide assets
  ## folder, or the scene's own subtree for an app that asks for no assets
  ## permission (agOwnFolder) and for every app on a frame whose
  ## `js.assetSandbox` is "scene". `storage` "internal" is the frame's
  ## internal storage (frameStorages), for an app with the assets permission
  ## on a frame that has one; "" where it has none.
  let frameConfig = e.owner.frameConfig
  if storage == "internal":
    if storageInternalPath.len == 0 or e.runtime.assetGrant == agOwnFolder or
        (frameConfig != nil and frameConfig.js != nil and frameConfig.js.assetSandbox == "scene"):
      return ""
    return storageInternalPath
  elif storage.len > 0 and storage != "assets":
    return ""
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

proc resolveAssetPath(e: JsAppEvalEnv, relPath: string, write = false, storage = ""): string =
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
  let root = assetsRoot(e, storage)
  if root.len == 0:
    return ""
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

proc assetFolderPathOk(relPath: string): bool =
  ## Every segment a folder the listing shows: no dot names, no OS junk
  ## (paths.isJunkDirName), no control characters or backslashes.
  var start = 0
  for i in 0 .. relPath.len:
    if i == relPath.len or relPath[i] == '/':
      if isJunkDirName(relPath.substr(start, i - 1)):
        return false
      start = i + 1
    elif relPath[i] < ' ' or relPath[i] in {'\127', '\\'}:
      return false
  true

proc jsAssetReadMaxBytes(e: JsAppEvalEnv): int =
  ## Full-buffer asset reads triple in RAM (bytes + base64 + JS string), so
  ## embedded targets get a small cap; larger files must use ranged reads.
  when defined(frameosEmbedded):
    min(jsFetchMaxBytes(e), EmbeddedAssetReadMaxBytes)
  else:
    jsFetchMaxBytes(e)

proc c_rmdir(path: cstring): cint {.importc: "rmdir", header: "<unistd.h>".}

proc assetsMount(e: JsAppEvalEnv): string =
  ## The frame's assets folder itself, whatever sandbox the app has in it.
  let frameConfig = e.owner.frameConfig
  if frameConfig == nil or frameConfig.assetsPath == "": "/srv/assets" else: frameConfig.assetsPath

proc makeAssetDirs(dir, mount: string) =
  ## The folders from the assets folder down to `dir`, one at a time.
  ## createDir makes every prefix from "/", and on an ESP32 "/srv" above
  ## the assets mount is no folder: a write into a new folder failed there
  ## ("No such file or directory: /srv/"), every time.
  if dirExists(dir):
    return
  if dir.len <= mount.len:
    when not defined(frameosEmbedded):
      createDir(dir) # a Pi's assets folder before anything was put in it
    return
  makeAssetDirs(dir.parentDir(), mount)
  discard existsOrCreateDir(dir)

proc assetWriteTarget(e: JsAppEvalEnv, opName: string, pathStr: string, bytes: int): string =
  ## The absolute path a write of `bytes` to `pathStr` goes to, its folder
  ## made, or "" (logged) when the app may not write there or the disk is
  ## nearly full: under 100 MB left on a Pi's card, too little for the write
  ## on an ESP32, whose flash storage is 1 or 24 MB all told and whose card
  ## is the assets folder itself.
  let full = resolveAssetPath(e, pathStr, write = true)
  if full.len == 0:
    frameos_apps.logError(e.owner, "JS app " & opName & AssetPathRefused & pathStr)
    return ""
  makeAssetDirs(full.parentDir(), assetsMount(e))
  let freeDiskSpace = getAvailableDiskSpace(full.parentDir())
  let floor = when defined(frameosEmbedded): bytes.int64 + 64 * 1024 else: 100'i64 * 1024 * 1024
  if freeDiskSpace != -1 and freeDiskSpace < floor:
    frameos_apps.logError(e.owner, "JS app " & opName & ": low disk space, asset not saved: " & pathStr)
    return ""
  full

proc writeAssetFile(e: JsAppEvalEnv, opName: string, pathStr: string,
    contents: string, append: bool): bool =
  let full = assetWriteTarget(e, opName, pathStr, contents.len)
  if full.len == 0:
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

type AssetOptions = object
  ## An assets call's options JSON read once into plain values. Looked up
  ## where they were used, each `options{…}` was a JsonNode alive across
  ## every exit of one proc, and every exit destroyed them all: 625 cleanup
  ## calls, 14.8 KB of the ESP32 image for this one bridge.
  storage, entry, background: string
  shallow, strict, text, keep, contain, hasLength, inflate, bytes, hasPixels, hasMask, maskInflate: bool
  offset, length, width, height, maskOffset, maskLength: int
  pixels, mask: RawPixels

proc rawPixelsOf(pixels: JsonNode): RawPixels =
  result = RawPixels(width: pixels{"width"}.getInt(0), height: pixels{"height"}.getInt(0),
    colors: pixels{"colors"}.getInt(1), bits: pixels{"bits"}.getInt(8),
    predictor: pixels{"predictor"}.getInt(1), invert: pixels{"invert"}.getBool(false))
  # The palette as RGB bytes, written in hex (six digits an entry).
  let hex = pixels{"palette"}.getStr()
  for i in countup(0, hex.len - 2, 2):
    try: result.palette.add char(parseHexInt(hex[i .. i + 1]))
    except ValueError: break

proc assetOptions(ctx: ptr JSContext, data: JSValue): AssetOptions {.noinline.} =
  let options = optionsArg(ctx, data)
  result.storage = options{"storage"}.getStr()
  result.entry = options{"entry"}.getStr()
  result.background = options{"background"}.getStr()
  result.shallow = options{"shallow"}.getBool(false)
  result.strict = options{"strict"}.getBool(false)
  result.text = options{"text"}.getBool(false)
  result.keep = options{"keep"}.getBool(false)
  result.contain = options{"fit"}.getStr("cover") == "contain"
  result.offset = options{"offset"}.getInt(0)
  let length = options{"length"}
  if not length.isNil and length.kind == JInt:
    result.hasLength = true
    result.length = length.getInt()
  result.width = options{"width"}.getInt(0)
  result.height = options{"height"}.getInt(0)
  result.inflate = options{"inflate"}.getBool(false)
  result.bytes = options{"bytes"}.getBool(false)
  let pixels = options{"pixels"}
  if not pixels.isNil and pixels.kind == JObject:
    result.hasPixels = true
    result.pixels = rawPixelsOf(pixels)
  # mask: another slice of samples, grey, the picture's opacity (a PDF's SMask).
  let mask = options{"mask"}
  if not mask.isNil and mask.kind == JObject and mask{"pixels"}.kind == JObject:
    result.hasMask = true
    result.maskOffset = mask{"offset"}.getInt(0)
    result.maskLength = mask{"length"}.getInt(high(int32).int)
    result.maskInflate = mask{"inflate"}.getBool(false)
    result.mask = rawPixelsOf(mask{"pixels"})

proc assetStorage(ctx: ptr JSContext, data: JSValue): string {.noinline.} =
  optionsArg(ctx, data){"storage"}.getStr()

proc logAssetSliceTooBig(e: JsAppEvalEnv, what: string, size: int64, readMax: int) {.noinline.} =
  frameos_apps.logError(e.owner,
    "JS app readAsset: " & what & " slice is " & $size &
    " bytes, over the " & $readMax & " byte limit; read it in chunks" &
    " with {offset, length}")

proc storageGone(e: JsAppEvalEnv, storage: string): bool =
  ## A storage the frame lists (`app.frame.storages`) whose folder is not
  ## there: a card that is not mounted any more, an internal storage that is not.
  if storage == "internal":
    return storageInternalPath.len > 0 and not dirExists(storageInternalPath)
  if storage.len == 0 or storage == "assets":
    let config = e.owner.frameConfig
    return storageCardMounted and not dirExists(
      if config == nil or config.assetsPath == "": "/srv/assets" else: config.assetsPath)

proc unreadable(path: string): bool =
  ## A folder whose stat failed for another reason than not being there: a
  ## card that answered a read with an error.
  var st: Stat
  stat(path.cstring, st) != 0 and errno != ENOENT and errno != ENOTDIR

proc assetsList(ctx: ptr JSContext, e: JsAppEvalEnv, pathStr: string, data: JSValue): JSValue =
  let options = assetOptions(ctx, data)
  let root = assetsRoot(e, options.storage)
  let dir = if root.len == 0: "" elif pathStr.len == 0: root else: resolveAssetPath(e, pathStr, storage = options.storage)
  var files: seq[string] = @[]
  # `strict`: null when the storage cannot be read (a card that is not
  # mounted, a read that failed), which an app can tell from an empty
  # folder. A folder that is not there is still [].
  if options.strict and (storageGone(e, options.storage) or
      (dir.len > 0 and not dirExists(dir) and unreadable(dir))):
    return jsNull(ctx)
  if dir.len > 0 and dirExists(dir):
    # Hidden/OS-junk entries (`.thumbs`, `.frameos`, `._IMG.jpg`,
    # `Thumbs.db`, `@eaDir`, …) never show up in an app's asset listing.
    if options.shallow:
      # One folder's entries, as a browser walks a card a folder at a
      # time (a recursive walk of a large SD card takes seconds). A read
      # that fails raises under `strict` (jsAssets answers null).
      for kind, entry in walkDir(dir, relative = false, checkDir = options.strict):
        let name = entry.extractFilename
        if kind in {pcDir, pcLinkToDir} and not isJunkDirName(name):
          files.add(entry[(root.len + 1)..^1] & "/")
        elif kind in {pcFile, pcLinkToFile} and not isHiddenOrJunkFile(name):
          files.add(entry[(root.len + 1)..^1])
    else:
      for filePath in walkDirRecNoJunk(dir, relative = false):
        files.add(filePath[(root.len + 1)..^1])
  files.sort()
  let arr = newJArray()
  for file in files:
    arr.add(newJString(file))
  jsonToJS(ctx, arr)

proc assetsRead(ctx: ptr JSContext, e: JsAppEvalEnv, pathStr: string, data: JSValue): JSValue =
  let options = assetOptions(ctx, data)
  let full = resolveAssetPath(e, pathStr, storage = options.storage)
  if full.len == 0 or not fileExists(full):
    return jsNull(ctx)
  let offset = max(0, options.offset)
  let readMax = jsAssetReadMaxBytes(e)
  # text: the bytes as a string (UTF-8, without the halves of characters
  # a slice cuts at its ends) instead of base64.
  var contents: string
  if options.entry.len > 0:
    # One member of a ZIP (an EPUB's chapter), inflated a window at a
    # time: only the slice asked for is ever held.
    try:
      contents = readZipEntry(full, options.entry, offset,
        if options.hasLength: options.length else: -1, readMax)
    except ZipEntryTooBig as error:
      logAssetSliceTooBig(e, pathStr & " entry " & options.entry, error.size, readMax)
      return jsNull(ctx)
    except ZipEntryError:
      # Not a ZIP, no such member, a damaged one: null, as for a file
      # that is not there. What the file is is the app's to say (a
      # library shows "not an EPUB" on the book), not the frame's log.
      return jsNull(ctx)
  elif options.inflate:
    # A compressed stream inside the file (a PDF's FlateDecode): the
    # slice inflated, never more than the read limit of it held.
    let length = if options.hasLength: options.length else: int(getFileSize(full)) - offset
    try:
      contents = readFileSlice(full, offset, length, true, readMax)
    except FileSliceTooBig:
      logAssetSliceTooBig(e, pathStr & " inflated", readMax + 1, readMax)
      return jsNull(ctx)
    except FileSliceError:
      return jsNull(ctx)
  else:
    let fileSize = int(getFileSize(full))
    var length = if options.hasLength: options.length else: fileSize - offset
    length = min(length, fileSize - offset)
    if length <= 0:
      return nimStringToJS(ctx, "")
    if length > readMax:
      logAssetSliceTooBig(e, pathStr, length, readMax)
      return jsNull(ctx)
    var file: File
    if not file.open(full):
      return jsNull(ctx)
    defer: file.close()
    file.setFilePos(offset)
    contents = newString(length)
    let bytesRead = file.readBuffer(addr contents[0], length)
    contents.setLen(bytesRead)
  if options.bytes:
    # bytes: a Uint8Array of them, for a parser that reads binary.
    var args = [JS_NewArrayBufferCopy(ctx, contents.cstring, contents.len.csize_t),
      JS_NewInt32(ctx, 0), JS_NewInt32(ctx, contents.len.int32)]
    result = JS_NewTypedArray(ctx, 3, addr args[0], 2) # JS_TYPED_ARRAY_UINT8
    JS_FreeValue(ctx, args[0])
    return result
  nimStringToJS(ctx, if options.text: utf8Whole(contents, offset > 0) else: encode(contents))

proc assetPicture(e: JsAppEvalEnv, keep: bool, width, height: int): Image =
  ## A picture of that size in the canvas's format, as fetchImage's kept
  ## pictures are; a kept one in the app's own slot.
  let
    context = e.context
    like =
      if not context.isNil and not context.decodeTargetImage.isNil: context.decodeTargetImage
      elif context.isNil: nil
      else: context.contextImage()
  if keep: e.runtime.keptPictureTarget(e.owner, like, width, height, (0, 0))
  elif like.isNil: newImage(width, height)
  else: newImageLike(like, width, height)

proc assetPartImage(e: JsAppEvalEnv, full: string, options: AssetOptions): Image =
  ## A picture inside a ZIP (an EPUB's illustration) or at a slice of a file
  ## (a PDF's JPEG, or with `pixels` its raw samples): the member or slice
  ## whole, under the read limit, decoded at the size asked (a JPEG scaled
  ## as it decodes, a PNG a row at a time, samples scaled as they come) into
  ## a picture of its own, then put over `background` where it is
  ## transparent: a canvas without alpha (an ESP32's) would otherwise show
  ## those parts black.
  var decoded: Image
  if options.hasPixels:
    if options.width <= 0 or options.height <= 0:
      return nil
    try:
      decoded = decodeRawPixels(full, options.offset,
        if options.hasLength: options.length else: high(int32).int,
        options.inflate, options.pixels, options.width, options.height)
    except FileSliceError, PixieError:
      return nil
  else:
    var member: string
    try:
      member =
        if options.entry.len > 0: readZipEntry(full, options.entry, 0, -1, jsAssetReadMaxBytes(e))
        elif options.hasLength and options.length <= jsAssetReadMaxBytes(e):
          readFileSlice(full, options.offset, options.length, options.inflate, jsAssetReadMaxBytes(e))
        else: ""
    except ZipEntryError, FileSliceError:
      return nil
    if member.len == 0:
      return nil
    if options.width <= 0 or options.height <= 0:
      return decodeImageWithDisplayBounds(member)
    decoded = newImage(options.width, options.height)
    discard decodeImageWithFallback(member, decoded,
      if options.contain: fitContain else: fitCover)
    member = ""
  if options.hasMask and decoded.width == options.width and decoded.height == options.height:
    # Its opacity from the mask's samples, scaled to the same size: the
    # picture premultiplied by it, to go over the background below.
    try:
      let alpha = decodeRawPixels(full, options.maskOffset, options.maskLength,
        options.maskInflate, options.mask, options.width, options.height)
      for i in 0 ..< options.width * options.height:
        let a = alpha.data[i].r.uint32
        let c = decoded.data[i]
        decoded.data[i] = rgbx(uint8(c.r.uint32 * a div 255), uint8(c.g.uint32 * a div 255),
          uint8(c.b.uint32 * a div 255), uint8(c.a.uint32 * a div 255))
    except FileSliceError, PixieError:
      discard # no mask: the picture opaque
  result = assetPicture(e, options.keep, options.width, options.height)
  if result.isNil:
    return nil
  if options.background.len > 0:
    result.fill(parseHtmlColor(options.background).rgbx)
    result.draw(decoded, blendMode = NormalBlend)
  else:
    result.draw(decoded, blendMode = OverwriteBlend)

proc assetFileImage(e: JsAppEvalEnv, full: string, options: AssetOptions): Image =
  if options.width > 0 and options.height > 0:
    # At the size asked, in the canvas's format: a browser's thumbnail of
    # a 12-megapixel photo is a scaled JPEG decode, never the photo.
    let fit = if options.contain: "contain" else: "cover"
    result = assetPicture(e, options.keep, options.width, options.height)
    if result.isNil:
      return nil
    if not readImageIntoTarget(full, result, fit):
      scaleAndDrawImage(result, readImageWithDisplayBounds(full), fit)
  # The photo's own colour profile, if the Assets panel wrote one
  # (utils/asset_colors) — the same treatment data/localImage gives it.
  # A kept picture shares its render with others (a grid of them), so it
  # never sets the frame's dither palette.
  let colorProfile = loadAssetColorProfile(full)
  if result.isNil and not options.keep:
    # The picture the app returns, as data/localImage and fetchImage give
    # it: decoded straight into the consumer's target where the interpreter
    # offers one (on an ESP32 the canvas itself), else at the consumer's
    # bounds. A second picture of a 13.3" panel's size is 3.8 MB that an
    # 8 MB board beside its canvas does not have. A profile that adjusts
    # colors goes into the canvas only under a fit that covers it all.
    let context = e.context
    let (target, mode) =
      if context.isNil: (Image(nil), "") else: e.owner.takeDecodeTarget(context)
    let adjusts = colorProfile.isSome and colorProfile.get().hasAdjustments()
    if not target.isNil and not (adjusts and mode notin ["cover", "stretch"]) and
        readImageIntoTarget(full, target, mode):
      result = target
    else:
      let (boundWidth, boundHeight) =
        if target.isNil and not context.isNil: e.owner.takeDecodeBounds(context) else: (0, 0)
      result = readImageWithDisplayBounds(full, boundWidth = boundWidth, boundHeight = boundHeight)
  elif result.isNil:
    result = readImageWithDisplayBounds(full)
  if result.isNil:
    return nil
  if colorProfile.isSome:
    if not options.keep:
      if colorProfile.get().hasPaletteOverride():
        setRenderPaletteOverride(colorProfile.get().palette)
      else:
        clearRenderPaletteOverride()
    if colorProfile.get().hasAdjustments():
      applyAssetColors(result, colorProfile.get())
      markImageGraded(result)

proc assetsImage(ctx: ptr JSContext, e: JsAppEvalEnv, pathStr: string, data: JSValue): JSValue =
  let options = assetOptions(ctx, data)
  let full = resolveAssetPath(e, pathStr, storage = options.storage)
  if full.len == 0 or not fileExists(full):
    return jsNull(ctx)
  let image =
    if options.entry.len > 0 or options.hasLength or options.hasPixels: assetPartImage(e, full, options)
    else: assetFileImage(e, full, options)
  if image.isNil:
    return jsNull(ctx)
  if options.keep:
    return jsonToJS(ctx, e.runtime.storeKeptImageJson(e.owner, image))
  jsonToJS(ctx, e.runtime.storeTransientImageJson(image))

proc jsAssets(ctx: ptr JSContext, op: JSValue, path: JSValue, data: JSValue): JSValue {.nimcall.} =
  ## Asset management scoped to the frame's assets folder. Ops:
  ## list (dir, options JSON {shallow} -> JSON array of relative paths: every
  ## file below, or with shallow the folder's own entries, a folder's with a
  ## trailing "/"), exists, size, read (options JSON {offset, length, text,
  ## entry} -> base64, or a string with text; entry reads that member of a
  ## ZIP file, utils/zip_entry.nim), write/append (path, base64), delete, image (options JSON {keep,
  ## width, height, fit} -> imageRef decoded within display bounds, or at that
  ## size, as fetchImage's are). Each op is a proc of its own: one proc's
  ## locals are destroyed at every one of its exits.
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let opStr = toNimString(ctx, op)
  let pathStr = toNimString(ctx, path)

  try:
    case opStr
    of "list":
      return assetsList(ctx, e, pathStr, data)
    of "exists":
      let full = resolveAssetPath(e, pathStr, storage = assetStorage(ctx, data))
      return nimBoolToJS(ctx, full.len > 0 and fileExists(full))
    of "size":
      let full = resolveAssetPath(e, pathStr, storage = assetStorage(ctx, data))
      if full.len == 0 or not fileExists(full):
        return nimIntToJS(ctx, -1)
      return nimFloatToJS(ctx, getFileSize(full).float)
    of "read":
      return assetsRead(ctx, e, pathStr, data)
    of "write", "append", "writeText", "appendText":
      # writeText / appendText: the string itself as UTF-8 ({text: true}),
      # else the bytes the base64 says.
      let raw = toNimStringLen(ctx, data)
      let append = opStr[0] == 'a'
      return nimBoolToJS(ctx, writeAssetFile(e, (if append: "appendAsset" else: "writeAsset"), pathStr,
        (if opStr.endsWith("Text"): raw else: decode(raw)), append))
    of "delete":
      let storage = assetStorage(ctx, data)
      let full = resolveAssetPath(e, pathStr, write = true, storage = storage)
      if full.len == 0:
        return nimBoolToJS(ctx, false)
      if fileExists(full):
        removeFile(full)
        return nimBoolToJS(ctx, true)
      # A folder, when it is empty: rmdir refuses one with anything in it
      # (an ESP32's flash storage, whose folders are name prefixes, too:
      # fos_assets_flash.c fv_rmdir). Never the root, never recursive.
      return nimBoolToJS(ctx, dirExists(full) and full != assetsRoot(e, storage) and
        c_rmdir(full.cstring) == 0)
    of "mkdir":
      # One folder in a folder that is there: an ESP32's mkdir of a parent
      # above its assets mount fails, so there is no `-p`. A name the listing
      # would hide (".cache", "@eaDir") is refused, as the device's own write
      # paths refuse dot names. False when it was there already.
      let full = resolveAssetPath(e, pathStr, write = true, storage = assetStorage(ctx, data))
      if full.len == 0 or not assetFolderPathOk(pathStr):
        frameos_apps.logError(e.owner, "JS app makeAssetFolder" & AssetPathRefused & pathStr)
        return nimBoolToJS(ctx, false)
      return nimBoolToJS(ctx, not existsOrCreateDir(full))
    of "image":
      return assetsImage(ctx, e, pathStr, data)
    else:
      frameos_apps.logError(e.owner, "JS app assets: unknown operation: " & opStr)
      return jsUndefSentinel(ctx)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app assets " & opStr & " failed: " & err.msg)
    if opStr in ["list", "size", "read", "image"]:
      return jsNull(ctx)
    return nimBoolToJS(ctx, false)

when not defined(frameosEmbedded):
  proc jsTransfer(ctx: ptr JSContext, op: JSValue, argsJson: JSValue): JSValue {.nimcall.} =
    ## `frameos.transfer(op, args)` (file_transfer_hooks.nim): files between
    ## the assets and the computer showing the frame, the browser preview's
    ## alone. JSON text back: "" is null (no host: every frame), "!" and a
    ## reason is what the prelude throws. The path is resolved against the
    ## app's own sandbox here, as its asset calls are: "upload" {dir, storage}
    ## is a write into that folder ("" its top), "download" {path, storage} a
    ## read of that file. Not in the ESP32's image: no page there to ask.
    let e = env(ctx)
    let host = fileTransfer
    var answer = ""
    if e != nil and not host.isNil:
      let what = toNimString(ctx, op)
      case what
      of "read":
        answer = host(storeAsker(e), what, "")
      of "upload", "download":
        let upload = what == "upload"
        var given = newJObject()
        try:
          given = parseJsonBounded(toNimString(ctx, argsJson))
        except CatchableError:
          discard
        let
          rel = given{if upload: "dir" else: "path"}.getStr().strip(chars = {'/'})
          storage = given{"storage"}.getStr()
        if upload and e.runtime.assetGrant == agRead:
          answer = "!this app's permissions do not include assets-write"
        else:
          let full =
            if upload and rel.len == 0: assetsRoot(e, storage)
            elif upload and not assetFolderPathOk(rel): ""
            else: resolveAssetPath(e, rel, write = upload, storage = storage)
          answer = if full.len == 0 or (if upload: fileExists(full) else: not fileExists(full)): "false"
                   else: host(storeAsker(e), what, full)
      else:
        answer = "!no such operation: " & what
    nimStringToJS(ctx, answer)

## Streams let apps pass around and process data bigger than memory allows in
## one piece: a data app can return a streamRef (it travels between nodes as
## plain JSON), and the consumer reads it chunk by chunk. Backed by simple
## string streams or files inside the assets folder. The registry is one for
## every app runtime, so a ref resolves in any app of the scene that opened
## it, and in no other scene: the ids count up, and a scene that guessed one
## read, wrote or closed a file another scene had open. It is capped, evicting
## (and closing) the oldest stream, the opener's own first, so forgotten
## handles cannot pile up and one scene's cannot push out another's.
const MaxOpenJsStreams = 64
const DefaultJsStreamChunkBytes = 65536
const MaxStringStreamBytes = when defined(frameosEmbedded): 512 * 1024 else: 16 * 1024 * 1024
  ## What a scene's string streams hold together: they are memory of the
  ## runtime's own, outside the JS heap's ceiling, and `streamWrite` grew one
  ## without end.

type JsStream = object
  stream: Stream
  lines: LineReader ## set by openLines: what nextLine reads
  spool: Spool ## the bytes a line reader reads, kept as long as it is open
  scene: string ## the scene whose app opened it

var jsStreamsGlobal = initOrderedTable[int, JsStream]()
var jsNextStreamId = 0

proc registerJsStream(scene: string, stream: Stream, lines: LineReader = nil, spool: Spool = nil): JsonNode =
  while jsStreamsGlobal.len >= MaxOpenJsStreams:
    var oldest = 0
    for id, held in jsStreamsGlobal.pairs:
      if oldest == 0:
        oldest = id
      if held.scene == scene:
        oldest = id
        break
    try:
      jsStreamsGlobal[oldest].stream.close()
    except CatchableError:
      discard
    jsStreamsGlobal.del(oldest)
  inc jsNextStreamId
  jsStreamsGlobal[jsNextStreamId] = JsStream(stream: stream, lines: lines, spool: spool, scene: scene)
  return %*{"__frameosType": "streamRef", "id": jsNextStreamId}

proc jsStreamOf(scene: string, id: int): bool =
  ## Whether `id` is a stream an app of `scene` opened.
  id != 0 and jsStreamsGlobal.hasKey(id) and jsStreamsGlobal[id].scene == scene

proc jsStreamById(scene: string, options: JsonNode): Stream =
  let id = options{"id"}.getInt(0)
  if jsStreamOf(scene, id):
    return jsStreamsGlobal[id].stream
  return nil

proc stringStreamBytes(scene: string): int =
  ## What the scene's string streams hold now.
  for held in jsStreamsGlobal.values:
    if held.scene == scene and held.stream of StringStream:
      result += StringStream(held.stream).data.len

proc closeJsStream(scene: string, id: int): bool =
  if not jsStreamOf(scene, id):
    return false
  try:
    jsStreamsGlobal[id].stream.close()
  finally:
    jsStreamsGlobal.del(id)
  true

proc closeLineStreams(runtime: JsAppRuntime) =
  ## What a call left open goes when it returns: a spool's file stays on the
  ## card for as long as a reader holds it.
  for id in runtime.lineStreamIds:
    try:
      discard closeJsStream(runtime.sceneId, id)
    except CatchableError:
      discard
  runtime.lineStreamIds.setLen(0)

proc lineOptions(options: JsonNode): LineOptions =
  result.unfold = options{"unfold"}.getBool(false)
  result.trim = options{"trim"}.getBool(false)
  result.maxLength = max(0, options{"maxLength"}.getInt(0))
  let only = options{"only"}
  if not only.isNil and only.kind == JArray:
    for item in only.elems:
      if item.kind == JString and item.getStr().len > 0:
        result.only.add(item.getStr())

proc jsOpenLines(ctx: ptr JSContext, text: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## A line reader over a string or a stream (docs/js-apps-and-code-nodes.md).
  ## Options JSON: {source, unfold, trim, only, maxLength}, where `source`
  ## (null for the string) is a streamRef, a byteIter field's among them.
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)
  var options = optionsArg(ctx, optionsJson)
  let scene = e.runtime.sceneId
  try:
    let source = options{"source"}
    var reference: JsonNode = nil
    if source.isNil or source.kind == JNull:
      reference = registerJsStream(scene, newStringStream(toNimString(ctx, text)))
    elif source{"spool"}.getStr("").len > 0:
      let field = source{"spool"}.getStr()
      if not e.runtime.spoolFields.hasKey(field):
        return jsNull(ctx)
      let spool = e.runtime.spoolFields[field]
      reference = registerJsStream(scene, newStream(spool), spool = spool)
    else:
      let id = source{"id"}.getInt(0)
      if not jsStreamOf(scene, id):
        return jsNull(ctx)
      reference = %*{"__frameosType": "streamRef", "id": id}
    let id = reference{"id"}.getInt()
    jsStreamsGlobal[id].lines = newLineReader(jsStreamsGlobal[id].stream, lineOptions(options))
    e.runtime.lineStreamIds.add(id)
    return jsonToJS(ctx, reference)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app openLines failed: " & err.msg)
    return jsNull(ctx)

proc jsNextLine(ctx: ptr JSContext, id: JSValue): JSValue {.nimcall.} =
  ## The next line, or null at the end. Called once per line of a feed.
  let e = env(ctx)
  let streamId = toNimFloat(ctx, id).int
  if e == nil or not jsStreamOf(e.runtime.sceneId, streamId) or jsStreamsGlobal[streamId].lines.isNil:
    return jsNull(ctx)
  var line = ""
  try:
    if jsStreamsGlobal[streamId].lines.nextLine(line):
      return nimStringToJS(ctx, line)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app nextLine failed: " & err.msg)
  return jsNull(ctx)

proc jsNextBlock(ctx: ptr JSContext, id: JSValue, stop: JSValue): JSValue {.nimcall.} =
  ## The lines up to the next one starting with `stop`, or null at the end.
  let e = env(ctx)
  let streamId = toNimFloat(ctx, id).int
  # `stop` as text before the stream is looked up: the conversion can run
  # the app's code, which can close it.
  let stopAt = toNimString(ctx, stop)
  if e == nil or not jsStreamOf(e.runtime.sceneId, streamId) or jsStreamsGlobal[streamId].lines.isNil:
    return jsNull(ctx)
  var text = ""
  try:
    if jsStreamsGlobal[streamId].lines.nextBlock(stopAt, text):
      return nimStringToJS(ctx, text)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app nextBlock failed: " & err.msg)
  return jsNull(ctx)

proc jsTimeZoneInfo(ctx: ptr JSContext, name: JSValue): JSValue {.nimcall.} =
  ## {name, changes: [start, offset, ...]}: the zone's canonical name and its
  ## UTC offsets as chrono holds them, for an app working in wall-clock time
  ## of zones other than the frame's. Empty on a frame without that zone's
  ## data, which is UTC, as it is for the Nim side.
  let canonical = canonicalTimeZone(toNimString(ctx, name))
  var changes = newJArray()
  if canonical.len > 0:
    initTimeZone()
    let zone = findTimeZone(canonical)
    if zone.valid:
      for change in findDstChanges(zone):
        changes.add(%change.start.float)
        changes.add(%change.offset.int)
  return jsonToJS(ctx, %*{"name": canonical, "changes": changes})

proc streamOpenAsset(ctx: ptr JSContext, e: JsAppEvalEnv, options: JsonNode): JSValue =
  let pathStr = options{"path"}.getStr("")
  let mode = options{"mode"}.getStr("r")
  let full = resolveAssetPath(e, pathStr, write = mode != "r")
  if full.len == 0:
    frameos_apps.logError(e.owner, "JS app openAssetStream" & AssetPathRefused & pathStr)
    return jsNull(ctx)
  var stream: Stream
  if mode == "r":
    if not fileExists(full):
      return jsNull(ctx)
    stream = newFileStream(full, fmRead)
  elif mode in ["w", "a"]:
    createDir(full.parentDir())
    let freeDiskSpace = getAvailableDiskSpace(full.parentDir())
    if freeDiskSpace != -1 and freeDiskSpace < 100 * 1024 * 1024:
      frameos_apps.logError(e.owner, "JS app openAssetStream: low disk space: " & pathStr)
      return jsNull(ctx)
    stream = newFileStream(full, if mode == "a": fmAppend else: fmWrite)
  else:
    frameos_apps.logError(e.owner, "JS app openAssetStream: unknown mode: " & mode)
    return jsNull(ctx)
  if stream.isNil:
    return jsNull(ctx)
  jsonToJS(ctx, registerJsStream(e.runtime.sceneId, stream))

proc streamCreate(ctx: ptr JSContext, e: JsAppEvalEnv, options: JsonNode): JSValue =
  let bytes = decode(options{"base64"}.getStr(""))
  if stringStreamBytes(e.runtime.sceneId) + bytes.len > MaxStringStreamBytes:
    frameos_apps.logError(e.owner, "JS app createStream: this scene's streams hold too much already")
    return jsNull(ctx)
  jsonToJS(ctx, registerJsStream(e.runtime.sceneId, newStringStream(bytes)))

proc streamRead(ctx: ptr JSContext, e: JsAppEvalEnv, options: JsonNode): JSValue =
  let stream = jsStreamById(e.runtime.sceneId, options)
  if stream.isNil:
    return jsNull(ctx)
  let length = clamp(options{"length"}.getInt(DefaultJsStreamChunkBytes), 1, jsAssetReadMaxBytes(e))
  nimStringToJS(ctx, encode(stream.readStr(length)))

proc streamWrite(e: JsAppEvalEnv, options: JsonNode): bool =
  let stream = jsStreamById(e.runtime.sceneId, options)
  if stream.isNil:
    return false
  let bytes = decode(options{"base64"}.getStr(""))
  if stream of StringStream and stringStreamBytes(e.runtime.sceneId) + bytes.len > MaxStringStreamBytes:
    frameos_apps.logError(e.owner, "JS app streamWrite: this scene's streams hold too much already")
    return false
  stream.write(bytes)
  true

proc streamRewind(scene: string, options: JsonNode): bool =
  let id = options{"id"}.getInt(0)
  if not jsStreamOf(scene, id):
    return false
  if jsStreamsGlobal[id].lines.isNil:
    jsStreamsGlobal[id].stream.setPosition(0)
  else:
    jsStreamsGlobal[id].lines.rewind()
  true

proc jsStreams(ctx: ptr JSContext, op: JSValue, optionsJson: JSValue): JSValue {.nimcall.} =
  ## Ops: openAsset {path, mode: r|w|a} -> streamRef, create {base64} -> streamRef,
  ## read {id, length} -> base64 ("" at end), write {id, base64}, atEnd {id},
  ## close {id}. Read sizes are capped like readAsset; loop for more. Each op
  ## with locals of its own is a proc of its own, as in jsAssets: a proc's
  ## locals are destroyed at every one of its exits.
  let e = env(ctx)
  if e == nil:
    return jsUndefSentinel(ctx)

  let opStr = toNimString(ctx, op)
  let options = optionsArg(ctx, optionsJson)

  try:
    case opStr
    of "openAsset":
      return streamOpenAsset(ctx, e, options)
    of "create":
      return streamCreate(ctx, e, options)
    of "read":
      return streamRead(ctx, e, options)
    of "write":
      return nimBoolToJS(ctx, streamWrite(e, options))
    of "atEnd":
      let stream = jsStreamById(e.runtime.sceneId, options)
      return nimBoolToJS(ctx, stream.isNil or stream.atEnd())
    of "rewind":
      return nimBoolToJS(ctx, streamRewind(e.runtime.sceneId, options))
    of "close":
      return nimBoolToJS(ctx, closeJsStream(e.runtime.sceneId, options{"id"}.getInt(0)))
    else:
      frameos_apps.logError(e.owner, "JS app streams: unknown operation: " & opStr)
      return jsUndefSentinel(ctx)
  except CatchableError as err:
    frameos_apps.logError(e.owner, "JS app streams " & opStr & " failed: " & err.msg)
    if opStr in ["write", "close", "rewind", "atEnd"]:
      return nimBoolToJS(ctx, false)
    return jsNull(ctx)

proc jsGetSetting(ctx: ptr JSContext, pathJson: JSValue): JSValue {.nimcall.} =
  ## Read a value from frameConfig.settings, e.g. getSetting("openAI", "apiKey"),
  ## with the keys typed on the frame over it.
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

  # A key typed on the frame wins over the one a plane sent (frame_service_keys.nim).
  var node = withServiceKeys(e.owner.frameConfig.settings, namespace)
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

proc pictureFormatLike(context: ExecutionContext): Image =
  ## An image in the canvas's pixel format, if one is about: what an app's
  ## own picture is made like, so drawing it later is a copy.
  if context.isNil: nil
  elif not context.decodeTargetImage.isNil: context.decodeTargetImage
  else: context.contextImage()

when defined(freertos):
  # What only the firmware knows (fos_client.c).
  proc fos_client_battery_percent(): cint {.importc, cdecl.}
  proc fos_client_wifi_rssi(): cint {.importc, cdecl.}

var
  layoutWrappedSceneId*: proc(owner: FrameScene): string {.nimcall.}
    ## Set by the interpreter: the id of the scene a layout wraps, else the
    ## scene's own (`app.frame.sceneId`).
  windowSceneListing* {.threadvar.}: proc(): JsonNode {.closure, gcsafe.}
    ## Set by a host that runs a frame's scenes side by side (runner.nim,
    ## single_scene_host.nim): the scenes a layout can open in windows,
    ## `[{id, name}]` in the frame's order (`app.frame.scenes`). Unset, a
    ## layout shows one scene.

proc windowLimit*(): int =
  ## How many of the frame's scenes may run as windows at once, the one in
  ## front included (`app.frame.windows`, docs/scene-layouts.md "Windows"): 0
  ## where there is no limit (a Pi, the browser preview), else by the memory
  ## the device leaves its scenes once the panel has its canvas and buffers
  ## (memory.sceneMemoryBytes; the preview simulating one counts the same):
  ## 4 from 9 MB, 2 from 4 MB (an 8 MB board with a panel up to 10.3"), 1
  ## below (the 13.3" colour E1004 on 8 MB, whose 3.84 MB canvas leaves about
  ## 2.5 MB: a second scene beside the one in front ran it out of memory,
  ## the hardware bench, 2026-11-17). Each one is a scene running: its
  ## program, its JS apps' interpreters and its UI, beside the layout and
  ## what the scene in front draws.
  let memory = sceneMemoryBytes()
  when not defined(frameosEmbedded):
    if memory <= 0:
      return 0
  if memory >= 9 * 1024 * 1024: 4
  elif memory >= 4 * 1024 * 1024: 2
  else: 1

proc jsGetAppFrame(ctx: ptr JSContext, key: JSValue): JSValue {.nimcall.} =
  ## One way out: a `return` per key repeated the clean-up of the key's
  ## text and the inlined sentinel (docs/esp32-image-size.md). `undef`: the
  ## key has no value here.
  let e = env(ctx)
  var undef = e == nil
  if not undef:
    case toNimString(ctx, key)
    of "width":
      # A .tsx app at render scale 2 is on a panel half the size (render_scale.nim).
      result = appLength(ctx, e, e.owner.frameConfig.width)
    of "height":
      result = appLength(ctx, e, e.owner.frameConfig.height)
    of "scale":
      # The render scale in effect for the scene, whatever kind of app asks.
      result = nimFloatToJS(ctx, effectiveRenderScale(e.owner.scene, e.owner.frameConfig))
    of "rotate":
      # A board rendered on its plane is turned by the board: the runtime draws
      # its canvas already turned and keeps 0 itself, and says the board's.
      let rotate = if boardRotation >= 0: boardRotation else: e.owner.frameConfig.rotate
      result = nimIntToJS(ctx, rotate.int32)
    of "assetsPath":
      result = nimStringToJS(ctx, e.owner.frameConfig.assetsPath)
    of "storages":
      result = jsonToJS(ctx, frameStorages())
    of "timeZone":
      result = nimStringToJS(ctx, e.owner.frameConfig.timeZone)
    of "debug":
      result = nimBoolToJS(ctx, e.owner.frameConfig.debug)
    of "embedded":
      # An ESP32-class runtime, or the preview running as one: no storage for
      # assets, a few MB of PSRAM. The OpenAI image app asks for a lighter
      # picture there.
      result = nimBoolToJS(ctx, runsAsEmbedded())
    of "fast":
      # Whether a change shows as soon as it is drawn (panel_shape.panelIsFast):
      # an app that follows a finger waits for it to lift where it does not.
      # The frame's panel, never the context's canvas, which onEvent, init()
      # and an async continuation do not have: on an ESP32 they read e-paper
      # on an LCD.
      result = nimBoolToJS(ctx, panelIsFast(e.owner.frameConfig.device))
    of "paper":
      # Whether the panel draws in inks (panel_shape.panelIsPaper): how a scene
      # looks there. Until 2026.11.10 it also said what `fast` says now, and
      # today the two are opposites on every panel. The panel's, as above.
      result = nimBoolToJS(ctx, panelIsPaper(e.owner.frameConfig.device))
    of "round":
      # Only the circle inside the panel's square shows and takes touches
      # (panel_shape.panelIsRound: the HyperPixel 2.1 Round, the Waveshare
      # 1.75" AMOLED). An app that draws the whole panel keeps what matters
      # inside it; the frame's own scenes do.
      result = nimBoolToJS(ctx, panelIsRound(e.owner.frameConfig.device))
    of "color":
      # Whether the panel shows colors (utils/asset_colors.panelShowsColor):
      # a scene draws in high contrast where it does not. The panel's, as above.
      result = nimBoolToJS(ctx, panelShowsColor(e.owner.frameConfig.device))
    of "sceneName":
      # A layout's is the name of the scene it wraps (interpreter.ensureLayoutScene).
      if not e.owner.scene.isNil and e.owner.scene.shownName.len > 0:
        result = nimStringToJS(ctx, e.owner.scene.shownName)
      else:
        undef = true
    of "systemScene":
      # A layout around the scene list or the settings: it may give them the
      # whole panel by returning a bare <yield />.
      if not e.owner.scene.isNil and e.owner.scene.systemScene:
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "typing":
      # A layout around a scene that has the keyboard on the screen up: it may
      # give the scene the whole panel by returning a bare <yield />.
      if not e.owner.scene.isNil and e.owner.scene.typing:
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "fullScreen":
      # A layout around a scene that asks for the whole panel (full_screen.nim:
      # its role field, else settings.fullScreen): the layout gives it by
      # returning a bare <yield />.
      if not e.owner.scene.isNil and e.owner.scene.wrapsFullScreen:
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "batteryPercent":
      # An ESP32 with a battery. A Pi and the preview have nothing to say.
      when defined(freertos):
        let percent = fos_client_battery_percent()
        if percent >= 0:
          result = nimIntToJS(ctx, percent.int32)
        else:
          undef = true
      else:
        undef = true
    of "accelerometer":
      # The frame has one (docs/accelerometer.md): frameos.accelerometer()
      # reads it. Undefined where it has none.
      var x, y, z: float
      if readAccelerometer(x, y, z):
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "tone":
      # Something plays frameos.tone() (docs/tones.md): a buzzer, a speaker or
      # the status LED, the browser preview, a board rendered on its plane.
      # Undefined where nothing does (a Raspberry Pi).
      if canPlayTones():
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "wifiRssi":
      when defined(freertos):
        let rssi = fos_client_wifi_rssi()
        if rssi != 0:
          result = nimIntToJS(ctx, rssi.int32)
        else:
          undef = true
      else:
        undef = true
    of "sceneId":
      # A layout's is the id of the scene it wraps, the one its <yield /> shows.
      if not e.owner.scene.isNil and not layoutWrappedSceneId.isNil:
        result = nimStringToJS(ctx, layoutWrappedSceneId(e.owner.scene))
      else:
        undef = true
    of "wentBack":
      # True while the scene a layout wraps is showing because a built-in scene
      # went back to it by itself (its Close, its Cancel, its timeout), not
      # because anyone picked it: a desktop opens no window again for it.
      if not e.owner.scene.isNil and not layoutWrappedSceneId.isNil and sceneWentBackTo.len > 0 and
          layoutWrappedSceneId(e.owner.scene) == sceneWentBackTo:
        result = nimBoolToJS(ctx, true)
      else:
        undef = true
    of "scenes":
      # The scenes a layout can open side by side: not on every host.
      if not windowSceneListing.isNil:
        result = jsonToJS(ctx, windowSceneListing())
      else:
        undef = true
    of "keptOpen":
      # The built-in scenes open beside the scene showing (`builtInsAway`).
      if not windowSceneListing.isNil:
        result = jsonToJS(ctx, %builtInsAway)
      else:
        undef = true
    of "windows":
      # How many of them may run at once, where there is a limit (windowLimit).
      let limit = windowLimit()
      if not windowSceneListing.isNil and limit > 0:
        result = nimIntToJS(ctx, limit.int32)
      else:
        undef = true
    of "eventMap":
      # The frame's event map (frame.json `eventMap`, docs/events.md "Event
      # map"): what its keys and swipes do whatever scene shows, for a layout
      # that labels the keys beside the glass. Undefined with none (the
      # preview of a scene, a frame never given one).
      let rules = e.owner.frameConfig.eventMap
      if not rules.isNil and rules.kind == JArray:
        result = jsonToJS(ctx, rules)
      else:
        undef = true
    of "theme":
      # The theme of the desktop around the frame's scene (ui/theme.nim), for
      # what an element's `look` cannot reach: an SVG's fill, a mask in the
      # page's color. None, or an empty one, is the app's own look.
      let theme = if themeSource.isNil: nil else: themeSource()
      if not theme.isNil and theme.kind == JObject and theme.len > 0:
        result = jsonToJS(ctx, theme)
      else:
        undef = true
    else:
      undef = true

  if undef:
    result = jsUndefSentinel(ctx)

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
  of "round":
    # This app draws a round panel's whole canvas: only the circle inside it
    # shows, so the app keeps what matters there (docs/scene-guide.md "Round
    # panels"). False in a window, a split's panel or a layout's hole, which
    # are rooms of their own, and on every other panel.
    let config = e.owner.frameConfig
    return nimBoolToJS(ctx, not config.isNil and panelIsRound(config.device) and
      e.context.hasImage and not e.context.image.isNil and
      e.context.image.width == frameos_apps.renderWidth(config) and
      e.context.image.height == frameos_apps.renderHeight(config))
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
    keys = @["width", "height", "rotate", "assetsPath", "storages", "timeZone", "debug", "embedded", "scale", "fast",
      "paper", "color", "round", "sceneName", "systemScene", "typing", "fullScreen", "wentBack", "batteryPercent", "wifiRssi",
      "accelerometer", "tone", "theme", "eventMap"]
    keys.add("sceneId")
    if not windowSceneListing.isNil:
      keys.add("scenes")
      keys.add("keptOpen")
      if windowLimit() > 0:
        keys.add("windows")
  of "context":
    keys = @["event", "hasImage", "payload", "loopIndex", "loopKey", "nextSleep", "round"]
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
    transientImageIds: @[],
    ownSleep: -1
  )

type
  DynamicJsApp* = ref object of AppRoot
    configJson*: JsonNode
    runtime*: JsAppRuntime
    events*: JsonNode ## config.json `events`: what its onEvent hears ("*": all of it)
    byteIterFields: seq[string] ## config.json fields with the `byteIter` capability

when not defined(frameosEmbedded):
  # What a control plane carries from one render process to the next
  # (docs/server-rendering.md, "Kept between pulls"): each live app's
  # `frameos.remember` values. A board keeps them until the scene unloads or
  # the chip sleeps; a plane draws every pull in a new process and hands them
  # over (wasm_main's frameos_wasm_kept_state). Off until that runtime turns
  # it on (`keepAppMemoryAcrossProcesses`): a Pi keeps its apps in one
  # process and needs no list of them. Not in the firmware.
  type ParkedAppMemory = tuple[sceneId: string, nodeId: int, memory: JsonNode]
  var
    appMemoryTracked {.threadvar.}: bool
    liveDynamicJsApps {.threadvar.}: seq[DynamicJsApp]
    parkedAppMemory {.threadvar.}: seq[ParkedAppMemory]

  proc keepAppMemoryAcrossProcesses*() =
    ## Track the live apps from now on, so their remembered values can be
    ## handed out (`keptAppMemory`) and put back (`restoreKeptAppMemory`).
    appMemoryTracked = true

  proc appSceneId(app: DynamicJsApp): string =
    if app.scene.isNil: "" else: app.scene.id.string

  proc applyKeptMemory(app: DynamicJsApp, memory: JsonNode) =
    ## Put back what an app of the last process remembered: its whole memory,
    ## as `remember` would have left it. Skipped when it is over the node's
    ## limit; a malformed key or value is left out.
    if app.runtime.isNil or memory.isNil or memory.kind != JObject:
      return
    var kept = initTable[string, string]()
    var bytes = 0
    for key, value in memory:
      if key.len == 0 or value.kind != JString:
        continue
      let text = value.getStr()
      if text.len == 0 or text == "null":
        continue
      kept[key] = text
      bytes += key.len + text.len
    if bytes > JsAppMemoryMaxBytes:
      return
    app.runtime.memory = kept
    app.runtime.memoryBytes = bytes

  proc takeParkedMemory(app: DynamicJsApp) =
    ## A parked entry for this app is applied and gone: each is used once, so
    ## a scene left and entered again in one process starts empty, as on a
    ## board.
    let sceneId = app.appSceneId()
    for i in 0 ..< parkedAppMemory.len:
      if parkedAppMemory[i].sceneId == sceneId and parkedAppMemory[i].nodeId == app.nodeId.int:
        let memory = parkedAppMemory[i].memory
        parkedAppMemory.delete(i)
        app.applyKeptMemory(memory)
        return

  proc trackDynamicJsApp(app: DynamicJsApp) =
    if not appMemoryTracked:
      return
    liveDynamicJsApps.add app
    app.takeParkedMemory()

  proc untrackDynamicJsApp(app: DynamicJsApp) =
    let i = liveDynamicJsApps.find(app)
    if i >= 0:
      liveDynamicJsApps.delete(i)

  proc keptAppMemory*(): JsonNode =
    ## Every live app's remembered values, for the next process:
    ## `[{sceneId, nodeId, memory: {key: <the JSON text remember kept>}}]`,
    ## an app with nothing remembered left out. A layout's apps and a
    ## `<Scene>`'s are live apps too.
    result = newJArray()
    for app in liveDynamicJsApps:
      if app.runtime.isNil or app.runtime.memory.len == 0:
        continue
      var memory = newJObject()
      for key, value in app.runtime.memory:
        memory[key] = newJString(value)
      result.add %*{"sceneId": app.appSceneId(), "nodeId": app.nodeId.int, "memory": memory}

  proc restoreKeptAppMemory*(entries: JsonNode): int =
    ## What `keptAppMemory` handed out in the last process: applied to a live
    ## app it names at once, else parked until that app is built
    ## (initDynamicJsApp). How many entries it took; malformed ones are
    ## skipped, and so is an entry over the node's `remember` limit.
    parkedAppMemory.setLen(0)
    if entries.isNil or entries.kind != JArray:
      return 0
    for entry in entries:
      if entry.kind != JObject:
        continue
      let
        sceneId = entry{"sceneId"}.getStr()
        nodeId = entry{"nodeId"}
        memory = entry{"memory"}
      if sceneId.len == 0 or nodeId.isNil or nodeId.kind != JInt or memory.isNil or memory.kind != JObject:
        continue
      parkedAppMemory.add (sceneId: sceneId, nodeId: nodeId.getInt(), memory: memory)
      inc result
    for app in liveDynamicJsApps:
      app.takeParkedMemory()

proc haveSources(runtime: JsAppRuntime) =
  ## The app's files in hand again (a module imported after the app was
  ## compiled): read once more, kept until the next compile lets them go.
  if runtime.sources.isNil and not runtime.reload.isNil:
    runtime.sources = runtime.reload()

proc appFile(runtime: JsAppRuntime, name: string): string =
  ## Contents of one of the app's files, "" when absent.
  runtime.haveSources()
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
  runtime.haveSources()
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

proc moduleOwner(ctx: ptr JSContext, moduleName: string): tuple[runtime: JsAppRuntime, file: string] =
  ## The app a module name belongs to, and its file: `#<appKey>/lib/a.ts` in
  ## a scene's context (each app's files apart from the others'), the bare
  ## file name in an interpreter of the app's own (prefix "").
  for runtime in liveJsRuntimes:
    if runtime.js.context == ctx and moduleName.startsWith(runtime.modulePrefix):
      return (runtime, moduleName.substr(runtime.modulePrefix.len))
  (nil, moduleName)

proc jsAppModuleNormalize(ctx: ptr JSContext, baseName: cstring, name: cstring,
                          opaque: pointer): cstring {.cdecl.} =
  ## Canonicalise every specifier to the file it names, so `./counter` and
  ## `./counter.ts` from two importers are one module, evaluated once.
  var canonical = ""
  try:
    let (runtime, base) = moduleOwner(ctx, $baseName)
    canonical = joinModulePath(base, $name)
    if not runtime.isNil:
      let resolved = runtime.resolveModuleName(canonical)
      if resolved.len > 0:
        canonical = resolved
      canonical = runtime.modulePrefix & canonical
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
  let moduleName = runtime.modulePrefix & name
  result = compileModule(ctx, runtime.appFile(name), moduleName, quicktsFlagsFor(name))
  if result == nil:
    rethrowNamingModule(ctx, moduleName)

proc jsAppModuleLoader(ctx: ptr JSContext, moduleName: cstring, opaque: pointer): ptr JSModuleDef {.cdecl.} =
  ## QuickJS calls this for every `import` the app's modules make. Modules are
  ## the app's own files and nothing else: there is no package registry on a
  ## frame, so a bare specifier fails the same way a missing file does.
  var name = $moduleName
  try:
    let (runtime, file) = moduleOwner(ctx, name)
    if runtime.isNil:
      discard JS_ThrowReferenceError(ctx, "could not load module '%s'", name.cstring)
      return nil
    name = file
    runtime.haveSources()
    let resolved = resolveAppModule(runtime.sources, name)
    if resolved.len == 0:
      discard JS_ThrowReferenceError(ctx, "%s",
        ("Cannot import '" & name & "': it is not one of this app's files. Import the app's own " &
         "files with a relative path (./helper, ./data.json); npm packages are not available.").cstring)
      return nil
    if resolved.endsWith(".json"):
      return loadAppJsonModule(ctx, runtime.modulePrefix & resolved, runtime.appFile(resolved))
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

const
  MaxKeptImages = 8
    ## Pictures an app may keep whatever their size; the oldest goes for a ninth,
  MaxKeptThumbnails = 48
    ## unless they are small: past eight, an app keeps pictures while they hold
  KeptThumbnailPixels = 8 * 480 * 480
    ## no more pixels than eight 480x480 photos, up to 48 of them (a store's or
    ## the Files sample's thumbnails). Memory still decides first
    ## (keptPictureTarget).

proc keptPixels(runtime: JsAppRuntime): int =
  for id in runtime.keptImageIds:
    let image = runtime.images.getOrDefault(id)
    if not image.isNil:
      result += image.width * image.height

proc keptHasRoom(runtime: JsAppRuntime, pixels: int): bool =
  let count = runtime.keptImageIds.len + 1
  count <= MaxKeptImages or
    (count <= MaxKeptThumbnails and runtime.keptPixels() + pixels <= KeptThumbnailPixels)

proc storeKeptImageJson(runtime: JsAppRuntime, owner: AppRoot, image: Image): JsonNode =
  result = runtime.storeImageJson(image)
  if result.kind == JObject:
    runtime.keptImageIds.add(result["id"].getInt())
    var dropped = 0
    while runtime.keptImageIds.len > MaxKeptImages and
        (runtime.keptImageIds.len > MaxKeptThumbnails or runtime.keptPixels() > KeptThumbnailPixels):
      runtime.images.del(runtime.keptImageIds[0])
      runtime.keptImageIds.delete(0)
      inc dropped
    if dropped > 0:
      frameos_apps.log(owner, %*{"event": "js:keptImages", "dropped": dropped,
        "limit": runtime.keptImageIds.len})

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
    options = parseJsonBounded(toNimString(ctx, optionsJson))
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
      # One buffer the size of the canvas, asked for first: on an ESP32 one
      # that does not fit is an out-of-memory abort, not an exception, and
      # four in a row restart the frame. A panel-sized canvas on the
      # reTerminal E1004 (1200x1600 RGB565, 3.84 MB) is more than the board
      # has beside its own (Sketchbook, Touch test, Handwriting notes: the UX
      # bench, 2026-11-27). Without the room the app gets null, which it
      # already draws without (docs/scene-guide.md).
      let bytes = imageBytes(if like.isNil: pfRgbx else: like.format, width, height)
      if not roomForImage(bytes):
        frameos_apps.logError(e.owner, "frameos.canvas: no room for a " & $width & "x" & $height &
          " canvas (" & $bytes & " bytes)")
      else:
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
      id = 0
    # No room, or the canvas failed: one way out for both (every return is
    # every live local's cleanup written out again).
    if id == 0:
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
      let entry = e.runtime.appEntry()
      node = jsxNode(ctx, content, addr e.runtime.images, entry, drawing = true)
      JS_FreeValue(ctx, entry)
      if node.tag != "svg":
        node = SvgNode(tag: "svg", attrs: @size, children: @[node])
    if node.attr("viewBox").len == 0 and node.attr("width").len == 0:
      for (name, value) in size:
        node.setAttr(name, value)
    let
      drawn = parseSvg(node, image.width, image.height, lateData = true) # drawn once, below
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

include frameos/js_runtime/js_video

var typedArrayFirstClass = 0'u32
  ## The class id of a Uint8ClampedArray, the first typed array class: one
  ## less it is an ArrayKind (QuickJS keeps them in JSTypedArrayEnum's order).

proc jsElements(ctx: ptr JSContext, value: JSValueConst, elements: var Elements): bool =
  ## A typed array in place, by kind.
  if typedArrayFirstClass == 0:
    var zero = JS_NewInt32(ctx, 0)
    let probe = JS_NewTypedArray(ctx, 1, addr zero, 0)
    typedArrayFirstClass = JS_GetClassID(probe)
    JS_FreeValue(ctx, probe)
  let (bytes, byteLen) = jsBytes(ctx, value)
  if bytes.isNil:
    return false
  let offset = JS_GetClassID(value).int - typedArrayFirstClass.int
  let kind = if offset >= 0 and offset <= ord(high(ArrayKind)): ArrayKind(offset) else: akUint8
  if not kind.supported:
    return false
  let size = case kind
    of akInt16, akUint16: 2
    of akInt32, akUint32, akFloat32: 4
    else: 1
  elements = Elements(data: bytes, length: byteLen div size, kind: kind)
  true

proc jsArgInt(ctx: ptr JSContext, value: JSValueConst, default: int): int =
  ## A whole number argument; `default` for anything else (NaN, a string).
  if not jsIsNumber(value):
    return default
  let number = toNimFloat(ctx, value)
  if number != number or abs(number) > 1e9: default else: number.int

proc jsTypedOps(ctx: ptr JSContext, args: seq[JSValue]): JSValue {.nimcall.} =
  ## `frameos.ops`: map, add, sub, mul and convolve over whole typed arrays
  ## (typed_ops.nim). False, logged, for arrays it cannot take or a range
  ## past their ends.
  let e = env(ctx)
  template refuse(): untyped =
    if e != nil:
      frameos_apps.logError(e.owner, "frameos.ops: arrays it cannot take (BigInt, Float16, Float64) or a range past their end")
    return nimBoolToJS(ctx, false)
  if args.len < 6:
    refuse()
  let op = jsArgInt(ctx, args[0], -1)
  # An array's bytes are a pointer into the JS heap, good only until the
  # scene's code runs again: it can detach the buffer or resize it. So what
  # can run it is read first (a kernel's elements may be getters, or a
  # proxy's), the arrays are taken after, and from there to the loops nothing
  # calls into JavaScript (a number is read as one, never converted).
  var kernel: array[9, int32]
  if op == 4:
    for k in 0 ..< 9:
      let v = JS_GetPropertyUint32(ctx, args[4], k.uint32)
      kernel[k] = int32(clamp(jsArgInt(ctx, v, 0), -65536, 65536))
      JS_FreeValue(ctx, v)
  var dst, a: Elements
  if not jsElements(ctx, args[1], dst) or not jsElements(ctx, args[2], a):
    refuse()
  if op == 4:
    let width = jsArgInt(ctx, args[3], 0)
    let shift = clamp(jsArgInt(ctx, args[5], 0), 0, 31)
    if width < 3 or a.length < width * 3 or dst.length < a.length:
      refuse()
    convolve3x3(dst, a, width, a.length div width, kernel, shift)
    return nimBoolToJS(ctx, true)
  let start = max(0, jsArgInt(ctx, args[4], 0))
  let requested = jsArgInt(ctx, args[5], -1)
  var finish = if requested < 0: min(dst.length, a.length) else: requested
  if op == 0:
    var table: Elements
    if not jsElements(ctx, args[3], table) or finish > dst.length or finish > a.length:
      refuse()
    mapTable(dst, a, table, start, finish)
    return nimBoolToJS(ctx, true)
  var b: Operand
  if jsIsNumber(args[3]):
    b = Operand(isArray: false, value: float32(toNimFloat(ctx, args[3])))
  else:
    b.isArray = true
    if not jsElements(ctx, args[3], b.elements):
      refuse()
    if requested < 0:
      finish = min(finish, b.elements.length)
    if finish > b.elements.length:
      refuse()
  if finish > dst.length or finish > a.length or op < 1 or op > 3:
    refuse()
  arith(Arith(op - 1), dst, a, b, start, finish)
  nimBoolToJS(ctx, true)

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
  let name = jsAppSourceNameFromSources(sources)
  if name.len > 0: sources[name].getStr() else: ""

proc hasJsAppSource*(sources: JsonNode): bool =
  ## Whether the app has a main module, its text not copied to find out.
  let name = jsAppSourceNameFromSources(sources)
  name.len > 0 and sources[name].str.len > 0

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

proc configFromSources*(sources: JsonNode): JsonNode =
  ## The app's config.json, when it is one: strict JSON and an object
  ## (utils/strict_json.nim). Anything else is no config, so it asks for
  ## nothing: what this reads is what a control plane's `JSON.parse` read
  ## when it showed the owner what the app asks for.
  if not sources.isNil and sources.kind == JObject and sources.hasKey("config.json"):
    result = strictJsonObject(sources["config.json"].getStr())
  if result.isNil:
    result = newJObject()

proc settingsKeysFromConfig*(config: JsonNode): seq[string] =
  ## config.json `settings`: the settings namespaces the app reads.
  let settingsNode = config{"settings"}
  if not settingsNode.isNil and settingsNode.kind == JArray:
    for key in settingsNode.items:
      if key.kind == JString and key.getStr().len > 0:
        result.add(key.getStr())

proc grantsFromConfig*(config: JsonNode): tuple[assets: JsAssetGrant, frame, code, store: bool] =
  ## config.json `permissions`: exactly what the app asks for. No list, or a
  ## value that is not one, asks for nothing. "frame" is `frameos.frame`,
  ## "code" `frameos.code`, "store" `frameos.storeAction`.
  ## One pass for them all: a second walk of the list cost 0.5 KB of ESP32 flash.
  result.assets = agOwnFolder
  let declared = config{"permissions"}
  if not declared.isNil and declared.kind == JArray:
    for item in declared.elems:
      case item.getStr()
      of "assets-write": result.assets = agReadWrite
      of "assets", "files": result.assets = max(result.assets, agRead)
      of "frame": result.frame = true
      of "code": result.code = true
      of "store": result.store = true
      else: discard

template assetGrantFromConfig*(config: JsonNode): JsAssetGrant = grantsFromConfig(config).assets
template frameGrantFromConfig*(config: JsonNode): bool = grantsFromConfig(config).frame
template codeGrantFromConfig*(config: JsonNode): bool = grantsFromConfig(config).code
template storeGrantFromConfig*(config: JsonNode): bool = grantsFromConfig(config).store

proc initDynamicJsApp*(keyword: string, node: DiagramNode, scene: FrameScene, sources: JsonNode,
    reload: proc (): JsonNode = nil): AppRoot =
  ## `reload`: the app's files read again, so that its interpreter keeps none
  ## of them once compiled (JsAppRuntime.reload).
  let source = jsAppSourceFromSources(sources)
  if source.len == 0:
    raise newException(ValueError, "Missing JavaScript app source for keyword: " & keyword)
  let config = configFromSources(sources)
  let category = config{"category"}.getStr().toLowerAscii()
  let outputType = outputTypeFromConfig(config)
  let grants = grantsFromConfig(config)
  let runtime = newJsAppRuntime(category, outputType, source, settingsKeysFromConfig(config),
                                jsAppSourceNameFromSources(sources), sources, grants.assets)
  runtime.frameGrant = grants.frame
  runtime.codeGrant = grants.code
  runtime.storeGrant = grants.store
  runtime.reload = reload
  var byteIterFields: seq[string] = @[]
  let fields = config{"fields"}
  if not fields.isNil and fields.kind == JArray:
    for field in fields.elems:
      let capabilities = if field.kind == JObject: field{"capabilities"} else: nil
      if not capabilities.isNil and capabilities.kind == JObject and capabilities.hasKey("byteIter"):
        byteIterFields.add(field{"name"}.getStr(""))
  let app = DynamicJsApp(
    nodeId: node.id,
    nodeName: node.data{"name"}.getStr(keyword),
    appKeyword: keyword,
    scene: scene,
    frameConfig: scene.frameConfig,
    configJson: runtimeConfigFromNode(config, node.data{"config"}),
    runtime: runtime,
    events: config{"events"},
    byteIterFields: byteIterFields
  )
  if scene of InterpretedFrameScene:
    # Its scene's context is where it runs: one of the scene's own, whether
    # or not the scene has code (runtime.ensureSceneJs).
    InterpretedFrameScene(scene).hasJsApps = true
  when not defined(frameosEmbedded):
    app.trackDynamicJsApp()
  return app

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
  when not defined(frameosEmbedded):
    untrackDynamicJsApp(DynamicJsApp(app))
  if not app.scene.isNil:
    forgetUiTarget(app.scene.id.string, app.nodeId.int, cast[pointer](app))
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
  var nextValue: JsonNode
  if value.kind == fkSpool and field in dynamicApp.byteIterFields:
    # Declared `byteIter`: the bytes stay out of the interpreter. A plain
    # string on the same edge still arrives as a string, which openLines reads
    # the same way.
    dynamicApp.runtime.spoolFields[field] = value.sp
    nextValue = %*{"__frameosType": "streamRef", "spool": field}
  else:
    dynamicApp.runtime.spoolFields.del(field)
    nextValue = dynamicApp.runtime.jsAppValueToJson(value)
  if dynamicApp.configJson.hasKey(field):
    dynamicApp.runtime.releaseReplacedImageRef(dynamicApp.configJson[field], nextValue)
  dynamicApp.configJson[field] = nextValue

# The app prelude: the frameos.* API glue, the Proxy views of app.config /
# state / frame / context, and the scene's apps by key. Evaluated once in a
# context that has the scene prelude already (runtime.setUpSceneContext: the
# JSX factory and memo()), the scene's own, which its JS apps share. Compiled
# on the device (~102 ms of a SenseCAP frame for 6.4 KB of both preludes,
# docs/realtime-rendering.md), or loaded as the bytecode
# tools/prelude_bytecode.nim wrote into the firmware image (evalAppPrelude).
const AppStringify: cstring = "__frameosAppStringify"
  ## What an app's values are read through (runtime.jsValueToJson): the
  ## scene's own keeps no undefined.

const appJsPrelude* = compactJs("""
  "use strict";
  const __appReplacer = (k, v) =>
    (typeof v === 'bigint') ? { __bigint: v.toString() } : v;
  globalThis.__frameosAppStringify = (v) => JSON.stringify(v, __appReplacer);
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
  // httpRequest's answer (an object, its body a string of its own), its
  // "name: value" header lines as an object: names in lower case, a repeated
  // one joined with ", " as the web's Headers does.
  const __frameosAnswer = (a) => {
    const h = {};
    if (typeof a.headers !== "string") return a;
    for (const line of a.headers.split("\n")) {
      const i = line.indexOf(":"), k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
      if (i > 0) h[k] = k in h ? h[k] + ", " + v : v;
    }
    a.headers = h;
    return a;
  };
  // What every asset and stream call below shares.
  const __frameosAsset = (op, path, data = "") => __frameosUnwrap(jsAssets(op, String(path || ""), data));
  const __frameosStream = (op, options) => __frameosUnwrap(jsStreams(op, JSON.stringify(options)));
  const __frameosStreamId = (ref) => (ref && ref.id) || ref;
  const __frameosVideo = (op, o) => JSON.parse(jsVideo(op, JSON.stringify(o, __appReplacer)) || "null");
  // frameos.frame and frameos.code: arg as JSON text when json is true, else the
  // plain string; JSON text back, "" is null and "!" a reason to throw.
  const __frameosOp = (fn, name, op, arg, json) => {
    const r = fn(String(op), json ? JSON.stringify(arg || {}, __appReplacer) : String(arg ?? ""));
    if (r[0] === "!") throw new Error("frameos." + name + ": " + r.slice(1));
    return JSON.parse(r || "null");
  };
  const frameos = {
    image: (spec = {}) => ({ __frameosType: "image", ...spec }),
    svg: (svg, spec = {}) => ({ __frameosType: "image", svg, ...spec }),
    node: (nodeId) => ({ __frameosType: "node", nodeId }),
    scene: (sceneId) => ({ __frameosType: "scene", sceneId }),
    color: (color) => ({ __frameosType: "color", color }),
    log: (...args) => jsAppLog("log", JSON.stringify(args, __appReplacer)),
    error: (...args) => jsAppLog("error", JSON.stringify(args, __appReplacer)),
    setNextSleep: (seconds) => jsSetNextSleep(Number(seconds || 0)),
    dispatch: (event, payload) => jsDispatch(String(event || ""), JSON.stringify(payload || {}, __appReplacer)),
    store: () => JSON.parse(jsStore() || "null"),
    accelerometer: () => {
      const r = jsAccelerometer();
      if (!r) return null;
      const v = r.split(" ");
      return { x: v[0] / 1000, y: v[1] / 1000, z: v[2] / 1000 };
    },
    tone: (notes, ms) => jsTone(notes == null ? "" : Array.isArray(notes)
      ? notes.map((n) => (Array.isArray(n) ? n[0] + ":" + n[1] : "")).join(",")
      : notes + ":" + (ms ?? 200)),
    storeAction: (action, args) => jsStoreAction(String(action || ""), JSON.stringify(args || {}, __appReplacer)) === true,
    frame: (op, arg) => __frameosOp(jsFrame, "frame", op, arg, op === "apply"),
    code: (op, arg, j = op === "ask" || op === "save") => __frameosOp(jsCode, "code", op, j ? { ...arg, action: op } : arg, j),
    transfer: (op, arg) => typeof jsTransfer == "function" ? __frameosOp(jsTransfer, "transfer", op, arg, true) : null,
    measureText: (texts, o = {}) => texts.length
      ? jsMeasureText(texts.join("\n"), String(o.className || ""), Number(o.width || 0)).split(" ").map(Number)
      : [],
    fetchText: (url) => jsFetchText(String(url || "")),
    fetchJson: (url) => jsFetchJson(String(url || "")),
    httpRequest: (url, options) => __frameosAnswer(
      jsHttpRequest(String(url || ""), JSON.stringify(options || {}, __appReplacer))
    ),
    fetchImage: (url, options) => JSON.parse(
      jsFetchImage(String(url || ""), JSON.stringify(options || {}, __appReplacer)) || '{"image":null}'
    ),
    releaseImage: (ref) => jsReleaseImage(Number(((ref && ref.image) || ref || {}).id || 0)) === true,
    canvas: (key, width, height, color) => JSON.parse(jsCanvas(String(key || "canvas"),
      JSON.stringify({ width: Number(width || 0), height: Number(height || 0), color: String(color || "") }))),
    draw: (canvas, content) => jsCanvasDraw(Number((canvas && canvas.id) || 0),
      (content && typeof content === "object") ? content : String(content || "")) === true,
    clear: (canvas, color) => jsCanvasClear(Number((canvas && canvas.id) || 0), String(color || "")) === true,
    video: (key, o) => __frameosVideo("play", { ...o, key: String(key || "video") }),
    seekVideo: (v, at) => __frameosVideo("seek", { id: (v && v.id) || 0, at: Number(at || 0) }) === true,
    releaseVideo: (v) => __frameosVideo("release", { id: (v && v.id) || 0 }) === true,
    videoInfo: (src, o) => __frameosVideo("info", { ...o, src: String(src || "") }),
    videoFrame: (src, o) => __frameosVideo("frame", { ...o, src: String(src || "") }),
    pixels: (cells, palette, options) => ({ __frameosType: "pixels", cells, palette, options: options || {} }),
    ops: {
      map: (dst, src, table, start, end) => jsTypedOps(0, dst, src, table, start ?? 0, end ?? -1) === true,
      add: (dst, a, b, start, end) => jsTypedOps(1, dst, a, b, start ?? 0, end ?? -1) === true,
      sub: (dst, a, b, start, end) => jsTypedOps(2, dst, a, b, start ?? 0, end ?? -1) === true,
      mul: (dst, a, b, start, end) => jsTypedOps(3, dst, a, b, start ?? 0, end ?? -1) === true,
      convolve: (dst, src, width, kernel, shift) => jsTypedOps(4, dst, src, width, kernel, shift ?? 0) === true,
    },
    listAssets: (dir, options) =>
      __frameosAsset("list", dir, options ? JSON.stringify(options) : "") || (options && options.strict ? null : []),
    assetExists: (path, options) => __frameosAsset("exists", path, options ? JSON.stringify(options) : "") === true,
    assetSize: (path, options) => __frameosAsset("size", path, options ? JSON.stringify(options) : "") ?? -1,
    readAsset: (path, options) => __frameosAsset("read", path, options ? JSON.stringify(options) : "") ?? null,
    writeAsset: (path, data, o) => __frameosAsset(o && o.text ? "writeText" : "write", path, String(data ?? "")) === true,
    appendAsset: (path, data, o) => __frameosAsset(o && o.text ? "appendText" : "append", path, String(data ?? "")) === true,
    deleteAsset: (path, options) => __frameosAsset("delete", path, options ? JSON.stringify(options) : "") === true,
    makeAssetFolder: (path, options) =>
      __frameosAsset("mkdir", String(path || ""), options ? JSON.stringify(options) : "") === true,
    loadAssetImage: (path, options) => __frameosAsset("image", path, options ? JSON.stringify(options) : "") ?? null,
    openAssetStream: (path, mode) => __frameosStream("openAsset", { path: String(path || ""), mode: String(mode || "r") }) ?? null,
    createStream: (base64) => __frameosStream("create", { base64: String(base64 || "") }) ?? null,
    streamRead: (ref, length) => __frameosStream("read", { id: __frameosStreamId(ref), length }) ?? null,
    streamWrite: (ref, base64) => __frameosStream("write", { id: __frameosStreamId(ref), base64: String(base64 || "") }) === true,
    streamAtEnd: (ref) => __frameosStream("atEnd", { id: __frameosStreamId(ref) }) === true,
    streamRewind: (ref) => __frameosStream("rewind", { id: __frameosStreamId(ref) }) === true,
    streamClose: (ref) => __frameosStream("close", { id: __frameosStreamId(ref) }) === true,
    openLines: (source, options) => __frameosUnwrap(jsOpenLines(
      typeof source === "string" ? source : "",
      JSON.stringify({ ...options, source: typeof source === "string" ? null : source })
    )) ?? null,
    nextLine: (ref) => jsNextLine(__frameosStreamId(ref)),
    nextBlock: (ref, stop) => jsNextBlock(__frameosStreamId(ref), String(stop || "")),
    timeZone: (name) => __frameosUnwrap(jsTimeZoneInfo(String(name || ""))),
    getSetting: (...path) => __frameosUnwrap(jsGetSetting(
      JSON.stringify(path.flat().map((p) => String(p)))
    )),
    setState: (key, value) => jsSetState(
      String(key || ""),
      JSON.stringify(value === undefined ? null : value, __appReplacer)
    ),
    remember: (key, value) => jsRemember(
      String(key || ""),
      JSON.stringify(value === undefined ? null : value, __appReplacer)
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
    warn: (...args) => jsAppLog("warn", JSON.stringify(args, __appReplacer)),
  };
  // btoa / atob and UTF-8's TextEncoder / TextDecoder, as the web has them (jsText).
  globalThis.btoa = (s) => jsText(0, String(s));
  globalThis.atob = (s) => jsText(1, String(s));
  // Functions, not classes: a third less bytecode in the firmware.
  globalThis.TextEncoder = function () { this.encoding = "utf-8"; this.encode = (s = "") => new Uint8Array(jsText(2, String(s))); };
  globalThis.TextDecoder = function (l = "utf-8") {
    if (String(l).toLowerCase().replace("-", "") !== "utf8") throw new RangeError("TextDecoder: utf-8 only");
    this.encoding = "utf-8";
    this.decode = (b) => b == null ? "" : jsText(3, ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
  };
  // Async (docs/async-js.md, js_async.nim): promises the host settles by id
  // between renders. Where nothing pumps them (jsAsyncMode() false: the
  // preview, a board that sleeps) fetch blocks and settles at once.
  const __waits = new Map();
  const __wait = (kind, arg, options, resolve, reject) => {
    const id = jsAsyncStart(kind, arg, options);
    if (id > 0) __waits.set(id, [resolve, reject]);
    else reject(new Error(kind + " could not start"));
    return id;
  };
  const __later = (kind, arg, options) => new Promise((ok, no) => __wait(kind, arg, options, ok, no));
  // An answer comes as JSON text or as an object (a fetch's, its body a string
  // of its own); one that cannot be read rejects rather than waits for ever.
  globalThis.__frameosSettle = (id, text, failed) => {
    const w = __waits.get(id);
    if (!w) return;
    __waits.delete(id);
    if (failed) return w[1](new Error(text));
    try { w[0](typeof text !== "string" ? text : text ? JSON.parse(text) : undefined); } catch (e) { w[1](e); }
  };
  const __fetchInit = (init) => JSON.stringify({ method: init.method, headers: init.headers, timeoutMs: init.timeoutMs,
    chunkBytes: init.chunkBytes, slim: init.slim,
    body: init.body == null || typeof init.body === "string" ? init.body : JSON.stringify(init.body) }, __appReplacer);
  const __response = (url, a) => {
    if (!a.status) throw new TypeError("fetch failed: " + (a.error || url));
    const body = a.body ?? "", h = a.headers || {};
    return { ok: a.status > 199 && a.status < 300, status: a.status, statusText: "", url: a.url || url, redirected: false,
      headers: { get: (n) => h[String(n).toLowerCase()] ?? null, has: (n) => String(n).toLowerCase() in h,
        forEach: (f) => Object.keys(h).forEach((k) => f(h[k], k)) },
      text: async () => body, json: async () => JSON.parse(body) };
  };
  // A response in pieces, fetch(url, { onChunk }) (docs/async-js.md): the
  // host hands each piece of the body here (js_async.nim), the first with
  // the answer's head: the URL it came from if another than asked, and its
  // headers a line each. What it returns: whether to go on reading.
  const __chunks = new Map();
  let __chunkSeq = 0;
  globalThis.__frameosChunk = (id, text, status, head, bytes, done, error) => {
    const c = __chunks.get(id);
    if (!c) return false;
    const info = c[1], h = info.headers;
    info.status = status;
    if (head) {
      const lines = head.split("\n");
      if (lines[0]) info.url = lines[0];
      for (const line of lines.slice(1)) {
        const at = line.indexOf(":"), k = line.slice(0, at).trim().toLowerCase(), v = line.slice(at + 1).trim();
        if (at > 0) h[k] = k in h ? h[k] + (k === "set-cookie" ? "\n" : ", ") + v : v;
      }
      // HTML the runtime slims on the way (docs/html-slim.md): "html" when the pieces are.
      info.slim = h["frameos-slim"] || "";
      delete h["frameos-slim"];
    }
    let go = false;
    try {
      if (!status) throw new TypeError("fetch failed: " + (error || info.url));
      info.bytes = bytes; info.done = done;
      if (error) info.error = error;
      // Aborted in onChunk: its entry is gone, and so is the reading.
      go = c[0](text, info) !== false && !done && __chunks.has(id);
    } catch (e) { __chunks.delete(id); c[3](e); return false; }
    if (!go && __chunks.delete(id)) c[2](info);
    return go;
  };
  globalThis.fetch = (input, init = {}) => {
    const url = String((input && input.url) || input || ""), o = __fetchInit(init), s = init.signal;
    return new Promise((ok, no) => {
      if (s && s.aborted) return no(s.reason);
      if (typeof init.onChunk === "function") {
        const c = [init.onChunk, { status: 0, url, headers: {}, done: false, bytes: 0 }, ok, no];
        if (!jsAsyncMode()) {
          // Nothing pumps promises: every piece is handed over in this call
          // (an ESP32's I/O task is asked as ever, and answers in it).
          const id = jsAsyncStart("stream", url, o) || -(++__chunkSeq);
          __chunks.set(id, c);
          jsFetchStream(url, o, id);
          if (__chunks.delete(id)) no(new TypeError("fetch failed: " + url));
          return;
        }
        const id = jsAsyncStart("stream", url, o);
        if (!id) return no(new Error("fetch could not start"));
        __chunks.set(id, c);
        // Aborted: rejected now, and the host stops reading.
        if (s) s.addEventListener("abort", () => { if (__chunks.delete(id)) { jsAsyncCancel(id); no(s.reason); } });
        return;
      }
      if (!jsAsyncMode()) return ok(__frameosAnswer(jsHttpRequest(url, o)));
      const id = __wait("fetch", url, o, ok, no);
      // Aborted while in flight: rejected now, its answer dropped when it comes.
      if (s && id) s.addEventListener("abort", () => { if (__waits.delete(id)) { jsAsyncCancel(id); no(s.reason); } });
    }).then((a) => __response(url, a));
  };
  // What an app asks before its first request: a runtime without it ignores onChunk.
  fetch.chunks = true;
  // AbortController and AbortSignal, as far as fetch and timers go:
  // fetch(url, { signal: AbortSignal.timeout(5000) }) rejects with a
  // TimeoutError after 5 s, controller.abort() with an AbortError.
  const __abortError = (name, message) => Object.assign(new Error(message), { name });
  class AbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this.__on = []; }
    addEventListener(type, fn) { if (type === "abort") this.__on.push(fn); }
    removeEventListener(type, fn) { this.__on = this.__on.filter((f) => f !== fn); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) { const c = new AbortController(); c.abort(reason); return c.signal; }
    static timeout(ms) {
      const c = new AbortController();
      setTimeout(() => c.abort(__abortError("TimeoutError", "The operation timed out.")), ms);
      return c.signal;
    }
    static any(signals) {
      const c = new AbortController();
      for (const s of signals) {
        if (s.aborted) { c.abort(s.reason); break; }
        s.addEventListener("abort", () => c.abort(s.reason));
      }
      return c.signal;
    }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) {
      const s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason = reason === undefined ? __abortError("AbortError", "This operation was aborted") : reason;
      for (const fn of [...s.__on, s.onabort]) if (typeof fn === "function") fn({ type: "abort", target: s });
    }
  }
  globalThis.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;
  const __timers = new Map();
  let __timerSeq = 0;
  const __timer = (fn, ms, args, every) => {
    const t = ++__timerSeq, s = String(Math.max(every ? 10 : 0, Number(ms) || 0) / 1000);
    const arm = () => {
      const id = __wait("sleep", s, "", () => {
        if (!__timers.has(t)) return;
        if (every) arm(); else __timers.delete(t);
        fn(...args);
      }, () => __timers.delete(t));
      if (id) __timers.set(t, id);
    };
    arm();
    return t;
  };
  globalThis.setTimeout = (fn, ms, ...args) => __timer(fn, ms, args, false);
  globalThis.setInterval = (fn, ms, ...args) => __timer(fn, ms, args, true);
  globalThis.clearTimeout = globalThis.clearInterval = (t) => {
    const id = __timers.get(t);
    __timers.delete(t);
    if (id) { __waits.delete(id); jsAsyncCancel(id); }
  };
  frameos.sleep = (seconds) => __later("sleep", String(Number(seconds) || 0), "");
  const __fetched = new Map();
  frameos.useFetch = (url, init = {}) => {
    url = String(url || "");
    const key = url + " " + JSON.stringify(init, __appReplacer);
    let s = __fetched.get(key);
    if (s && (s.loading || !(init.maxAge > 0) || Date.now() - s.at < init.maxAge * 1000)) return s;
    if (!s) {
      if (__fetched.size >= 32) __fetched.delete(__fetched.keys().next().value);
      __fetched.set(key, s = { data: undefined, error: undefined, status: 0, ok: false });
    }
    s.loading = true;
    const take = (r, body) => {
      s.status = r.status; s.ok = r.ok; s.error = undefined;
      s.data = init.as === "text" ? body : JSON.parse(body);
    };
    const fail = (e) => { s.error = (e && e.message) || String(e); };
    const end = () => { s.loading = false; s.at = Date.now(); };
    if (!jsAsyncMode()) {
      try {
        const a = __frameosAnswer(jsHttpRequest(url, __fetchInit(init)));
        take(__response(url, a), a.body ?? "");
      } catch (e) { fail(e); }
      end();
    } else {
      fetch(url, init).then((r) => r.text().then((b) => take(r, b))).then(undefined, fail)
        .then(() => { end(); frameos.dispatch("render"); });
    }
    return s;
  };
  // The scene's JS apps, by key (app_runtime.nim appKey): they share its
  // context, each with its module, the app object its functions get
  // and the handlers of its last UI (js_runtime/jsx.nim).
  const __frameosApps = globalThis.__frameosApps = Object.create(null);
  globalThis.__frameosAddApp = (key, module) => {
    __frameosApps[key] = { module, missing: {}, handlers: [], app: {
      get nodeId() { return __frameosUnwrap(jsGetAppMeta("nodeId")); },
      get nodeName() { return __frameosUnwrap(jsGetAppMeta("nodeName")); },
      get category() { return __frameosUnwrap(jsGetAppMeta("category")); },
      config: __frameosAppConfig,
      state: __frameosAppState,
      frame: __frameosAppFrame,
      log: frameos.log,
      logError: frameos.error,
    } };
  };
  globalThis.__frameosDropApp = (key) => { delete __frameosApps[key]; };
  // A node in a flow calls run(), a node feeding a field calls get(). An app
  // without the one its node needs does nothing, so say so, once.
  globalThis.__frameosInvoke = (key, name) => {
    const a = __frameosApps[key];
    if (!a) return undefined;
    const mod = (a.module && a.module.default) || a.module || {};
    const fn = mod[name];
    if (name === "get") {
      globalThis.__frameosRender = (globalThis.__frameosRender | 0) + 1;
      if (typeof __frameosNextRender === "function") __frameosNextRender();
      // A whole render runs whatever is dirty (memo() runs a dirty call again).
      globalThis.__frameosDirty = [];
    }
    if (typeof fn === "function") {
      const r = fn(a.app, globalThis.__frameosContext);
      // An async init() goes on between renders (docs/async-js.md): a throw
      // in it, or a rejection nobody caught, is the app's log line.
      if (name === "init" && r && typeof r.then === "function")
        r.then(undefined, (e) => frameos.error("init() failed: " + ((e && e.message) || String(e))));
      return r;
    }
    if (name !== "init" && !a.missing[name]) {
      a.missing[name] = true;
      jsAppLog("error", JSON.stringify([name === "run"
        ? "This app has no run(), so it does nothing in a flow: a node after an event calls run(app, context), and get() only when its output feeds a field."
        : name === "onEvent"
        ? "This app lists events in its config.json and has no onEvent()."
        : "This app has no get(), so its output is empty: a node feeding a field calls get(app, context), and run() only in a flow."]));
    }
    return undefined;
  };
  """)


when defined(frameosPreludeBytecode):
  # The preludes as bytecode, written by tools/prelude_bytecode.nim for this
  # exact QuickJS (embedded/esp32/build_nim.sh runs it). A module from another
  # engine version or an older prelude is refused here, not on the device.
  import assets/prelude_bytecode
  import frameos/js_runtime/prelude_checksum
  const quickjsVersionInTree = staticRead(
    currentSourcePath().parentDir.parentDir.parentDir.parentDir / "quickjs" / "VERSION").strip()
  static:
    doAssert preludeBytecodeQuickjsVersion == quickjsVersionInTree,
      "src/assets/prelude_bytecode.nim was written for QuickJS " & preludeBytecodeQuickjsVersion &
      " and the tree has " & quickjsVersionInTree & ": rerun tools/prelude_bytecode.nim"
    doAssert appPreludeSourceChecksum == preludeChecksum(appJsPrelude),
      "src/assets/prelude_bytecode.nim is stale (appJsPrelude changed): rerun tools/prelude_bytecode.nim"

proc evalAppPrelude(js: QuickJS) =
  ## The prelude into a fresh context: the bytecode built into the image when
  ## there is one (a load, not a compile), else the source. Not both: the
  ## source in the image as a fallback was 10 KB of the ESP32's flash for a
  ## load the checks above make sure of (an engine that refuses it raises).
  when defined(frameosPreludeBytecode):
    discard js.evalBytecode(appPreludeBytecode.toOpenArrayByte(0, appPreludeBytecode.high))
  else:
    discard js.eval(appJsPrelude)
  when not defined(frameosEmbedded):
    # The snapshot harness pins the clock (utils/frame_time.nim), for the
    # JavaScript apps too: a clock or a calendar's "today" renders the same
    # picture on every run (e2e/makesnapshots.py also sets TZ=UTC).
    let pinned = frameEpochPinned()
    if pinned > 0:
      discard js.eval("Date.now=()=>" & $(pinned * 1000) & ";")

proc registerAppNatives(js: var QuickJS) =
  ## The bridge the app prelude calls, into a context. Tables, not a call
  ## each: 35 inline registrations were 875 bytes of the ESP32 image.
  const
    natives1 = [("jsSetNextSleep", NimFunction1(jsSetNextSleep)), ("jsRecall", jsRecall),
      ("jsFetchText", jsFetchText), ("jsFetchJson", jsFetchJson), ("jsReleaseImage", jsReleaseImage),
      ("jsNextLine", jsNextLine),
      ("jsTimeZoneInfo", jsTimeZoneInfo), ("jsGetSetting", jsGetSetting), ("jsGetAppMeta", jsGetAppMeta),
      ("jsGetAppConfig", jsGetAppConfig), ("jsGetAppState", jsGetAppState), ("jsGetAppFrame", jsGetAppFrame),
      ("jsGetAppContext", jsGetAppContext), ("jsGetAppKeys", jsGetAppKeys), ("jsAsyncCancel", jsAsyncCancel),
      ("jsTone", jsTone)]
    natives2 = [("jsAppLog", NimFunction2(jsAppLog)), ("jsDispatch", jsDispatch),
      ("jsStoreAction", jsStoreAction), ("jsFrame", jsFrame), ("jsCode", jsCode), ("jsSetState", jsSetState),
      ("jsRemember", jsRemember), ("jsHttpRequest", jsHttpRequest), ("jsText", jsText),
      ("jsFetchImage", jsFetchImage),
      ("jsCanvas", jsCanvas), ("jsCanvasDraw", jsCanvasDraw), ("jsCanvasClear", jsCanvasClear),
      ("jsVideo", jsVideo), ("jsStreams", jsStreams), ("jsOpenLines", jsOpenLines), ("jsNextBlock", jsNextBlock)]
  js.setModuleLoader(jsAppModuleLoader, jsAppModuleNormalize)
  for (name, fn) in natives1:
    js.registerFunction(name, fn)
  for (name, fn) in natives2:
    js.registerFunction(name, fn)
  js.registerFunction("jsStore", jsStore)
  js.registerFunction("jsAccelerometer", jsAccelerometer)
  js.registerFunction("jsAsyncMode", jsAsyncMode)
  js.registerFunction("jsAssets", jsAssets)
  js.registerFunction("jsAsyncStart", jsAsyncStart)
  js.registerFunction("jsFetchStream", jsFetchStream)
  js.registerFunction("jsTypedOps", jsTypedOps)
  js.registerFunction("jsMeasureText", jsMeasureText)
  when not defined(frameosEmbedded):
    js.registerFunction("jsTransfer", jsTransfer)
  probe(phPrelude):
    evalAppPrelude(js)

proc sceneContextFor(scene: FrameScene): InterpretedFrameScene =
  ## The scene whose context an app of `scene` runs in, set up: the scene's
  ## own, beside its program (runtime.ensureSceneJs). nil when there is none
  ## to share: no interpreted scene, or one whose JavaScript started in the
  ## context of the scenes without code before it knew of its apps.
  if scene.isNil or not (scene of InterpretedFrameScene):
    return nil
  let host = InterpretedFrameScene(scene)
  host.hasJsApps = true
  ensureSceneJs(host)
  if host.jsKind == sjShared:
    return nil
  let ctx = host.js.context
  for known in appContexts:
    if known.context == ctx:
      return host
  registerAppNatives(host.js)
  appContexts.add((host.js.runtime, ctx))
  host

proc ensureReady(runtime: JsAppRuntime, frameConfig: FrameConfig, scene: FrameScene) =
  ## The app's module evaluated where it runs: its scene's context, which the
  ## scene's program and other JS apps share (one QuickJS a scene, not one
  ## an app node), or, with no interpreted scene, a QuickJS of its own that
  ## joins the scene's heap budget (runtime.sceneHeapBudgetFor).
  if runtime.ready:
    return
  if runtime.source.len == 0 and not runtime.reload.isNil:
    # Started again (a teardown after a render, memory running short): its
    # files read again, from where its scene's JSON lives.
    runtime.sources = runtime.reload()
    runtime.source = jsAppSourceFromSources(runtime.sources)
    if runtime.source.len == 0:
      raise newException(JSException, "The app's files could not be read again: " & runtime.sourceName)
  defer:
    # Compiled (or not): QuickJS keeps no source, so neither does the app.
    if not runtime.reload.isNil:
      runtime.source = ""
      runtime.sources = nil
  let sceneId = if scene.isNil: "" else: scene.id.string
  runtime.sceneId = sceneId
  let host = sceneContextFor(scene)
  inc nextJsAppKey
  runtime.appKey = nextJsAppKey
  if host.isNil:
    when defined(frameosEmbedded):
      # Reclaim the other nodes' interpreters before building this one.
      evictIdleJsRuntimes(runtime)
    when defined(memProbe): memProbe("    newQuickJS BEFORE")
    runtime.js = newQuickJS(sceneJsConfig(frameConfig, sceneId))
    when defined(memProbe): memProbe("    newQuickJS AFTER")
    setUpSceneContext(runtime.js)
    registerAppNatives(runtime.js)
    runtime.modulePrefix = ""
  else:
    runtime.js = host.js
    runtime.host = host
    runtime.modulePrefix = "#" & $runtime.appKey & "/"
  if not liveJsRuntimes.contains(runtime):
    liveJsRuntimes.add(runtime)
  # The test harness, when this runtime runs an app's tests (app_tests.nim):
  # after the prelude so it can wrap `frameos`, before the module so the
  # module's describe() calls land in it.
  if runtime.extraPrelude.len > 0:
    discard runtime.js.eval(runtime.extraPrelude, "frameos-test-harness.js")
  # Named after the real file so `./helper` resolves beside it and error
  # locations read `app.ts:12:3` (appText takes the prefix off).
  let filename = runtime.modulePrefix & runtime.sourceName
  when defined(memProbe): memProbe("      prelude done, module src=" & $runtime.source.len & "B BEFORE")

  # Evaluate the source as a real ES module — TypeScript and JSX included,
  # the bundled QuickJS parses both — and hand its namespace to the
  # prelude's registry. Nothing is generated, so error locations are the
  # app's own lines and no line map is kept.
  let ctx = runtime.js.context
  var namespace: JSValue
  try:
    probe(phCompile):
      namespace = runtime.js.evalModuleNamespace(runtime.source, filename, quicktsFlagsFor(runtime.sourceName))
  except CatchableError as error:
    let message = runtime.appText(mapJsErrorText(ctx, error.msg))
    if runtime.host.isNil:
      clearJsSourceMaps(ctx)
      runtime.js.close()
    forgetJsApp(runtime)
    raise newException(JSException, message)
  let key = JS_NewInt32(ctx, runtime.appKey.int32)
  let added = callGlobalFunction(ctx, "__frameosAddApp", [key, namespace])
  JS_FreeValue(ctx, key)
  JS_FreeValue(ctx, namespace)
  if JS_IsException(added) != 0:
    JS_FreeValue(ctx, added)
    raise newException(JSException, "Could not install the app module: " & runtime.sourceName)
  JS_FreeValue(ctx, added)
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

proc svgStretchesOnto*(fit: string, requestedWidth, requestedHeight, offeredWidth, offeredHeight: int): bool =
  ## Whether an SVG asked for at one size and drawn by its consumer onto an
  ## offered target of another is the SVG drawn at the offer's size: the
  ## consumer stretches it, or covers or contains with it at the offer's own
  ## aspect. pixie scales an SVG's root to the size it is drawn at, x and y
  ## each by its own factor, as a stretch does.
  if requestedWidth <= 0 or requestedHeight <= 0 or offeredWidth <= 0 or offeredHeight <= 0:
    return false
  case fit
  of "stretch": true
  of "cover", "contain":
    requestedWidth.int64 * offeredHeight.int64 == offeredWidth.int64 * requestedHeight.int64
  else: false

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
  if (offeredWidth != requestedWidth or offeredHeight != requestedHeight) and
      svgStretchesOnto(context.decodeTargetScalingMode, requestedWidth, requestedHeight,
        offeredWidth, offeredHeight):
    # Asked for at another size, and placed so that the picture is that size
    # stretched onto the offer: drawn at the offer's size, it is the same
    # picture (the SVG's root scaled as vectors, sharper even), with nothing
    # allocated for it. An app that draws at `app.frame.width` in a window or
    # a split's cell is the case: a Big typographic clock in a Windows 98
    # window asked for 800x480 RGBX, 1.5 MB, that the reTerminal E1002 did not
    # have, and aborted out of memory (2026-11-16).
    let (target, _) = owner.takeDecodeTarget(context, deferBackground = true)
    if target.isNil:
      return nil
    var owed = takeOwedBackground(context, target)
    var rendered = renderSvgIntoTarget(svg, target, owed)
    if not rendered and releaseRenderMemory():
      rendered = renderSvgIntoTarget(svg, target, owed)
    if not rendered:
      rendered = renderSvgIntoTargetWithDegrade(svg, target, owed)
    if owed.isSome:
      payBackground(target, owed.get())
    return if rendered: target else: nil
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
    # The handler straight from the app's list, its event built here: no
    # JSON text to parse, no JavaScript in between, and `e.target` (a copy
    # of the event, as React's) only where the docs promise one: a field's
    # edit and a box's scroll. The way through the prelude's __frameosHandle
    # (the payload as JSON text, parsed, spread twice) was 1.5 to 2 ms of a
    # tap on the SenseCAP Indicator, for a handler that ran in 0.1.
    let entry = runtime.appEntry()
    let handlers = if jsIsObject(entry): JS_GetPropertyStr(ctx, entry, "handlers") else: jsUndefined(ctx)
    let fn = if jsIsObject(handlers): JS_GetPropertyUint32(ctx, handlers, handler.uint32) else: jsUndefined(ctx)
    JS_FreeValue(ctx, handlers)
    JS_FreeValue(ctx, entry)
    if JS_IsFunction(ctx, fn) == 0:
      JS_FreeValue(ctx, fn)
      return
    proc eventObject(): JSValue =
      result = if not event.isNil and event.kind == JObject: jsonToJS(ctx, event) else: JS_NewObject(ctx)
      discard JS_SetPropertyStr(ctx, result, "type", nimStringToJS(ctx, name))
      const names = ["localX", "localY", "width", "height"]
      for i in 0 .. 3:
        discard JS_SetPropertyStr(ctx, result, names[i].cstring, nimFloatToJS(ctx, hit[i]))
    var e = eventObject()
    if name in ["change", "input", "keyDown", "scroll"]:
      discard JS_SetPropertyStr(ctx, e, "target", eventObject())
    var returned: JSValue
    let marks = signalMarks()
    withAppEnv(ctx, JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson,
        context: ExecutionContext(scene: owner.scene, event: name, payload: event, loopKey: ".", nextSleep: -1))):
      returned = JS_Call(ctx, fn, jsUndefined(ctx), 1, addr e)
    JS_FreeValue(ctx, e)
    JS_FreeValue(ctx, fn)
    if not owner.scene.isNil:
      let target = uiTarget(owner.scene.id.string, owner.nodeId.int, create = false)
      if not target.isNil:
        let refused = JS_IsException(returned) == 0 and jsIsBool(returned) and
          not toNimBool(ctx, returned)
        # Signals set: the components that read them may do (partialRender).
        # Nothing set: what changed is anyone's guess, get() runs. A scroll
        # handler that returns false and set none changed nothing get()
        # reads: the box scrolls on the tree it has (a list whose rows built
        # still cover what shows, docs/jsx-ui.md "Scrolling and clipping").
        if JS_IsException(returned) == 0 and signalMarks() != marks:
          target.partial = true
        elif not (refused and name == "scroll"):
          target.full = true
        # A pointer handler that returns false asks for no render: what it
        # changed shows with the next one (docs/jsx-ui.md "Events").
        target.declined = refused and (name.startsWith("pointer") or
          name == "scroll" and signalMarks() == marks)
    if JS_IsException(returned) != 0:
      frameos_apps.logError(owner, "JS app handler failed: " &
        runtime.appText(mappedJsExceptionDetails(ctx).message))
    JS_FreeValue(ctx, returned)

proc keepUiRegions(runtime: JsAppRuntime, owner: AppRoot, sceneId: string,
    regions: var seq[UiRegion], x, y: int, scale: float32) =
  ## What the pointer can do to the UI just drawn with its corner at x, y,
  ## `scale` canvas pixels to each of its own.
  let target = uiTarget(sceneId, owner.nodeId.int)
  target.owner = cast[pointer](owner)
  target.regions = move(regions)
  target.offsetX = x.float32
  target.offsetY = y.float32
  target.scale = scale
  when defined(frameosWasm):
    if not owner.scene.isNil:
      target.sceneX = owner.scene.canvasX.float32
      target.sceneY = owner.scene.canvasY.float32
  # Into the app that drew these regions, every render: the scene can be
  # loaded again since the last one (a switch away and back), with a new app.
  target.call = proc(handler: int, name: string, event: JsonNode, hit: UiHit) {.closure, raises: [].} =
    try:
      runtime.callJsxHandler(owner, handler, name, event, hit)
    except Exception:
      discard # a handler's failure is logged; one in the logging has nowhere to go

var embeddedSceneRenderer*: proc(owner: FrameScene, nodeId: NodeId, index: int, sceneId, props: string,
    x, y: float32, visible: array[4, float32], width, height: int, asHole: bool, context: ExecutionContext): Image {.nimcall.}
  ## Set by the interpreter: a `<Scene>`'s or `<yield />`'s picture, or with
  ## `asHole` the scene itself drawn into the canvas (non-nil when it was).
  ## (`x`, `y`) is where it lands in the owner's canvas and `visible` the part
  ## of that which shows (left, top, right, bottom), for the pointer.

var embeddedYieldReady*: proc(owner: FrameScene): bool {.nimcall.}
  ## Set by the interpreter: whether `owner` is a layout with a scene to wrap.

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc fillSceneImages(owner: AppRoot, context: ExecutionContext, node: SvgNode, scale: float32,
    index: var int, ox, oy: float32, clip: array[4, float32], holes: var UiHoles): bool {.discardable.} =
  ## The layout emitted a `<Scene>` as an `<image>` waiting for its picture
  ## (it could not know the size before): the scenes run here, each at the
  ## size it got, a hole straight into the canvas. Walks the UI's tree, nested
  ## viewports included; only for a UI whose JSX held a scene. (`ox`, `oy`):
  ## where this level's coordinates start on the UI; `clip`: left, top, right
  ## and bottom of what shows there.
  let id = node.attr("scene-id")
  if id.len > 0:
    # A hole, a layout seen on its own, a scene that is gone: nothing to show,
    # an empty group, not a picture pixie would stretch across the bounds of
    # every window around it.
    var image: Image
    if not embeddedSceneRenderer.isNil:
      let
        x = ox + node.attrFloat("x")
        y = oy + node.attrFloat("y")
        w = node.attrFloat("width")
        h = node.attrFloat("height")
        at = holes.indexAt(x, y)
        props = node.attr("scene-props")
      if at >= 0:
        template hole: untyped = holes.items[at]
        let box = [hole.left.float32, hole.top.float32, hole.right.float32, hole.bottom.float32]
        # Nothing to put there: the chrome paints where it would have been.
        hole.clean = not embeddedSceneRenderer(owner.scene, owner.nodeId, index, id, props, box[0], box[1], box,
          int(hole.right - hole.left), int(hole.bottom - hole.top), true, context).isNil
      else:
        image = embeddedSceneRenderer(owner.scene, owner.nodeId, index, id, props, x * scale, y * scale,
          [max(x, clip[0]) * scale, max(y, clip[1]) * scale, min(x + w, clip[2]) * scale, min(y + h, clip[3]) * scale],
          round(w * scale).int, round(h * scale).int, false, context)
    inc index
    let tag = if image.isNil: "g" else: "image"
    # What it draws changed: its parse goes, and its ancestors' (true), which
    # hold its elements in theirs (pixie's parseSvg keeps a parse per node at
    # any depth).
    result = node.image != image or node.tag != tag
    node.image = image
    node.tag = tag
    if result:
      node.forgetParse()
    return
  var nx = ox
  var ny = oy
  var inner = clip
  if node.tag == "svg" and node.attr("x").len > 0:
    # A box that clips (ui/layout.nim): a viewport at x, y whose viewBox starts
    # where its children's coordinates do, moved on by how far it is scrolled.
    let
      left = ox + node.attrFloat("x")
      top = oy + node.attrFloat("y")
      view = node.attr("viewBox").splitWhitespace()
    inner = [max(clip[0], left), max(clip[1], top),
      min(clip[2], left + node.attrFloat("width")), min(clip[3], top + node.attrFloat("height"))]
    nx = left
    ny = top
    if view.len == 4:
      nx -= parseFloat(view[0]).float32
      ny -= parseFloat(view[1]).float32
  for child in node.children:
    if fillSceneImages(owner, context, child, scale, index, nx, ny, inner, holes):
      result = true
  if result:
    node.forgetParse()

proc placed(v, scale: float32, limit: int): int =
  clamp(round(v * scale).int, 0, limit)

proc holesOf(owner: AppRoot, context: ExecutionContext, target: UiTarget,
    requestedWidth, requestedHeight: int, regionScale: float32): UiHoles =
  ## Where this UI's embedded scenes can be holes in the canvas the planner
  ## offered: its whole render this one node, drawn at the canvas's own size.
  if owner.scene.isNil or not context.wholeFrame or not context.hasImage or context.image.isNil or
      context.decodeTargetImage != context.image or
      requestedWidth != context.image.width or requestedHeight != context.image.height:
    return
  result = seekHoles(target.memo, target.input, not embeddedYieldReady.isNil and embeddedYieldReady(owner.scene))
  for i in 0 ..< result.count:
    template h: untyped = result.items[i]
    h.left = placed(h.x, regionScale, requestedWidth).int32
    h.top = placed(h.y, regionScale, requestedHeight).int32
    h.right = placed(h.x + h.w, regionScale, requestedWidth).int32
    h.bottom = placed(h.y + h.h, regionScale, requestedHeight).int32
    if h.right <= h.left or h.bottom <= h.top:
      h.clean = false
    # Past the canvas's edge, any of the four (a window dragged half off a
    # desktop): clamped, the scene would be squeezed into what shows. A
    # picture is cut instead.
    if h.x < 0 or h.y < 0 or round((h.x + h.w) * regionScale).int > requestedWidth or
        round((h.y + h.h) * regionScale).int > requestedHeight:
      h.clean = false

proc noteHoles(scene: FrameScene, holes: UiHoles) =
  ## Holes that moved, came or went leave nothing the canvas can be trusted
  ## with: the chrome has painted where they were.
  var key = 0
  for i in 0 ..< holes.count:
    template h: untyped = holes.items[i]
    if h.clean:
      key = key !& h.left.int !& h.top.int !& h.right.int !& h.bottom.int
  scene.holesMoved = key != scene.holesKey
  if scene.holesMoved:
    scene.holesKey = key
    forgetPanelRegions()

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
    keptTree: SvgNode
  # Put in `lastJsx` only as this returns. The callers hand over `lastJsx`
  # itself as `root`, which ORC borrows: replaced there mid-way, `root` was
  # its last owner's and was freed, and every later `root.tag` read freed
  # memory (a SenseCAP Indicator's Guru Meditation in Tap counter on a
  # desktop, the hardware bench, 2026-11-19).
  defer:
    if not keptTree.isNil:
      runtime.lastJsx = keptTree
  let target = uiTarget(sceneId, owner.nodeId.int, create = root.tag != "svg")
  if root.tag != "svg":
    # Where a change costs a refresh no press shows, a drag counts whole and
    # pictures come in the render (ui/events.nim); on paper the keyboard and
    # a select take its look (ui/keyboard.nim). The frame's panel, as
    # `app.frame.fast` and `paper` say it.
    let device = if owner.frameConfig.isNil: "" else: owner.frameConfig.device
    target.input.slow = not panelIsFast(device)
    target.input.paper = panelIsPaper(device)
    # A UI that is a round panel's whole canvas keeps its keyboard on the glass.
    target.input.round = not owner.frameConfig.isNil and panelIsRound(owner.frameConfig.device) and
      requestedWidth == frameos_apps.renderWidth(owner.frameConfig) and
      requestedHeight == frameos_apps.renderHeight(owner.frameConfig)
    try:
      # Inside a layout a field's keyboard is the frame's (KeyboardDock): its
      # corner here is where the last render put this UI in the scene's canvas.
      svg = layoutUiDocked(root, layoutWidth, layoutHeight, target.input, regions, target.memo, sceneId,
        regionScale, target.offsetX, target.offsetY)
      when defined(frameosWasm):
        if textsSeenOn:
          target.texts = takeTextsSeen()
    except CatchableError as error:
      frameos_apps.logError(owner, "JS app returned a UI that failed to lay out: " & error.msg)
      return nil
    # A tree that says what the last one said was laid out as the last one
    # (ui/layout.nim build): that one is the tree to keep for the pointer's
    # render, and this equal copy goes.
    let kept = target.memo.source
    if not kept.isNil and kept != root and runtime.lastJsx == root:
      keptTree = kept
  # `<img src="https://…">`: each picture at the size it got, here or on its
  # way (a slow panel fetches it now: one refresh with every picture).
  if runtime.jsxMemo.sawUrl and root.tag != "svg":
    runtime.fillUrlImages(owner, context, svg, regionScale, target.input.slow)
  # Its videos: the frame due now, at the size each `<img>` got (js_video.nim).
  when not defined(frameosEmbedded) and not defined(frameosWasm):
    if runtime.videos.len > 0 and root.tag != "svg":
      runtime.fillVideos(owner, context, svg, regionScale,
        runtime.videoSpots(owner, context, target, requestedWidth, requestedHeight, regionScale))
  # The scenes it embeds, each drawn now that its size is known. The offered
  # target comes after: its corner moves the slots only when it is a cell.
  let firstSlot = if owner.scene.isNil: 0 else: owner.scene.slots.len
  var holes: UiHoles
  var aroundHolesOf: Image
  if runtime.jsxMemo.sawScene and root.tag != "svg":
    holes = holesOf(owner, context, target, requestedWidth, requestedHeight, regionScale)
    for i in 0 ..< holes.count:
      if holes.items[i].clean:
        # Before the first scene runs: the target can be taken once.
        aroundHolesOf = owner.takeDecodeTarget(context, deferBackground = true).image
        break
    if aroundHolesOf.isNil:
      holes = UiHoles()
    if not owner.scene.isNil:
      noteHoles(owner.scene, holes)
    var index = 0
    fillSceneImages(owner, context, svg, regionScale, index, 0, 0,
      [0'f32, 0, layoutWidth.float32, layoutHeight.float32], holes)
  var intoTarget: Image
  if not aroundHolesOf.isNil:
    # The chrome around the holes, the scenes straight into them: no picture of
    # them to make, none to composite, and what is not due stays.
    var boxes: seq[PixelBox]
    for i in 0 ..< holes.count:
      template h: untyped = holes.items[i]
      if h.clean:
        boxes.add((h.left.int, h.top.int, int(h.right - h.left), int(h.bottom - h.top)))
    var owed = takeOwedBackground(context, aroundHolesOf)
    probe(phDraw):
      if not renderSvgAround(svg, aroundHolesOf, boxes, owed, reuse = true) and
          not (releaseRenderMemory() and renderSvgAround(svg, aroundHolesOf, boxes, owed, reuse = true)):
        frameos_apps.logError(owner, "JS app: JSX failed to render around its scenes")
    intoTarget = aroundHolesOf
  else:
    # A UI's nodes come back from the layout where they did not change.
    probe(phDraw):
      intoTarget = svgIntoOfferedTarget(owner, context, svg, requestedWidth, requestedHeight,
        reuse = root.tag != "svg")
  if not intoTarget.isNil:
    if intoTarget.width == requestedWidth and intoTarget.height == requestedHeight:
      let
        localX = (intoTarget.origin mod max(intoTarget.stride, 1)) - (if owner.scene.isNil: 0 else: owner.scene.canvasX.int)
        localY = (intoTarget.origin div max(intoTarget.stride, 1)) - (if owner.scene.isNil: 0 else: owner.scene.canvasY.int)
      if not owner.scene.isNil:
        for i in firstSlot ..< owner.scene.slots.len:
          owner.scene.slots[i].x += localX.float32
          owner.scene.slots[i].y += localY.float32
          for edge in 0 .. 3:
            owner.scene.slots[i].visible[edge] += (if edge mod 2 == 0: localX.float32 else: localY.float32)
      if regions.len > 0 or not target.isNil:
        probe(phRegions):
          runtime.keepUiRegions(owner, sceneId, regions, localX, localY, regionScale)
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

{.pop.}

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
    return VInt(payload.getBiggestInt().int64)
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
        result[key] = if f.isNaN or f == Inf or f == NegInf: newJNull() else: jsValueToJson(ctx, value, AppStringify)
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
  result = jsValueToJson(ctx, rest, AppStringify)
  if result.kind != JObject:
    return nil
  result["svg"] = %toNimString(ctx, svg)

proc jsOptionInt(ctx: ptr JSContext, options: JSValueConst, name: cstring, default: int): int =
  ## A whole number off an options object; `default` for anything else.
  let value = JS_GetPropertyStr(ctx, options, name)
  defer: JS_FreeValue(ctx, value)
  if JS_IsException(value) != 0:
    JS_FreeValue(ctx, JS_GetException(ctx))
    return default
  if not jsIsNumber(value):
    return default
  let number = toNimFloat(ctx, value)
  if number != number or abs(number) > 1e9: default else: number.int

proc readPalette(ctx: ptr JSContext, value: JSValueConst, palette: var PixelPalette): int =
  ## A palette of 0xRRGGBB numbers, an Array or a Uint32Array, into all 256
  ## entries: past its end, black. How many colors it had (256 at most: no
  ## cell can name another). Read off the object, no JSON: an app that cycles
  ## its colors hands a new palette over every frame.
  result = min(jsOptionInt(ctx, value, "length", 0), 256)
  for i in 0 ..< 256:
    var v: int32 = 0
    if i < result:
      let entry = JS_GetPropertyUint32(ctx, value, i.uint32)
      if jsIsNumber(entry):
        discard JS_ToInt32(ctx, addr v, entry)
      JS_FreeValue(ctx, entry)
    palette[i] = rgbx(uint8((v shr 16) and 255), uint8((v shr 8) and 255), uint8(v and 255), 255)

proc writeCells(image: Image, cells, known: Cells; width, height, ps: int; palette: PixelPalette;
    recolored: ptr Recolored; anyRecolored: bool) =
  ## Cells as `ps` squares of their palette's colors from the image's corner;
  ## with `known` (the cells the image holds) only those whose index or color
  ## changed. An RGB565 image (an LCD's) takes pixel_ops' -O2 loop with the
  ## palette packed once; anything else goes a pixel at a time through pixie's
  ## setPixel, so every format stores what it always does (sixteen greys
  ## dithered by place), which e-paper and a Pi never notice and the
  ## firmware's flash does.
  if image.format == pfRgb565:
    var colors: Palette565
    for i in 0 ..< 256:
      colors[i] = rgbxToRgb565(palette[i])
    blitCells16(cast[ptr UncheckedArray[uint16]](image.pixelAddr(image.dataIndex(0, 0))), image.stride, cells, known, width,
      height, ps, addr colors, recolored, anyRecolored)
    return
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * width])
    let old = if known.isNil: nil else: cast[Cells](addr known[sy * width])
    if not old.isNil and not anyRecolored and equalMem(src, old, width):
      continue
    for sx in 0 ..< width:
      let index = src[sx]
      if old.isNil or index != old[sx] or recolored[index]:
        for y in sy * ps ..< sy * ps + ps:
          for x in sx * ps ..< sx * ps + ps:
            image.setPixel(image.dataIndex(x, y), palette[index])

const MaxPixelFrameBytes = 256 * 1024
  ## The largest frame of cells a panel buffer keeps a copy of: three buffers
  ## of a 480x480 panel at one pixel a cell are 691 KB of PSRAM already.

proc imageFromPixels(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext,
    payload: JSValueConst): tuple[isPixels: bool, image: Image] =
  ## `return frameos.pixels(cells, palette, {width, height, pixelSize})`, the
  ## 8-bit palette mode: a frame of cells, each one byte, an index into a
  ## palette of up to 256 0xRRGGBB colors, every cell a `pixelSize` square
  ## (`width` x `height` cells, the frame over `pixelSize` by default). It is
  ## written straight into the target the planner offered (the panel's own
  ## buffer on an LCD), with no canvas to copy from and no JSX to lay out, and
  ## an app never sees how the panel stores a pixel. A grid that covers the
  ## target waives the background it owes; one that stops short pays it. Each
  ## panel buffer remembers its cells and palette, so only the cells whose
  ## index or color changed cross the PSRAM bus: an app that animates by
  ## cycling its palette writes only the cells of the colors that moved. A
  ## grid larger than the frame is a picture of its own, for the next node to
  ## scale.
  let ctx = runtime.js.context
  let kind = JS_GetPropertyStr(ctx, payload, "__frameosType")
  defer: JS_FreeValue(ctx, kind)
  if not jsIsString(kind) or toNimString(ctx, kind) != "pixels":
    return (false, nil)
  result.isPixels = true
  let
    cellsValue = JS_GetPropertyStr(ctx, payload, "cells")
    paletteValue = JS_GetPropertyStr(ctx, payload, "palette")
    options = JS_GetPropertyStr(ctx, payload, "options")
  defer:
    JS_FreeValue(ctx, options)
    JS_FreeValue(ctx, paletteValue)
    JS_FreeValue(ctx, cellsValue)
  let
    frameWidth = defaultImageWidth(owner, context, %*{})
    frameHeight = defaultImageHeight(owner, context, %*{})
    # At a render scale above 1 (render_scale.nim) a .tsx app sized its grid
    # for the canvas it was told, the panel over the scale: a cell is the
    # scale's square of the panel, so the grid covers the panel as the rest of
    # the app's picture does. A whole scale (every automatic one) keeps each
    # cell whole; a fraction rounds up, and a grid past the panel is a picture
    # of its own. At 2 on the reTerminal E1003 the games drew in the top-left
    # quarter (the UX bench, 2026-11-27).
    scale = runtime.jsxScale(owner)
    asked = clamp(jsOptionInt(ctx, options, "pixelSize", 1), 1, 64)
    scaled = asked.float * max(scale, 1.0)
    ps = if scaled - float(int(scaled)) > 1e-6: int(scaled) + 1 else: int(scaled)
    width = jsOptionInt(ctx, options, "width", frameWidth div ps)
    height = jsOptionInt(ctx, options, "height", frameHeight div ps)
  var palette: PixelPalette
  # The palette and the options before the cells: reading them can run the
  # app's code (a getter, a proxy), which can detach or resize the cells'
  # buffer, and the cells are a pointer into it. Nothing below calls into
  # JavaScript.
  let
    colors = readPalette(ctx, paletteValue, palette)
    (cells, byteLen) = jsBytes(ctx, cellsValue)
  # One constant message: the numbers in one were a kilobyte of firmware.
  if cells.isNil or colors == 0 or width <= 0 or height <= 0 or
      width.int64 * height.int64 > byteLen.int64 or width * ps > 4096 or height * ps > 4096:
    frameos_apps.logError(owner, "frameos.pixels(cells, palette, options) needs a typed array of width x height cells and a palette")
    return
  let fits = width * ps <= frameWidth and height * ps <= frameHeight
  var target: Image = nil
  let (offeredWidth, offeredHeight) = owner.offeredDecodeTargetSize(context)
  if fits and offeredWidth == frameWidth and offeredHeight == frameHeight:
    target = owner.takeDecodeTarget(context, deferBackground = true).image
  if target.isNil:
    let
      like = pictureFormatLike(context)
      pictureWidth = if fits: frameWidth else: width * ps
      pictureHeight = if fits: frameHeight else: height * ps
    target = if like.isNil: newImage(pictureWidth, pictureHeight) else: newImageLike(like, pictureWidth, pictureHeight)
  result.image = target
  let owed = takeOwedBackground(context, target)
  var (panel, frame) = takePanelPixelFrame(target, context.wholeFrame)
  let count = width * height
  var
    known: Cells = nil
    recolored: Recolored
    anyRecolored = false
  if owed.isSome and (width * ps != target.width or height * ps != target.height):
    payBackground(target, owed.get())
  elif panel and frame.width == width and frame.height == height and frame.size == ps and frame.cells.len == count:
    known = cast[Cells](addr frame.cells[0])
    for i in 0 ..< 256:
      if frame.palette[i] != palette[i]:
        recolored[i] = true
        anyRecolored = true
  writeCells(target, cells, known, width, height, ps, palette, addr recolored, anyRecolored)
  if panel and count <= MaxPixelFrameBytes:
    if known.isNil:
      # A new record, never the old one cut to size: a seq keeps its capacity
      # when it shrinks.
      frame = PixelFrame(width: width, height: height, size: ps, cells: newSeqUninit[uint8](count))
    copyMem(addr frame.cells[0], cells, count)
    frame.palette = palette
    keepPanelPixelFrame(move frame)

proc toValue(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, payload: JSValueConst,
    expectedType: string, spent: ptr bool = nil): Value =
  ## `spent`: the caller owns `payload` and lets it go here once it has been
  ## read, where that is before the work it asks for; set when it went.
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
      when defined(memProbe): memProbe("    jsx walk BEFORE")
      probe(phWalk):
        let entry = runtime.appEntry()
        runtime.lastJsx = jsxNode(ctx, payload, addr runtime.images, entry, addr runtime.jsxMemo)
        JS_FreeValue(ctx, entry)
      when defined(memProbe): memProbe("    jsx walk AFTER")
      if not spent.isNil:
        # What get() returned goes before its tree is drawn: the tree is the
        # walker's own now, and the strings the objects held (a map's paths,
        # a third of a megabyte) are memory the drawing is short of on an
        # ESP32.
        JS_FreeValue(ctx, payload)
        spent[] = true
      result = VImage(runtime.imageFromJsx(owner, context, runtime.lastJsx))
      when defined(memProbe): memProbe("    jsx image AFTER")
      return
    let pixels = runtime.imageFromPixels(owner, context, payload)
    if pixels.isPixels:
      if pixels.image.isNil:
        return valueFromJsonByType(newJNull(), expectedType)
      return VImage(pixels.image)

  if expectedType == "image" or jsIsObject(payload) or JS_IsArray(ctx, payload) != 0:
    let svgSpec = svgImageSpecFromJs(ctx, payload)
    if not svgSpec.isNil:
      return runtime.toValue(owner, context, svgSpec, expectedType)
    return runtime.toValue(owner, context, jsValueToJson(ctx, payload, AppStringify), expectedType)

  if expectedType.len > 0:
    if expectedType in ["string", "text"]:
      return VString(toNimString(ctx, payload))
    return valueFromJsonByType(jsValueToJson(ctx, payload, AppStringify), expectedType)

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

  runtime.toValue(owner, context, jsValueToJson(ctx, payload, AppStringify), expectedType)

type JsAppError* = object of CatchableError
  ## A JS app's get() threw. The message is the JS error's; the mapped stack
  ## is already logged.

proc invoke(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext, fnName: string,
    raiseOnError = false): JSValue =
  ensureReady(runtime, owner.frameConfig, owner.scene)
  let ctx = runtime.js.context
  var args {.noinit.}: array[2, JSValue]
  args[0] = JS_NewInt32(ctx, runtime.appKey.int32)
  args[1] = nimStringToJS(ctx, fnName)
  defer: JS_FreeValue(ctx, args[1])

  runtime.liveConfig = configJson
  # Callers hold the runtime on jsRuntimeStack (midCall) for as long as they
  # hold the value this returns.
  when defined(memProbe): memProbe("    js invoke " & fnName & " BEFORE")
  withAppEnv(ctx, JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)):
    try:
      probe(phGet):
        result = callGlobalFunction(ctx, "__frameosInvoke", args)
        # The microtask checkpoint at the end of a call, as a browser has at
        # the end of a task: the callbacks of promises the call settled run
        # now, while the bridge still knows whose call it is (a `fetch` that
        # blocked where nothing pumps, docs/async-js.md, settles at once).
        runtime.js.runPendingJobs()
    finally:
      runtime.closeLineStreams()
      when defined(memProbe): memProbe("    js invoke " & fnName & " AFTER")

  if JS_IsException(result) != 0:
    let details = mappedJsExceptionDetails(ctx)
    let message = runtime.appText(details.message)
    frameos_apps.logError(owner, &"JS app {fnName} failed: " & message)
    if details.stack.len > 0:
      frameos_apps.log(owner, %*{
        "event": "jsApp:error",
        "nodeId": owner.nodeId.int,
        "nodeName": owner.nodeName,
        "stack": runtime.appText(details.stack)
      })
    JS_FreeValue(ctx, result)
    if raiseOnError:
      raise newException(JsAppError, message)
    return jsNull(ctx)

proc callAppGlobalForText*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode,
    context: ExecutionContext, fnName: string): string =
  ## Call a global JavaScript function (not a module export) in the app's
  ## context, the bridge set up as for `get`, and hand back what it returned
  ## as text. The test harness returns its report this way (app_tests.nim). A
  ## throw, or a module that does not load, is a JsAppError.
  try:
    ensureReady(runtime, owner.frameConfig, owner.scene)
  except CatchableError as error:
    raise newException(JsAppError, error.msg)
  let ctx = runtime.js.context
  runtime.midCall:
    var payload: JSValue
    withAppEnv(ctx, JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)):
      payload = callGlobalFunction(ctx, fnName, [])
    defer: JS_FreeValue(ctx, payload)
    if JS_IsException(payload) != 0:
      let details = mappedJsExceptionDetails(ctx)
      raise newException(JsAppError, runtime.appText(details.message))
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

proc partialRender(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext): Image =
  ## Only the memo()'d components the handlers' signals dirtied run again,
  ## their elements spliced into the tree read last (jsx.nim jsxSplice): no
  ## get(), no walk of what did not change. nil when a whole get() is needed.
  let ctx = runtime.js.context
  var root = runtime.lastJsx
  runtime.midCall:
    var pairs: JSValue
    withAppEnv(ctx, JsAppEvalEnv(runtime: runtime, owner: owner, configJson: configJson, context: context)):
      probe(phGet):
        pairs = callGlobalFunction(ctx, "__frameosPartial", [])
    probe(phWalk):
      let entry = runtime.appEntry()
      root = jsxSplicePairs(ctx, root, pairs, addr runtime.images, entry, addr runtime.jsxMemo)
      JS_FreeValue(ctx, entry)
    JS_FreeValue(ctx, pairs)
  if root.isNil:
    return nil
  runtime.lastJsx = root
  result = runtime.imageFromJsx(owner, context, root)

proc ownSleepLeft(runtime: JsAppRuntime): float =
  ## What is left of the sleep the last whole get() asked for, in seconds; -1
  ## when it asked for none.
  if runtime.ownSleep < 0:
    return -1
  max(runtime.ownSleep - inMilliseconds(getMonoTime() - runtime.ownSleepAt).float / 1000, 0)

proc keepOwnSleep(runtime: JsAppRuntime, context: ExecutionContext): bool =
  ## A render that runs no get(): the sleep get() asked for goes on counting
  ## down (true), as if get() had asked again. False once it ran out: the
  ## render get() wanted then is due, so a whole get() it is.
  let left = runtime.ownSleepLeft()
  if left < 0:
    return true
  if left <= 0:
    return false
  context.nextSleep = left
  true

proc get*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext): Value =
  probe(phInit):
    runtime.init(owner, configJson)
  if not owner.scene.isNil:
    let target = uiTarget(owner.scene.id.string, owner.nodeId.int, create = false)
    # A handler ran since the last render and changed what get() reads: no
    # pointer's render after it may lay the old tree out again.
    let handled = not target.isNil and target.full
    if not target.isNil and (target.partial or target.full):
      # Handlers ran since the last render: when every one set signals and
      # nothing else asks for a new tree (the same config, a render sooner
      # than the scene's own interval), the components that read them alone.
      let partial = target.partial and not target.full
      target.partial = false
      target.full = false
      if partial and not target.inputOnly and not runtime.lastJsx.isNil and runtime.lastJsxConfig == configJson and
          inMilliseconds(getMonoTime() - runtime.lastJsxAt).float < owner.scene.refreshInterval * 1000 and
          runtime.keepOwnSleep(context):
        let image = runtime.partialRender(owner, configJson, context)
        if not image.isNil:
          runtime.lastJsxAt = getMonoTime()
          return VImage(image)
    if not target.isNil and target.inputOnly:
      target.inputOnly = false
      # Only the pointer asked for this render: the last tree with the new
      # pointer, while nothing else can have changed what get() returns (the
      # same config, a render sooner than the scene's own interval).
      if not handled and not runtime.lastJsx.isNil and runtime.lastJsxConfig == configJson and
          inMilliseconds(getMonoTime() - runtime.lastJsxAt).float < owner.scene.refreshInterval * 1000 and
          runtime.keepOwnSleep(context):
        return VImage(runtime.imageFromJsx(owner, context, runtime.lastJsx))
  try:
    runtime.midCall:
      # A throw fails the node, as a raising Nim app does: the interpreter then
      # defaults the consumer's arg or paints the error into its image, and the
      # node cache keeps nothing. It used to hand the consumer null instead,
      # which the cache then served until it expired.
      # The tree of the render before goes before the next is made: only the
      # pointer's render above reads it, and get() and its drawing want the
      # memory (a map's tree held a third of a megabyte while the next map
      # was fetched and parsed).
      runtime.lastJsx = nil
      # What get() itself asks of the sleep, for the renders that run no get()
      # (keepOwnSleep); the render's own as before, the last word winning.
      let before = context.nextSleep
      context.nextSleep = -1
      defer:
        runtime.ownSleep = context.nextSleep
        runtime.ownSleepAt = getMonoTime()
        if context.nextSleep < 0:
          context.nextSleep = before
      let payload = runtime.invoke(owner, configJson, context, "get", raiseOnError = true)
      var spent = false
      defer:
        if not spent:
          JS_FreeValue(runtime.js.context, payload)
      result = toValue(runtime, owner, context, payload, runtime.outputType, addr spent)
      if not runtime.lastJsx.isNil:
        runtime.lastJsxConfig = copy(configJson)
        runtime.lastJsxAt = getMonoTime()
      return
  finally:
    runtime.clearTransientImages()

proc run*(runtime: JsAppRuntime, owner: AppRoot, configJson: JsonNode, context: ExecutionContext,
    isEvent = false): bool {.discardable.} =
  ## `run`, or with `isEvent` the app's `onEvent` (true: it asks to be drawn again).
  runtime.init(owner, configJson)
  try:
    runtime.midCall:
      let payload = runtime.invoke(owner, configJson, context, if isEvent: "onEvent" else: "run")
      defer: JS_FreeValue(runtime.js.context, payload)
      if isEvent:
        result = jsIsBool(payload) and toNimBool(runtime.js.context, payload)
      elif runtime.category == "render":
        let value = toValue(runtime, owner, context, payload, "image")
        if value.kind == fkImage and not value.asImage().isNil:
          let drawn = value.asImage()
          context.image.draw(drawn)
          # A render app's image lands at the origin, its own size.
          applyAutoFitToDrawn(context.image, 0, 0, min(drawn.width, context.image.width),
            min(drawn.height, context.image.height), drawn)
  finally:
    runtime.clearTransientImages()

proc dynamicJsAppSubscribes*(app: AppRoot): bool =
  app.isDynamicJsApp() and not DynamicJsApp(app).events.isNil and DynamicJsApp(app).events.kind == JArray

proc dynamicJsAppHears*(app: AppRoot, event: string): bool =
  ## By name, or through "*" (the contract says which events that takes). An
  ## app's own render and init are its get() and init(), nothing it is told.
  if event == evRender or event == evInit:
    return false
  let everything = eventPolicy(event).heardByAll
  for item in DynamicJsApp(app).events.elems:
    if item.kind == JString and (item.str == event or (everything and item.str == "*")):
      return true

proc onEventDynamicJsApp*(app: AppRoot, context: ExecutionContext): bool =
  let dynamicApp = DynamicJsApp(app)
  dynamicApp.runtime.run(dynamicApp, dynamicApp.configJson, context, isEvent = true)

proc getDynamicJsApp*(app: AppRoot, context: ExecutionContext): Value =
  let dynamicApp = DynamicJsApp(app)
  probe(phApp):
    result = dynamicApp.runtime.get(dynamicApp, dynamicApp.configJson, context)

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
