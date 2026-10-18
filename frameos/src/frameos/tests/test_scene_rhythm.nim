import std/[json, options, os, tables, unittest]
import pixie
import ../event_loop
import ../interpreter
import ../scene_rhythm
import ../types
import ../utils/memory

# Scenes inside scenes on their own schedule (frameos/scene_rhythm.nim).
#
# Every pass here starts from a blank canvas, as the Pi's does. The panels
# count their own runs: each run writes `runs + 1` into its state, so a panel
# whose picture came back from a copy shows its color with the count unchanged.

const
  W = 40
  H = 20

var logged: seq[JsonNode] = @[]

proc testConfig(): FrameConfig =
  FrameConfig(name: "rhythm", mode: "rpios", width: W, height: H, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
    assetsPath: getTempDir() / "frameos-rhythm-test-assets")

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = logged.add(payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc panel(name, hex: string, interval: float, nextSleep = -1.0): ExportedInterpretedScene =
  ## render -> color -> setAsState(runs = runs + 1) [-> nextSleepDuration]
  var nodes = @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/color", "config": {"color": hex}}),
    node(3, "app", %*{"keyword": "logic/setAsState", "config": {"stateKey": "runs", "debugLog": "false"}}),
    node(4, "code", %*{"codeJS": "(state.runs || 0) + 1", "codeArgs": [],
      "codeOutputs": [{"name": "valueJson", "type": "json"}]}),
  ]
  var edges = @[
    edge(1, 1, "next", 2, "prev"), edge(2, 2, "next", 3, "prev"),
    edge(3, 4, "fieldOutput", 3, "fieldInput/valueJson"),
  ]
  if nextSleep >= 0:
    nodes.add(node(5, "app", %*{"keyword": "logic/nextSleepDuration", "config": {"duration": nextSleep}}))
    edges.add(edge(4, 3, "next", 5, "prev"))
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: interval, publicStateFields: @[], nodes: nodes, edges: edges, apps: %*{},
    # What the loader gives every scene (refresh_interval.nim): the interval
    # is a state field, seeded from the setting.
    refreshIntervalKey: "refreshInterval", refreshIntervalDefault: interval,
    refreshIntervalImplicit: true, init: init, render: render, runEvent: runEvent)

proc splitOf(name: string, left, right: string, followsChildren: bool, interval = 300.0,
    rightConfig = %*{}): ExportedInterpretedScene =
  ## render -> split(1x2) -> [scene left, scene right]
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#101010"),
    refreshInterval: interval, refreshFollowsChildren: followsChildren, publicStateFields: @[],
    refreshIntervalKey: "refreshInterval", refreshIntervalDefault: interval, refreshIntervalImplicit: true,
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/split",
        "config": {"rows": 1, "columns": 2, "margin": "0", "gap": "0"}}),
      node(3, "scene", %*{"keyword": left, "config": {}}),
      node(4, "scene", %*{"keyword": right, "config": rightConfig}),
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 2, "field/render_functions[1][1]", 3, "prev"),
      edge(3, 2, "field/render_functions[1][2]", 4, "prev"),
    ],
    apps: %*{}, init: init, render: render, runEvent: runEvent)

let
  clockId = "tests/rhythm/clock".SceneId
  photoId = "tests/rhythm/photo".SceneId
  pacedId = "tests/rhythm/paced".SceneId
  splitId = "tests/rhythm/split".SceneId
  slowSplitId = "tests/rhythm/slow-split".SceneId
  plainSplitId = "tests/rhythm/plain-split".SceneId
  overrideSplitId = "tests/rhythm/override-split".SceneId
  pacedSplitId = "tests/rhythm/paced-split".SceneId
  sharedId = "tests/rhythm/shared".SceneId
  nestedId = "tests/rhythm/nested".SceneId

var uploaded = initTable[SceneId, ExportedInterpretedScene]()
uploaded[clockId] = panel("Clock", "#ff0000", 1.0)
uploaded[photoId] = panel("Photo", "#0000ff", 600.0)
uploaded[pacedId] = panel("Paced", "#00ff00", 3600.0, nextSleep = 42.0)
# Set to full speed: it renders whenever a panel is due.
uploaded[splitId] = splitOf("Split", clockId.string, photoId.string, followsChildren = true,
  interval = 0.04)
