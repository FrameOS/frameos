# FrameOS wasm runtime: interpreted scenes rendered in the browser.
#
# Compiled with emscripten (tools/build_wasm.sh, -d:frameosWasm) into an ES
# module the frontend loads inside a Web Worker for the "live preview" modal.
# Scenes arrive as the same JSON the backend ships to frames
# (seq[FrameSceneInput]); rendering happens through frameos/interpreter with
# pixie, code nodes run on QuickJS. The C API below mirrors the ESP32
# embedded runtime (src/embedded), swapping the firmware hooks for
# emscripten JS-library hooks (log + event notifications go out through
# postMessage, HTTP comes in through synchronous XHR).

import std/[json, locks, math, monotimes, options, sequtils, strformat, strutils, tables, times]
import pixie

import frameos/types
import frameos/channels
import frameos/single_scene_host
import frameos/relayed_input
import frameos/interpreter
import frameos/planner
import frameos/utils/image as frameos_image
import frameos/utils/memory
import frameos/js_runtime/runtime as jsRuntime
import frameos/js_runtime/app_tests
import lib/tz
import frameos/version

# ------------------------------------------------------------------ JS hooks
# Implemented in tools/wasm/frameos_library.js and linked by emcc.

proc jsLogHook(msg: cstring) {.importc: "frameos_wasm_js_log", cdecl.}
proc jsEventHook(event: cstring, payload: cstring) {.importc: "frameos_wasm_js_event", cdecl.}

proc log(msg: string) =
  jsLogHook(msg.cstring)

# ------------------------------------------------------------------- state

var
  frameConfig: FrameConfig
  logger: Logger
  defaultSceneId: Option[SceneId] = none(SceneId)
  scenesLoadedCount = 0
  # The loaded payload's scene order, for `setCurrentScene {direction}`.
  loadedSceneOrder: seq[SceneId] = @[]
  # The scene's lifetime, its lifecycle events and the dispatcher's EventHost:
  # shared with the ESP32 runtime (frameos/single_scene_host).
  host = SingleSceneHost()
  lastImage: Image
  lastNextSleep: float = -1
  sceneInfoBuffer: string
  sceneStateBuffer: string
  lastErrorBuffer: string
  versionBuffer: string
  appTestsBuffer: string
  # Backend-persisted scene state, seeded via frameos_wasm_set_scene_state
  # before the scene's first render and merged into scene.state at init.
  pendingSceneStates = initTable[string, JsonNode]()

proc currentSceneName(): string =
  host.sceneName

proc setLastError(msg: string) =
  lastErrorBuffer = msg
  if msg.len > 0:
    log("error: " & msg)

# ------------------------------------------------------------------- scenes

proc selectSceneById(sceneIdText: string): bool =
  let sceneId = SceneId(sceneIdText)
  if not getInterpretedScenes().hasKey(sceneId):
    setLastError("scene not found: " & sceneIdText)
    return false
  host.makeCurrent(sceneId)
  true

# ------------------------------------------------------------------- setup

proc JS_SetTimezoneOffsetFunc(fn: proc (time: int64): cint {.cdecl.}) {.importc, header: "quickjs/quickjs.h".}

proc frameZoneOffset(time: int64): cint {.cdecl.} =
  ## What JS `Date` takes for the local zone at `time` (milliseconds since
  ## the epoch): minutes west of UTC in the frame's configured zone, not the
  ## browser's. QuickJS asks it (JS_SetTimezoneOffsetFunc, quickts) for every
  ## getTimezoneOffset() and local date field.
  try:
    let zone = if frameConfig.isNil: "UTC" else: frameConfig.timeZone
    cint(-(utcOffsetSeconds(zone, float(time div 1000)).int64 div 60))
  except CatchableError:
    0

