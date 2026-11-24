import std/[json, monotimes, options, os, strutils, tables]
import ../channels
import ../driver_abi
import ../event_loop
import ../events
import ../input_state
import ../interpreter
import ../layout_choice
import ../scene_code_hooks
import ../scene_store_hooks
import ../types
import system/sceneSwitcher/scene as sceneSwitcher
import system/sceneSettings/scene as sceneSettings

# The runner of docs/event-fixtures.json's `dispatcher` section: the shared
# dispatcher (event_loop.nim) with a recording host around the real
# interpreter. What is held here holds on every host, because the Linux runner,
# the ESP32 runtime and the wasm preview all compile this one module and supply
# nothing but an `EventHost` — queueing, the origin allow-list, the
# command/event split and the render rule are not theirs to have opinions on.
#
# "Add a case there first; a runner that disagrees is the bug."

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "event-fixtures.json"
let fixtures = parseFile(fixturesPath)

proc originOf(name: string): EventOrigin =
  for origin in EventOrigin:
    if $origin == name:
      return origin
  doAssert false, "unknown origin in fixtures: " & name

proc testConfig(): FrameConfig =
  FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)

proc testLogger(config: FrameConfig, sink: ref seq[JsonNode]): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    sink[].add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

type RecordingHost = ref object
  ## What a host is, reduced to what the dispatcher can see of it.
  config: FrameConfig
  logger: Logger
  scenes: Table[SceneId, FrameScene]
  current: SceneId
  order: seq[SceneId] ## the case's scene list, in its order (`setCurrentScene {direction}`)
  trace: seq[string]
  pinned: seq[string] ## `run` lines the step pins with their payload
  loop: EventLoop

proc sceneName(scene: FrameScene): string =
  ## Its id's last part; a scene's own settings window, `sceneSettings#` and
  ## its scene's.
  let owner = settingsWindowScene(scene.id.string)
  if owner.len > 0: "sceneSettings#" & owner.rsplit("/", maxsplit = 1)[^1]
  else: scene.id.string.rsplit("/", maxsplit = 1)[^1]

proc builtIn(sceneId: string): ExportedInterpretedScene =
  ## The runtime's own scene at `sceneId`, as every host picks it.
  if isSceneSettings(sceneId): sceneSettings.exportedScene
  else: sceneSwitcher.exportedScene

proc sceneInstance(host: RecordingHost, sceneId: SceneId): FrameScene =
  if not host.scenes.hasKey(sceneId):
    host.loop.hostRun:
      # The scene switcher is the runtime's own, built by its export as every
      # host builds it (scenes.nim's system scenes, single_scene_host).
      host.scenes[sceneId] =
        if isBuiltInScene(sceneId.string): builtIn(sceneId.string).init(sceneId, host.config, host.logger, %*{})
        else: init(sceneId, host.config, host.logger, %*{})
  host.scenes[sceneId]

proc runOn(scene: FrameScene, event: string, payload: JsonNode) =
  let context = ExecutionContext(scene: scene, event: event, payload: payload,
    hasImage: false, loopIndex: 0, loopKey: ".")
  if isBuiltInScene(scene.id.string): builtIn(scene.id.string).runEvent(scene, context)
  else: runEvent(scene, context)

# The scene switcher's tiles: the running case's scene list, as each host
# lists the scenes `setCurrentScene {direction}` walks.
var caseOrder: seq[SceneId]
sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    for sceneId in caseOrder:
      result.add SwitcherEntry(id: sceneId.string, name: sceneId.string)

