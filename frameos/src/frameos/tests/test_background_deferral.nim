import std/[json, os, tables, strutils]
import pixie
import ../interpreter
import ../types
import ../utils/image

# A render owes the canvas the scene's background instead of painting it
# first (ExecutionContext.backgroundPending): whatever draws first pays it,
# and a first paint that covers the canvas opaquely — a JS app's SVG that
# starts with a full-canvas rect, drawn through render/image straight into
# the canvas — waives it. Everything else must look exactly as before: the
# canvas below starts out a colour no scene uses, so a background that was
# owed and never paid shows as that colour.

const
  Width = 96
  Height = 64
  Sentinel = rgbx(255, 0, 255, 255)

proc testLogger(): Logger =
  var logger = Logger(enabled: false)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  logger

proc svgApp(body: string): JsonNode =
  ## A JS app whose get() returns the given SVG body at the canvas size.
  let source = "export function get(app, context) {\n" &
    "  const W = app.frame.width, H = app.frame.height\n" &
    "  return frameos.svg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"' + W + '\" height=\"' + H + " &
    "'\" viewBox=\"0 0 ' + W + ' ' + H + '\">" & body & "</svg>', { width: W, height: H })\n}\n"
  %*{
    "name": "svg", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}],
    "sources": {"app.ts": source}
  }

proc svgScene(body: string): JsonNode =
  %*[{
    "id": "deferral", "name": "Deferral",
    "settings": {"execution": "interpreted", "backgroundColor": "#00ff00"},
    "fields": [],
    "apps": {"svg": svgApp(body)},
    "nodes": [
      {"id": "render", "type": "event", "data": {"keyword": "render"}},
      {"id": "art", "type": "app", "data": {"keyword": "svg", "config": {}}},
      {"id": "draw", "type": "app", "data": {"keyword": "render/image",
        "config": {"placement": "stretch", "blendMode": "normal"}}}
    ],
    "edges": [
      {"id": "e1", "type": "appNodeEdge", "source": "render", "target": "draw",
       "sourceHandle": "next", "targetHandle": "prev"},
      {"id": "e2", "type": "codeNodeEdge", "source": "art", "target": "draw",
       "sourceHandle": "fieldOutput", "targetHandle": "fieldInput/image"}
    ]
  }]

proc render(scenes: JsonNode): Image =
  let inputs = parseInterpretedSceneInputs($scenes)
  doAssert inputs.len == 1
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in buildInterpretedScenes(inputs):
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  let config = FrameConfig(
    name: "test", mode: "rpios", width: Width, height: Height, rotate: 0,
    scalingMode: "cover", assetsPath: getTempDir(), debug: false,
    settings: %*{}, saveAssets: %*false
  )
  let scene = init(inputs[0].id, config, testLogger(), %*{})
  # A canvas with something else on it already: an ESP32's persistent canvas
  # holds the last frame, an LCD's back buffer the one before that.
  let canvas = newImage(Width, Height)
  canvas.fill(Sentinel)
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, image: canvas, hasImage: true,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  result = interpreter.render(scene, context)
  doAssert not context.backgroundPending, "the render left the background owed"
  setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

proc count(image: Image, color: ColorRGBX): int =
  for c in image:
    if c == color:
      inc result

block:
  # The DVD logo's shape: a full-canvas opaque rect first. The background is
  # never painted, and the rect is everywhere the circle is not.
  backgroundPaintsForTest = 0
  let image = render(svgScene(
    "<rect x=\"0\" y=\"0\" width=\"' + W + '\" height=\"' + H + '\" fill=\"#ff0000\"/>" &
    "<circle cx=\"48\" cy=\"32\" r=\"8\" fill=\"#0000ff\"/>"))
  doAssert backgroundPaintsForTest == 0, "a covering SVG still paid the background: " & $backgroundPaintsForTest
  doAssert image.count(Sentinel) == 0
  doAssert image.count(rgbx(0, 255, 0, 255)) == 0, "the background shows through a covering rect"
  doAssert image[0, 0] == rgbx(255, 0, 0, 255)
  doAssert image[Width - 1, Height - 1] == rgbx(255, 0, 0, 255)
  doAssert image[48, 32] == rgbx(0, 0, 255, 255)

block:
  # An SVG that does not cover: the background goes down first, once.
  backgroundPaintsForTest = 0
  let image = render(svgScene("<circle cx=\"48\" cy=\"32\" r=\"8\" fill=\"#0000ff\"/>"))
  doAssert backgroundPaintsForTest == 1, $backgroundPaintsForTest
  doAssert image.count(Sentinel) == 0
  doAssert image[0, 0] == rgbx(0, 255, 0, 255)
  doAssert image[48, 32] == rgbx(0, 0, 255, 255)

block:
  # A translucent full-canvas rect does not cover: it blends with the background.
  backgroundPaintsForTest = 0
  let image = render(svgScene(
    "<rect width=\"' + W + '\" height=\"' + H + '\" fill=\"#ff0000\" fill-opacity=\"0.5\"/>"))
  doAssert backgroundPaintsForTest == 1, $backgroundPaintsForTest
  doAssert image.count(Sentinel) == 0
  let p = image[10, 10]
  doAssert p.r > 100 and p.g > 100 and p.b == 0, "not red over green: " & $p

block:
  # A first node that is not a fused image: the background is painted before
  # it draws.
  backgroundPaintsForTest = 0
  let scenes = %*[{
    "id": "deferral", "name": "Deferral",
    "settings": {"execution": "interpreted", "backgroundColor": "#00ff00"},
    "fields": [], "apps": {},
    "nodes": [
      {"id": "render", "type": "event", "data": {"keyword": "render"}},
      {"id": "box", "type": "app", "data": {"keyword": "render/color",
        "config": {"color": "#0000ff"}}}
    ],
    "edges": [
      {"id": "e1", "type": "appNodeEdge", "source": "render", "target": "box",
       "sourceHandle": "next", "targetHandle": "prev"}
    ]
  }]
  let image = render(scenes)
  doAssert backgroundPaintsForTest == 1, $backgroundPaintsForTest
  doAssert image.count(Sentinel) == 0

block:
  # Nothing draws at all: the frame still shows the background.
  backgroundPaintsForTest = 0
  let scenes = %*[{
    "id": "deferral", "name": "Deferral",
    "settings": {"execution": "interpreted", "backgroundColor": "#00ff00"},
    "fields": [], "apps": {},
    "nodes": [{"id": "render", "type": "event", "data": {"keyword": "render"}}],
    "edges": []
  }]
  let image = render(scenes)
  doAssert backgroundPaintsForTest == 1, $backgroundPaintsForTest
  doAssert image.count(rgbx(0, 255, 0, 255)) == Width * Height

block:
  # An app that throws: its error is drawn over the background, not over the
  # last frame.
  backgroundPaintsForTest = 0
  var scenes = svgScene("")
  scenes[0]["apps"]["svg"]["sources"]["app.ts"] = %"export function get() { throw new Error('nope') }\n"
  let image = render(scenes)
  doAssert image.count(Sentinel) == 0, "the error frame left the old canvas showing"

echo "background deferral ok"
