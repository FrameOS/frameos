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

import std/[json, monotimes, options, tables, times]
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
import ./render_probe
import ./ui/layout
import ./ui/tree
from ./utils/image import renderSvgIntoTarget
from ./utils/svg_frames import forgetPanelFrames
import pixie/fileformats/svg
import ./js_runtime/runtime as jsRuntime
import system/sceneSwitcher/scene as sceneSwitcher
import system/sceneSettings/scene as sceneSettings
from ./events import isSceneSettings
when defined(memProbe): import ./utils/memory

export event_loop

type
  WindowList* = object
    ## The scenes kept for windows, by id: two lists side by side, as there
    ## are a few at most (app_runtime.windowLimit). A table's generic code, or
    ## a list of pairs, costs the ESP32 more flash than the lookups ever save;
    ## lists of ids and of scenes reuse what the firmware has already.
    ids: seq[SceneId]
    scenes: seq[FrameScene]

proc len*(w: WindowList): int {.inline.} = w.ids.len

proc hasKey*(w: WindowList, id: SceneId): bool = w.ids.find(id) >= 0

proc getOrDefault*(w: WindowList, id: SceneId, default: FrameScene = nil): FrameScene =
  let i = w.ids.find(id)
  if i >= 0: w.scenes[i] else: default

proc `[]=`(w: var WindowList, id: SceneId, scene: FrameScene) =
  let i = w.ids.find(id)
  if i >= 0:
    w.scenes[i] = scene
  else:
    w.ids.add id
    w.scenes.add scene

proc del(w: var WindowList, id: SceneId) =
  let i = w.ids.find(id)
  if i >= 0:
    w.ids.delete(i)
    w.scenes.delete(i)

proc clear(w: var WindowList) =
  w.ids.setLen(0)
  w.scenes.setLen(0)

iterator keys*(w: WindowList): SceneId =
  for id in w.ids:
    yield id

iterator values*(w: WindowList): FrameScene =
  for scene in w.scenes:
    yield scene

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
    covered*: FrameScene
      ## The scene the scene switcher or the scene settings opened over, kept
      ## while there is room, and current again without its init when the
      ## way back leads to it: its JS interpreters, memo and laid-out tree
      ## are still there (they go on their own when memory is short, as any
      ## idle interpreter does). Closing the switcher rebuilt the scene from
      ## its JSON on an ESP32, ~250 ms of the SenseCAP Indicator's way back
      ## (2026-11-07). A Pi keeps every scene it showed; this keeps one.
    coveredExported: ExportedInterpretedScene
    coveredId: Option[SceneId]
    renderRequested*: bool
    discardNoticeUntil: int64
      ## A notice on the panel until then (monotonic ns): a scene lost its
      ## interpreter, and the tap that needed it did nothing
      ## (reportInterpreterDiscards).
    keepJsRuntimes*: bool
      ## Keep the scene's idle JS interpreters between renders while there is
      ## room (settleIdleJsAppRuntimes): an ESP32 that does not deep-sleep.
      ## The preview sets it while it runs as an ESP32 (wasm_main
      ## `frameos_wasm_set_embedded`): an awake frame's, the one you tap.
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
    windowed*: bool
      ## Runs the frame's scenes side by side, as a Pi's runner does
      ## (docs/scene-layouts.md "Windows"): a scene switched away from is
      ## kept in `windows`, a layout's `<Scene id>` is that kept scene, and
      ## the layout goes along from scene to scene. An ESP32 turns it on
      ## (embedded_runtime.nim), the wasm preview when asked
      ## (frameos_wasm_set_windowed).
    windows*: WindowList
      ## Every scene that ran and is not the resident one, while windowed.
    windowOrder: seq[SceneId]
      ## The frame's own scenes among `windows` (not the built-in ones), the
      ## one kept longest ago first: what goes first for another to run where
      ## only a few may (app_runtime.windowLimit).
    failedWindows: seq[SceneId]
      ## Scenes that could not start in a window, until the scenes change.
    refusedWindows: seq[SceneId]
      ## Scenes a layout asked for past the limit, said once.
    drawn: seq[SceneId]
      ## The windows drawn in this render pass.

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

