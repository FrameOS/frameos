# FrameOS embedded scene runtime for interpreted scenes via QuickJS.
#
# Owns the interpreted-scene lifecycle on the ESP32: scenes arrive as the
# same JSON the backend ships to Linux frames (seq[FrameSceneInput]), get
# parsed/instantiated through frameos/interpreter, and render through the
# scene graph — code nodes and inline expressions run on QuickJS, app nodes
# run the AOT-compiled standard app library. The firmware's C side feeds us
# scene JSON (from SPIFFS or the backend) and asks for rendered frames.

import std/[json, locks, options, sequtils, strformat, tables]
import pixie

import frameos/types
import frameos/utils/asset_colors
import lib/tz
import std/times
import frameos/channels
import frameos/single_scene_host
when defined(memProbe): import frameos/utils/memory
import frameos/interpreter
import frameos/values
import frameos/planner
import frameos/js_runtime/runtime as jsRuntime
import frameos/js_runtime/app_runtime

# ------------------------------------------------------------------ C hooks

proc espLog(msg: cstring) {.importc: "frameos_nim_log_hook", cdecl.}
proc espFlushLogs() {.importc: "frameos_nim_flush_logs", cdecl.}
  ## Uploads the backend log queue now (frameos_nim_glue.c; a no-op when
  ## log upload is off or internal RAM is short). Safe from the render
  ## task: it takes the log lock, never the Nim lock.
proc requestSceneSelect(sceneId: cstring): bool {.importc: "frameos_nim_request_scene_select", cdecl.}
  ## Queues a scene switch with the firmware (fos_scenes_select), which owns
  ## it: the scene may have to come off flash, and the choice is persisted.
proc requestRuntimeCommand(command: cstring, payloadJson: cstring): bool {.importc: "frameos_nim_request_runtime_command", cdecl.}
  ## A device command a scene-side producer reached the dispatcher with
  ## (`metrics` is the only one a scene may say). The firmware owns them all:
  ## main/fos_events.c.

proc sceneStateLoad(sceneId: cstring): cstring {.importc: "frameos_nim_scene_state_load", cdecl.}
  ## The scene's state as last persisted (main/fos_scene_state.c): malloc'd
  ## JSON this side frees, or nil.
proc sceneStateSave(sceneId: cstring, json: cstring): bool {.importc: "frameos_nim_scene_state_save", cdecl.}
proc cFree(p: pointer) {.importc: "free", header: "<stdlib.h>", cdecl.}

proc log*(msg: string) =
  espLog(msg.cstring)

# ------------------------------------------------------------------- state

var
  frameConfig: FrameConfig
  logger: Logger
  defaultSceneId: Option[SceneId] = none(SceneId)
  scenesLoadedCount = 0
  # The scene's lifetime, its lifecycle events and the dispatcher's EventHost:
  # shared with the wasm preview (frameos/single_scene_host). Allocated here so
  # the status procs below can be asked before initRuntime.
  host = SingleSceneHost()

type
  SceneCatalogEntry* = object
    ## One scene the frame CAN run, as listed in /state/scenes/index.json —
    ## id, display name and refresh interval, and nothing else. The point is
    ## that this is all the memory a non-active scene costs: its nodes, its
    ## app configs and (increasingly) its JavaScript stay on flash until the
    ## scene is selected. A frame with twenty JS-heavy scenes holds one.
    id*: string
    name*: string
    refreshInterval*: float

var sceneCatalog: seq[SceneCatalogEntry] = @[]
  ## Empty on the legacy path (one scenes.json parsed whole), in which case
  ## every listing falls back to the resident cache. Non-empty means the
  ## firmware is feeding scenes one at a time.

proc sceneCount*(): int =
  scenesLoadedCount

proc hasScene*(): bool =
  not host.exported.isNil or defaultSceneId.isSome

proc currentSceneName*(): string =
  host.sceneName