proc frameos_wasm_init(width, height: cint, name: cstring,
    timeZone: cstring, settingsJson: cstring): bool {.exportc, cdecl.} =
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Safe to call repeatedly; every call resets scenes and state.
  ##
  ## settingsJson carries the frame's assembled settings (app API keys etc.),
  ## the same object the device receives in frame.json; apps read secrets from
  ## frameConfig.settings{"openAI"}{"apiKey"} and the like.
  try:
    host.dropScene()
    resetInterpretedScenes()
    setSimulatedEmbedded(false)
    host.sceneId = none(SceneId)
    defaultSceneId = none(SceneId)
    scenesLoadedCount = 0
    host.renderRequested = false
    lastImage = nil
    pendingSceneStates = initTable[string, JsonNode]()

    var settings = %*{}
    let settingsText = $settingsJson
    if settingsText.len > 0:
      try:
        let parsed = parseJson(settingsText)
        if parsed.kind == JObject:
          settings = parsed
      except CatchableError:
        setLastError("init: could not parse settings JSON; running without secrets")

    let tz = ($timeZone).strip()
    frameConfig = FrameConfig(
      name: $name,
      mode: "wasm",
      width: width.int,
      height: height.int,
      device: "wasm",
      deviceConfig: DeviceConfig(
        partial: false,
        partialMaxAreaPercent: 0.0,
        partialMaxRefreshesBeforeFull: 0,
        pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
      ),
      maxHttpResponseBytes: DefaultMaxHttpResponseBytes,
      rotate: 0,
      flip: "",
      scalingMode: "cover",
      settings: settings,
      assetsPath: "/srv/assets",
      saveAssets: %*false,
      logToFile: "",
      debug: false,
      timeZone: if tz.len > 0: tz else: "UTC",
      schedule: FrameSchedule(events: @[]),
      gpioButtons: @[],
      controlCode: ControlCode(enabled: false),
      network: NetworkConfig(),
      agent: AgentConfig(),
      mountpoints: MountpointsConfig(items: @[]),
      errorBehavior: ErrorBehaviorConfig(mode: "continue"),
      palette: PaletteConfig(colors: @[]),
      httpsProxy: HttpsProxyConfig(),
      timeZoneUpdates: TimeZoneUpdatesConfig(),
      frameAdminAuth: %*{},
    )
    logger = Logger(
      frameConfig: frameConfig,
      enabled: true,
      log: proc(payload: JsonNode) =
        jsLogHook(($payload).cstring)
    )
    # Load the baked tz data (a device does this from detectSystemTimeZone;
    # there is no /etc/localtime here) so chrono knows the configured zone.
    # JS-side time: `frameos.format` (chrono) and `new Date()` (QuickJS via
    # frameZoneOffset) both follow it.
    initTimeZone()
    jsRuntime.setJsTimeZone(frameConfig.timeZone)
    JS_SetTimezoneOffsetFunc(frameZoneOffset)
    initLock(logger.lock)
    channels.embeddedLogHook = proc(payload: JsonNode) {.gcsafe.} =
      jsLogHook(($payload).cstring)
    channels.embeddedEventHook = proc(sceneId: Option[SceneId], event: string,
        payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
      {.cast(gcsafe).}:
        # Pointer and keyboard input comes from the page in the first place
        # and arrives many times a second: like runner.nim, which keeps it out
        # of the frame log, it is not echoed back.
        if eventPolicy(event).device notin {edPointer, edKeyboard}:
          jsEventHook(event.cstring, (if payload.isNil: "{}" else: $payload).cstring)
        # Queued, never run from inside the run that dispatched it — the rule
        # every host has (docs/events.md). frameos_wasm_event and the render
        # pass drain.
        host.queue(origin, event, payload, sceneId)
    host.frameConfig = frameConfig
    host.logger = logger
    host.note = proc (message: string) = log(message)
    host.logEntry = proc (entry: JsonNode) = jsLogHook(($entry).cstring)
    # Nobody else owns a switch here: the preview just does it.
    host.requestSelect = proc (sceneId: string): bool = selectSceneById(sceneId)
    # The loaded payload's order, for `setCurrentScene {direction}`; a preview
    # of one scene switches nowhere.
    host.sceneOrder = proc (): seq[SceneId] = loadedSceneOrder
    host.runtimeCommand = proc (command: RuntimeCommand, payload: JsonNode) =
      log("runtime command ignored in the preview: " & $command)
    # Backend-persisted state, seeded by frameos_wasm_set_scene_state.
    host.initialState = proc (sceneId: SceneId): JsonNode =
      pendingSceneStates.getOrDefault(sceneId.string)
    host.start()
    result = true
  except Exception as e:
    setLastError("init failed: " & e.msg)
    result = false

# ------------------------------------------------------------------ loading

proc frameos_wasm_load_scenes(payload: cstring): cint {.exportc, cdecl.} =
  ## Parse and install interpreted scenes from the backend's JSON format
  ## (array of scenes). Returns the number of scenes loaded.
  try:
    let inputs = parseInterpretedSceneInputs($payload)
    if inputs.len == 0:
      setLastError("loadScenes: no scenes in payload")
      return 0
    let firstId = some(inputs[0].id)
    let newScenes = buildInterpretedScenes(inputs)
    if newScenes.len == 0:
      setLastError("loadScenes: no scenes survived parsing")
      return 0

    host.dropScene()
    replaceInterpretedScenesCache(newScenes)
    scenesLoadedCount = newScenes.len
    loadedSceneOrder = inputs.mapIt(it.id).filterIt(newScenes.hasKey(it))

    if host.sceneId.isSome and not newScenes.hasKey(host.sceneId.get()):
      host.sceneId = none(SceneId)
    defaultSceneId = firstId
    if host.sceneId.isNone:
      host.sceneId = firstId
    host.renderRequested = true
    log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
    scenesLoadedCount.cint
  except Exception as e:
    setLastError("loadScenes failed: " & e.msg)
    0

proc frameos_wasm_set_save_assets(payloadJson: cstring): bool {.exportc, cdecl.} =
  ## The frame's saveAssets config (bool, or {nodeName: bool}), so apps'
  ## "auto" save mode behaves like on a device. Call after init; without it
  ## the runtime keeps the historical default of false.
  try:
    if frameConfig.isNil:
      setLastError("setSaveAssets: init not called")
      return false
    frameConfig.saveAssets = parseJson($payloadJson)
    true
  except Exception as e:
    setLastError("setSaveAssets failed: " & e.msg)
    false

proc frameos_wasm_set_scene_state(sceneId: cstring, stateJson: cstring): bool {.exportc, cdecl.} =
  ## Seed persisted state for a scene before it initializes — how the backend
  ## restores stored state for virtual frames, where every render is a fresh
  ## wasm process. Merged into scene.state (over field defaults) when the
  ## scene inits, so it must be called before the first render.
  try:
    let parsed = parseJson($stateJson)
    if parsed.kind != JObject:
      setLastError("setSceneState: state must be a JSON object")
      return false
    pendingSceneStates[$sceneId] = parsed
    true
  except Exception as e:
    setLastError("setSceneState failed: " & e.msg)
    false

proc frameos_wasm_set_fusion(enabled: bool) {.exportc, cdecl.} =
  ## The differential's kill switch, same contract as the device console's
  ## `set fusion 0|1`: with fusion off every image edge falls back to the
  ## materialized floor, and the rendered pixels must not change. Plans are
  ## built at scene init, so call this before selecting the scene.
  imageFusionEnabled = enabled

proc frameos_wasm_set_embedded(enabled: bool) {.exportc, cdecl.} =
  ## Run as an ESP32 (memory.runsAsEmbedded): a JS app's interpreter lasts
  ## one render, `app.frame.embedded` is true, downloads decode into the
  ## canvas. Off by default, as a Pi; every frameos_wasm_init turns it off.
  setSimulatedEmbedded(enabled)

proc frameos_wasm_select_scene(sceneId: cstring): bool {.exportc, cdecl.} =
  try:
    selectSceneById($sceneId)
  except Exception as e:
    setLastError("selectScene failed: " & e.msg)
    false

# ---------------------------------------------------------------- rendering

proc frameos_wasm_render_impl(): cint {.exportc, cdecl.} =
  ## Render the current scene into an RGBA buffer owned by Nim; read it via
  ## frameos_wasm_buffer/_buffer_len/_width/_height. Returns 0 on success,
  ## 1 when the render produced an error frame, 2 when nothing could render.
  ##
  ## Called through `frameos_wasm_render` in tools/wasm/fos_wasm_mem.c, which
  ## wraps it in the setjmp guard that catches a simulated out-of-memory and
  ## returns 3. Without a simulated memory limit the guard is a direct call.
  host.renderRequested = false
  try:
    refreshDecodeBudget()
    if not host.ensureScene():
      setLastError("no scene selected")
      return 2
    # Log like the device's runner does, so the preview's runtime log shows
    # each render happening even when cached apps return an identical image.
    log($(%*{"event": "render:scene", "width": frameConfig.width, "height": frameConfig.height}))
    let renderStarted = epochTime()
    let context = ExecutionContext(
      scene: host.scene,
      event: "render",
      payload: %*{},
      hasImage: false,
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )
    # Renders, then delivers what the render (and an `init` or `open` before
    # it) dispatched. A `render` dispatched from inside a render is dropped by
    # the interpreter, so this does not loop the preview; one that a handler
    # dispatched is one more pass, as on a frame.
    let image = host.renderScene(context)
    if image.isNil:
      setLastError("render returned no image")
      return 2
    lastImage = image
    lastNextSleep = context.nextSleep
    log($(%*{
      "event": "render:done",
      "sceneId": if host.sceneId.isSome: host.sceneId.get().string else: "",
      "ms": round((epochTime() - renderStarted) * 1000, 3)
    }))
    0
  except Exception as e:
    setLastError("render failed: " & e.msg)
    try:
      lastImage = renderError(frameConfig.width, frameConfig.height, "Render failed: " & e.msg)
      1
    except CatchableError:
      lastImage = nil
      2

proc frameos_wasm_buffer(): pointer {.exportc, cdecl.} =
  if lastImage.isNil or lastImage.dataLen == 0 or not lastImage.isContiguous:
    return nil
  addr lastImage.data[0]

proc frameos_wasm_buffer_len(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint
  else: (lastImage.dataLen * 4).cint

proc frameos_wasm_width(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint else: lastImage.width.cint

proc frameos_wasm_height(): cint {.exportc, cdecl.} =
  if lastImage.isNil: 0.cint else: lastImage.height.cint

# ------------------------------------------------------------------- events

proc frameos_wasm_event(eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  ## Dispatch an event ("setSceneState", "button", custom events, ...) into
  ## the current scene, exactly like the backend does over the frame API.
  try:
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    # Everything the page sends is the `preview` origin; what that may say is
    # the contract's (docs/events-contract.json).
    if eventPolicy($eventName).device notin {edPointer, edKeyboard}:
      jsEventHook(eventName, ($payload).cstring)
    host.send(eoPreview, $eventName, payload)
  except Exception as e:
    setLastError("event " & $eventName & " failed: " & e.msg)
    false

proc frameos_wasm_device_input(inputJson: cstring): cint {.exportc, cdecl.} =
  ## Button edges a thin client saw, relayed with the render pull they asked
  ## for (frameos/relayed_input.nim): delivered as the board's own driver's,
  ## `gpio` from `driver`, then time passes to now, so a tap whose
  ## double-press window closed on the board is a `press` before the render.
  ## Returns how many edges were delivered, -1 when the input was unreadable.
  try:
    let edges = relayedButtonEdges(parseJson($inputJson), getMonoTime().ticks div 1_000_000)
    for payload in edges:
      discard host.send(eoDriver, "gpio", payload)
    discard host.tick()
    edges.len.cint
  except Exception as e:
    setLastError("device input failed: " & e.msg)
    -1

proc frameos_wasm_control_event(origin: cstring, eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  ## An event a control plane sent a thin client (a custom event from the
  ## workspace), held for its render pull and delivered here before the
  ## render, as the frame's own HTTP API or hub would have. From `http:admin`
  ## or `cloud` only, so the contract's origin rules still decide (the cloud
  ## may fire a custom event only where the scene declared it). False when it
  ## came to nothing.
  try:
    let source =
      case $origin
      of $eoHttpAdmin: eoHttpAdmin
      of $eoCloud: eoCloud
      else:
        setLastError("control event from " & $origin & ", which is not a control plane")
        return false
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    host.send(source, $eventName, payload)
  except Exception as e:
    setLastError("control event " & $eventName & " failed: " & e.msg)
    false

proc frameos_wasm_tick(): bool {.exportc, cdecl.} =
  ## Time passing with nothing sent — the worker calls this while a pointer or
  ## a button is held or a button press waits for a possible second one, so a
  ## long press is delivered while the finger is still down, as on a frame. True when it made an event; ask frameos_wasm_render_requested.
  try:
    host.tick()
  except Exception as e:
    setLastError("tick failed: " & e.msg)
    false

proc frameos_wasm_pointers_down(): cint {.exportc, cdecl.} =
  ## How much input the runtime is still timing: pointers held, GPIO buttons
  ## held, and button presses waiting out their double-press window. The
  ## worker ticks while any is, so a long press lands while the finger is
  ## down and a `press` once its window closes.
  if host.events.isNil: 0.cint
  else: (host.events.inputState.pointersDown + host.events.inputState.buttonsBusy).cint

proc frameos_wasm_render_requested(): bool {.exportc, cdecl.} =
  host.renderRequested

# ------------------------------------------------------------------- status

proc frameos_wasm_next_sleep(): cdouble {.exportc, cdecl.} =
  ## Seconds the scene asked to sleep before the next render
  ## (logic/nextSleepDuration); -1 when the scene didn't override it.
  lastNextSleep.cdouble

proc frameos_wasm_scene_interval(): cdouble {.exportc, cdecl.} =
  if not host.scene.isNil and host.scene.refreshInterval > 0:
    return host.scene.refreshInterval.cdouble
  if not host.exported.isNil and host.exported.refreshInterval > 0:
    return host.exported.refreshInterval.cdouble
  0.0

proc frameos_wasm_scene_info(): cstring {.exportc, cdecl.} =
  let scenes = getInterpretedScenes()
  var sceneItems = newJArray()
  for sceneId, exported in scenes:
    sceneItems.add(%*{
      "id": sceneId.string,
      "name": if exported.name.len > 0: exported.name else: sceneId.string,
      "refreshInterval": exported.refreshInterval,
    })
  sceneInfoBuffer = $(%*{
    "loaded": scenesLoadedCount,
    "currentSceneId": if host.sceneId.isSome: host.sceneId.get().string else: "",
    "currentSceneName": currentSceneName(),
    "defaultSceneId": if defaultSceneId.isSome: defaultSceneId.get().string else: "",
    "renderRequested": host.renderRequested,
    "scenes": sceneItems,
  })
  sceneInfoBuffer.cstring

proc frameos_wasm_scene_state(): cstring {.exportc, cdecl.} =
  if host.scene.isNil or host.scene.state.isNil or host.scene.state.kind != JObject:
    sceneStateBuffer = "{}"
  else:
    sceneStateBuffer = $host.scene.state
  sceneStateBuffer.cstring

proc frameos_wasm_last_error(): cstring {.exportc, cdecl.} =
  lastErrorBuffer.cstring

proc frameos_wasm_run_app_tests(appJson: cstring, testFile: cstring): cstring {.exportc, cdecl.} =
  ## Run one test file of a JavaScript app (`appJson`: the app as a scene
  ## carries it, or just `{"sources": {...}}`) in this runtime's interpreter
  ## and return the report (js_runtime/app_tests.nim) as JSON. Needs
  ## frameos_wasm_init first, for the frame the tests see.
  try:
    let app = parseJson($appJson)
    let sources = if app.kind == JObject and app.hasKey("sources"): app["sources"] else: app
    appTestsBuffer = $runJsAppTests(sources, $testFile, frameConfig)
  except Exception as e:
    appTestsBuffer = $(%*{"ok": false, "error": "could not run the tests: " & e.msg,
      "counts": {"passed": 0, "failed": 0, "skipped": 0, "total": 0}, "durationMs": 0, "children": [], "logs": []})
  appTestsBuffer.cstring

# The FrameOS version this runtime was built from, in the same published form
# a frame reports ("2026.9.0", no build hash) — so a preview can say which
# interpreter it renders with, and whether that is the firmware the frame
# actually runs. Baked at build time (-d:frameosVersion, from versions.json).
proc frameos_wasm_version(): cstring {.exportc, cdecl.} =
  versionBuffer = publishedFrameOSVersion(compiledFrameOSVersion())
  versionBuffer.cstring

# ---------------------------------------------------------------- keep alive
# Nim/ARC emits destructor calls for every module-level global at the end of
# the main module's top-level code — the moment main() returns, all global
# tables (scene registries, asset tables, ...) are freed, while MODULARIZE
# keeps the wasm instance callable. Exiting through emscripten's live-runtime
# unwind skips that epilogue entirely and keeps the runtime alive for the
# exported frameos_wasm_* calls.
proc emscripten_exit_with_live_runtime() {.importc, header: "<emscripten.h>", noreturn.}
emscripten_exit_with_live_runtime()