proc newRecordingHost(sceneId: SceneId, logs: ref seq[JsonNode]): RecordingHost =
  let host = RecordingHost(config: testConfig(), current: sceneId, scenes: initTable[SceneId, FrameScene]())
  host.logger = testLogger(host.config, logs)
  host.loop = newEventLoop(EventHost(
    requestRender: proc () = host.trace.add("render"),
    selectScene: proc (payload: JsonNode): bool =
      let next = payload{"sceneId"}.getStr().SceneId
      if next.string.len == 0 and isBuiltInScene(host.current.string):
        # A built-in scene let go with nothing to go back to: no scene, as
        # single_scene_host.nim does on an ESP32 given none yet.
        host.trace.add("select none")
        host.loop.deliverLifecycle(host.sceneInstance(host.current), "close", %*{})
        host.current = SceneId("")
        return true
      if not getInterpretedScenes().hasKey(next) and not getUploadedInterpretedScenes().hasKey(next) and
          not isBuiltInScene(next.string):
        host.trace.add("select " & next.string & " failed")
        return false
      if next == host.current:
        return false
      host.trace.add("select " & next.string)
      if host.current.string.len > 0:
        host.loop.deliverLifecycle(host.sceneInstance(host.current), "close", %*{})
      host.current = next
      # The switch's `state`, before "open", as runner.nim and
      # single_scene_host.nim hand it over.
      if hasStatePayload(payload):
        host.loop.host.runScene(host.sceneInstance(next), "setCurrentScene", payload)
      host.loop.deliverLifecycle(host.sceneInstance(next), "open", %*{"sceneId": next.string})
      true,
    displayPower: proc (on: bool) = host.trace.add("power " & (if on: "on" else: "off")),
    runtimeCommand: proc (command: RuntimeCommand, payload: JsonNode) = host.trace.add("command " & $command),
    sceneFor: proc (target: Option[SceneId]): FrameScene =
      let sceneId = if target.isSome: target.get() else: host.current
      # A case with no scene (`"scene": ""`): a frame given none yet.
      if sceneId.string.len == 0: nil else: host.sceneInstance(sceneId),
    runScene: proc (scene: FrameScene, event: string, payload: JsonNode) =
      let line = "run " & sceneName(scene) & " " & event
      let pinned = line & " " & $payload
      host.trace.add(if pinned in host.pinned: pinned else: line)
      runOn(scene, event, payload),
    # Input reaches a scene only under the names it listens for (runner.nim and
    # single_scene_host.nim answer the same way): a `run` line is a listener.
    sceneListens: proc (scene: FrameScene, event: string): bool = sceneListensTo(scene, event),
    sceneOrder: proc (): seq[SceneId] = host.order,
    keyboardAt: proc (x, y: int): bool = sceneKeyboardAt(host.current, x, y),
    log: proc (entry: JsonNode) =
      if entry{"event"}.getStr() == "event:refused":
        host.trace.add("refused " & entry["name"].getStr() & " " & entry["origin"].getStr() & " " &
          entry["reason"].getStr())
      elif entry{"event"}.getStr() == "event:mapped":
        # "mapped frame button -> setCurrentScene", "mapped scene button"
        var line = "mapped " & entry["scope"].getStr() & " " & entry["name"].getStr()
        if entry.hasKey("emit"):
          line.add(" -> " & entry["emit"].getStr())
        host.trace.add(line),
  ), host.config)
  # On the thread that owns a dispatcher, a scene's dispatch goes straight into
  # its queue (channels.nim) — as on the runner thread.
  let loop = host.loop
  localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
    {.cast(gcsafe).}:
      loop.enqueue(origin, event, payload, scene)
  host