var parkedLayout: FrameScene
  ## The layout of the scene dropped last, kept for the next scene that wears
  ## it (interpreter.nim takeParkedLayout): one at a time.

proc cleanupScene*(scene: FrameScene)

proc dropParkedLayout*() =
  ## New scenes arrived (the layout may be one of them, changed), or memory
  ## is short: the kept layout goes.
  if not parkedLayout.isNil:
    let layout = parkedLayout
    parkedLayout = nil
    cleanupScene(layout)

proc takeParked(layoutId: string): FrameScene {.nimcall.} =
  if not parkedLayout.isNil and parkedLayout.id.string == layoutId:
    result = parkedLayout
    parkedLayout = nil

takeParkedLayout = takeParked

proc cleanupScene*(scene: FrameScene) =
  ## Break ORC cycles and close the scene's QuickJS context before dropping
  ## the last reference (mirrors scenes.nim cleanupSceneRuntime, which lives
  ## outside these builds). The layout it wore is kept for the next scene.
  if not scene.isNil and not scene.wornLayout.isNil:
    let layout = scene.wornLayout
    scene.wornLayout = nil
    if layout != parkedLayout:
      dropParkedLayout()
      parkedLayout = layout
  if scene.isNil or not (scene of InterpretedFrameScene):
    return
  when defined(memProbe): memProbe("  cleanupScene: entry")
  let interpreted = InterpretedFrameScene(scene)
  for _, childScene in interpreted.sceneNodes:
    cleanupScene(childScene)
  rhythmReleaseScene(scene)
  forgetSceneGraph(interpreted)
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
  dropParkedLayout()
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

proc dropCovered*(host: SingleSceneHost) =
  ## Let go of the scene a built-in scene opened over.
  if not host.covered.isNil:
    cleanupScene(host.covered)
  host.covered = nil
  host.coveredExported = nil
  host.coveredId = none(SceneId)

proc roomToCover(): bool =
  ## Keep a covered scene down to the headroom idle interpreters are kept to
  ## between renders that decode nothing (utils/memory KeepInterpretersBytes;
  ## a host without a ceiling answers 0: room). A decode that finds memory
  ## short releases the interpreters first, as for any kept scene.
  let headroom = availableRenderHeadroomBytes()
  headroom <= 0 or headroom >= KeepInterpretersBytes

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

proc applyPendingSwitch(host: SingleSceneHost, sceneId: SceneId) =
  ## The state the switch to `sceneId` carried, applied to the resident scene
  ## (public fields only, by its own `setCurrentScene` handling), in the
  ## order runner.nim keeps: before "open". Then the switch is done.
  if host.pendingSwitchId == sceneId.string and not host.pendingSwitchPayload.isNil:
    try:
      host.runNow("setCurrentScene", host.pendingSwitchPayload)
    except Exception as e:
      host.say("setCurrentScene state failed: " & e.msg)
  host.pendingSwitchId = ""
  host.pendingSwitchPayload = nil

proc lifecycle*(host: SingleSceneHost, event: string, payload: JsonNode) =
  ## "open" and "close", sent the way runner.nim sends them: "open" when a
  ## scene becomes the current one, "close" when the host switches away from
  ## it. ("init" is the interpreter's own, fired by its init.) What a listener
  ## dispatches is queued, like from any other run.
  if not host.events.isNil:
    host.events.deliverLifecycle(host.scene, event, payload)

proc keepAsWindow(host: SingleSceneHost) =
  ## The resident scene is switched away from on a windowed host: it stays,
  ## in `windows`, and the layout it wore is parked for the next scene
  ## (runner.nim carryLayout). A built-in scene (the switcher, the
  ## settings) too, as the runner keeps it: a layout may show it in a
  ## window of its own, and it is opened afresh from the next scene.
  if host.scene.isNil:
    return
  let scene = host.scene
  if not scene.wornLayout.isNil:
    let layout = scene.wornLayout
    scene.wornLayout = nil
    if layout != parkedLayout:
      dropParkedLayout()
      parkedLayout = layout
  host.windows[scene.id] = scene
  if not isBuiltInScene(scene.id.string):
    host.windowOrder.add scene.id
  host.scene = nil
  host.exported = nil

proc forgetWindow(host: SingleSceneHost, sceneId: SceneId) =
  let at = host.windowOrder.find(sceneId)
  if at >= 0:
    host.windowOrder.delete(at)

