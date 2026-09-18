import std/[json, tables, os, math, strutils, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../utils/memory

# Scene rhythm (frameos/scene_rhythm.nim): embedded scenes on their own
# schedule, partial passes into a persistent canvas, the overpaint rule, and
# the tiers that keep a not-due child from re-running when a full pass wipes
# the canvas.
#
# The trick every test here leans on: tamper with the canvas inside a child's
# rectangle. If the child RAN, its opaque fill paints over the tampering. If it
# did not — skipped by a partial pass, or restored from pixels copied out
# before the wipe — the tampering is still there.

const
  W = 40
  H = 20

var logged: seq[JsonNode] = @[]

proc testConfig(): FrameConfig =
  FrameConfig(name: "rhythm", mode: "embedded", width: W, height: H, rotate: 0,
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

proc colorChild(name, hex: string, interval: float, nextSleep = -1.0): ExportedInterpretedScene =
  ## render -> color [-> nextSleepDuration]
  var nodes = @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/color", "config": {"color": hex}}),
  ]
  var edges = @[edge(1, 1, "next", 2, "prev")]
  if nextSleep >= 0:
    nodes.add(node(3, "app", %*{"keyword": "logic/nextSleepDuration", "config": {"duration": nextSleep}}))
    edges.add(edge(2, 2, "next", 3, "prev"))
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: interval, publicStateFields: @[], nodes: nodes, edges: edges, apps: %*{},
    init: init, render: render, runEvent: runEvent)

proc mutatingChild(name, hex: string, interval: float): ExportedInterpretedScene =
  ## render -> color -> setAsState(seen = 42): a scene that writes its own
  ## state while rendering, like every scene built around logic/setAsState.
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: interval, publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/color", "config": {"color": hex}}),
      node(3, "app", %*{"keyword": "logic/setAsState", "config": {"stateKey": "seen", "debugLog": "false"}}),
      node(4, "code", %*{"codeJS": "42", "codeArgs": [], "codeOutputs": [{"name": "valueJson", "type": "json"}]}),
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"), edge(2, 2, "next", 3, "prev"),
      edge(3, 4, "fieldOutput", 3, "fieldInput/valueJson"),
    ],
    apps: %*{}, init: init, render: render, runEvent: runEvent)

proc splitOf(name: string, left, right: string, followsChildren: bool,
    interval = 300.0): ExportedInterpretedScene =
  ## render -> split(1x2) -> [scene left, scene right]
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#101010"),
    refreshInterval: interval, refreshFollowsChildren: followsChildren, publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/split",
        "config": {"rows": 1, "columns": 2, "margin": "0", "gap": "0"}}),
      node(3, "scene", %*{"keyword": left, "config": {}}),
      node(4, "scene", %*{"keyword": right, "config": {}}),
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 2, "field/render_functions[1][1]", 3, "prev"),
      edge(3, 2, "field/render_functions[1][2]", 4, "prev"),
    ],
    apps: %*{}, init: init, render: render, runEvent: runEvent)

proc overlaid(name, child: string, interval: float): ExportedInterpretedScene =
  ## render -> scene child (whole canvas) -> split(1x2) -> [color, nothing]
  ## The split's left cell paints over the child afterwards: overpainted.
  ExportedInterpretedScene(name: name, backgroundColor: parseHtmlColor("#101010"),
    refreshInterval: interval, publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "scene", %*{"keyword": child, "config": {}}),
      node(3, "app", %*{"keyword": "render/split",
        "config": {"rows": 1, "columns": 2, "margin": "0", "gap": "0"}}),
      node(4, "app", %*{"keyword": "render/color", "config": {"color": "#ffffff"}}),
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 2, "next", 3, "prev"),
      edge(3, 3, "field/render_functions[1][1]", 4, "prev"),
    ],
    apps: %*{}, init: init, render: render, runEvent: runEvent)