proc sceneInfoJson*(): string =
  ## The scene list as the console, the USB API and the cloud see it.
  ##
  ## Sourced from the CATALOG when the firmware stores scenes as per-scene
  ## files (the lazy path: only the active scene is parsed, everything else is
  ## a name and an id read from the index). Falls back to the resident cache
  ## for the legacy single-payload path, where every scene is parsed anyway.
  ## `available` is what the frame can switch to; `loaded` is what is actually
  ## built in memory, which on the lazy path is at most one.
  var sceneItems = newJArray()
  var available = 0
  if sceneCatalog.len > 0:
    for entry in sceneCatalog:
      sceneItems.add(%*{
        "id": entry.id,
        "name": if entry.name.len > 0: entry.name else: entry.id,
        "refreshInterval": entry.refreshInterval,
      })
    available = sceneCatalog.len
  else:
    let scenes = getInterpretedScenes()
    for sceneId, exported in scenes:
      sceneItems.add(%*{
        "id": sceneId.string,
        "name": if exported.name.len > 0: exported.name else: sceneId.string,
        "refreshInterval": exported.refreshInterval,
      })
    available = scenes.len
  let payload = %*{
    "loaded": scenesLoadedCount,
    "available": available,
    "hasScene": hasScene(),
    "currentSceneId": if host.sceneId.isSome: host.sceneId.get().string else: "",
    "currentSceneName": currentSceneName(),
    "defaultSceneId": if defaultSceneId.isSome: defaultSceneId.get().string else: "",
    "renderRequested": host.renderRequested,
    "scenes": sceneItems,
  }
  $payload

# ------------------------------------------------------- state persistence

# A deep sleep is a reset, and this frame deep-sleeps between renders: without
# this, "Apply to active scene" lasted one render. The scene's public state
# (what the workspace shows and sets) and its persist:"disk" fields are kept in
# a file per scene (main/fos_scene_state.c), written when they change and read
# back when the scene is built — the Linux runtime's ./state/scene-<id>.json,
# for a chip. One scene is resident at a time, so one remembered write is
# enough to skip the flash write an unchanged state would cost.
var lastSavedStateId = ""
var lastSavedStateJson = ""

# Firmware up to 2026.10.5 wrote every persisted field to the file, defaults
# included, and the file seeds the scene before its declared defaults do: a
# scene installed with mode "random" ignored every later "album" the editor
# deployed (#531 stopped writing defaults, but a file already written kept
# pinning). The file now carries a format marker; one without it predates the
# rule and is dropped the first time it is read, so the scene seeds from the
# defaults the control plane just sent. The loss is one-time and bounded:
# a value somebody set on the device itself between 2026.10.5 and this.
const SceneStateFormatKey = "__persist"
const SceneStateFormat = 2

proc loadPersistedSceneState(sceneId: string): JsonNode =
  ## nil when nothing is persisted or the file is not an object.
  let raw = sceneStateLoad(sceneId.cstring)
  if raw == nil:
    return nil
  let text = $raw
  cFree(raw)
  try:
    result = parseJson(text)
    if result.kind != JObject:
      result = nil
  except CatchableError:
    result = nil
  if result.isNil:
    return nil
  if result{SceneStateFormatKey}.getInt(0) != SceneStateFormat:
    log("scene state: dropping a file written before the off-default rule for " &
      sceneId & " (it pinned every field's default over the deployed values)")
    discard sceneStateSave(sceneId.cstring, "{}".cstring)
    return nil
  result.delete(SceneStateFormatKey)

proc saveSceneState(sceneId: string, state: JsonNode) =
  ## An empty state removes the file; anything else is written with the
  ## format marker.
  var text = "{}"
  if not state.isNil and state.kind == JObject and state.len > 0:
    state[SceneStateFormatKey] = %SceneStateFormat
    text = $state
  if sceneId == lastSavedStateId and text == lastSavedStateJson:
    return
  if sceneStateSave(sceneId.cstring, text.cstring):
    lastSavedStateId = sceneId
    lastSavedStateJson = text

proc residentSceneState(persistable: bool): JsonNode =
  ## The resident scene's public fields and its persist:"disk" ones. For the
  ## file (`persistable`), only those off their declared default: a default
  ## in the file would outlive a redeploy that changes it (values.nim,
  ## `stateAtDeclaredDefault`), while a missing key is seeded afresh.
  result = newJObject()
  let scene = host.scene
  if scene.isNil or host.exported.isNil or scene.state.isNil or scene.state.kind != JObject:
    return
  let declaredFields = if persistable: declaredStateFields(host.exported) else: @[]
  for field in host.exported.publicStateFields:
    if scene.state.hasKey(field.name) and
        (not persistable or worthPersistingState(declaredFields, field.name, scene.state[field.name])):
      result[field.name] = scene.state[field.name]
  for key in host.exported.persistedStateKeys:
    if not result.hasKey(key) and scene.state.hasKey(key) and
        (not persistable or worthPersistingState(declaredFields, key, scene.state[key])):
      result[key] = scene.state[key]