proc takeWindow(host: SingleSceneHost, sceneId: SceneId): bool =
  ## The kept instance of `sceneId` made the resident one again, when there
  ## is one. An older copy of the parked layout it still wears goes, so it
  ## takes the parked one, with what it keeps (runner.nim carryLayout).
  let kept = host.windows.getOrDefault(sceneId, nil)
  if kept.isNil:
    return false
  host.windows.del(sceneId)
  host.forgetWindow(sceneId)
  host.scene = kept
  host.exported =
    if isSceneSettings(sceneId.string): sceneSettings.exportedScene
    elif sceneId.string == SceneSwitcherId: sceneSwitcher.exportedScene
    else: getInterpretedScenes().getOrDefault(sceneId, nil)
  if not kept.wornLayout.isNil and not parkedLayout.isNil and kept.wornLayout != parkedLayout and
      kept.wornLayout.id == parkedLayout.id:
    cleanupScene(kept.wornLayout)
    kept.wornLayout = nil
  true

proc dropWindows*(host: SingleSceneHost) =
  ## Let go of every kept scene: new scenes arrived, or the runtime restarts.
  for scene in host.windows.values:
    cleanupScene(scene)
  host.windows.clear()
  host.windowOrder.setLen(0)
  host.failedWindows.setLen(0)
  host.refusedWindows.setLen(0)
  host.drawn.setLen(0)

proc carryDesktop*(host: SingleSceneHost) =
  ## New scenes are coming: what the layout worn or parked kept (its windows,
  ## where) goes to its next instance (interpreter.carryLayoutState).
  if host.windowed:
    carryLayoutState(if not host.scene.isNil and not host.scene.wornLayout.isNil: host.scene else: parkedLayout)

proc openInLayout(host: SingleSceneHost, sceneId: SceneId): bool =
  ## Whether the desktop around the frame's scene has `sceneId` open: its
  ## `openScenes` (docs/scene-layouts.md "Windows"). Between two scenes, the
  ## layout parked for the next one.
  let layout = if host.scene.isNil: parkedLayout else: host.scene.wornLayout
  if layout.isNil or layout.state.isNil or layout.state.kind != JObject:
    return false
  let open = layout.state{"openScenes"}
  if open.isNil or open.kind != JArray:
    return false
  for id in open.elems:
    if id.kind == JString and id.str == sceneId.string:
      return true

proc keepsInWindow*(host: SingleSceneHost, sceneId: SceneId): bool =
  ## Whether a scene the frame leaves stays running, for a window: always
  ## where there is no limit, as on a Pi; where only a few run at once
  ## (app_runtime.windowLimit), while the desktop around it has it open.
  windowLimit() <= 0 or host.openInLayout(sceneId)

proc desktopShown(host: SingleSceneHost): bool =
  ## The frame's scene wears a desktop: a layout with scenes open.
  let layout = if host.scene.isNil: parkedLayout else: host.scene.wornLayout
  if not layout.isNil and not layout.state.isNil and layout.state.kind == JObject:
    let open = layout.state{"openScenes"}
    result = not open.isNil and open.kind == JArray and open.len > 0

proc followDesktop(host: SingleSceneHost) =
  ## Where only a few scenes run at once, the built-in scenes stay open for a
  ## window (`builtInScenesStay`) while a desktop shows: a frame without one
  ## keeps its one scene and its one settings, as it always did.
  if host.windowed and windowLimit() > 0:
    builtInScenesStay = host.desktopShown()

proc dropWindow(host: SingleSceneHost, sceneId: SceneId) =
  let scene = host.windows.getOrDefault(sceneId, nil)
  host.windows.del(sceneId)
  host.forgetWindow(sceneId)
  cleanupScene(scene)

proc trimWindows(host: SingleSceneHost) =
  ## After a pass, where only a few scenes run at once: a kept window that
  ## the desktop around the frame's scene does not have open, and that was
  ## not drawn, goes. With no desktop around it, every one.
  if not host.windowed or host.windows.len == 0 or windowLimit() <= 0:
    return
  var gone: seq[SceneId]
  for id in host.windows.keys:
    if id notin host.drawn and not host.openInLayout(id):
      gone.add id
  for id in gone:
    host.dropWindow(id)