block dispatcher:
  var allScenes = newJArray()
  for c in fixtures["dispatcher"]["cases"]:
    for scene in c["scenes"]:
      allScenes.add(scene)
  setUploadedInterpretedScenes(buildInterpretedScenes(parseInterpretedSceneInputs($allScenes)))
  resetInterpretedScenes()

  var ran = 0
  for c in fixtures["dispatcher"]["cases"]:
    let name = c["name"].getStr()
    let logs = new(seq[JsonNode])
    chooseLayout("") # safe mode's case writes the frame's own choice
    let host = newRecordingHost(c["scene"].getStr().SceneId, logs)
    for scene in c["scenes"]:
      host.order.add(scene["id"].getStr().SceneId)
    caseOrder = host.order
    # The frame's own event map (frame.json `eventMap`), when the case has one.
    host.config.eventMap = c{"frameEventMap"}
    # A host whose built-in scenes stay open as windows (a desktop layout).
    builtInScenesStay = c{"windows"}.getBool()
    if host.current.string.len > 0:
      discard host.sceneInstance(host.current)
    discard host.loop.drain() # what `init` dispatched is not this case's subject
    for index, step in c["steps"].getElems():
      let where = name & ", step " & $(index + 1)
      host.trace.setLen(0)
      host.pinned.setLen(0)
      if step.hasKey("trace"):
        for line in step["trace"]:
          if line.getStr().startsWith("run ") and line.getStr().count(' ') > 2:
            host.pinned.add(line.getStr())

      var handled = 0
      if step{"renderPass"}.getBool():
        let scene = host.sceneInstance(host.current)
        host.trace.add("pass " & sceneName(scene))
        host.loop.hostRun:
          runEvent(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
            hasImage: false, loopIndex: 0, loopKey: "."))
      else:
        for send in step["send"]:
          host.loop.enqueue(originOf(send["origin"].getStr()), send["event"].getStr(),
            (if send{"payload"}.isNil: %*{} else: copy(send["payload"])))
      handled = host.loop.drain(step{"budget"}.getInt(DefaultDrainBudget))

      if step.hasKey("trace"):
        var expected: seq[string]
        for line in step["trace"]:
          expected.add(line.getStr())
        doAssert host.trace == expected, where & ":\n  got      " & $host.trace & "\n  expected " & $expected
      if step.hasKey("handled"):
        doAssert handled == step["handled"].getInt(), where & ": drained " & $handled
      if step.hasKey("pending"):
        doAssert host.loop.pending == step["pending"].getInt(), where & ": " & $host.loop.pending & " still queued"
      if step.hasKey("current"):
        doAssert host.current.string == step["current"].getStr(), where & ": current scene is " & host.current.string
      if step.hasKey("state"):
        let state = host.sceneInstance(host.current).state
        for key, value in step["state"]:
          if value.kind == JNull:
            doAssert not state.hasKey(key), where & ": state." & key & " is set: " & $state
          else:
            doAssert state{key} == value, where & ": state." & key & " = " & $state{key}
    # Leave nothing queued for the next case's loop to be blamed for.
    localEventSink = nil
    builtInScenesStay = false
    inc ran
  doAssert ran >= 10

# ---------------------------------------------------------- the queue itself

block dispatch_now_reports_what_came_of_it:
  let logs = new(seq[JsonNode])
  let host = newRecordingHost("fixtures/dispatcher/command".SceneId, logs)
  doAssert host.loop.dispatchNow(eoHttpAdmin, "reload", %*{})
  doAssert not host.loop.dispatchNow(eoHttpWrite, "reload", %*{}), "a refused event came to nothing"
  doAssert not host.loop.dispatchNow(eoHttpWrite, "setCurrentScene", %*{"sceneId": "fixtures/dispatcher/nowhere"})
  localEventSink = nil

