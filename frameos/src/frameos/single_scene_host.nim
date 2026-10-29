## The host half of the event dispatcher for a runtime that holds ONE scene at
## a time on ONE task: the ESP32 (src/embedded/embedded_runtime.nim) and the
## wasm preview (src/wasm/wasm_main.nim). Both used to carry their own copy of
## all of this, and the copies drifted — the nil dereference the E1002 bench
## found (2026-09-21) was the same line in both, and only one of the two
## platforms traps on it.
##
## What a platform supplies is what is truly its own: who owns a scene switch
## (the firmware queues it and loads the scene off flash; the preview just does
## it), what a device command does there, where a log line goes, and what state
## a scene starts with. Everything else — the scene's lifetime, its lifecycle
## events, the EventHost the dispatcher talks to — is here.
##
## The Linux runner holds many scenes on a thread of its own and is its own
## host (frameos/runner.nim).

import std/[json, options, tables]
import pixie
import ./event_loop
import ./interpreter
import ./scene_rhythm
import ./types
import ./utils/asset_colors
import ./utils/dither
import ./utils/memory
import ./js_runtime/app_runtime
import ./js_runtime/run_budget
import ./js_runtime/runtime as jsRuntime
import system/sceneSwitcher/scene as sceneSwitcher
import system/sceneSettings/scene as sceneSettings
when defined(memProbe): import ./utils/memory

export event_loop

type
  SingleSceneHost* = ref object
    frameConfig*: FrameConfig
    logger*: Logger
    scene*: FrameScene                    ## the resident instance, nil until its first render
    exported*: ExportedInterpretedScene
      ## How the resident scene runs: an interpreted scene's, or a built-in
      ## one's (the scene switcher, system/sceneSwitcher/scene.nim; the scene
      ## settings, system/sceneSettings/scene.nim), which draws itself
      ## through the same three procs.
    sceneId*: Option[SceneId]             ## the current scene, resident or not
    renderRequested*: bool
    keepJsRuntimes*: bool
      ## Keep the scene's idle JS interpreters between renders while there is
      ## room (settleIdleJsAppRuntimes): an ESP32 that does not deep-sleep.
      ## The preview leaves it off and releases them, as a deep-sleeping
      ## frame must, so an app leaning on module state shows it there.
    events*: EventLoop
    # The payload of a `setCurrentScene` that carried `state`, held until that
    # scene is the resident one.
    pendingSwitchId: string
    pendingSwitchPayload: JsonNode
    # --- the platform's own
    requestSelect*: proc (sceneId: string): bool
      ## Make `sceneId` the current scene, now or soon. False: no such scene.
    sceneOrder*: proc (): seq[SceneId]
      ## The frame's scene list in the control plane's order, for a
      ## `setCurrentScene {direction}` (docs/events.md, "Event map"). nil:
      ## no such switch here.
    runtimeCommand*: proc (command: RuntimeCommand, payload: JsonNode)
    displayPower*: proc (on: bool)
      ## `turnOn` / `turnOff` / `toggleScreen`: the platform's backlight (an
      ## ESP32 LCD). nil where there is nothing to switch: e-paper holds its
      ## image unpowered, and the preview's canvas has no backlight.
    logEntry*: proc (entry: JsonNode)     ## a frame log line
    note*: proc (message: string)         ## a line for whoever is watching the console
    initialState*: proc (sceneId: SceneId): JsonNode
      ## Persisted state a scene starts with; nil = none.

proc say(host: SingleSceneHost, message: string) =
  if not host.note.isNil:
    host.note(message)

proc sceneName*(host: SingleSceneHost): string =
  if not host.exported.isNil and host.exported.name.len > 0:
    return host.exported.name
  if host.sceneId.isSome:
    return host.sceneId.get().string
  ""

proc takeRenderRequested*(host: SingleSceneHost): bool =
  result = host.renderRequested
  host.renderRequested = false

# ----------------------------------------------------------------- lifetime

