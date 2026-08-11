import std/[json, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../utils/memory

# Nested `render/split` and what it costs.
#
# Split gives each cell a `subImage` — a COPY of that region of its parent —
# lets the child render into it, and draws it back. One level of that is one
# cell-sized buffer live at a time. Nesting stacks them: while an inner cell
# renders, its parent's cell buffer is still live, and so is the parent's
# parent's, all the way up to the canvas.
#
# No scene the repo ships nests splits today, so this is the test that says
# what happens when one does — both that it renders correctly, and what the
# live set actually looks like. It is the measurement behind the case for an
# image *view* in the pixie fork, where a cell would borrow its parent's pixels
# instead of copying them and the whole stack would collapse to the canvas.

const
  CanvasWidth = 400
  CanvasHeight = 240

# An ESP32-S3-class budget so an over-allocation fails here rather than on a
# frame.
availableRenderBytesOverride = 4 * 1024 * 1024
refreshDecodeBudget()

proc testConfig(): FrameConfig =
  FrameConfig(
    name: "nested-split", mode: "embedded", width: CanvasWidth, height: CanvasHeight,
    rotate: 0, scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) = discard payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc splitNode(id: int, rows, columns: int): DiagramNode =
  node(id, "app", %*{
    "keyword": "render/split",
    "config": {"rows": rows, "columns": columns, "margin": "0", "gap": "0"}
  })

proc colorNode(id: int, hex: string): DiagramNode =
  node(id, "app", %*{"keyword": "render/color", "config": {"color": hex}})

## event -> split(1x2) -> [ split(2x1) -> [color, color], color ]
##
## Two levels deep, so the inner cell renders while the outer cell buffer is
## still live.
proc nestedScene(): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Nested split",
    backgroundColor: parseHtmlColor("#101010"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      splitNode(2, 1, 2),   # outer: two columns
      splitNode(3, 2, 1),   # inner: two rows, inside the first column
      colorNode(4, "#ff0000"),
      colorNode(5, "#00ff00"),
      colorNode(6, "#0000ff"),
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      # Cell renderers are wired as node fields on the split.
      edge(2, 2, "field/render_functions[1][1]", 3, "prev"),
      edge(3, 2, "field/render_functions[1][2]", 6, "prev"),
      edge(4, 3, "field/render_functions[1][1]", 4, "prev"),
      edge(5, 3, "field/render_functions[2][1]", 5, "prev"),
    ],
    apps: %*{}
  )

let sceneId = "tests/nested-split".SceneId
var uploaded = initTable[SceneId, ExportedInterpretedScene]()
uploaded[sceneId] = nestedScene()
setUploadedInterpretedScenes(uploaded)
resetInterpretedScenes()

let config = testConfig()
let scene = init(sceneId, config, testLogger(config), %*{})
var context = ExecutionContext(
  scene: scene, event: "render", payload: %*{}, hasImage: false,
  loopIndex: 0, loopKey: ".", nextSleep: 0.0
)
let canvas = render(scene, context)

doAssert canvas.width == CanvasWidth and canvas.height == CanvasHeight

# The nested split must actually have rendered its cells, not silently skipped
# them: left column split in two horizontally, right column one colour.
proc at(x, y: int): ColorRGBX = canvas.unsafe[x, y]
let topLeft = at(CanvasWidth div 4, CanvasHeight div 4)
let bottomLeft = at(CanvasWidth div 4, CanvasHeight * 3 div 4)
let right = at(CanvasWidth * 3 div 4, CanvasHeight div 2)

doAssert topLeft != bottomLeft,
  "the inner split did not divide its cell: both halves are " & $topLeft
doAssert topLeft.r > 200 and topLeft.g < 60, "inner top cell should be red, got " & $topLeft
doAssert bottomLeft.g > 200 and bottomLeft.r < 60, "inner bottom cell should be green, got " & $bottomLeft
doAssert right.b > 200 and right.r < 60, "outer right cell should be blue, got " & $right

# What the nesting costs, stated rather than assumed. Each level holds a copy
# of its region while the level below renders, so the live set is the canvas
# plus one buffer per level on the deepest path — not the canvas alone.
let canvasBytes = CanvasWidth * CanvasHeight * 4
let outerCellBytes = (CanvasWidth div 2) * CanvasHeight * 4
let innerCellBytes = (CanvasWidth div 2) * (CanvasHeight div 2) * 4
let liveAtDeepest = canvasBytes + outerCellBytes + innerCellBytes

echo "test_nested_split_memory: nested split renders correctly"
echo "  canvas            ", canvasBytes, " B"
echo "  + outer cell copy ", outerCellBytes, " B"
echo "  + inner cell copy ", innerCellBytes, " B"
echo "  live at the deepest cell = ", liveAtDeepest, " B (",
  formatFloat(liveAtDeepest / canvasBytes, ffDecimal, 2), "x the canvas)"

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
