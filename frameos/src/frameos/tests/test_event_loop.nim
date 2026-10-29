import std/[json, monotimes, options, os, strutils, tables]
import ../channels
import ../event_loop
import ../events
import ../input_state
import ../interpreter
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
  scene.id.string.rsplit("/", maxsplit = 1)[^1]

proc builtIn(sceneId: string): ExportedInterpretedScene =
  ## The runtime's own scene at `sceneId`, as every host picks it.
  if sceneId == SceneSettingsId: sceneSettings.exportedScene else: sceneSwitcher.exportedScene

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
      if not getInterpretedScenes().hasKey(next) and not getUploadedInterpretedScenes().hasKey(next) and
          not isBuiltInScene(next.string):
        host.trace.add("select " & next.string & " failed")
        return false
      if next == host.current:
        return false
      host.trace.add("select " & next.string)
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
      host.sceneInstance(if target.isSome: target.get() else: host.current),
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
    let host = newRecordingHost(c["scene"].getStr().SceneId, logs)
    for scene in c["scenes"]:
      host.order.add(scene["id"].getStr().SceneId)
    caseOrder = host.order
    # The frame's own event map (frame.json `eventMap`), when the case has one.
    host.config.eventMap = c{"frameEventMap"}
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

echo "test_event_loop: ok"