block the_frame_page_is_withheld_from_a_run_on_the_access_keys_event:
  # The HTTP write door (origin `http:write`: the frame access key, `public`
  # access) is for scenes. While a scene runs on an event from it the frame
  # offers no page (frame_settings_hooks.nim): the hooks every reader asks
  # are nil, so neither the frame page nor an app with `frameos.frame` (a
  # terminal) restarts, updates or re-joins the frame on what the key sent.
  # Any other origin runs with the page as the host offers it.
  let logs = new(seq[JsonNode])
  let host = newRecordingHost("fixtures/dispatcher/voiceKey".SceneId, logs)
  discard host.sceneInstance(host.current)
  discard host.loop.drain()
  frameSettingsRead = proc (): JsonNode {.nimcall, gcsafe, raises: [].} = newJObject()
  frameSettingsApply = proc (changes: JsonNode) {.nimcall, gcsafe, raises: [].} = discard
  frameSettingsAction = proc (action: string) {.nimcall, gcsafe, raises: [].} = discard
  sceneCode = proc (asker, op, arg: string): string {.nimcall, gcsafe, raises: [].} = ""
  sceneStoreAction = proc (asker, action, args: string) {.nimcall, gcsafe, raises: [].} = discard
  var offered: seq[bool]
  let run = host.loop.host.runScene
  host.loop.host.runScene = proc (scene: FrameScene, event: string, payload: JsonNode) =
    offered.add(not frameSettingsRead.isNil and not frameSettingsApply.isNil and not frameSettingsAction.isNil)
    # The code host and the store's actions go with the page.
    doAssert sceneCode.isNil == frameSettingsRead.isNil
    doAssert sceneStoreAction.isNil == frameSettingsRead.isNil
    doAssert framePageWithheld == frameSettingsRead.isNil
    run(scene, event, payload)
  for origin in [eoHttpWrite, eoDriver, eoHttpAdmin, eoHttpWrite]:
    host.loop.enqueue(origin, "button", %*{"label": "REFRESH", "action": "press"})
    discard host.loop.drain()
  doAssert offered == @[false, true, true, false], $offered
  # Back as they were once the run is over...
  doAssert not framePageWithheld
  doAssert not frameSettingsRead.isNil and not frameSettingsApply.isNil and not frameSettingsAction.isNil
  # ...and after a run that never came back (an ESP32's out-of-memory abort
  # jumps over every `finally`): the host's recovery puts them back.
  withholdFramePage()
  doAssert frameSettingsRead.isNil
  host.loop.resetAfterAbort()
  doAssert not framePageWithheld and not frameSettingsRead.isNil
  doAssert not sceneCode.isNil and not sceneStoreAction.isNil
  frameSettingsRead = nil
  frameSettingsApply = nil
  frameSettingsAction = nil
  sceneCode = nil
  sceneStoreAction = nil
  localEventSink = nil

block a_payload_is_an_object:
  # `payload{"state"}` is nil without the key, and `.kind` on nil took an ESP32
  # down on the bench (a scene's setCurrentScene carries no state). Hosts ask
  # hasStatePayload; and a payload that is not an object never reaches them.
  doAssert not hasStatePayload(nil)
  doAssert not hasStatePayload(%*{"sceneId": "a"})
  doAssert not hasStatePayload(%*{"state": "text"})
  doAssert not hasStatePayload(%*[1, 2])
  doAssert hasStatePayload(%*{"sceneId": "a", "state": {}})
  let logs = new(seq[JsonNode])
  let host = newRecordingHost("fixtures/dispatcher/lanes".SceneId, logs)
  host.pinned = @["""run lanes button {"pin":-1,"label":"","role":"","action":"press"}"""]
  host.loop.enqueue(eoHttpWrite, "button", %*[1, 2, 3])
  host.loop.enqueue(eoHttpWrite, "setCurrentScene", %*"fixtures/dispatcher/command")
  discard host.loop.drain()
  # (the main lane runs ahead of input; a button with nothing in it is a press of pin -1)
  doAssert host.trace == @["select  failed", """run lanes button {"pin":-1,"label":"","role":"","action":"press"}"""], $host.trace
  localEventSink = nil

