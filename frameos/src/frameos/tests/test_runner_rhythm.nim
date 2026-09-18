import std/[json, options, tables, asyncdispatch, unittest, strutils]
import pixie
import ../config
import ../interpreter
import ../runner
import ../scenes
import ../types
import ../channels

# The render loop on scene rhythm (frameos/scene_rhythm.nim): a split of a
# fast clock and a slow photo wakes for the clock, runs only the clock, and
# never lets what goes to the driver (flip, overlays) back into the canvas the
# next pass builds on.

type LogStore = ref object
  entries: seq[JsonNode]

proc testLogger(config: FrameConfig, store: LogStore): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    # Unconditionally: the loop pauses scene logs when it renders this fast,
    # and these tests are about exactly those passes.
    store.entries.add(payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc clearEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok: break

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc colorChild(name, hex: string, interval: float): ExportedInterpretedScene =
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: interval, publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/color", "config": {"color": hex}}),
    ],
    edges: @[edge(1, 1, "next", 2, "prev")],
    apps: %*{}, init: init, render: render, runEvent: runEvent)

let
  clockId = "tests/runner-rhythm/clock".SceneId
  photoId = "tests/runner-rhythm/photo".SceneId
  splitId = "tests/runner-rhythm/split".SceneId

var uploaded = initTable[SceneId, ExportedInterpretedScene]()
uploaded[clockId] = colorChild("Clock", "#ff0000", 0.05)
uploaded[photoId] = colorChild("Photo", "#0000ff", 600.0)
uploaded[splitId] = ExportedInterpretedScene(name: "Split",
  backgroundColor: parseHtmlColor("#101010"), refreshInterval: 300.0,
  refreshFollowsChildren: true, publicStateFields: @[],
  nodes: @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/split",
      "config": {"rows": 1, "columns": 2, "margin": "0", "gap": "0"}}),
    node(3, "scene", %*{"keyword": clockId.string, "config": {}}),
    node(4, "scene", %*{"keyword": photoId.string, "config": {}}),
  ],
  edges: @[
    edge(1, 1, "next", 2, "prev"),
    edge(2, 2, "field/render_functions[1][1]", 3, "prev"),
    edge(3, 2, "field/render_functions[1][2]", 4, "prev"),
  ],
  apps: %*{}, init: init, render: render, runEvent: runEvent)

proc testRunner(store: LogStore, flip = ""): RunnerThread =
  # The size stays frame.json's: the loop persists a changed one back to it.
  var config = loadConfig()
  config.rotate = 0
  config.flip = flip
  config.controlCode = ControlCode(enabled: false, position: "center", size: 0, padding: 0,
    offsetX: 0, offsetY: 0, qrCodeColor: parseHtmlColor("#000000"),
    backgroundColor: parseHtmlColor("#ffffff"))
  RunnerThread(
    frameConfig: config,
    scenes: initTable[SceneId, FrameScene](),
    currentSceneId: splitId,
    lastRenderAt: 0.0,
    sleepFuture: none(Future[void]),
    isRendering: false,
    triggerRenderNext: false,
    logger: testLogger(config, store)
  )

suite "runner loop on scene rhythm":
  setup:
    clearEventChannel()
    updateUploadedScenes(uploaded)

  test "the loop wakes for the clock and runs only the clock":
    let store = LogStore(entries: @[])
    let runnerThread = testRunner(store)
    waitFor runnerThread.startRenderLoop(maxCycles = 4)

    var passes: seq[JsonNode] = @[]
    var sleeps: seq[float] = @[]
    for entry in store.entries:
      case entry{"event"}.getStr()
      of "render:pass": passes.add(entry)
      of "render:sleep": sleeps.add(entry{"ms"}.getFloat())
      else: discard
    # First pass is the whole scene; every one after it is the clock alone.
    check passes.len == 3
    for pass in passes:
      check pass{"pass"}.getStr() == "partial"
      check pass{"ran"}.len == 1
      check pass{"ran"}[0].getStr().startsWith(clockId.string)
    # ...and the loop sleeps the clock's 50 ms, not the split's 300 s nor the
    # photo's 600 s.
    check sleeps.len >= 3
    for ms in sleeps:
      check ms <= 60.0

  test "flip happens on the copy that goes out, never on the canvas":
    let store = LogStore(entries: @[])
    let runnerThread = testRunner(store, flip = "horizontal")
    let exported = findExportedScene(splitId).get()
    let scene = exported.init(splitId, runnerThread.frameConfig, runnerThread.logger, %*{})
    let left = runnerThread.frameConfig.width div 4
    let right = runnerThread.frameConfig.width * 3 div 4
    for pass in 0 ..< 3:
      let (image, _) = runnerThread.renderSceneImage(exported, scene, rfRedraw)
      # What the driver gets is flipped: the clock (left cell) shows on the right.
      check image.unsafe[right, 5].r == 255
      check image.unsafe[left, 5].b == 255
      # The canvas is not: a second flip would have put it back, a third not.
      check runnerThread.sceneCanvas.unsafe[left, 5].r == 255
      check runnerThread.sceneCanvas.unsafe[right, 5].b == 255
      check image.bufferPointer != runnerThread.sceneCanvas.bufferPointer

  test "an unmarked render event is a fresh pass; a scene's own is not":
    let store = LogStore(entries: @[])
    let runnerThread = testRunner(store)
    sendEvent("render", %*{})
    waitFor runnerThread.startMessageLoop(maxIterations = 3)
    check runnerThread.triggerRenderNext
    check runnerThread.renderForce == rfFresh

    runnerThread.renderForce = rfNone
    runnerThread.triggerRenderNext = false
    sendEvent("render", %*{"rhythm": "due"})
    waitFor runnerThread.startMessageLoop(maxIterations = 3)
    check runnerThread.triggerRenderNext
    check runnerThread.renderForce == rfNone

    runnerThread.triggerRenderNext = false
    sendEvent("render", %*{"rhythm": "redraw"})
    waitFor runnerThread.startMessageLoop(maxIterations = 3)
    check runnerThread.renderForce == rfRedraw
