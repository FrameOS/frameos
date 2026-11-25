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

import frameos/render_probe
import frameos/utils/json_depth
from frameos/js_runtime/burrito import scriptBreathe
import frameos/types
import frameos/utils/asset_colors
from frameos/render_scale import MaxRenderScale
import lib/tz
import std/[monotimes, times]
import frameos/channels
from frameos/events_gen import contractEventIndex, ContractEventPolicies, ecInput, SceneSwitcherId
import frameos/single_scene_host
import frameos/scene_rhythm
import frameos/layout_choice
import frameos/frame_service_keys
import system/sceneSwitcher/scene as sceneSwitcher
import system/sceneSettings/scene as sceneSettings
import frameos/scene_store_hooks
import frameos/scene_code_hooks
import frameos/scene_icon
from frameos/utils/memory import panelMemoryBytes, waitingTextDrops
when defined(memProbe): import frameos/utils/memory
import frameos/interpreter
import frameos/values
import frameos/planner
import frameos/js_runtime/runtime as jsRuntime
import frameos/js_runtime/app_runtime
import frameos/utils/svg_frames
# The loading mark's C entry points (fos_nim_loading_mark_*_impl), drawn by
# the RGB LCD's own task while a scene switch loads (lcd_st7701s_rgb.c).
import frameos/loading_mark

# ------------------------------------------------------------------ C hooks

proc espLog(msg: cstring) {.importc: "frameos_nim_log_hook", cdecl.}
proc espFlushLogs() {.importc: "frameos_nim_flush_logs", cdecl.}
  ## Uploads the backend log queue now (frameos_nim_glue.c; a no-op when
  ## log upload is off or internal RAM is short). Safe from the render
  ## task: it takes the log lock, never the Nim lock.
proc requestSceneSelect(sceneId: cstring): bool {.importc: "frameos_nim_request_scene_select", cdecl.}
proc requestDisplayPower(on: bool) {.importc: "frameos_nim_display_power", cdecl.}
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
  # The legacy single-payload path's scene order (the lazy path's is the
  # catalog), for `setCurrentScene {direction}`.
  loadedSceneOrder: seq[SceneId]
  layoutCatalog: seq[LayoutEntry]
  # Every new catalog off flash is a new set: a scene's definition cached
  # under an earlier one may have changed (loadScene).
  catalogGeneration = 0
  cachedInCatalog: Table[SceneId, int]
  # The scene's lifetime, its lifecycle events and the dispatcher's EventHost:
  # shared with the wasm preview (frameos/single_scene_host). Allocated here so
  # the status procs below can be asked before initRuntime.
  host = SingleSceneHost()

var sceneCatalog: seq[SwitcherEntry]
  ## The scenes the frame CAN run, as listed in /state/scenes/index.json:
  ## each as the switcher's tile and its `app.frame.scenes` entry (id, name,
  ## window size, icon, category), and nothing else. The point is that this
  ## is all the memory a non-active scene costs: its nodes, its app configs
  ## and (increasingly) its JavaScript stay on flash until the scene is
  ## selected. A frame with twenty JS-heavy scenes holds one.
  ## Empty on the legacy path (one scenes.json parsed whole), in which case
  ## every listing falls back to the resident cache. Non-empty means the
  ## firmware is feeding scenes one at a time.
var catalogRefresh: seq[float]
  ## Each catalog scene's refresh interval, at the same index, for sceneInfoJson.

proc sceneCount*(): int =
  scenesLoadedCount

proc hasScene*(): bool =
  not host.exported.isNil or defaultSceneId.isSome

proc currentSceneName*(): string =
  host.sceneName