let
  clockId = "tests/rhythm/clock".SceneId
  photoId = "tests/rhythm/photo".SceneId
  pacedId = "tests/rhythm/paced".SceneId
  splitId = "tests/rhythm/split".SceneId
  plainSplitId = "tests/rhythm/plain-split".SceneId
  outerId = "tests/rhythm/outer".SceneId
  overlaidId = "tests/rhythm/overlaid".SceneId
  pacedSplitId = "tests/rhythm/paced-split".SceneId
  innerId = "tests/rhythm/inner".SceneId
  sharedId = "tests/rhythm/shared".SceneId
  mutatingId = "tests/rhythm/mutating".SceneId
  mutatingSplitId = "tests/rhythm/mutating-split".SceneId
  nestedOuterId = "tests/rhythm/nested-outer".SceneId

var uploaded = initTable[SceneId, ExportedInterpretedScene]()
uploaded[clockId] = colorChild("Clock", "#ff0000", 1.0)
uploaded[photoId] = colorChild("Photo", "#0000ff", 600.0)
uploaded[pacedId] = colorChild("Paced", "#00ff00", 3600.0, nextSleep = 42.0)
uploaded[splitId] = splitOf("Split", clockId.string, photoId.string, followsChildren = true)
uploaded[mutatingId] = mutatingChild("Mutating photo", "#0000ff", 600.0)
uploaded[mutatingSplitId] = splitOf("Mutating split", clockId.string, mutatingId.string, followsChildren = true)
uploaded[plainSplitId] = splitOf("Plain split", clockId.string, photoId.string,
  followsChildren = false, interval = 60.0)
uploaded[outerId] = splitOf("Outer", splitId.string, pacedId.string, followsChildren = true)
uploaded[overlaidId] = overlaid("Overlaid", photoId.string, 60.0)
uploaded[pacedSplitId] = splitOf("Paced split", pacedId.string, clockId.string, followsChildren = true)
# One scene node as the split's default renderer: the same instance, every cell.
uploaded[sharedId] = ExportedInterpretedScene(name: "Shared", backgroundColor: parseHtmlColor("#101010"),
  refreshInterval: 300.0, refreshFollowsChildren: true, publicStateFields: @[],
  nodes: @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/split",
      "config": {"rows": 1, "columns": 2, "margin": "0", "gap": "0"}}),
    node(3, "scene", %*{"keyword": clockId.string, "config": {}}),
  ],
  edges: @[
    edge(1, 1, "next", 2, "prev"),
    edge(2, 2, "field/render_function", 3, "prev"),
  ],
  apps: %*{}, init: init, render: render, runEvent: runEvent)
# A scene with its own 60 s interval that embeds a photo, itself a panel of a split.
uploaded[innerId] = splitOf("Inner", photoId.string, pacedId.string, followsChildren = false, interval = 60.0)
uploaded[nestedOuterId] = splitOf("Nested outer", innerId.string, clockId.string, followsChildren = true)
setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = testConfig()
let tamper = rgbx(9, 9, 9, 255)

proc newScene(id: SceneId): FrameScene =
  logged = @[]
  init(id, config, testLogger(config), %*{})

proc tamperRect(canvas: Image, x, y, w, h: int) =
  canvas.view(x, y, w, h).fill(tamper)

proc countEvent(name: string): int =
  for entry in logged:
    if entry{"event"}.getStr() == name: inc result