block the_hosts_keyboard_reaches_the_input_state:
  # Where the host says its keyboard on the screen is, a press at the edge is
  # a key at once, not held for an edge swipe (input_state.nim).
  let loop = newEventLoop(EventHost(keyboardAt: proc (x, y: int): bool = y >= 300),
    FrameConfig(width: 480, height: 480, rotate: 0, scalingMode: "cover", saveAssets: %*false))
  var output: seq[InputDelivery]
  let right = PointerWireMax - 10
  discard loop.inputState.applyNamedInput("pointerDown", %*{"x": right, "y": PointerWireMax - 10,
    "pointerId": 1, "pointerType": "touch", "button": 0, "buttons": 1}, eoDriver, getMonoTime(), output)
  doAssert output.len == 1 and output[0].name == "pointerDown", $output.len
  output.setLen(0)
  discard loop.inputState.applyNamedInput("pointerDown", %*{"x": right, "y": 10,
    "pointerId": 2, "pointerType": "touch", "button": 0, "buttons": 1}, eoDriver, getMonoTime(), output)
  doAssert output.len == 0, "above it, the edge holds the press"

block a_full_lane_drops_and_counts:
  let logs = new(seq[JsonNode])
  let host = newRecordingHost("fixtures/dispatcher/lanes".SceneId, logs)
  host.loop.laneCapacity = 3
  for i in 0 ..< 5:
    host.loop.enqueue(eoDriver, "gpio", %*{"pin": i, "label": "A", "level": 0})
  doAssert host.loop.pending == 3
  doAssert host.loop.dropped == 2
  # A move still coalesces into a full lane: it takes the slot of the move before it.
  discard host.loop.drain()
  for i in 0 ..< 3:
    host.loop.enqueue(eoDriver, "mouseMove", %*{"x": i, "y": i})
  doAssert host.loop.pending == 1
  localEventSink = nil

block a_long_wait_keeps_the_drags_shape_in_bounded_points:
  # A drag that piles up while a scene is busy: every move it replaced is in
  # `points`, thinned past MovePointsMax pairs, the newest kept.
  let logs = new(seq[JsonNode])
  let host = newRecordingHost("fixtures/dispatcher/points".SceneId, logs)
  for i in 0 ..< 200:
    host.loop.enqueue(eoDriver, "pointerMove", %*{"x": i * 100, "y": 0, "pointerId": 1, "pointerType": "touch"})
  doAssert host.loop.pending == 1
  let payload = host.loop.inputLaneForTest()[0].payload
  let points = payload["points"]
  doAssert points.len div 2 <= MovePointsMax and points.len div 2 > MovePointsMax div 2, $points.len
  doAssert points[0].getInt() == 0 # the first move stays
  doAssert points[^2].getInt() == 199 * 100 - 100 # the one before this move stays
  var last = -1
  for i in 0 ..< points.len div 2:
    doAssert points[2 * i].getInt() > last # in order, oldest first
    last = points[2 * i].getInt()
  discard host.loop.drain()
  localEventSink = nil

when not defined(frameosEmbedded):
  block a_drivers_coalesced_moves_carry_their_positions:
    # The Linux evdev path: structs, no JSON until delivery.
    let loop = newEventLoop(EventHost(), FrameConfig(width: 800, height: 480, rotate: 0, scalingMode: "cover",
      saveAssets: %*false))
    for i in 0 ..< 4:
      loop.enqueueInput(eoDriver, DriverInputEvent(kind: ord(dikPointerAbs).cint, pointerId: 1,
        pointerType: ord(dptTouch).cint, x: cint(PointerWireMax div 8 * (i + 1)), y: cint(PointerWireMax div 2)))
    doAssert loop.pending == 1
    let envelope = loop.inputLaneForTest()[0]
    doAssert envelope.trail.len == 6
    var output: seq[InputDelivery]
    loop.inputState.applyDriverInput(envelope.input, eoDriver, getMonoTime(), output, envelope.trail)
    doAssert output.len == 1 and output[0].name == "pointerMove"
    doAssert output[0].payload["x"].getInt() == 399
    doAssert output[0].payload["points"] == %*[99, 239, 199, 239, 299, 239], $output[0].payload

echo "test_event_loop: ok"