proc currentSceneId*(): string =
  ## The scene showing, "" for none: what `sceneInfoJson` says as
  ## `currentSceneId`, without the list around it.
  if host.sceneId.isSome: host.sceneId.get().string else: ""

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
    for i, entry in sceneCatalog:
      sceneItems.add(%*{
        "id": entry.id,
        "name": if entry.name.len > 0: entry.name else: entry.id,
        "refreshInterval": catalogRefresh[i],
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
    result = parseJsonBounded(text)
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

proc readLayoutState(id: string): JsonNode {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    result = loadPersistedSceneState(id)

proc persistableSceneState(): JsonNode =
  ## The resident scene's keys worth a file.
  residentSceneState(persistable = true)

var persistOwed = false
  ## An animation's quiet frame left its look at the state for later
  ## (renderCurrentScene): any look pays it, and a scene about to go is
  ## looked at first (persistOwedSceneState).

proc persistSceneState*() =
  ## Write the resident scene's state when it differs from what was written.
  ## The scene switcher keeps none: a reboot never comes back to it.
  persistOwed = false
  if host.scene.isNil or host.sceneId.isNone or isBuiltInScene(host.sceneId.get().string):
    return
  saveSceneState(host.sceneId.get().string, persistableSceneState())

proc persistOwedSceneState() =
  ## Before the resident scene changes: the look a quiet frame put off.
  if persistOwed:
    persistSceneState()

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

proc writeLayoutState(id: string, state: JsonNode) {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    mergePersistedSceneState(id, state)

layoutStateRead = readLayoutState
layoutStateWrite = writeLayoutState

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

proc drainSceneEvents*(): bool =
  ## What async code dispatched (single_scene_host.drainQueued), after the pump.
  result = host.drainQueued()
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
        parseJsonBounded($payloadJson)
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
      if target.len > 0 and not isBuiltInScene(target) and
          (host.scene.isNil or host.sceneId.get().string != target):
        mergePersistedSceneState(target, state)
        host.renderRequested = true
        persisted = true
    result = host.send(origin.get(), event, payload) or persisted
    let index = contractEventIndex(event)
    if index >= 0 and ContractEventPolicies[index].class == ecInput:
      # A finger's or a key's event asks for its render when a handler
      # changed something, and that render's pass looks at the state
      # (renderCurrentScene); until then it is owed. Looked at here, every
      # pointerMove of a drag and each of a tap's three events built the
      # state and compared it, ~0.6 ms each on a SenseCAP Indicator.
      persistOwed = true
    else:
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

proc fos_nim_set_render_scale_impl(scale: cdouble) {.exportc, cdecl.} =
  ## frame.json's `renderScale` (frameos/render_scale.nim): what JSX from a
  ## .tsx or .jsx app is laid out for, 0 = automatic from the panel's size.
  ## fos_client pushes the config value every render pass like scaling_mode,
  ## and apps read the scale off the FrameConfig on every render, so a
  ## console/settings/cloud change applies on the next one. The C side
  ## normalizes to 0..4; anything else (NaN included) keeps the current one.
  if not frameConfig.isNil and scale >= 0.0 and scale <= MaxRenderScale:
    frameConfig.renderScale = float(scale)

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
    let node = if text.len == 0: newJObject() else: parseJsonBounded(text)
    if not frameConfig.isNil:
      frameConfig.colors = node
    setFrameColorSettings(parseFrameColorSettings(node))
    lastColorsJson = text
  except CatchableError as e:
    log("colors: ignored, does not parse: " & e.msg)

var lastEventMapJson: string

proc fos_nim_set_event_map_impl(json: cstring) {.exportc, cdecl.} =
  ## frame.json's `eventMap` (docs/events.md, "Event map"): what the frame's
  ## buttons do whatever scene is showing, as the firmware keeps it — the
  ## rule list as compact JSON, "" for none. fos_client pushes the stored
  ## text every render pass like `colors`; it is parsed only when it changed,
  ## and the dispatcher reads it off the FrameConfig it already holds, so a
  ## push applies to the next press. A list that does not parse keeps the
  ## previous one.
  if json == nil:
    return
  let text = $json
  if text == lastEventMapJson:
    return
  try:
    var rules: JsonNode = nil
    if text.len > 0:
      rules = parseJsonBounded(text)
      if rules.kind != JArray:
        log("eventMap: ignored, not a list")
        return
    if not frameConfig.isNil:
      frameConfig.eventMap = rules
    lastEventMapJson = text
    log(&"eventMap: {(if rules.isNil: 0 else: rules.len)} rule(s)")
  except CatchableError as e:
    log("eventMap: ignored, does not parse: " & e.msg)

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
      let node = parseJsonBounded(text)
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

var quietRenders* = false

proc fos_nim_set_keep_js_impl(keep: cint) {.exportc, cdecl.} =
  ## The firmware's say on keeping the scene's JS interpreters between
  ## renders (single_scene_host.keepJsRuntimes): yes on a frame that does not
  ## deep-sleep, while there is room. A deep sleeper also keeps its split's
  ## own interval as the fastest it wakes.
  rhythmHoldFloor = keep == 0
  host.keepJsRuntimes = keep != 0
  # Async JavaScript (docs/async-js.md) needs interpreters that outlive the
  # render and an idle wait to pump them in: on a deep sleeper the promises
  # would go with the boot, so fetch and the hooks block there instead.
  asyncPumped = keep != 0

proc fos_nim_js_runtime_bytes_impl(): csize_t {.exportc, cdecl.} =
  ## What the live JS app interpreters hold, for the render:animation line.
  liveJsAppRuntimeBytes().csize_t

proc fos_nim_set_storages_impl(internalPath: cstring, card: cint) {.exportc, cdecl.} =
  ## The firmware's storages, once at boot (main.c): the internal storage's
  ## path ("" without one) and whether the assets folder is a card that
  ## mounted. What `app.frame.storages` lists and the asset calls' `storage`
  ## reaches (js_runtime/app_runtime.nim).
  storageInternalPath = $internalPath
  storageCardMounted = card != 0

proc fos_nim_set_quiet_impl(quiet: cint) {.exportc, cdecl.} =
  ## An animation's quiet frame (fos_animation.h): no `render #N` line and no
  ## scene log lines until the next frame that logs in full.
  quietRenders = quiet != 0
  if not logger.isNil:
    logger.enabled = not quietRenders

proc debugEnabled*(): bool =
  ## The frame's `debug` setting (`set debug 1` on the console): the per-node
  ## profile lines, and the render line's per-phase probe (render_probe.nim).
  frameConfig.debug

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
    # Automatic until fos_client's first push (frameos_nim_set_render_scale).
    renderScale: 0.0,
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
      # Off for an animation's quiet frames (setQuiet), like the Linux
      # runner's fast-render log pause: the scene's own lines, not the
      # runtime's.
      if logger.enabled:
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
  # The backlight is the firmware's (fos_client.c): a panel without one
  # switches nothing there.
  host.displayPower = proc (on: bool) = requestDisplayPower(on)
  # The scene list in scenes.json order, for `setCurrentScene {direction}`:
  # the catalog's on the lazy path, the parsed payload's on the legacy one.
  host.sceneOrder = proc (): seq[SceneId] =
    if sceneCatalog.len == 0:
      return loadedSceneOrder
    for entry in sceneCatalog:
      result.add(SceneId(entry.id))
  host.runtimeCommand = proc (command: RuntimeCommand, payload: JsonNode) =
    let name = $command
    let payloadText = $payload
    if not requestRuntimeCommand(name.cstring, payloadText.cstring):
      log("runtime command not handled: " & name)
  # The state a scene starts with: what it last had (persistSceneState), the
  # way the Linux runtime seeds a scene from ./state/scene-<id>.json.
  host.initialState = proc (sceneId: SceneId): JsonNode = loadPersistedSceneState(sceneId.string)
  host.start()
  # A desktop layout runs the frame's scenes side by side, as on a Pi, as many
  # at once as the memory allows (app_runtime.windowLimit,
  # docs/scene-layouts.md "Windows"); a frame without one keeps one scene.
  host.setWindowed(true)

# ------------------------------------------------------------------- scenes

proc desktopKeepsScenes(): bool =
  ## A desktop (docs/scene-layouts.md "Windows"): the scene in front stays
  ## running in its window when another is read off flash. Not where one
  ## scene runs at a time: the next one takes its place (keepsInWindow).
  host.windowed and windowLimit() != 1 and (host.windows.len > 0 or
    not host.scene.isNil and host.keepsInWindow(host.scene.id))

proc makeRoomForScenes*(whole: bool) =
  ## Before a scene comes off flash or a whole set arrives, and before its
  ## text is even copied: the scene it replaces goes first, with its QuickJS
  ## context, its app instances and its kept interpreters, and pixie's kept
  ## masks with it. Built first and dropped after, the old and the new were in
  ## memory together, and a switch storm on the reTerminal E1003 (8 MB PSRAM,
  ## 1.65 MB free in blocks of 328 KB) aborted a load out of memory that the
  ## old scene's room would have held (2026-11-15). The scene cache stays
  ## until the new one is built, so a payload that does not parse leaves the
  ## old scene to be built again by the next render.
  ##
  ## `whole`: a whole set. A desktop's windows (where they were) go to the
  ## layout's next instance, and the scenes in them go: they may be changed.
  ## One scene on a desktop keeps the scene in front in its window, so
  ## nothing goes.
  if whole:
    host.carryDesktop()
    host.dropScene()
    host.dropWindows()
    dropParkedLayout()
  elif not desktopKeepsScenes():
    host.dropScene()
  else:
    return
  clearCoverageCache()
  clearGlyphCache()
  inc waitingTextDrops
  when defined(memProbe): memProbe("  makeRoomForScenes: old scene dropped")

proc loadSceneInputs(inputs: seq[FrameSceneInput]): int

proc loadScenes*(scenes: ptr UncheckedArray[cstring], lens: ptr UncheckedArray[csize_t], count: int): int =
  ## Parse and install interpreted scenes from the backend's JSON format
  ## (array of scenes; same payload Linux frames read from scenes.json), split
  ## by the firmware where it lies (fos_store_split_scenes): each scene copied
  ## alone, never a second block the size of the whole set.
  ## Returns the number of scenes loaded; the current scene is re-created
  ## on the next render so hot updates don't tear down mid-render state.
  persistOwedSceneState()
  var inputs: seq[FrameSceneInput]
  for i in 0 ..< count:
    var text = newString(lens[i].int)
    if text.len > 0:
      copyMem(addr text[0], scenes[i], text.len)
    inputs.add(parseInterpretedSceneInput(text))
  loadSceneInputs(inputs)

proc loadSceneInputs(inputs: seq[FrameSceneInput]): int =
  if inputs.len == 0:
    log("loadScenes: no scenes in payload")
    return 0

  let firstId = some(inputs[0].id)
  # Normally done already (makeRoomForScenes, before the payload was even
  # copied); here for a caller that did not.
  makeRoomForScenes(whole = true)
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScenes: no scenes survived parsing")
    return 0

  replaceInterpretedScenesCache(newScenes)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
  scenesLoadedCount = newScenes.len
  loadedSceneOrder = @[]
  # The set is held whole now: it is the list. The catalog read off flash
  # described the set before it, and the scene list, the switcher's tiles and
  # next / previous went on reading it until the next boot (a reTerminal E1002
  # given 4 scenes in place of 17 said "4 loaded, 16 available", 2026-11-18).
  sceneCatalog.setLen(0)
  catalogRefresh.setLen(0)
  layoutCatalog.setLen(0)
  for input in inputs:
    if newScenes.hasKey(input.id):
      if newScenes[input.id].isLayout:
        layoutCatalog.add LayoutEntry(id: input.id.string, name: newScenes[input.id].name,
          desktop: newScenes[input.id].isDesktop, category: newScenes[input.id].category)
      else:
        loadedSceneOrder.add(input.id)

  # Keep the current scene across updates when it still exists; otherwise
  # fall back to the first scene in the payload.
  if host.sceneId.isSome and not newScenes.hasKey(host.sceneId.get()):
    host.sceneId = none(SceneId)
  defaultSceneId = firstId
  if host.sceneId.isNone:
    host.sceneId = firstId

  log(&"loadScenes: {scenesLoadedCount} scene(s) ready, default \"{firstId.get().string}\"")
  scenesLoadedCount

proc catalogHas(sceneIdText: string): bool =
  sceneCatalog.anyIt(it.id == sceneIdText)

proc textAt(node: JsonNode, key: string): string =
  ## `node{key}` as text, "" where it is none: one call per read of the index.
  node{key}.getStr()

proc setSceneCatalog*(indexJson: string): int =
  ## Install the list of scenes available on flash, WITHOUT parsing any of
  ## them. `indexJson` is /state/scenes/index.json:
  ##   {"scenes": [{"id", "name", "refreshInterval"}, …], "default": "<id>"}
  ##
  ## This is what makes lazy loading possible: the frame can list, schedule
  ## and switch scenes knowing only this, and pays for a scene's nodes and
  ## JavaScript only while it is the active one. A new list may hold a changed
  ## layout: the one kept between switches goes, and so do the scenes running
  ## in a desktop's windows, which may be changed too.
  host.carryDesktop()
  host.dropWindows()
  dropParkedLayout()
  inc catalogGeneration
  var parsed: JsonNode
  try:
    parsed = parseJsonBounded(indexJson)
  except CatchableError as e:
    log("setSceneCatalog: unparseable index: " & e.msg)
    return 0
  if parsed.isNil or parsed.kind != JObject:
    log("setSceneCatalog: index is not an object")
    return 0
  var entries: seq[SwitcherEntry]
  var intervals: seq[float]
  var layouts: seq[LayoutEntry] = @[]
  let scenesNode = parsed{"scenes"}
  if not scenesNode.isNil and scenesNode.kind == JArray:
    for item in scenesNode.items:
      if item.kind != JObject:
        continue
      let id = item.textAt("id")
      if id.len > 0 and item{"isLayout"}.getBool(false):
        # Read off flash by id when a scene names it, and in no list but the
        # frame page's.
        layouts.add LayoutEntry(id: id, name: item.textAt("name"), desktop: item{"desktop"}.getBool(false),
          category: item.textAt("category"))
        continue
      if id.len == 0:
        continue
      entries.add SwitcherEntry(id: id, name: item.textAt("name"), windowSize: item.textAt("windowSize"),
        # The store only checked its length; what is not an icon is none.
        icon: sceneIconPath(item.textAt("icon")), category: item.textAt("category"),
        opens: item.textAt("opens"))
      intervals.add item{"refreshInterval"}.getFloat(0.0)
  sceneCatalog = move(entries)
  catalogRefresh = move(intervals)
  layoutCatalog = layouts
  forgetMissingLayouts() # a layout missing before may be on flash now
  if sceneCatalog.len == 0:
    log("setSceneCatalog: no scenes in index")
    return 0
  # The default is what boots when nothing was selected before; fall back to
  # the first entry so an index without one still starts something.
  let defaultId = parsed.textAt("default")
  defaultSceneId = some(SceneId(
    if defaultId.len > 0: defaultId else: sceneCatalog[0].id))
  # A previously selected scene that is no longer on flash must not stick
  # around as the target of the next render.
  if host.sceneId.isSome and not catalogHas(host.sceneId.get().string):
    host.sceneId = none(SceneId)
  log(&"setSceneCatalog: {sceneCatalog.len} scene(s) available, default \"{defaultSceneId.get().string}\"")
  sceneCatalog.len

proc loadScene*(payload: string, alongside = false): bool =
  when defined(memProbe): memProbe("  >>> loadScene payload=" & $payload.len & "B")
  persistOwedSceneState()
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
  # Its apps' files stay in its slot (sfHost): read again from there when an
  # interpreter starts.
  let inputs = parseInterpretedSceneInput(payload, SceneFiles(kind: sfHost))
  if inputs.len == 0:
    log("loadScene: payload contained no scene")
    return false
  if alongside:
    addInterpretedSceneToCache(inputs[0])
    inc scenesLoadedCount
    log("loadScene: \"" & inputs[0].id.string & "\" resident alongside")
    return true
  let sceneId = inputs[0].id
  if desktopKeepsScenes():
    # A desktop (docs/scene-layouts.md "Windows"): the scene in front stays
    # running in its window, and the one read off flash starts beside it.
    # What no window runs leaves the cache, as a switch's whole-cache
    # replacement below would.
    #
    # A definition cached under an earlier set is not this one: the set's
    # catalog dropped the windows but not the scene in front, and its new
    # text arriving from flash was ignored, so it kept running its old
    # version, layout and all (`layout:missing` for the set before's layout
    # after every desktop push, the SenseCAP Indicator and the reTerminal
    # E1004, the hardware bench, 2026-11-16).
    if getInterpretedScenes().hasKey(sceneId) and
        cachedInCatalog.getOrDefault(sceneId, -1) != catalogGeneration:
      if not host.scene.isNil and host.scene.id == sceneId:
        host.dropScene()
      removeInterpretedSceneFromCache(sceneId)
    if not getInterpretedScenes().hasKey(sceneId):
      addInterpretedSceneToCache(inputs[0])
      cachedInCatalog[sceneId] = catalogGeneration
    host.switchLoaded(sceneId)
    var gone: seq[SceneId]
    for cached in getInterpretedScenes().keys:
      if cached != sceneId and not host.windows.hasKey(cached):
        gone.add cached
    for cached in gone:
      removeInterpretedSceneFromCache(cached)
      cachedInCatalog.del(cached)
    scenesLoadedCount = 1 + host.windows.len
    if defaultSceneId.isNone:
      defaultSceneId = some(sceneId)
    log(&"loadScene: \"{sceneId.string}\" in front, {host.windows.len} more in windows")
    return true
  makeRoomForScenes(whole = false) # normally done already, before the copy
  let newScenes = buildInterpretedScenes(inputs)
  if newScenes.len == 0:
    log("loadScene: scene did not survive parsing")
    return false

  # Another scene of the same set: a layout found missing from it stays so.
  replaceInterpretedScenesCache(newScenes, newSet = false)
  when defined(memProbe): memProbe("  loadScene: scenes cache replaced")
  scenesLoadedCount = newScenes.len
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

proc fos_scenes_read_scene_file(sceneId: cstring, outLen: ptr csize_t): cstring {.importc, cdecl.}

proc readSceneFile(sceneId: SceneId): string {.nimcall, gcsafe.} =
  ## interpreter.sceneFileReader: a scene's slot file again, for an
  ## interpreter that starts to read its app's files from.
  var len: csize_t
  let bytes = fos_scenes_read_scene_file(sceneId.string.cstring, len.addr)
  if bytes.isNil:
    return ""
  result = newString(len.int)
  if len > 0:
    copyMem(addr result[0], bytes, len.int)
  cFree(bytes)

sceneFileReader = readSceneFile

proc switcherListing(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  ## The scene switcher's tiles: the catalog (names and ids off flash, in
  ## scenes.json order) on the lazy path, the parsed payload's otherwise —
  ## the same list `setCurrentScene {direction}` walks (host.sceneOrder).
  {.cast(gcsafe).}:
    if sceneCatalog.len == 0:
      return loadedSceneListing(loadedSceneOrder)
    for entry in sceneCatalog:
      result.add entry

sceneSwitcherListing = switcherListing

proc embeddedLayouts(): seq[LayoutEntry] {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    layoutCatalog

layoutListing = embeddedLayouts

# A long render lets its core's other tasks run (frameos_nim_glue.c): pixie
# calls this from its row loops, the QuickJS interrupt handler from scripts.
proc fos_render_breathe() {.importc, cdecl, raises: [].}
proc fos_render_breathe_reset*() {.importc, cdecl, raises: [].}
proc embeddedBreathe() {.nimcall, gcsafe, raises: [].} =
  fos_render_breathe()
renderBreathe = embeddedBreathe
scriptBreathe = embeddedBreathe

# pixie's row jobs (a gradient's rows into a grey or 565 canvas) on both cores
# (components/frameos_nim/fos_rows.c). Two workers' scratch whether or not
# the helper task can be made: without it every row is the caller's.
proc fosRowsRun(fn: RowsProc, ctx: pointer, rows, blockRows: int32)
  {.importc: "fos_rows_run", cdecl, gcsafe, raises: [].}
rowsRunner = fosRowsRun
rowsWorkers = 2

# The settings panel's frame page, behind its gear (docs/scene-settings.md
# "The frame page"): the facts it shows and what it sets (Wi-Fi, rotation,
# scale), from main/fos_frame_settings.c. Every call comes from the scene, on
# the render task.
proc fos_frame_settings_json(): cstring {.importc, cdecl.}
proc fos_frame_settings_apply(json: cstring) {.importc, cdecl.}
proc fos_frame_settings_action(action: cstring) {.importc, cdecl.}

proc frameSettingsJson(): JsonNode {.nimcall, gcsafe, raises: [].} =
  let raw = fos_frame_settings_json()
  if raw.isNil:
    return nil
  try:
    result = parseJsonBounded($raw)
  except Exception:
    result = nil
  cFree(raw)

proc frameSettingsSet(values: JsonNode) {.nimcall, gcsafe, raises: [].} =
  fos_frame_settings_apply(($values).cstring)

proc frameSettingsDo(action: string) {.nimcall, gcsafe, raises: [].} =
  fos_frame_settings_action(action.cstring)

sceneSettings.frameSettingsRead = frameSettingsJson
sceneSettings.frameSettingsApply = frameSettingsSet
sceneSettings.frameSettingsAction = frameSettingsDo

# The service keys typed on the frame page (frame_service_keys.nim), in NVS
# (main/fos_frame_settings.c): read when an app first asks for a key.
proc fos_service_keys_load(): cstring {.importc, cdecl.}
proc fos_service_keys_save(json: cstring): bool {.importc, cdecl.}

proc serviceKeysFromNvs(): string {.nimcall, gcsafe, raises: [].} =
  let raw = fos_service_keys_load()
  if not raw.isNil:
    result = $raw
    zeroMem(raw, result.len) # keys: not left in freed heap
    cFree(raw)

proc serviceKeysToNvs(text: string): bool {.nimcall, gcsafe, raises: [].} =
  fos_service_keys_save(text.cstring)

serviceKeysLoad = serviceKeysFromNvs
serviceKeysSave = serviceKeysToNvs

# The scene store's host (docs/scene-store.md, frameos/scene_store_hooks.nim):
# the facts and the work, from main/fos_store.c, which does the work on a task
# of its own. Every call comes from a JS app, on the render task.
proc fos_store_json(asker: cstring): cstring {.importc, cdecl.}
proc fos_store_action(asker, action, args: cstring) {.importc, cdecl.}

proc takeCString(raw: cstring): string =
  ## A string the firmware malloc'd, as Nim's, the C one freed.
  if not raw.isNil:
    result = $raw
    cFree(raw)

proc sceneStoreJson(asker: string): string {.nimcall, gcsafe, raises: [].} =
  takeCString(fos_store_json(asker.cstring))

proc sceneStoreDo(asker, action, args: string) {.nimcall, gcsafe, raises: [].} =
  fos_store_action(asker.cstring, action.cstring, args.cstring)

sceneStoreRead = sceneStoreJson
sceneStoreAction = sceneStoreDo

# The code editor's host (docs/code-editor.md, frameos/scene_code_hooks.nim):
# main/fos_code.c answers every operation, reads a scene's file off the scene
# store and asks the plane on the task that makes every request a scene asks
# for. Every call comes from a JS app, on the render task.
proc fos_code(asker, op, arg: cstring): cstring {.importc, cdecl.}

proc sceneCodeDo(asker, op, arg: string): string {.nimcall, gcsafe, raises: [].} =
  takeCString(fos_code(asker.cstring, op.cstring, arg.cstring))

sceneCode = sceneCodeDo

proc selectScene*(sceneIdText: string): bool =
  when defined(memProbe): memProbe("  >>> selectScene " & sceneIdText)
  persistOwedSceneState()
  let sceneId = SceneId(sceneIdText)
  if isBuiltInScene(sceneIdText):
    # The scene switcher (fos_scenes.c applies it without a slot): the scene
    # it covers is kept while render memory allows (single_scene_host's
    # `covered`), and its parsed payload stays in the cache for the way back.
    # Asked again while it shows (a reconnect re-announcing it), it keeps
    # what it was opened from. fos_scenes.c logs the switch.
    if host.sceneId != some(sceneId):
      host.makeCurrent(sceneId)
    return true
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

proc openHome*(): bool =
  ## The scene switcher as the frame's home (docs/scene-switcher.md "The
  ## frame's home"): what fos_scenes.c opens at boot when nothing was picked
  ## on the frame and no scene is marked default (fos_boot_scene.h). False on
  ## a frame that takes no taps (e-paper with keys alone, `takesNoTaps`): it
  ## starts on its first scene, as before.
  if takesNoTaps(host.frameConfig, panelLook(host.frameConfig).paper):
    return false
  host.carrySwitchState(SceneSwitcherId, %*{"home": true})
  selectScene(SceneSwitcherId)

proc sceneRunning*(sceneIdText: string): bool =
  ## Whether the scene runs in a window of a desktop already: fos_scenes.c
  ## brings it to the front (selectScene) without reading it off flash.
  host.windowed and host.windows.hasKey(SceneId(sceneIdText))

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
# (`fos_render_canvas_bits_per_pixel`, components/frameos_display), panel
# first: pixie's sixteen-grey surface for a 4-bit grey panel, its 8-bit luma
# surface for a four-grey or black-and-white panel (whose error diffusion
# wants the 256 levels) and its 16-bit RGB 5/6/5 surface for an RGB565 LCD,
# whatever the PSRAM;
# for a colour e-paper panel RGBX when a full canvas takes at most half the
# module's PSRAM, else 565. A grey canvas loses nothing a grey panel shows —
# blending is per channel, so the luma of a composite is the composite of
# the lumas — and every pass over it (a fill, a blend, the dither) moves a
# quarter of the bytes. The 1872x1404 sixteen-grey reTerminal E1003's is
# 1.3 MiB (2.5 in luma, 5.0 in 565): its stores are dithered as the pack did,
# and the level a store leaves is the level on the glass. An LCD's 565 canvas is its own
# back frame buffer (panelCanvas below): drawn in place, nothing to pack or
# copy. The 800x480 colour boards and a 1200x1600 panel on a 16 MB module
# render in full colour; 1200x1600 Spectra 6 on an 8 MB module needs 565 —
# RGBA is 7.3 MiB and does not fit, 565 is 3.7 MiB and does. A 565 canvas
# costs colour even though the dither keeps its error rows at full
# precision: rounding every stored pixel to 5/6 bits turns a smooth gradient
# into plateaus (a 480-row sky keeps 11 blue levels of 90), and the
# diffusion pass prints the plateau edges as bands — seen on the 7.3"
# weather scene. So a 565 canvas stores with pixie's per-pixel dither
# (`ditherStores`), which brings the gradient back at no memory cost, and
# RGBX is used wherever it fits. `-d:frameosCanvasRgbx` / `-d:frameosCanvas565`
# / `-d:frameosCanvasGray8` / `-d:frameosCanvasGray4` force a format for A/B measurement; the Pi runtime and the wasm preview are
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
proc canvasBitsPerPixel(): csize_t {.importc: "fos_display_canvas_bits_per_pixel", cdecl.}
proc displayRenderPsramBytes(): csize_t {.importc: "fos_display_render_psram_bytes", cdecl.}

# What the panel takes of the PSRAM before any scene runs, for the window
# limit (memory.sceneMemoryBytes): the canvas, the packed buffer and an RGB
# LCD's frame buffers (fos_display_render_psram_bytes, less the 1.5 MiB of
# render headroom it adds) and the emergency reserve the glue arms at boot
# (FOS_NIM_EMERGENCY_RESERVE_BYTES). The same sum as devices.ts
# esp32DeviceHeapBytes less the canvas, which the preview charges the same way.
panelMemoryBytes = proc(): int {.nimcall, gcsafe, raises: [].} =
  let panel = displayRenderPsramBytes().int
  if panel <= 0: 0 else: max(0, panel - 1536 * 1024) + 1024 * 1024

var sceneCanvas: Image

# The panel's own buffer for this render, when the firmware hands one in
# (fos_nim_render_panel_impl: an LCD's back frame buffer). A canvas in the
# panel's format and orientation IS that buffer: the scene draws straight
# into what the panel scans next, and there is nothing to pack or copy. The
# LCD has up to three such buffers (LCD_FBS), used in turn; their wrappers are
# kept. A wrapper that fell out of this list reads as a canvas nobody can vouch
# for (canvasGenerationForRhythm), so every buffer needs a slot: with two slots
# for three buffers a layout's panel was run again on every tick of its chrome.
var panelTarget: pointer
var panelTargetBytes: int
var panelCanvases: array[3, Image]
var nextPanelCanvas = 0

proc displayBufferGeneration(buffer: pointer): int64 {.importc: "fos_display_buffer_generation", cdecl.}

# Any LCD buffer's write generation, for a render that finds no frame of its
# own in the buffer it draws to take the newest another one still holds.
panelBufferGeneration = proc(buffer: pointer): int64 {.nimcall, raises: [].} =
  displayBufferGeneration(buffer)

proc setPanelTarget*(target: pointer, bytes: int, generation: uint32 = 0) =
  ## `generation`: the writes the firmware made into the buffer, so a scene
  ## that draws it whole from one SVG knows whether it still holds the last
  ## frame drawn there (utils/svg_frames.nim).
  panelTarget = target
  panelTargetBytes = bytes
  if target.isNil:
    endPanelFrame()
  else:
    beginPanelFrame(target, generation)

proc sceneCanvasFormat*(): PixelFormat =
  when defined(frameosCanvasRgbx): pfRgbx
  elif defined(frameosCanvas565): pfRgb565
  elif defined(frameosCanvasGray8): pfGray8
  elif defined(frameosCanvasGray4): pfGray4
  else:
    case canvasBitsPerPixel()
    of 32: pfRgbx
    of 8: pfGray8
    of 4: pfGray4
    else: pfRgb565

proc sceneCanvasWidth*(): int =
  if frameConfig.isNil: 0
  elif frameConfig.rotate in [90, 270]: frameConfig.height
  else: frameConfig.width

proc sceneCanvasHeight*(): int =
  if frameConfig.isNil: 0
  elif frameConfig.rotate in [90, 270]: frameConfig.width
  else: frameConfig.height

proc panelCanvas(width, height: int, format: PixelFormat): Image =
  ## The panel's buffer as the canvas, when it can be: a 565 canvas over a
  ## 565 panel, unrotated (a rotated panel packs, which rotates). nil else.
  if panelTarget.isNil or format != pfRgb565 or frameConfig.isNil or frameConfig.rotate != 0 or
      width * height * 2 != panelTargetBytes:
    return nil
  for canvas in panelCanvases:
    if not canvas.isNil and canvas.bufferPointer == panelTarget and canvas.width == width and
        canvas.height == height:
      return canvas
  result = newImage565Over(width, height, panelTarget)
  # The rounding the 565 pack used to do (half a step of per-pixel jitter),
  # so a gradient on the glass does not step every eight levels.
  result.ditherStores = true
  panelCanvases[nextPanelCanvas] = result
  nextPanelCanvas = (nextPanelCanvas + 1) mod panelCanvases.len

proc renderCanvasIsPanel*(image: Image): bool =
  ## Whether `image` is the panel buffer handed in for this render: drawn
  ## there, it is already packed.
  not image.isNil and not panelTarget.isNil and image.bufferPointer == panelTarget

proc frameos_nim_set_canvas_heap_bytes(bytes: csize_t) {.importc, cdecl.}

proc setCanvasHeapBytes(bytes: int) =
  frameos_nim_set_canvas_heap_bytes(csize_t(max(bytes, 0)))

proc renderCanvas*(): Image =
  ## The canvas the next render draws into, at the scene's (rotated)
  ## dimensions. Made on first use, reused for every render after. The
  ## panel's own buffer when it can be (panelCanvas).
  let
    width = sceneCanvasWidth()
    height = sceneCanvasHeight()
    format = sceneCanvasFormat()
  let direct = panelCanvas(width, height, format)
  if not direct.isNil:
    setCanvasHeapBytes(0)
    return direct
  if not sceneCanvas.isNil and sceneCanvas.width == width and
      sceneCanvas.height == height and sceneCanvas.format == format:
    return sceneCanvas
  let canvasBytes =
    case format
    of pfRgb565: width * height * 2
    of pfGray8: width * height
    of pfGray4: ((width + 1) div 2) * height
    of pfRgbx: width * height * 4
  let buffer = canvasBuffer(csize_t(canvasBytes))
  # The OOM restart policy asks whether a canvas could still be made:
  # nothing to make when it has a reserved block, its own size otherwise.
  setCanvasHeapBytes(if buffer != nil: 0 else: canvasBytes)
  if buffer != nil:
    sceneCanvas =
      case format
      of pfRgb565: newImage565Over(width, height, buffer)
      of pfGray8: newImageGray8Over(width, height, buffer)
      of pfGray4: newImageGray4Over(width, height, buffer)
      of pfRgbx: newImageOver(width, height, buffer)
  else:
    # No firmware block (a host build, or the reservation failed): the Nim
    # heap is PSRAM too, so this is the same memory without the guarantee.
    log(&"canvas: no reserved block for {width}x{height}, allocating from the heap")
    sceneCanvas =
      case format
      of pfRgb565: newImage565(width, height)
      of pfGray8: newImageGray8(width, height)
      of pfGray4: newImageGray4(width, height)
      of pfRgbx: newImage(width, height)
  if format == pfRgb565:
    sceneCanvas.ditherStores = true
  let described =
    case format
    of pfRgb565: "rgb565 (dithered stores)"
    of pfGray8: "gray8"
    of pfGray4: "gray4 (dithered stores)"
    of pfRgbx: "rgbx"
  log(&"canvas: {width}x{height} {described}")
  sceneCanvas

proc panelHasPartialWaveform*(): bool {.importc: "fos_display_supports_partial", cdecl.}

proc beginKeptCanvasFrame*(): bool =
  ## A render on a panel with a partial waveform: the kept canvas holds the
  ## last frame as an LCD's buffer does, so an SVG repaints only its damage
  ## (utils/svg_frames.nim). What else writes into it says so through
  ## rhythmForgetCanvases. A frame-wide color correction is applied to the
  ## finished canvas, and pixels left in place would take it twice.
  if panelHasPartialWaveform() and not frameColorSettings.global.hasAdjustments():
    beginPanelFrame(renderCanvas().bufferPointer, 0)
    result = true

proc endKeptCanvasFrame*() =
  endPanelFrame()

proc panelPressMapNow*(maxEntries: int): seq[PanelPressRect] =
  ## Where a press on the glass does something, of what the last render drew,
  ## in the panel's pixels (interpreter.panelPressMap). Kept by the glue after
  ## every render for the touch task, which clicks at a press the moment it
  ## lands, on its own core, while this task renders.
  if host.scene.isNil or frameConfig.isNil:
    return
  panelPressMap(host.scene, sceneCanvasWidth(), sceneCanvasHeight(), frameConfig.rotate, frameConfig.flip,
    maxEntries)

proc canvasGenerationForRhythm(canvas: Image): int64 {.nimcall, raises: [].} =
  ## What wrote into this kept canvas since it was drawn (scene_rhythm.nim): a
  ## panel buffer's count from the firmware, nothing on the scene canvas but
  ## what `rhythmForgetCanvases` hears of; -1 when a frame-wide colour
  ## correction would apply to a kept panel a second time.
  {.cast(raises: []).}:
    if frameColorSettings.global.hasAdjustments():
      return -1
  if canvas.isNil:
    -1
  elif canvas == sceneCanvas:
    0
  elif not panelBufferGeneration.isNil and canvas in panelCanvases:
    # This buffer or the one the rhythm is asking about (its neighbour).
    panelBufferGeneration(canvas.bufferPointer)
  else:
    -1

rhythmCanvasGeneration = canvasGenerationForRhythm

proc sceneRefreshSeconds*(): float =
  if not host.scene.isNil and host.scene.refreshInterval > 0:
    return host.scene.refreshInterval
  if not host.exported.isNil and host.exported.refreshInterval > 0:
    return host.exported.refreshInterval
  0.0

proc sceneAwaited*(): bool =
  ## May the next pass show the loading mark (scene_rhythm.nim)?
  rhythmAwaited(host.scene)

var lastNextSleep: float = -1
var lastPersistLook: MonoTime

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
  var image: Image
  probe(phScene):
    image = host.renderScene(context)
  # An animation's quiet frames look four times a second: the look builds the
  # state it would write and compares the text, 0.9 ms of a 34 ms frame of
  # DVD Logo Bounce on the SenseCAP Indicator (2026-11-18). Every other
  # render looks, the frame an animation logs in full among them.
  let persistAt = getMonoTime()
  if not quietRenders or (persistAt - lastPersistLook).inMilliseconds >= 250:
    lastPersistLook = persistAt
    probe(phPersist):
      persistSceneState()
  else:
    persistOwed = true
  when defined(memProbe): memProbe("  renderCurrentScene: idle js runtimes released")
  if image.isNil:
    log("render returned no image")
    return none(Image)
  lastNextSleep = context.nextSleep
  some(image)