proc makeRoom(host: SingleSceneHost, forced: bool): bool =
  ## Room for one more of the frame's scenes to run, where only so many may at
  ## once (app_runtime.windowLimit; the one in front counts, a built-in scene
  ## does not). A kept window goes for it: first one the desktop no longer
  ## has open and that was not drawn in this pass, the one kept longest ago
  ## first; `forced` (a scene brought to the front), else the one kept
  ## longest ago. False when nothing could go: the scene does not start.
  let limit = windowLimit()
  if limit <= 0:
    return true
  var over = host.windowOrder.len + 1 - limit
  if not host.scene.isNil and host.sceneId.isSome and not isBuiltInScene(host.sceneId.get().string):
    inc over
  for anyOne in [false, forced]:
    var i = 0
    while over > 0 and i < host.windowOrder.len:
      let id = host.windowOrder[i]
      if anyOne or id notin host.drawn and not host.openInLayout(id):
        host.say("scene " & id.string & " let go: " & $limit & " run at once")
        host.dropWindow(id)
        dec over
      else:
        inc i
  over <= 0

proc startScene(host: SingleSceneHost, sceneId: SceneId, exported: ExportedInterpretedScene,
    persisted: bool): FrameScene =
  ## A new instance of `sceneId`, started with the state it kept (`persisted`:
  ## a built-in scene keeps none), in the host's run: the resident scene's
  ## and a window's alike.
  var state = if host.initialState.isNil or not persisted: nil else: host.initialState(sceneId)
  if state.isNil:
    state = %*{}
  host.events.hostRun:
    result = exported.init(sceneId, host.frameConfig, host.logger, state)

proc windowScene(host: SingleSceneHost, sceneId: SceneId): FrameScene =
  ## `hostSceneFor`: this host's instance of a scene, started if it has not
  ## run and there is room for it (makeRoom); a built-in scene only as it is
  ## (runner.nim windowScene).
  if host.sceneId == some(sceneId) and not host.scene.isNil:
    return host.scene
  result = host.windows.getOrDefault(sceneId, nil)
  if isBuiltInScene(sceneId.string) and not result.isNil and not result.state{"away"}.getBool():
    result = nil
  if not result.isNil:
    host.drawn.add sceneId
  if not result.isNil or isBuiltInScene(sceneId.string):
    return
  var scenes = getInterpretedScenes()
  if sceneId in host.failedWindows or scenes.hasKey(sceneId) and scenes[sceneId].isLayout:
    return nil
  if not scenes.hasKey(sceneId) and (host.sceneOrder.isNil or sceneId notin host.sceneOrder()):
    return nil
  if not host.makeRoom(forced = false):
    if sceneId notin host.refusedWindows:
      host.refusedWindows.add sceneId
      host.say("scene " & sceneId.string & " not started: " & $windowLimit() & " run at once")
    return nil
  if not scenes.hasKey(sceneId):
    # On an ESP32 a scene is on flash until it runs (embedded_runtime.nim).
    if sceneLoader.isNil or not sceneLoader(sceneId):
      return nil
    scenes = getInterpretedScenes()
    if not scenes.hasKey(sceneId) or scenes[sceneId].isLayout:
      return nil
  try:
    result = host.startScene(sceneId, scenes[sceneId], persisted = true)
    host.windows[sceneId] = result
    host.windowOrder.add sceneId
    host.drawn.add sceneId
    let refused = host.refusedWindows.find(sceneId)
    if refused >= 0:
      host.refusedWindows.delete(refused)
    host.say("scene \"" & scenes[sceneId].name & "\" initialized in a window")
  except Exception as e:
    # Once: a window does not try again on every pass until the scenes change.
    host.failedWindows.add sceneId
    host.say("scene " & sceneId.string & " could not start in a window: " & e.msg)
    return nil

proc loadedSceneListing*(order: seq[SceneId]): seq[SwitcherEntry] =
  ## The switcher's tiles and `app.frame.scenes` off the scenes held whole
  ## (the browser's payload, an ESP32 without a scene index), in `order`:
  ## each with its name, window size, icon and category.
  let scenes = getInterpretedScenes()
  for sceneId in order:
    var entry = SwitcherEntry(id: sceneId.string)
    let scene = scenes.getOrDefault(sceneId, nil)
    if not scene.isNil:
      entry.name = scene.name
      entry.windowSize = scene.windowSize
      entry.icon = scene.icon
      entry.category = scene.category
    result.add entry