# Left on the frame's default: its panels render at most every 5 minutes.
uploaded[slowSplitId] = splitOf("Slow split", clockId.string, photoId.string, followsChildren = true)
uploaded[plainSplitId] = splitOf("Plain split", clockId.string, photoId.string,
  followsChildren = false, interval = 60.0)
# A panel's option: the split seeds the photo's refreshInterval with 7.
uploaded[overrideSplitId] = splitOf("Override split", clockId.string, photoId.string,
  followsChildren = true, rightConfig = %*{"refreshInterval": 7})
uploaded[pacedSplitId] = splitOf("Paced split", pacedId.string, photoId.string, followsChildren = true,
  interval = 0.04)
# A clock in the first cell, and one scene node as the split's default
# renderer for the other two: the same photo instance, twice.
uploaded[sharedId] = ExportedInterpretedScene(name: "Shared", backgroundColor: parseHtmlColor("#101010"),
  refreshInterval: 300.0, refreshFollowsChildren: true, publicStateFields: @[],
  nodes: @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/split",
      "config": {"rows": 1, "columns": 3, "margin": "0", "gap": "0"}}),
    node(3, "scene", %*{"keyword": photoId.string, "config": {}}),
    node(4, "scene", %*{"keyword": clockId.string, "config": {}}),
  ],
  edges: @[
    edge(1, 1, "next", 2, "prev"),
    edge(2, 2, "field/render_function", 3, "prev"),
    edge(3, 2, "field/render_functions[1][1]", 4, "prev"),
  ],
  apps: %*{}, init: init, render: render, runEvent: runEvent)
# A generated split as a panel of another: [split(clock, photo), paced]
uploaded[nestedId] = splitOf("Nested", splitId.string, pacedId.string, followsChildren = true,
  interval = 0.04)
setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = testConfig()

proc newScene(id: SceneId): FrameScene =
  logged = @[]
  init(id, config, testLogger(config), %*{})

proc pass(scene: FrameScene, canvas = newImage(W, H)): Image =
  ## One render of the top scene into a fresh canvas, like the Pi's runner.
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(scene, context)

proc child(scene: FrameScene, nodeId: int): FrameScene =
  InterpretedFrameScene(scene).sceneNodes[nodeId.NodeId]

proc runs(scene: FrameScene): int =
  scene.state{"runs"}.getInt()

proc pixel(image: Image, x, y: int): ColorRGBX =
  image.getPixel(image.dataIndex(x, y))

proc countEvent(name: string): int =
  for entry in logged:
    if entry{"event"}.getStr() == name: inc result

proc lastEvent(name: string): JsonNode =
  for entry in logged:
    if entry{"event"}.getStr() == name: result = entry