proc cleanupScene*(scene: FrameScene) =
  ## Break ORC cycles and close the scene's QuickJS context before dropping
  ## the last reference (mirrors scenes.nim cleanupSceneRuntime, which lives
  ## outside these builds).
  if scene.isNil or not (scene of InterpretedFrameScene):
    return
  when defined(memProbe): memProbe("  cleanupScene: entry")
  let interpreted = InterpretedFrameScene(scene)
  for _, childScene in interpreted.sceneNodes:
    cleanupScene(childScene)
  interpreted.execNode = nil
  interpreted.getDataNode = nil
  # Before the apps are dropped: each JS app node owns a QuickJS runtime with
  # no destructor, and liveJsRuntimes keeps it reachable regardless, so the
  # scene going away frees none of it.
  for _, app in interpreted.appsByNodeId:
    releaseJsAppRuntime(app)
  when defined(memProbe): memProbe("  cleanupScene: js app runtimes released")
  interpreted.appsByNodeId = initTable[NodeId, AppRoot]()
  interpreted.appInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
  interpreted.appInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
  interpreted.codeInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
  interpreted.codeInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
  interpreted.sceneNodes = initTable[NodeId, FrameScene]()
  interpreted.sceneExportByNodeId = initTable[NodeId, ExportedScene]()
  interpreted.nextNodeIds = initTable[NodeId, NodeId]()
  interpreted.eventListeners = initTable[string, seq[NodeId]]()
  interpreted.nodes = initTable[NodeId, DiagramNode]()
  interpreted.edges = @[]
  interpreted.cacheValues = initTable[NodeId, Value]()
  interpreted.cacheTimes = initTable[NodeId, float]()
  interpreted.cacheKeys = initTable[NodeId, JsonNode]()
  interpreted.cacheExprs = initTable[NodeId, JsonNode]()
  when defined(memProbe): memProbe("  cleanupScene: tables cleared")
  cleanupSceneJs(interpreted)
  when defined(memProbe): memProbe("  cleanupScene: js closed")

proc recoverAbortedRun*(host: SingleSceneHost): tuple[jsDropped, jsBytes: int] =
  ## After an out-of-memory abort: the ESP32's allocator longjmps out of the
  ## render, scene switch or event it was serving (frameos_nim_glue.c), and
  ## every `finally` on the way out was skipped. What those would have put
  ## back is put back here, or every later run inherits it until a reboot:
  ## the run's wall-clock deadline (each later JS call failed at once with
  ## "render exceeded its 90000ms wall-clock deadline"), the dispatcher's
  ## flags (no event delivered again), the recursion guards (false "depends
  ## on itself"), the render-pass depth (no embedded scene would ever be due
  ## again, scene_rhythm.nim), sceneJsLock (the next code node waits
  ## forever), and the JS interpreters that were mid-call, which can be
  ## neither run nor freed and are dropped. Returns how many were dropped and
  ## the bytes they still hold. What the aborted run allocated stays leaked;
  ## the glue decides whether that warrants a restart.
  resetRunBudgets()
  if not host.events.isNil:
    host.events.resetAfterAbort()
  clearRunNodeStacks(host.scene)
  rhythmResetAfterAbort()
  let apps = abandonMidCallJsAppRuntimes()
  let scenes = abandonMidCallSceneJs()
  (apps.count + scenes.count, apps.bytes + scenes.bytes)

proc dropScene*(host: SingleSceneHost) =
  ## Let go of the resident instance; the current scene id stays.
  if not host.scene.isNil:
    cleanupScene(host.scene)
    host.scene = nil
    host.exported = nil

proc runOn(host: SingleSceneHost, scene: FrameScene, event: string, payload: JsonNode) =
  ## One run of the resident scene, through its export: the interpreter's for
  ## a scene off the list, the switcher's own for the switcher.
  let context = ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0, loopKey: ".")
  if not host.exported.isNil and scene == host.scene:
    host.exported.runEvent(scene, context)
  else:
    runEvent(scene, context)

proc runNow(host: SingleSceneHost, event: string, payload: JsonNode) =
  host.runOn(host.scene, event, payload)

proc lifecycle*(host: SingleSceneHost, event: string, payload: JsonNode) =
  ## "open" and "close", sent the way runner.nim sends them: "open" when a
  ## scene becomes the current one, "close" when the host switches away from
  ## it. ("init" is the interpreter's own, fired by its init.) What a listener
  ## dispatches is queued, like from any other run.
  if not host.events.isNil:
    host.events.deliverLifecycle(host.scene, event, payload)