proc setWindowed*(host: SingleSceneHost, enabled: bool) =
  ## Turn running scenes side by side on or off. On, a layout's
  ## `app.frame.scenes` lists the frame's scenes and its `<Scene id>` is this
  ## host's own instance of each (docs/scene-layouts.md "Windows").
  host.windowed = enabled
  builtInScenesStay = enabled
  host.followDesktop()
  if enabled:
    hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        host.windowScene(sceneId)
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        # The host's own list, the switcher's: an ESP32's catalog, whose
        # scenes are on flash until they run, or the browser's payload.
        result = newJArray()
        if not sceneSwitcherListing.isNil:
          for entry in sceneSwitcherListing():
            result.add listingItem(entry)
  else:
    hostSceneFor = nil
    windowSceneListing = nil
    host.dropWindows()

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
  if drop and host.windowed and (windowLimit() <= 0 or not host.scene.isNil and host.keepsInWindow(host.scene.id)):
    if host.sceneId != some(sceneId):
      host.keepAsWindow()
    host.sceneId = some(sceneId)
    host.renderRequested = true
    return
  if drop:
    let
      leaving = host.sceneId
      opensOver = isBuiltInScene(sceneId.string) and leaving.isSome and
        not isBuiltInScene(leaving.get().string) and not host.scene.isNil
    if opensOver and roomToCover():
      host.dropCovered()
      host.covered = host.scene
      host.coveredExported = host.exported
      host.coveredId = leaving
      host.scene = nil
      host.exported = nil
    else:
      host.dropScene()
  # The way back led somewhere else. Also when the old instance stays until the
  # firmware has read the new one from flash: left for later, it went when
  # memory ran short, in the middle of the next scene.
  if host.coveredId.isSome and host.coveredId.get() != sceneId and not isBuiltInScene(sceneId.string):
    host.dropCovered()
  host.sceneId = some(sceneId)
  host.renderRequested = true

proc switchLoaded*(host: SingleSceneHost, sceneId: SceneId) =
  ## An ESP32's switch to a scene its firmware just read off flash
  ## (embedded_runtime.loadScene) on a desktop: the switch `makeCurrent`
  ## makes, from the scene in front, which stays in its window.
  if not host.scene.isNil:
    host.sceneId = some(host.scene.id)
  host.makeCurrent(sceneId)

proc ensureScene*(host: SingleSceneHost): bool =
  ## The current scene, resident: built on first use, handed the state its
  ## `setCurrentScene` carried, then told it is "open".
  if not host.scene.isNil:
    return true
  if host.sceneId.isNone:
    return false
  let sceneId = host.sceneId.get()
  if host.coveredId == some(sceneId) and not host.covered.isNil:
    # Back from the switcher or the settings to the scene they covered: the
    # same instance, told it is current again. A switch that carried state
    # applies it as it would to a fresh one.
    host.scene = host.covered
    host.exported = host.coveredExported
    host.covered = nil
    host.coveredExported = nil
    host.coveredId = none(SceneId)
    host.applyPendingSwitch(sceneId)
    host.lifecycle("open", %*{"sceneId": sceneId.string})
    return true
  if host.windowed and host.takeWindow(sceneId):
    # The scene it was in a window, or when it was left: the same one,
    # brought forward. A switch that carried state applies it.
    host.applyPendingSwitch(sceneId)
    wearLayout(host.scene)
    host.lifecycle("open", %*{"sceneId": sceneId.string})
    return true
  let builtIn = isBuiltInScene(sceneId.string)
  if builtIn:
    # The scene switcher or the scene settings: drawn by the runtime,
    # nothing to parse, no state of its own to start from.
    # A scene's own settings on a desktop too (event_loop.settingsWindows).
    host.exported = if isSceneSettings(sceneId.string): sceneSettings.exportedScene
      else: sceneSwitcher.exportedScene
  else:
    let scenes = getInterpretedScenes()
    if not scenes.hasKey(sceneId):
      host.say("scene not found: " & sceneId.string)
      return false
    host.exported = scenes[sceneId]
    # Brought to the front where only so many run at once: the window kept
    # longest ago goes first.
    if host.windowed:
      discard host.makeRoom(forced = true)
  when defined(memProbe): memProbe("  SCENE INIT " & sceneId.string)
  host.scene = host.startScene(sceneId, host.exported, persisted = not builtIn)
  when defined(memProbe): memProbe("  ensureScene: init done")
  host.say("scene \"" & host.sceneName & "\" initialized")
  # The order runner.nim keeps: the switch's state is applied (public fields
  # only, by the scene's own `setCurrentScene` handling), then "open".
  host.applyPendingSwitch(sceneId)
  if host.windowed:
    wearLayout(host.scene)
  host.lifecycle("open", %*{"sceneId": sceneId.string})
  true