suite "scene rhythm":
  setup:
    rhythmClockOverride = 1000.0
    availableRenderBytesOverride = 0

  test "a scene the split drawer generated follows its panels":
    let parsed = parseInterpretedScenes("""[
      {"id": "generated", "name": "Split", "nodes": [], "edges": [], "fields": [],
       "settings": {"refreshInterval": 300, "backgroundColor": "#000000",
                    "splitScreenLayout": {"name": "Split", "root": {"type": "split", "children": []}}}},
      {"id": "plain", "name": "Plain", "nodes": [], "edges": [], "fields": [],
       "settings": {"refreshInterval": 300, "backgroundColor": "#000000"}}
    ]""")
    check parsed["generated".SceneId].refreshFollowsChildren
    check not parsed["plain".SceneId].refreshFollowsChildren

  test "a panel that is not due keeps its picture; the split ticks at its fastest panel":
    let scene = newScene(splitId)
    let first = scene.pass()
    check first.pixel(5, 5).r == 255       # clock, left
    check first.pixel(30, 5).b == 255      # photo, right
    let clock = scene.child(3)
    let photo = scene.child(4)
    check clock.runs == 1 and photo.runs == 1
    # Nothing is due for a second, so the split waits a second, not 0.04 s.
    check abs(scene.refreshInterval - 1.0) < 0.001
    rhythmClockOverride = 1001.0
    let second = scene.pass()
    check clock.runs == 2
    check photo.runs == 1                  # did not run...
    check second.pixel(30, 5).b == 255     # ...yet its picture is there
    check countEvent("render:rhythm") == 1
    # Only the panel that is not due next pass keeps a copy.
    check clock.rhythm.copies.len == 0
    check photo.rhythm.copies.len == 1
    rhythmClockOverride = 1600.0
    discard scene.pass()
    check photo.runs == 2

  test "a split's own interval is the fastest it renders":
    # A 1 s clock in a split left on 300 s (an e-ink frame, a battery ESP32)
    # does not make the frame refresh every second.
    let scene = newScene(slowSplitId)
    discard scene.pass()
    check abs(scene.refreshInterval - 300.0) < 0.001
    # The clock will be due by then, so it is not kept; the photo is.
    check scene.child(3).rhythm.copies.len == 0
    check scene.child(4).rhythm.copies.len == 1
    # With every panel slower than the split, the split waits for the first.
    scene.child(3).state["refreshInterval"] = %900
    rhythmClockOverride = 1300.0
    discard scene.pass()
    check abs(scene.refreshInterval - 300.0) < 0.001   # the photo, due at 1600
    rhythmClockOverride = 1600.0
    discard scene.pass()
    check abs(scene.refreshInterval - 600.0) < 0.001   # the clock at 2200, the photo at 2200

  test "nextSleep inside a panel is the panel's, never the frame's":
    let scene = newScene(pacedSplitId)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
      image: newImage(W, H), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    discard render(scene, context)
    check context.nextSleep < 0
    check abs(scene.child(3).rhythm.dueAt - 1042.0) < 0.001   # its own nextSleep
    check abs(scene.child(4).rhythm.dueAt - 1600.0) < 0.001   # its refreshInterval
    check abs(scene.refreshInterval - 42.0) < 0.001

  test "a panel's refresh interval option is that panel's schedule":
    let scene = newScene(overrideSplitId)
    discard scene.pass()
    check abs(scene.child(4).rhythm.dueAt - 1007.0) < 0.001
    scene.child(4).state["refreshInterval"] = %3
    rhythmClockOverride = 1007.0
    discard scene.pass()
    check abs(scene.child(4).rhythm.dueAt - 1010.0) < 0.001

  test "a scene with its own interval keeps it, and its panels still keep their pictures":
    let scene = newScene(plainSplitId)
    discard scene.pass()
    check abs(scene.refreshInterval - 60.0) < 0.001
    rhythmClockOverride = 1060.0
    let second = scene.pass()
    check scene.child(3).runs == 2
    check scene.child(4).runs == 1
    check second.pixel(30, 5).b == 255

  test "a panel whose state changed runs although it is not due":
    let scene = newScene(splitId)
    discard scene.pass()
    scene.child(4).state["search"] = %"mountains"
    rhythmClockOverride = 1001.0
    discard scene.pass()
    check scene.child(4).runs == 2
    # Its own write of `runs` while rendering is not a change from outside.
    rhythmClockOverride = 1002.0
    discard scene.pass()
    check scene.child(4).runs == 2

  test "a panel that asks to be drawn again is due":
    let scene = newScene(splitId)
    discard scene.pass()
    rhythmMarkDue(scene.child(4))
    rhythmClockOverride = 1001.0
    discard scene.pass()
    check scene.child(4).runs == 2

  test "a render somebody asked for draws every panel anew":
    let scene = newScene(splitId)
    discard scene.pass()
    rhythmRequestFreshPass()
    rhythmClockOverride = 1001.0
    discard scene.pass()
    check scene.child(4).runs == 2
    # Its schedule starts over from that run.
    check abs(scene.child(4).rhythm.dueAt - 1601.0) < 0.001

  test "the dispatcher asks for a fresh pass for renders from outside the scene only":
    var renders = 0
    let loop = newEventLoop(EventHost(requestRender: proc () = inc renders), config)
    let scene = newScene(splitId)
    discard scene.pass()
    rhythmClockOverride = 1001.0
    loop.enqueue(eoScene, "render", %*{})
    loop.enqueue(eoSystem, "render", %*{})
    discard loop.drain()
    discard scene.pass()
    check scene.child(4).runs == 1
    loop.enqueue(eoHttpWrite, "render", %*{})
    discard loop.drain()
    check renders == 2
    rhythmClockOverride = 1002.0
    discard scene.pass()
    check scene.child(4).runs == 2

  test "without the memory for a copy, a panel that is not due is repainted":
    let scene = newScene(splitId)
    availableRenderBytesOverride = 1024    # nothing to spare
    discard scene.pass()
    let photo = scene.child(4)
    check photo.rhythm.copies.len == 0
    check countEvent("render:rhythm:copyRefused") == 1
    rhythmClockOverride = 1001.0
    let second = scene.pass()
    check photo.runs == 2                  # it ran again...
    check abs(photo.rhythm.dueAt - 1600.0) < 0.001   # ...without being rescheduled
    check second.pixel(30, 5).b == 255
    check lastEvent("render:rhythm"){"repainted"}.len == 1
    # Refused once, logged once.
    check countEvent("render:rhythm:copyRefused") == 1

  test "a repaint is marked on the scene while it runs":
    var seen: seq[bool] = @[]
    let scene = newScene(splitId)
    availableRenderBytesOverride = 1024
    let photoExport = InterpretedFrameScene(scene).sceneExportByNodeId[4.NodeId]
    InterpretedFrameScene(scene).sceneExportByNodeId[4.NodeId] = ExportedScene(
      init: photoExport.init, render: photoExport.render,
      runEvent: proc (self: FrameScene, context: ExecutionContext) =
        seen.add(self.repainting)
        photoExport.runEvent(self, context))
    discard scene.pass()
    rhythmClockOverride = 1001.0
    discard scene.pass()
    check seen == @[false, true]
    check not scene.child(4).repainting

  test "copies stay within a quarter of free render memory":
    let scene = newScene(splitId)
    # The photo's half of the canvas is W/2 * H * 4 = 1600 bytes; a quarter
    # of 8000 is 2000, so it fits, and with 4000 it does not.
    availableRenderBytesOverride = 8000
    discard scene.pass()
    check scene.child(4).rhythm.copies.len == 1
    let other = newScene(splitId)
    availableRenderBytesOverride = 4000
    discard other.pass()
    check other.child(4).rhythm.copies.len == 0

  test "one scene drawn into several cells runs in all of them or in none":
    let scene = newScene(sharedId)
    let first = scene.pass()
    let photo = scene.child(3)
    check photo.runs == 2                  # once per cell
    check photo.rhythm.copies.len == 2
    rhythmClockOverride = 1001.0
    let second = scene.pass()
    check photo.runs == 2
    check second.pixel(20, 5).b == 255 and second.pixel(33, 5).b == 255
    check first.pixel(20, 5) == second.pixel(20, 5)
    check second.pixel(5, 5).r == 255      # the clock ran

  test "a split inside a split follows its own panels":
    let scene = newScene(nestedId)
    discard scene.pass()
    let inner = scene.child(3)
    check abs(inner.refreshInterval - 1.0) < 0.001
    check abs(scene.refreshInterval - 1.0) < 0.001
    rhythmClockOverride = 1001.0
    let second = scene.pass()
    check inner.child(3).runs == 2         # the clock
    check inner.child(4).runs == 1         # the photo, kept
    check scene.child(4).runs == 1         # the paced panel, kept
    check second.pixel(15, 5).b == 255     # the photo's quarter of the canvas

  test "switching the top scene draws everything and drops the old copies":
    let scene = newScene(splitId)
    discard scene.pass()
    check scene.child(4).rhythm.copies.len == 1
    let other = newScene(plainSplitId)
    discard other.pass()
    check scene.child(4).rhythm.copies.len == 0
    rhythmClockOverride = 1001.0
    discard scene.pass()
    check scene.child(4).runs == 2

  test "copies keep the canvas's own pixel format":
    let scene = newScene(splitId)
    discard scene.pass(newImage565(W, H))
    check scene.child(4).rhythm.copies["./1"].pixels.format == pfRgb565
    rhythmClockOverride = 1001.0
    let second = scene.pass(newImage565(W, H))
    check scene.child(4).runs == 1
    check second.pixel(30, 5).b > 200