proc makeCurrent*(host: SingleSceneHost, sceneId: SceneId, drop = true) =
  ## The switch itself, once the platform has decided `sceneId` is next: the
  ## scene being left hears "close", and the next render builds the new one.
  if host.sceneId.isSome and host.sceneId.get() != sceneId:
    host.lifecycle("close", %*{})
    # A photo's own dither palette (utils/asset_colors) outlives the render
    # that loaded it, not the scene that showed it; same for the marks on
    # the photos a sidecar graded.
    clearRenderPaletteOverride()
    clearGradedImages()
  if drop:
    host.dropScene()
  host.sceneId = some(sceneId)
  host.renderRequested = true

proc ensureScene*(host: SingleSceneHost): bool =
  ## The current scene, resident: built on first use, handed the state its
  ## `setCurrentScene` carried, then told it is "open".
  if not host.scene.isNil:
    return true
  if host.sceneId.isNone:
    return false
  let sceneId = host.sceneId.get()
  let builtIn = isBuiltInScene(sceneId.string)
  if builtIn:
    # The scene switcher or the scene settings: drawn by the runtime,
    # nothing to parse, no state of its own to start from.
    host.exported = if sceneId.string == SceneSettingsId: sceneSettings.exportedScene
      else: sceneSwitcher.exportedScene
  else:
    let scenes = getInterpretedScenes()
    if not scenes.hasKey(sceneId):
      host.say("scene not found: " & sceneId.string)
      return false
    host.exported = scenes[sceneId]
  when defined(memProbe): memProbe("  SCENE INIT " & sceneId.string)
  var persisted = if host.initialState.isNil or builtIn: nil else: host.initialState(sceneId)
  if persisted.isNil:
    persisted = %*{}
  host.events.hostRun:
    host.scene = host.exported.init(sceneId, host.frameConfig, host.logger, persisted)
  when defined(memProbe): memProbe("  ensureScene: init done")
  host.say("scene \"" & host.sceneName & "\" initialized")
  # The order runner.nim keeps: the switch's state is applied (public fields
  # only, by the scene's own `setCurrentScene` handling), then "open".
  if host.pendingSwitchId == sceneId.string and not host.pendingSwitchPayload.isNil:
    try:
      host.runNow("setCurrentScene", host.pendingSwitchPayload)
    except Exception as e:
      host.say("setCurrentScene state failed: " & e.msg)
  host.pendingSwitchId = ""
  host.pendingSwitchPayload = nil
  host.lifecycle("open", %*{"sceneId": sceneId.string})
  true

# -------------------------------------------------------------- dispatcher

proc selectFromEvent(host: SingleSceneHost, payload: JsonNode): bool =
  ## `setCurrentScene`, as the dispatcher hands it over.
  let nextId = payload{"sceneId"}.getStr()
  if nextId.len == 0:
    return false
  if host.sceneId.isSome and host.sceneId.get().string == nextId:
    # The scene already showing: `state` is applied, nothing switches.
    if not hasStatePayload(payload) or host.scene.isNil:
      return false
    host.runNow("setCurrentScene", payload)
    return true
  if host.requestSelect.isNil or not host.requestSelect(nextId):
    host.say("setCurrentScene: scene not selectable: " & nextId)
    return false
  if hasStatePayload(payload):
    host.pendingSwitchId = nextId
    host.pendingSwitchPayload = copy(payload)
  true