proc reopenBuiltIn*(host: SingleSceneHost, state: JsonNode): bool =
  ## The current built-in scene (the switcher, the settings) opened again as
  ## it was left, on a host whose memory is its control plane's: the wasm
  ## runtime rendering for a frame, a fresh process per pull
  ## (docs/server-rendering.md, "Keys, touch and the schedule"). The switch
  ## that opened it is replayed with the state it kept (what it was opened
  ## from, the layout, the settings' fields), then the rest of that state
  ## (the highlight, the page, the form's values) is put back over what
  ## opening it set. No device host calls this: a device never keeps a
  ## built-in scene. False when the current scene is not a built-in one, is
  ## resident already, or `state` is not an object.
  if host.sceneId.isNone or not isBuiltInScene(host.sceneId.get().string) or not host.scene.isNil:
    return false
  if state.isNil or state.kind != JObject:
    return false
  let sceneId = host.sceneId.get().string
  host.pendingSwitchId = sceneId
  host.pendingSwitchPayload = %*{"sceneId": sceneId, "state": copy(state)}
  if not host.ensureScene() or host.scene.isNil:
    return false
  if host.scene.state.isNil or host.scene.state.kind != JObject:
    host.scene.state = newJObject()
  for key, value in state:
    host.scene.state[key] = copy(value)
  true

# -------------------------------------------------------------- dispatcher

proc selectFromEvent(host: SingleSceneHost, payload: JsonNode): bool =
  ## `setCurrentScene`, as the dispatcher hands it over.
  let nextId = payload{"sceneId"}.getStr()
  if nextId.len == 0:
    # A built-in scene closing with no scene to go back to (event_loop.nim
    # builtInScene; an ESP32 given none yet): back to no scene, the status
    # screen. Nothing for the firmware to load or persist.
    if host.sceneId.isNone or not isBuiltInScene(host.sceneId.get().string):
      return false
    host.lifecycle("close", %*{})
    host.dropScene()
    host.sceneId = none(SceneId)
    host.renderRequested = true
    return true
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
        # Windowed: the scene in its window.
        if host.windowed:
          return host.windows.getOrDefault(target.get(), nil)
        return nil
      # Windowed, a switch is only a change of focus, the scene running
      # already: it is here at once, so what was queued behind the switch (a
      # layout's two commands, a `sceneSettings` from the scene now in
      # front) finds it, as on a Pi. Not without a desktop where only a few
      # run (an ESP32): a switch queued for the wake would build the scene it
      # leaves.
      if host.windowed and host.scene.isNil and builtInScenesStay:
        discard host.ensureScene()
      host.scene,
    runScene: proc (scene: FrameScene, event: string, payload: JsonNode) =
      host.runOn(scene, event, payload),
    sceneListens: proc (scene: FrameScene, event: string): bool = sceneListensTo(scene, event),
    sceneOrder: host.sceneOrder,
    keyboardAt: proc (x, y: int): bool =
      host.sceneId.isSome and sceneKeyboardAt(host.sceneId.get(), x, y),
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

proc drainQueued*(host: SingleSceneHost): bool =
  ## What the scene's async code dispatched between renders (a `render` when
  ## a picture or an answer came, docs/async-js.md): delivered now, by the
  ## platform's idle loop after the pump. Nothing else sends while it idles,
  ## so it sat in the queue until the next tap. True when something was.
  not host.events.isNil and host.events.drain() > 0