proc persistableSceneState(): JsonNode =
  ## The resident scene's keys worth a file.
  residentSceneState(persistable = true)

proc persistSceneState*() =
  ## Write the resident scene's state when it differs from what was written.
  if host.scene.isNil or host.sceneId.isNone:
    return
  saveSceneState(host.sceneId.get().string, persistableSceneState())

proc mergePersistedSceneState(sceneId: string, state: JsonNode) =
  ## State for a scene that is not resident — a `setSceneState` on a
  ## wake-check pass, a `setCurrentScene` carrying state for the scene it
  ## switches to — goes to the file now, so the pass that builds the scene
  ## starts from it even if a deep sleep comes first. Keys the scene does not
  ## own are pruned by the first persistSceneState after it is built.
  var current = loadPersistedSceneState(sceneId)
  if current.isNil:
    current = newJObject()
  for key, value in state:
    current[key] = value
  saveSceneState(sceneId, current)

proc sceneStateJson*(): string =
  ## The current scene's public state: what `/state`, the cloud hello and the
  ## backend's commands pull report. The resident scene's live values, or —
  ## between a deep sleep and the first render — what was persisted for it,
  ## so a frame that woke only to check for commands still says what it shows.
  if host.scene.isNil:
    if host.sceneId.isNone:
      return "{}"
    let persisted = loadPersistedSceneState(host.sceneId.get().string)
    return if persisted.isNil: "{}" else: $persisted
  $residentSceneState(persistable = false)

proc takeRenderRequested*(): bool =
  host.takeRenderRequested()

proc recoverFromOomAbort*(): tuple[jsDropped, jsBytes: int] =
  ## single_scene_host.recoverAbortedRun, for the glue's abort handler.
  host.recoverAbortedRun()

proc tickInput*(): bool =
  ## Time passing with nothing sent (single_scene_host.tick).
  result = host.tick()
  if result:
    persistSceneState()

proc originFromMask(mask: cuint): Option[EventOrigin] =
  ## The firmware names an origin by its bit in fos_events_gen.h
  ## (`FOS_ORIGIN_*` = 1 shl the origin's place in the contract) — the same
  ## order `EventOrigin` is generated in.
  for origin in EventOrigin:
    if mask == (1.cuint shl ord(origin)):
      return some(origin)
  none(EventOrigin)

proc fos_nim_send_event_impl*(originMask: cuint, eventName: cstring, payloadJson: cstring): bool {.exportc, cdecl.} =
  ## One event from the firmware, stamped with who said it. It is queued and
  ## the queue is drained before this returns (one task: nobody else will), so
  ## what its handlers dispatch is delivered here too, after them. False when it
  ## came to nothing: an origin that may not say it, no scene, bad JSON.
  try:
    let origin = originFromMask(originMask)
    if origin.isNone:
      log("event " & $eventName & " dropped: unknown origin")
      return false
    let payload =
      if payloadJson == nil or ($payloadJson).len == 0:
        %*{}
      else:
        parseJson($payloadJson)
    # State aimed at a scene that is not the resident one is persisted first:
    # the dispatcher can only hand it to a built scene, and on a wake-check
    # pass (no render) or a switch there is none — the next build takes it
    # from the file, deep sleep or not. The render it asks for is the pass
    # that builds the scene with it.
    var persisted = false
    let event = $eventName
    let state = payload{"state"}
    if not state.isNil and state.kind == JObject:
      let target =
        if event == "setCurrentScene": payload{"sceneId"}.getStr()
        elif event == "setSceneState" and host.sceneId.isSome: host.sceneId.get().string
        else: ""
      if target.len > 0 and (host.scene.isNil or host.sceneId.get().string != target):
        mergePersistedSceneState(target, state)
        host.renderRequested = true
        persisted = true
    result = host.send(origin.get(), event, payload) or persisted
    persistSceneState()
  except Exception as e:
    log("event " & $eventName & " failed: " & e.msg)
    result = false

# ------------------------------------------------------------------- setup