suite "scene rhythm":
  setup:
    rhythmNowOverride = 1000.0
    rhythmStorageTier = false
    rhythmCanvasVolatile = false
    rhythmRunSecondsOverride = 30.0     # a photo: fetch + decode, worth a store
    availableRenderBytesOverride = 0

  test "absoluteRect reads a view's place off origin and stride":
    let canvas = newImage(W, H)
    let cell = canvas.view(7, 3, 10, 5)
    check absoluteRect(cell) == (7, 3, 10, 5)
    check absoluteRect(cell.view(2, 1, 4, 2)) == (9, 4, 4, 2)
    check absoluteRect(canvas) == (0, 0, W, H)

  test "a scene the split drawer generated follows its children":
    let parsed = parseInterpretedScenes("""[
      {"id": "generated", "name": "Split", "nodes": [], "edges": [], "fields": [],
       "settings": {"refreshInterval": 300, "backgroundColor": "#000000",
                    "splitScreenLayout": {"name": "Split", "root": {"type": "split"}}}},
      {"id": "plain", "name": "Plain", "nodes": [], "edges": [], "fields": [],
       "settings": {"refreshInterval": 300, "backgroundColor": "#000000"}}
    ]""")
    check parsed["generated".SceneId].refreshFollowsChildren
    check not parsed["plain".SceneId].refreshFollowsChildren

  test "each child gets its own due time; nextSleep stays inside the child":
    let scene = newScene(pacedSplitId)
    let canvas = newImage(W, H)
    let first = renderRhythmPass(scene, canvas, rfRedraw)
    check not first.info.partial
    # The paced child's nextSleepDuration (42 s) did not reach the split.
    check first.nextSleep < 0
    let children = InterpretedFrameScene(scene).sceneNodes
    check abs(children[3.NodeId].rhythm.dueAt - 1042.0) < 0.001   # its own nextSleep
    check abs(children[4.NodeId].rhythm.dueAt - 1001.0) < 0.001   # its refreshInterval
    # The loop wakes for the soonest of them.
    check abs(rhythmNextWakeSeconds(scene) - 1.0) < 0.001

  test "a split follows its children; a partial pass runs only what is due":
    let scene = newScene(splitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    check canvas.unsafe[5, 5].r == 255      # clock, left
    check canvas.unsafe[30, 5].b == 255     # photo, right
    # Tamper with both cells, then let only the clock come due.
    canvas.tamperRect(0, 0, 20, H)
    canvas.tamperRect(20, 0, 20, H)
    rhythmNowOverride = 1001.0
    let tick = renderRhythmPass(scene, canvas)
    check tick.info.partial
    check tick.info.ran.len == 1
    check tick.info.ran[0].startsWith(clockId.string)
    check canvas.unsafe[5, 5].r == 255      # the clock repainted its cell
    check canvas.unsafe[30, 5] == tamper    # the photo did not run, and nothing wiped it
    # ...and again a second later, with the photo still ten minutes away.
    check abs(rhythmNextWakeSeconds(scene) - 1.0) < 0.001
    # The split itself never comes due on its own 300 s interval.
    rhythmNowOverride = 1400.0
    check renderRhythmPass(scene, canvas).info.partial

  test "a scene with its own interval re-renders fully, and keeps not-due children's pixels":
    let scene = newScene(plainSplitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(20, 0, 20, H)          # the photo's cell
    rhythmNowOverride = 1060.0               # the split's own 60 s interval
    let pass = renderRhythmPass(scene, canvas)
    check not pass.info.partial
    check pass.info.reason == "scene due"
    # The full pass wiped the canvas, yet the photo (due at 1600) was copied
    # out first and copied back: it did not run.
    check pass.info.restored.len == 1
    check canvas.unsafe[30, 5] == tamper
    check canvas.unsafe[5, 5].r == 255       # the clock was due, and ran
    # Its due time is untouched: a forced pass does not shift its phase.
    check abs(InterpretedFrameScene(scene).sceneNodes[4.NodeId].rhythm.dueAt - 1600.0) < 0.001
    # Nothing is held once the pass is over.
    check InterpretedFrameScene(scene).sceneNodes[4.NodeId].rhythm.snapshot.isNil

  test "an explicit render runs everything":
    let scene = newScene(plainSplitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(20, 0, 20, H)
    rhythmNowOverride = 1010.0
    let pass = renderRhythmPass(scene, canvas, rfFresh)
    check not pass.info.partial
    check pass.info.restored.len == 0
    check canvas.unsafe[30, 5].b == 255

  test "a child whose state changed runs even when it is not due":
    let scene = newScene(plainSplitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(20, 0, 20, H)
    InterpretedFrameScene(scene).sceneNodes[4.NodeId].state["search"] = %"mountains"
    rhythmNowOverride = 1060.0
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.restored.len == 0
    check canvas.unsafe[30, 5].b == 255

  test "no memory, no snapshot: the child just runs":
    let scene = newScene(plainSplitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(20, 0, 20, H)
    availableRenderBytesOverride = 1024       # an embedded frame with nothing to spare
    rhythmNowOverride = 1060.0
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.restored.len == 0
    check canvas.unsafe[30, 5].b == 255
    check countEvent("rhythm:snapshot:refused") >= 1

  test "an overpainted child never renders alone, and keeps its own snapshot":
    let scene = newScene(overlaidId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    let photo = InterpretedFrameScene(scene).sceneNodes[2.NodeId]
    check photo.rhythm.overpainted
    check canvas.unsafe[5, 5].r == 255 and canvas.unsafe[5, 5].b == 255   # the white overlay
    check canvas.unsafe[30, 5].b == 255 and canvas.unsafe[30, 5].r == 0   # the photo beside it
    # Its pixels on the canvas are not its own, so the snapshot taken right
    # after it ran is kept for the next full pass.
    check not photo.rhythm.snapshot.isNil
    rhythmNowOverride = 1060.0
    let pass = renderRhythmPass(scene, canvas)
    check not pass.info.partial
    check pass.info.restored.len == 1
    check canvas.unsafe[30, 5].b == 255
    check canvas.unsafe[5, 5].r == 255
    # When the photo itself is due, that is a full pass too — never a partial.
    rhythmNowOverride = 1600.5
    InterpretedFrameScene(scene).rhythm.tree.topDueAt = 99999.0
    let due = renderRhythmPass(scene, canvas)
    check not due.info.partial
    check due.info.reason.contains("cannot render alone")

  test "nesting: a node inside a split inside a split renders alone, at its absolute rectangle":
    let scene = newScene(outerId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    # outer: [ inner split (0..20) | paced (20..40) ]; inner: [clock 0..10 | photo 10..20]
    check canvas.unsafe[3, 5].r == 255
    check canvas.unsafe[15, 5].b == 255
    check canvas.unsafe[30, 5].g == 255
    canvas.tamperRect(0, 0, W, H)
    rhythmNowOverride = 1001.0
    let tick = renderRhythmPass(scene, canvas)
    check tick.info.partial
    check tick.info.ran.len == 1
    check canvas.unsafe[3, 5].r == 255       # the clock, two levels down
    check canvas.unsafe[15, 5] == tamper     # its sibling photo: untouched
    check canvas.unsafe[30, 5] == tamper     # the paced scene: untouched
    # The paced scene is next (its own nextSleep), then the photo.
    rhythmNowOverride = 1042.5
    let paced = renderRhythmPass(scene, canvas)
    check paced.info.partial
    check canvas.unsafe[30, 5].g == 255
    check canvas.unsafe[15, 5] == tamper

  test "a scene dispatching render marks itself, not everything":
    let scene = newScene(splitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(0, 0, W, H)
    rhythmNowOverride = 1000.5                # nothing is due yet
    let photo = InterpretedFrameScene(scene).sceneNodes[4.NodeId]
    rhythmMarkDue(photo)
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.partial
    check canvas.unsafe[30, 5].b == 255
    check canvas.unsafe[5, 5] == tamper

  test "a due scene that embeds a not-due one re-renders alone and keeps the inner pixels":
    let scene = newScene(nestedOuterId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    # outer: [ inner (0..20) | clock (20..40) ]; inner: [photo 0..10 | paced 10..20]
    check canvas.unsafe[3, 5].b == 255
    check canvas.unsafe[15, 5].g == 255
    canvas.tamperRect(0, 0, 10, H)            # the photo, two levels down
    canvas.tamperRect(20, 0, 20, H)           # the clock
    rhythmNowOverride = 1060.0                # inner's own interval; the clock is due too
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.partial                   # the outer split never ran
    # Inner ran, and its fill wiped the photo's cell — which was copied out
    # first and copied back, because the photo is not due until 1600.
    check canvas.unsafe[3, 5] == tamper
    check canvas.unsafe[15, 5].g == 255       # paced was due (1042), and ran
    check canvas.unsafe[30, 5].r == 255       # so did the clock
    check pass.info.restored.len == 1
    let inner = InterpretedFrameScene(scene).sceneNodes[3.NodeId]
    let photo = InterpretedFrameScene(inner).sceneNodes[3.NodeId]
    check abs(photo.rhythm.dueAt - 1600.0) < 0.001
    check photo.rhythm.snapshot.isNil
    # The photo is still schedulable on its own afterwards.
    rhythmNowOverride = 1600.5
    inner.rhythm.dueAt = 99999.0
    InterpretedFrameScene(scene).sceneNodes[4.NodeId].rhythm.dueAt = 99999.0
    InterpretedFrameScene(inner).sceneNodes[4.NodeId].rhythm.dueAt = 99999.0
    let later = renderRhythmPass(scene, canvas)
    check later.info.partial
    check later.info.ran.len == 1
    check canvas.unsafe[3, 5].b == 255

  test "one instance drawn into every cell never renders alone":
    let scene = newScene(sharedId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    check canvas.unsafe[5, 5].r == 255 and canvas.unsafe[30, 5].r == 255
    check InterpretedFrameScene(scene).sceneNodes[3.NodeId].rhythm.shared
    canvas.tamperRect(0, 0, W, H)
    rhythmNowOverride = 1001.0
    let pass = renderRhythmPass(scene, canvas)
    # One rectangle cannot stand for both cells: the whole scene runs, and
    # both cells come out fresh.
    check not pass.info.partial
    check pass.info.restored.len == 0
    check canvas.unsafe[5, 5].r == 255 and canvas.unsafe[30, 5].r == 255

  test "an overlay change keeps the canvas and runs nothing":
    let scene = newScene(splitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(0, 0, W, H)
    rhythmNowOverride = 1000.5
    let pass = renderRhythmPass(scene, canvas, rfRedraw)
    check pass.info.partial
    check pass.info.ran.len == 0
    check pass.info.reason == "canvas kept"
    check canvas.unsafe[5, 5] == tamper
    # ...unless something is due, which then runs as it would have anyway.
    rhythmNowOverride = 1001.0
    let tick = renderRhythmPass(scene, canvas, rfRedraw)
    check tick.info.ran.len == 1
    check canvas.unsafe[5, 5].r == 255

  test "a timed wake that lands early renders what is due next, not everything":
    let scene = newScene(splitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    canvas.tamperRect(0, 0, W, H)
    rhythmNowOverride = 1000.4                # the host woke 0.6 s early
    check not rhythmAnythingDue(scene)
    rhythmPullEarliestDue(scene)
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.partial
    check pass.info.ran.len == 1
    check canvas.unsafe[5, 5].r == 255
    check canvas.unsafe[30, 5] == tamper

  test "a battery frame takes along what is nearly due":
    rhythmSlackFraction = 0.1
    let scene = newScene(splitId)
    let canvas = newImage(W, H)
    discard renderRhythmPass(scene, canvas, rfRedraw)
    # 10% of the photo's 600 s, capped at a minute: at 1545 it rides along
    # with the clock's wake instead of costing a wake of its own at 1600.
    rhythmNowOverride = 1545.0
    let pass = renderRhythmPass(scene, canvas)
    check pass.info.partial
    check pass.info.ran.len == 2
    rhythmSlackFraction = 0.0

  test "a different canvas is a full pass":
    let scene = newScene(splitId)
    discard renderRhythmPass(scene, newImage(W, H), rfRedraw)
    rhythmNowOverride = 1001.0
    let pass = renderRhythmPass(scene, newImage(W, H))
    check not pass.info.partial
    check pass.info.reason == "canvas changed"

  test "deep sleep: pixels survive in storage and come back into a fresh canvas":
    rhythmStorageTier = true
    rhythmCanvasVolatile = true
    rhythmWallOverride = 1_800_000_000.0
    removeDir(config.assetsPath)
    createDir(config.assetsPath)
    block firstWake:
      let scene = newScene(splitId)
      let canvas = newImage(W, H)
      discard renderRhythmPass(scene, canvas, rfRedraw)
      # The photo (600 s) outlives the next wake (the clock's, 1 s away... but
      # the wake that matters is a minute-scale one: see the gain rule below).
      check countEvent("rhythm:store") == 1
    block nextWake:
      # A reboot: no scene instance, no tree, an empty canvas.
      rhythmNowOverride = 5.0
      rhythmWallOverride = 1_800_000_060.0
      let scene = newScene(splitId)
      let canvas = newImage(W, H)
      # Prove the pixels come from the file: rewrite them on disk.
      var stored: seq[string] = @[]
      for kind, path in walkDir(config.assetsPath / ".rhythm"):
        if path.endsWith(".px"): stored.add(path)
      check stored.len == 1
      var bytes = readFile(stored[0])
      let header = 4 + 4 + 12 + 24 + 16 + 16 # magic, version, shape, due+interval+rate, two keys
      for i in countup(header, bytes.len - 9, 4):
        bytes[i] = char(7); bytes[i + 1] = char(7); bytes[i + 2] = char(7); bytes[i + 3] = char(255)
      writeFile(stored[0], bytes)
      let pass = renderRhythmPass(scene, canvas, rfRedraw)
      check pass.info.restored.len == 1
      check canvas.unsafe[30, 5] == rgbx(7, 7, 7, 255)
      check canvas.unsafe[5, 5].r == 255      # the clock ran
      # Its due time came back with it: 600 s from the first wake, 60 s ago.
      let photo = InterpretedFrameScene(scene).sceneNodes[4.NodeId]
      check abs((photo.rhythm.dueAt - 5.0) - 540.0) < 0.001
      # Nothing new to write: the file is still good.
      check countEvent("rhythm:store") == 0
    block expired:
      rhythmNowOverride = 5.0
      rhythmWallOverride = 1_800_000_700.0
      let scene = newScene(splitId)
      let canvas = newImage(W, H)
      let pass = renderRhythmPass(scene, canvas, rfRedraw)
      check pass.info.restored.len == 0
      check canvas.unsafe[30, 5].b == 255
    block otherDefinition:
      # The same scene id, redeployed with another graph: old pixels are not it.
      rhythmWallOverride = 1_800_000_710.0
      uploaded[photoId] = colorChild("Photo", "#00ffff", 600.0)
      setUploadedInterpretedScenes(uploaded)
      let scene = newScene(splitId)
      let canvas = newImage(W, H)
      let pass = renderRhythmPass(scene, canvas, rfRedraw)
      check pass.info.restored.len == 0
      check canvas.unsafe[30, 5].g == 255
    removeDir(config.assetsPath)
    rhythmWallOverride = -1

  test "a scene that writes its own state still comes back from storage on a fresh wake":
    rhythmStorageTier = true
    rhythmCanvasVolatile = true
    rhythmWallOverride = 1_800_000_000.0
    removeDir(config.assetsPath)
    createDir(config.assetsPath)
    block firstWake:
      let scene = newScene(mutatingSplitId)
      discard renderRhythmPass(scene, newImage(W, H), rfRedraw)
      let photo = InterpretedFrameScene(scene).sceneNodes[4.NodeId]
      check photo.state{"seen"}.getInt() == 42       # it did write its state
      check photo.rhythm.stateKey != photo.rhythm.seedKey
      check countEvent("rhythm:store") == 1
      # In memory, the pixels stay good: the state is what the run left.
      rhythmNowOverride = 1060.0
      let canvas = newImage(W, H)
      check renderRhythmPass(scene, canvas, rfRedraw).info.restored.len == 0 # new canvas: nothing to copy
    block nextWake:
      rhythmNowOverride = 5.0
      rhythmWallOverride = 1_800_000_060.0
      let scene = newScene(mutatingSplitId)
      let canvas = newImage(W, H)
      let pass = renderRhythmPass(scene, canvas, rfRedraw)
      # A fresh instance starts from the same seed the stored run started from.
      check pass.info.restored.len == 1
      check canvas.unsafe[30, 5].b == 255
      check countEvent("rhythm:restore") == 1
    removeDir(config.assetsPath)
    rhythmWallOverride = -1

  test "a store that would cost more than it saves is refused":
    rhythmStorageTier = true
    rhythmCanvasVolatile = true
    rhythmWallOverride = 1_800_000_000.0
    rhythmRunSecondsOverride = 0.0      # a colour fill: nothing to save
    removeDir(config.assetsPath)
    createDir(config.assetsPath)
    let scene = newScene(splitId)
    discard renderRhythmPass(scene, newImage(W, H), rfRedraw)
    check countEvent("rhythm:store") == 0
    check countEvent("rhythm:store:refused") == 1
    removeDir(config.assetsPath)
    rhythmWallOverride = -1

  test "a stay-awake frame writes nothing to storage":
    rhythmStorageTier = true
    rhythmCanvasVolatile = false
    rhythmWallOverride = 1_800_000_000.0
    removeDir(config.assetsPath)
    createDir(config.assetsPath)
    let scene = newScene(splitId)
    discard renderRhythmPass(scene, newImage(W, H), rfRedraw)
    check countEvent("rhythm:store") == 0
    removeDir(config.assetsPath)
    rhythmWallOverride = -1