proc queue*(host: SingleSceneHost, origin: EventOrigin, event: string, payload: JsonNode,
            target = none(SceneId)) =
  ## What the scene itself sends (channels.embeddedEventHook): queued, never run
  ## from inside the run that dispatched it. `send` and `renderScene` drain.
  if not host.events.isNil:
    host.events.enqueue(origin, event, payload, target)

const
  DiscardNoticeNanos = 6_000_000_000'i64
  DiscardNoticeText = "Low memory: this scene was reloaded. Please tap again."

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc drawDiscardNotice(image: Image) =
  ## A strip along the bottom of the picture. Drawn with the JSX layout, as
  ## the built-in scenes are: no fonts or text code of its own.
  let height = clamp(image.height div 12, 28, 64)
  var classes = "flex items-center justify-center w-full h-full bg-black text-white"
  classes.px("text", height div 2 - 2)
  try:
    let strip = image.view(0, image.height - height, image.width, height)
    discard renderSvgIntoTarget(layoutUi(el("div", classes, SvgNode(text: DiscardNoticeText)), image.width, height), strip)
  except CatchableError:
    discard # a notice is not worth a render
  # Nothing about what these buffers hold can be trusted now: the next pass
  # draws everything, the strip's pixels included.
  rhythmForgetCanvases()
  forgetPanelFrames()

proc reportInterpreterDiscards*(host: SingleSceneHost, context: ExecutionContext, image: Image) =
  ## What became of the JS interpreters this render: a scene whose interpreter
  ## goes keeps its picture and stops answering, and without this nobody would
  ## know why. The frame's log says each one, and when it cost a UI its tap
  ## handlers the panel says so too.
  let now = getMonoTime().ticks
  let discarded = takeInterpreterDiscards()
  if discarded.count > 0:
    if discarded.heldHandlers:
      host.discardNoticeUntil = now + DiscardNoticeNanos
    host.logger.log(%*{"event": "js:interpreterDiscarded", "sceneId": discarded.sceneId,
      "reason": discarded.reason, "count": discarded.count, "freeBytes": availableRenderHeadroomBytes()})
  if now < host.discardNoticeUntil and not image.isNil:
    drawDiscardNotice(image)
    # The pass that takes the notice away.
    let left = (host.discardNoticeUntil - now).float / 1e9
    if context.nextSleep < 0 or context.nextSleep > left:
      context.nextSleep = left

{.pop.}

proc renderScene*(host: SingleSceneHost, context: ExecutionContext): Image =
  ## One render pass of the resident scene, then whatever it (and an `init` or
  ## `open` before it) dispatched: delivered now that the run is over. A
  ## `render` among it is one more pass.
  host.drawn.setLen(0)
  host.events.hostRun:
    result = if host.exported.isNil: interpreter.render(host.scene, context)
      else: host.exported.render(host.scene, context)
  # No tick here either: a finger that went down before this render and
  # lifted during it has its release still in the platform's queue (the
  # ESP32's touch queue, the preview worker's messages), so ticking to now
  # made a tap held across a 750 ms render a `longPress`, and the release
  # no tap. The platform ticks once it has delivered what it queued.
  let settleStart = getMonoTime()
  discard host.events.drain()
  host.trimWindows()
  host.followDesktop()
  # The scene is done with its JS apps until the next render. On a
  # deep-sleeping ESP32 that is a fresh boot away, and the next decode wants
  # the memory: they go. An ESP32 that stays awake keeps them while there is
  # room (keepJsRuntimes), and the next render skips building them again;
  # they still go for a decode, an image or a fill that finds memory short
  # (utils/memory.nim). The preview keeps them as an awake ESP32 does while
  # it runs as one (under its simulated memory limit), and as a Pi does
  # otherwise.
  if runsAsEmbedded():
    discard settleIdleJsAppRuntimes(host.keepJsRuntimes)
    # A covered scene holds more than its interpreters (its nodes' images):
    # it goes when render memory is short, or on a frame that keeps nothing.
    if not host.covered.isNil and (not host.keepJsRuntimes or not roomToCover()):
      host.dropCovered()
    host.reportInterpreterDiscards(context, result)
  if probeOn:
    probeAdd(phSettle, (getMonoTime() - settleStart).inNanoseconds)