proc getFrameConfig*(): FrameConfig =
  frameConfig

proc fos_nim_set_scaling_mode_impl(mode: cstring) {.exportc, cdecl.} =
  ## Fallback fit for image consumers that do not place the image themselves
  ## (a node's own placement wins since #321). fos_client pushes the config
  ## value every render pass, so console/settings/cloud changes apply live —
  ## unlike rotate, no canvas re-init is involved. The C side normalizes to
  ## contain/cover/stretch/center before calling.
  if not frameConfig.isNil and mode != nil and mode.len > 0:
    frameConfig.scalingMode = $mode

var lastColorsJson: string

proc fos_nim_set_colors_impl(json: cstring) {.exportc, cdecl.} =
  ## frame.json's `colors` block (utils/asset_colors): the automatic fit
  ## switch and the frame-wide correction. fos_client pushes the stored text
  ## every render pass like scaling_mode; it is parsed only when it changed.
  ## "" is the defaults. A block that does not parse keeps the previous one.
  if json == nil:
    return
  let text = $json
  if text == lastColorsJson:
    return
  try:
    let node = if text.len == 0: newJObject() else: parseJson(text)
    if not frameConfig.isNil:
      frameConfig.colors = node
    setFrameColorSettings(parseFrameColorSettings(node))
    lastColorsJson = text
  except CatchableError as e:
    log("colors: ignored, does not parse: " & e.msg)

var lastPaletteJson: string

proc fos_nim_set_palette_impl(json: cstring) {.exportc, cdecl.} =
  ## frame.json's `palette`, as the firmware keeps it: the colour list alone,
  ## `["#rrggbb", …]` ("" = the panel's built-in palette). fos_client pushes
  ## the stored text every render pass like `colors`; it is parsed only when
  ## it changed. The packer fits it onto the panel's table through
  ## utils/dither.fitPaletteOverride, so a list of the wrong length is
  ## ignored there rather than refused here. One unreadable colour empties
  ## the list, as the Linux config parser does.
  if json == nil:
    return
  let text = $json
  if text == lastPaletteJson:
    return
  var colors: seq[(int, int, int)] = @[]
  try:
    if text.len > 0:
      let node = parseJson(text)
      if node.kind == JArray:
        for entry in node.items:
          let color = parseHtmlColor(entry.getStr())
          colors.add((int(color.r * 255), int(color.g * 255), int(color.b * 255)))
  except CatchableError as e:
    log("palette: ignored, does not parse: " & e.msg)
    colors = @[]
  if not frameConfig.isNil:
    frameConfig.palette.colors = colors
  lastPaletteJson = text

proc fos_nim_set_time_zone_impl(timeZone: cstring) {.exportc, cdecl.} =
  ## The frame's IANA zone name: what scenes pass on (the weather app's
  ## open-meteo `timezone=`, `frame.timeZone` in JS) and what chrono converts
  ## with once fos_nim_load_tz_data_impl has loaded that zone's slice.
  ## fos_client pushes it every render pass, like scaling_mode, so a
  ## console/cloud change applies without a reboot.
  if not frameConfig.isNil and timeZone != nil:
    frameConfig.timeZone = $timeZone

var tzRuleBuffer: string

proc fos_nim_load_tz_data_impl(sliceJson: cstring, timeZone: cstring): cstring {.exportc, cdecl.} =
  ## Loads a per-zone tzdata slice (lib/tz.nim, the same shape as the full
  ## tzdata.json) into chrono and returns the POSIX TZ rule in force for
  ## `timeZone` at this moment, for the C side to setenv("TZ") so newlib,
  ## QuickJS Date and the schedule agree with chrono. Empty string when the
  ## slice is unusable or does not contain the zone. The returned pointer is
  ## valid until the next call.
  tzRuleBuffer = ""
  try:
    if sliceJson != nil and sliceJson.len > 0 and loadTimeZoneSlice($sliceJson):
      let zone = if timeZone != nil: $timeZone else: ""
      tzRuleBuffer = posixTzRule(zone, epochTime())
      if tzRuleBuffer.len > 0:
        frameConfig.timeZone = zone
        log("tz: loaded " & zone & " -> " & tzRuleBuffer)
      else:
        log("tz: slice loaded but zone '" & zone & "' not in it")
  except Defect as e:
    log("tz: load failed (defect): " & e.msg)
  except CatchableError as e:
    log("tz: load failed: " & e.msg)
  tzRuleBuffer.cstring