proc start*(host: SingleSceneHost) =
  ## Builds the dispatcher around this host. Call once `frameConfig` and the
  ## platform's callbacks are set, and again after either changes.
  host.pendingSwitchId = ""
  host.pendingSwitchPayload = nil
  host.events = newEventLoop(EventHost(
    requestRender: proc () = host.renderRequested = true,
    selectScene: proc (payload: JsonNode): bool = host.selectFromEvent(payload),
    # The scene hears the event either way, switched or not.
    displayPower: proc (on: bool) =
      if not host.displayPower.isNil:
        host.displayPower(on),
    runtimeCommand: proc (command: RuntimeCommand, payload: JsonNode) =
      if not host.runtimeCommand.isNil:
        host.runtimeCommand(command, payload),
    sceneFor: proc (target: Option[SceneId]): FrameScene =
      # One resident scene: an event aimed at another one has nowhere to go.
      if target.isSome and (host.sceneId.isNone or target.get() != host.sceneId.get()):
        return nil
      host.scene,
    runScene: proc (scene: FrameScene, event: string, payload: JsonNode) =
      host.runOn(scene, event, payload),
    sceneListens: proc (scene: FrameScene, event: string): bool = sceneListensTo(scene, event),
    sceneOrder: host.sceneOrder,
    log: proc (entry: JsonNode) =
      if not host.logEntry.isNil:
        host.logEntry(entry),
  ), host.frameConfig)

proc send*(host: SingleSceneHost, origin: EventOrigin, event: string, payload: JsonNode): bool =
  ## One event from the platform: queued, and the queue drained before this
  ## returns (one task: nobody else will). False when it came to nothing.
  if host.events.isNil:
    host.say("event " & event & " dropped: runtime not ready")
    return false
  # The current scene is built on first use, and an event is a use: a
  # battery ESP32 reads the button that woke it before the first render, so
  # the press found no resident scene and was dropped ("dispatched": false).
  # Not for a scene switch: the dispatcher serves that without a scene, and
  # a switch queued for the wake (the backend's set_current_scene) would
  # otherwise build the scene it is leaving first — seconds of JavaScript
  # transpiling for a scene nobody sees.
  if event != "setCurrentScene":
    discard host.ensureScene()
  # No tick on the way in. A button edge the platform queued during a render
  # carries when it was seen (`atMs`), and the input state advances the holds
  # to that moment itself; ticking to now first turned a tap made during a
  # 30 s refresh into a 30 s long press before its release was delivered.
  # Time passes in `tick`, between events.
  host.events.dispatchNow(origin, event, payload)

proc tick*(host: SingleSceneHost): bool =
  ## Time passing with nothing sent: a held pointer or button becomes a long
  ## press (frameos/input_state.nim). The platform calls this from its idle
  ## loop; true when something came of it and a render may be wanted.
  if host.events.isNil:
    return false
  if host.events.tick() == 0:
    return false
  discard host.events.drain()
  true

proc queue*(host: SingleSceneHost, origin: EventOrigin, event: string, payload: JsonNode,
            target = none(SceneId)) =
  ## What the scene itself sends (channels.embeddedEventHook): queued, never run
  ## from inside the run that dispatched it. `send` and `renderScene` drain.
  if not host.events.isNil:
    host.events.enqueue(origin, event, payload, target)

proc renderScene*(host: SingleSceneHost, context: ExecutionContext): Image =
  ## One render pass of the resident scene, then whatever it (and an `init` or
  ## `open` before it) dispatched: delivered now that the run is over. A
  ## `render` among it is one more pass.
  host.events.hostRun:
    result = if host.exported.isNil: interpreter.render(host.scene, context)
      else: host.exported.render(host.scene, context)
  # No tick here either: a finger that went down before this render and
  # lifted during it has its release still in the platform's queue (the
  # ESP32's touch queue, the preview worker's messages), so ticking to now
  # made a tap held across a 750 ms render a `longPress`, and the release
  # no tap. The platform ticks once it has delivered what it queued.
  discard host.events.drain()
  # The scene is done with its JS apps until the next render. On a
  # deep-sleeping ESP32 that is a fresh boot away, and the next decode wants
  # the memory: they go. An ESP32 that stays awake keeps them while there is
  # room (keepJsRuntimes), and the next render skips building them again;
  # they still go for a decode, an image or a fill that finds memory short
  # (utils/memory.nim). The preview releases them while it runs as an ESP32,
  # so that an app keeping values in module variables misbehaves in the
  # editor rather than only on a sleeping frame; otherwise it keeps them, as
  # a Pi does.
  if runsAsEmbedded():
    discard settleIdleJsAppRuntimes(host.keepJsRuntimes)