proc fos_nim_set_debug_impl(enabled: cint) {.exportc, cdecl.} =
  ## Turns the interpreter's per-node memory profile on and off at runtime
  ## (`set debug 1` on the console). It logs a line per node per render — the
  ## byte size of the value on that edge, the heap delta across the node, and
  ## which fusion tier the planner picked — which is how you find out where a
  ## render's peak memory actually goes. Off by default: on a memory-tight
  ## device the answer matters, but so does not paying for it every render.
  if not frameConfig.isNil:
    frameConfig.debug = enabled != 0

proc initRuntime*(width, height: int, name: string, maxHttpResponseBytes: int,
    rotate = 0) =
  ## Build the minimal FrameConfig + Logger the interpreter and apps expect.
  ## Logs go synchronously to the firmware's ESP_LOG hook; events (e.g. a
  ## "render" dispatched from a scene) set a flag the C render loop polls.
  ##
  ## `settings` starts empty and stays owned by the firmware: the settings poll
  ## (fos_settings.c) delivers backend and cloud service settings alike through
  ## fos_nim_apply_service_settings. Nim never fetches them itself.
  let httpResponseLimit =
    if maxHttpResponseBytes > 0: maxHttpResponseBytes else: DefaultMaxHttpResponseBytes
  var settings = %*{}
  frameConfig = FrameConfig(
    name: name,
    mode: "embedded",
    width: width,
    height: height,
    device: "embedded",
    deviceConfig: DeviceConfig(
      partial: false,
      partialMaxAreaPercent: 0.0,
      partialMaxRefreshesBeforeFull: 0,
      pins: PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
    ),
    maxHttpResponseBytes: httpResponseLimit,
    # width/height are the PANEL's; the interpreter creates the scene canvas
    # at the rotated dimensions (same contract as runner.renderSceneImage on
    # Pi) and the embedded packers rotate while packing.
    rotate: (rotate + 1080) mod 360,
    flip: "",
    scalingMode: "cover",
    settings: settings,
    assetsPath: "/srv/assets",
    saveAssets: %*false,
    logToFile: "",
    debug: false,
    timeZone: "UTC",
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
      espLog(($payload).cstring)
  )
  initLock(logger.lock)
  channels.embeddedLogHook = proc(payload: JsonNode) {.gcsafe.} =
    espLog(($payload).cstring)
  channels.embeddedLogFlushHook = proc() {.gcsafe.} =
    espFlushLogs()
  channels.embeddedEventHook = proc(sceneId: Option[SceneId], event: string, payload: JsonNode,
      origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      # Queued, never run from inside the run that dispatched it — the rule the
      # Pi has always had (docs/events.md). Whoever entered the runtime drains:
      # fos_nim_send_event_impl, and the render pass for what a render, an
      # `init` or an `open` dispatched.
      host.queue(origin, event, payload, sceneId)
  host.frameConfig = frameConfig
  host.logger = logger
  host.note = proc (message: string) = log(message)
  host.logEntry = proc (entry: JsonNode) = espLog(($entry).cstring)
  # The firmware owns a switch (the scene may have to come off flash, and the
  # choice is persisted): it is queued there, and comes back as selectScene.
  host.requestSelect = proc (sceneId: string): bool = requestSceneSelect(sceneId.cstring)
  host.runtimeCommand = proc (command: RuntimeCommand, payload: JsonNode) =
    let name = $command
    let payloadText = $payload
    if not requestRuntimeCommand(name.cstring, payloadText.cstring):
      log("runtime command not handled: " & name)
  # The state a scene starts with: what it last had (persistSceneState), the
  # way the Linux runtime seeds a scene from ./state/scene-<id>.json.
  host.initialState = proc (sceneId: SceneId): JsonNode = loadPersistedSceneState(sceneId.string)
  host.start()

# ------------------------------------------------------------------- scenes

proc loadScenes*(payload: string): int =
  when defined(memProbe): memProbe("  >>> loadScenes payload=" & $payload.len & "B")
  ## Parse and install interpreted scenes from the backend's JSON format
  ## (array of scenes; same payload Linux frames read from scenes.json).
  ## Returns the number of scenes loaded; the current scene is re-created
  ## on the next render so hot updates don't tear down mid-render state.
  let inputs = parseInterpretedSceneInputs(payload)
  if inputs.len == 0:
    log("loadScenes: no scenes in payload")
    return 0

  let firstId = some(inputs[0].id)
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScenes: no scenes survived parsing")
    return 0

  # Tear down the old scene before swapping the registry so its QuickJS
  # context and app instances are reclaimed.
  host.dropScene()
  when defined(memProbe): memProbe("  loadScene: old scene dropped")

  replaceInterpretedScenesCache(newScenes)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
  scenesLoadedCount = newScenes.len

  # Keep the current scene across updates when it still exists; otherwise
  # fall back to the first scene in the payload.
  if host.sceneId.isSome and not newScenes.hasKey(host.sceneId.get()):
    host.sceneId = none(SceneId)
  defaultSceneId = firstId
  if host.sceneId.isNone:
    host.sceneId = firstId

  log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
  scenesLoadedCount

proc setSceneCatalog*(indexJson: string): int =
  ## Install the list of scenes available on flash, WITHOUT parsing any of
  ## them. `indexJson` is /state/scenes/index.json:
  ##   {"scenes": [{"id", "name", "refreshInterval"}, …], "default": "<id>"}
  ##
  ## This is what makes lazy loading possible: the frame can list, schedule
  ## and switch scenes knowing only this, and pays for a scene's nodes and
  ## JavaScript only while it is the active one.
  var parsed: JsonNode
  try:
    parsed = parseJson(indexJson)
  except CatchableError as e:
    log("setSceneCatalog: unparseable index: " & e.msg)
    return 0
  if parsed.isNil or parsed.kind != JObject:
    log("setSceneCatalog: index is not an object")
    return 0
  var entries: seq[SceneCatalogEntry] = @[]
  let scenesNode = parsed{"scenes"}
  if not scenesNode.isNil and scenesNode.kind == JArray:
    for item in scenesNode.items:
      if item.kind != JObject:
        continue
      let id = item{"id"}.getStr()
      if id.len == 0:
        continue
      entries.add(SceneCatalogEntry(
        id: id,
        name: item{"name"}.getStr(),
        refreshInterval: item{"refreshInterval"}.getFloat(0.0),
      ))
  sceneCatalog = entries
  if entries.len == 0:
    log("setSceneCatalog: no scenes in index")
    return 0
  # The default is what boots when nothing was selected before; fall back to
  # the first entry so an index without one still starts something.
  let defaultId = parsed{"default"}.getStr()
  defaultSceneId = some(SceneId(
    if defaultId.len > 0: defaultId else: entries[0].id))
  # A previously selected scene that is no longer on flash must not stick
  # around as the target of the next render.
  if host.sceneId.isSome and
      not entries.anyIt(it.id == host.sceneId.get().string):
    host.sceneId = none(SceneId)
  log(&"setSceneCatalog: {entries.len} scene(s) available, default \"{defaultSceneId.get().string}\"")
  entries.len

proc catalogHas(sceneIdText: string): bool =
  sceneCatalog.anyIt(it.id == sceneIdText)

proc loadScene*(payload: string, alongside = false): bool =
  when defined(memProbe): memProbe("  >>> loadScene payload=" & $payload.len & "B")
  ## Build ONE scene and make it the only resident one, tearing down whatever
  ## was live. `payload` is a single scene object (the element the combined
  ## scenes.json holds in its array); it is wrapped so the existing array
  ## parser can be reused rather than duplicated.
  ##
  ## `alongside`: a scene the resident one embeds (a split's panel), parsed
  ## into the cache next to it, nothing torn down. Scene nodes resolve by id
  ## when their scene starts, so a split cannot start until every panel it
  ## names is resident too.
  ##
  ## Returns false and leaves the runtime scene-less on a bad payload — the
  ## caller (fos_scenes.c) logs and keeps the previous file on flash, so a
  ## corrupt scene cannot take the frame down permanently.
  let inputs = parseInterpretedSceneInputs("[" & payload & "]")
  if inputs.len == 0:
    log("loadScene: payload contained no scene")
    return false
  if alongside:
    addInterpretedSceneToCache(inputs[0])
    inc scenesLoadedCount
    log("loadScene: \"" & inputs[0].id.string & "\" resident alongside")
    return true
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScene: scene did not survive parsing")
    return false

  host.dropScene()
  when defined(memProbe): memProbe("  loadScene: old scene dropped")

  replaceInterpretedScenesCache(newScenes)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
  scenesLoadedCount = newScenes.len
  let sceneId = inputs[0].id
  host.sceneId = some(sceneId)
  if defaultSceneId.isNone:
    defaultSceneId = some(sceneId)
  host.renderRequested = true
  log(&"loadScene: \"{sceneId.string}\" resident (1 of {max(sceneCatalog.len, 1)})")
  true

proc fos_scenes_read_scene_json(sceneId: cstring, outLen: ptr csize_t): cstring {.importc, cdecl.}

proc loadEmbeddedScene(sceneId: SceneId): bool {.nimcall.} =
  ## interpreter.sceneLoader: a scene the resident one embeds (a split's
  ## panel), read off its slot (fos_scenes.c) and parsed alongside. Its own
  ## panels come the same way when it starts.
  var len: csize_t
  let json = fos_scenes_read_scene_json(sceneId.string.cstring, len.addr)
  if json.isNil:
    return false
  try:
    result = loadScene($json, alongside = true)
  finally:
    cFree(json)

sceneLoader = loadEmbeddedScene

proc selectScene*(sceneIdText: string): bool =
  when defined(memProbe): memProbe("  >>> selectScene " & sceneIdText)
  let sceneId = SceneId(sceneIdText)
  let scenes = getInterpretedScenes()
  # On the lazy path the scene is on flash, not in the cache: record the
  # choice and let the firmware feed the payload through loadScene. Returning
  # true here means "known scene", not "already loaded".
  if sceneCatalog.len > 0 and not scenes.hasKey(sceneId):
    if not catalogHas(sceneIdText):
      log("selectScene: scene not found: " & sceneIdText)
      return false
    # The old instance stays until loadScene replaces it.
    host.makeCurrent(sceneId, drop = false)
    log("selectScene: " & sceneIdText & " (pending load from flash)")
    return true
  if not scenes.hasKey(sceneId):
    log("selectScene: scene not found: " & sceneIdText)
    return false

  host.makeCurrent(sceneId)
  log("selectScene: " & sceneIdText)
  true

proc fos_nim_set_fusion_impl(enabled: cint) {.exportc, cdecl.} =
  ## Test hook for the value-pipeline differential (docs/value-pipeline.md,
  ## principle 4): with fusion off, every image edge falls back to a fully
  ## materialized `Value` — and the panel must come out identical. Rendering the
  ## same scene both ways and comparing the two previews is the on-hardware
  ## version of the host harness, and the only way to check the claim against
  ## the real decoders rather than a test seam.
  ##
  ## Plans are built when a scene loads, so the flag alone would not take
  ## effect: drop the live scene and let the next render re-plan it.
  let wanted = enabled != 0
  if imageFusionEnabled == wanted:
    return
  imageFusionEnabled = wanted
  host.dropScene()
  host.renderRequested = true
  log("image fusion " & (if wanted: "enabled" else: "disabled") & "; scene will re-plan")

# ------------------------------------------------------------- the canvas
#
# One scene canvas for the device's uptime, not one per render.
#
# Two decisions live here. The format, decided per board by the firmware
# (`fos_render_canvas_bytes_per_pixel`, components/frameos_display): RGBX
# when a full canvas takes at most half the module's PSRAM, else pixie's
# 16-bit RGB 5/6/5 surface. The 800x480 boards and a 1200x1600 panel on a
# 16 MB module render in full colour; 1200x1600 on an 8 MB module is the
# one that needs 565 — RGBA is 7.3 MiB and does not fit, 565 is 3.7 MiB and
# does. A 565 canvas costs colour even though the dither keeps its error
# rows at full precision: rounding every stored pixel to 5/6 bits turns a
# smooth gradient into plateaus (a 480-row sky keeps 11 blue levels of 90),
# and the diffusion pass prints the plateau edges as bands — seen on the
# 7.3" weather scene. So a 565 canvas stores with pixie's per-pixel dither
# (`ditherStores`), which brings the gradient back at no memory cost, and
# RGBX is used wherever it fits. `-d:frameosCanvasRgbx` / `-d:frameosCanvas565`
# force a format for A/B measurement; the Pi runtime and the wasm preview are
# untouched either way and keep full RGBA.
#
# The lifetime: the memory comes from one PSRAM block the firmware claims at
# boot (`frameos_nim_reserve_canvas`, before Wi-Fi and TLS have carved the
# heap up) and hands back through `frameos_nim_canvas_buffer`. A multi-MB
# contiguous run is the one allocation fragmentation can deny a long-running
# device; claiming it once and never freeing it is how that cannot happen —
# and it also removes the per-render allocate/GC churn of the old scheme.
# Nothing aliases the canvas across renders (docs/value-pipeline.md: the
# cache never stores the live canvas), so reusing it is safe.

proc canvasBuffer(len: csize_t): pointer {.importc: "frameos_nim_canvas_buffer", cdecl.}
proc canvasBytesPerPixel(): csize_t {.importc: "fos_display_canvas_bytes_per_pixel", cdecl.}

var sceneCanvas: Image

proc sceneCanvasFormat*(): PixelFormat =
  when defined(frameosCanvasRgbx): pfRgbx
  elif defined(frameosCanvas565): pfRgb565
  else:
    if canvasBytesPerPixel() == 4: pfRgbx else: pfRgb565

proc sceneCanvasWidth*(): int =
  if frameConfig.isNil: 0
  elif frameConfig.rotate in [90, 270]: frameConfig.height
  else: frameConfig.width

proc sceneCanvasHeight*(): int =
  if frameConfig.isNil: 0
  elif frameConfig.rotate in [90, 270]: frameConfig.width
  else: frameConfig.height

proc renderCanvas*(): Image =
  ## The canvas the next render draws into, at the scene's (rotated)
  ## dimensions. Made on first use, reused for every render after.
  let
    width = sceneCanvasWidth()
    height = sceneCanvasHeight()
    format = sceneCanvasFormat()
  if not sceneCanvas.isNil and sceneCanvas.width == width and
      sceneCanvas.height == height and sceneCanvas.format == format:
    return sceneCanvas
  let bytesPerPixel = if format == pfRgb565: 2 else: 4
  let buffer = canvasBuffer(csize_t(width * height * bytesPerPixel))
  if buffer != nil:
    sceneCanvas =
      if format == pfRgb565: newImage565Over(width, height, buffer)
      else: newImageOver(width, height, buffer)
  else:
    # No firmware block (a host build, or the reservation failed): the Nim
    # heap is PSRAM too, so this is the same memory without the guarantee.
    log(&"canvas: no reserved block for {width}x{height}, allocating from the heap")
    sceneCanvas =
      if format == pfRgb565: newImage565(width, height)
      else: newImage(width, height)
  if format == pfRgb565:
    sceneCanvas.ditherStores = true
  log(&"canvas: {width}x{height} " & (if format == pfRgb565: "rgb565 (dithered stores)" else: "rgbx"))
  sceneCanvas

proc sceneRefreshSeconds*(): float =
  if not host.scene.isNil and host.scene.refreshInterval > 0:
    return host.scene.refreshInterval
  if not host.exported.isNil and host.exported.refreshInterval > 0:
    return host.exported.refreshInterval
  0.0

var lastNextSleep: float = -1

proc sceneNextSleepSeconds*(): float =
  ## Per-render sleep override the scene's last render set through
  ## logic/nextSleepDuration (context.nextSleep on the Pi runner);
  ## negative = no override, use the interval logic.
  lastNextSleep

proc renderCurrentScene*(): Option[Image] =
  ## Render the active interpreted scene; none() when no scenes are loaded
  ## (the caller falls back to the baked demo scene).
  lastNextSleep = -1
  if not host.ensureScene():
    return none(Image)
  # The persistent canvas goes in with the event; the interpreter's "render"
  # handler fills it with the scene background and draws into it.
  let context = ExecutionContext(
    scene: host.scene,
    event: "render",
    payload: %*{},
    image: renderCanvas(),
    hasImage: true,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )
  # renderScene hands the JS apps' interpreters back before it returns, so the
  # packing and display work below see the memory.
  let image = host.renderScene(context)
  persistSceneState()
  when defined(memProbe): memProbe("  renderCurrentScene: idle js runtimes released")
  if image.isNil:
    log("render returned no image")
    return none(Image)
  lastNextSleep = context.nextSleep
  some(image)
