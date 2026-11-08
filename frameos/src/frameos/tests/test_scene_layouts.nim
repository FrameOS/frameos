import std/[json, tables, unittest, os, strutils]
import pixie
import ../events_gen
import ../interpreter
import ../scene_rhythm
import ../types

# Layouts, <yield /> and <Scene> (docs/scene-layouts.md), and the pass the
# canvas keeps for free. Each panel counts its runs in its state.

const
  W = 40
  H = 40

proc panel(id, hex: string, interval: float, extra = ""): string =
  """{"id": "$1", "name": "$1", "settings": {"execution": "interpreted", "refreshInterval": $3, "backgroundColor": "#000000"$4},
    "fields": [], "apps": {},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": "$2"}}},
      {"id": "3", "type": "app", "data": {"keyword": "logic/setAsState", "config": {"stateKey": "runs", "debugLog": "false"}}},
      {"id": "4", "type": "code", "data": {"codeJS": "(state.runs || 0) + 1", "codeArgs": [],
        "codeOutputs": [{"name": "valueJson", "type": "json"}]}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "3", "source": "4", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/valueJson"}]}""" % [id, hex, $interval, extra]

proc barLayout(id, chrome: string, interval: float, gap = "0"): string =
  """{"id": "$1", "name": "$1", "settings": {"execution": "interpreted", "refreshInterval": $3,
    "backgroundColor": "#00ff00", "splitScreenLayout": {"root": {}}, "isLayout": true},
    "fields": [], "apps": {},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/split", "config": {"rows": 2, "columns": 1, "margin": "0", "gap": "$4"}}},
      {"id": "3", "type": "scene", "data": {"keyword": "$2", "config": {}}},
      {"id": "4", "type": "scene", "data": {"keyword": "system/yield", "config": {}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "field/render_functions[1][1]", "target": "3", "targetHandle": "prev"},
      {"id": "3", "source": "2", "sourceHandle": "field/render_functions[2][1]", "target": "4", "targetHandle": "prev"}]}""" % [id, chrome, $interval, gap]

proc jsxScene(id, source: string, interval: float, extraSettings = "", extra = ""): string =
  let app = %*{"origin": "jsxUi", "name": "ui", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "ui", "category": "data", "output": [{"name": "image", "type": "image"}], "fields": []})}}
  """{"id": "$1", "name": "$1", "settings": {"execution": "interpreted", "refreshInterval": $2, "backgroundColor": "#000000"$3},
    "fields": [], "apps": {"jsxUi": $4}$5,
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "jsxUi", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}""" %
    [id, $interval, extraSettings, $app, extra]

proc withLayout(sceneJson, layoutId: string, state = "{}"): string =
  sceneJson.strip()[0 .. ^2] & """, "layout": {"sceneId": "$1", "state": $2}}""" % [layoutId, state]

const counterUi = """
let taps = 0
export function get(app) {
  return <div className={`w-full h-full ${taps ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => { taps++ }} />
}
"""

const sceneUi = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full bg-white">
      <div className="h-[10px] bg-black" />
      <Scene id="tests/child" title="hello" count={3} />
    </div>
  )
}
"""

const yieldUi = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-white" />
      <yield />
    </div>
  )
}
"""

let scenesJson = "[" & [
  panel("tests/chrome", "#ff0000", 1.0),
  barLayout("tests/layout", "tests/chrome", 300.0),
  panel("tests/content", "#0000ff", 600.0).withLayout("tests/layout"),
  panel("tests/alone", "#0000ff", 600.0).withLayout("tests/nowhere"),
  panel("tests/child", "#00ffff", 500.0),
  jsxScene("tests/embed", sceneUi, 300.0),
  jsxScene("tests/counter", counterUi, 3000.0).withLayout("tests/layout"),
  jsxScene("tests/uiLayout", yieldUi, 300.0, ""","isLayout": true"""),
  panel("tests/inUiLayout", "#0000ff", 600.0).withLayout("tests/uiLayout"),
  panel("tests/styled", "#0000ff", 600.0).withLayout("tests/layout", """{"title": "Mine"}"""),
].join(",") & "]"

let parsed = parseInterpretedScenes(scenesJson)
setUploadedInterpretedScenes(parsed)
setUploadedSceneOrder(@["tests/layout".SceneId, "tests/content".SceneId])
resetInterpretedScenes()

var logged: seq[JsonNode] = @[]

let config = FrameConfig(name: "layouts", mode: "rpios", width: W, height: H, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-layout-test-assets")

proc logger(): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) = logged.add(payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

proc newScene(id: string): FrameScene =
  logged = @[]
  init(id.SceneId, config, logger(), %*{})

proc pass(scene: FrameScene, canvas = newImage(W, H)): Image =
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(scene, context)

proc layoutOf(scene: FrameScene): FrameScene =
  InterpretedFrameScene(scene).sceneNodes[LayoutSceneKey]

proc panelOf(scene: FrameScene, id: string): FrameScene =
  for child in InterpretedFrameScene(scene).sceneNodes.values:
    if child.id.string == id:
      return child

proc runs(scene: FrameScene): int = scene.state{"runs"}.getInt()

proc color(image: Image, x, y: int): ColorRGBX = image.getPixel(image.dataIndex(x, y))

proc colored(hex: string): ColorRGBX = parseHtmlColor(hex).rgbx

suite "layouts":
  setup:
    rhythmClockOverride = 1000.0

  test "a layout's chrome and the scene it wraps render on their own schedules":
    let scene = newScene("tests/content")
    let first = pass(scene)
    let layout = scene.layoutOf
    let chrome = layout.panelOf("tests/chrome")
    check first.color(5, 5) == colored("#ff0000")
    check first.color(5, 35) == colored("#0000ff")
    check chrome.runs == 1 and scene.runs == 1
    # What a host reads: the chrome is due in a second, the content in ten minutes.
    check abs(scene.refreshInterval - 1.0) < 0.001
    rhythmClockOverride = 1001.0
    let second = pass(scene)
    check chrome.runs == 2 and scene.runs == 1
    check second.color(5, 5) == colored("#ff0000")
    check second.color(5, 35) == colored("#0000ff") # from its copy
    # The content's own interval is what schedules it, not the frame's pace.
    rhythmClockOverride = 1500.0
    discard pass(scene)
    check scene.runs == 1
    rhythmClockOverride = 1601.0
    discard pass(scene)
    check scene.runs == 2

  test "a layout takes its parameters from the install":
    let scene = newScene("tests/styled")
    discard pass(scene)
    check scene.layoutOf.state{"title"}.getStr() == "Mine"

  test "a layout that is not on the frame leaves the scene as it is, and says so once":
    let scene = newScene("tests/alone")
    let image = pass(scene)
    check image.color(5, 35) == colored("#0000ff")
    discard pass(scene)
    var said = 0
    for entry in logged:
      if entry{"event"}.getStr() == "layout:missing": inc said
    check said == 1

  test "a layout is in no scene order":
    check "tests/layout".SceneId notin sceneOrderSnapshot()
    check "tests/content".SceneId in sceneOrderSnapshot()

  test "a layout shown on its own has nothing to yield":
    let scene = newScene("tests/layout")
    let image = pass(scene)
    check image.color(5, 35) == rgbx(128, 128, 128, 255)

  test "taps go to the scene under them, in its own coordinates":
    let scene = newScene("tests/counter")
    let red = pass(scene)
    check red.color(5, 35) == colored("#ef4444")
    let tap = %*{"x": 5, "y": 35, "pointerId": 0, "pointerType": "mouse"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: tap, loopIndex: 0, loopKey: ".", nextSleep: -1))
    # Its handler ran: the scene is due whatever its interval, and redraws.
    rhythmClockOverride = 1000.01
    let green = pass(scene)
    check green.color(5, 35) == colored("#22c55e")

  test "a layout makes the dispatcher build pointer events for the scene inside it":
    # The content has handlers; the top scene's own list does not know that.
    let scene = newScene("tests/counter")
    discard pass(scene)
    check sceneListensTo(scene, "tap")

  test "a press on the chrome is not the content's":
    let scene = newScene("tests/counter")
    let before = pass(scene)
    let tap = %*{"x": 5, "y": 5, "pointerId": 0, "pointerType": "mouse"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: tap, loopIndex: 0, loopKey: ".", nextSleep: -1))
    rhythmClockOverride = 1000.01
    let after = pass(scene)
    check after.color(5, 35) == before.color(5, 35)

suite "a canvas that stays":
  var generation = 0'i64
  setup:
    rhythmClockOverride = 1000.0
    generation = 0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  teardown:
    rhythmCanvasGeneration = nil

  test "a panel not due is left alone: not run, not copied, not repainted":
    let scene = newScene("tests/content")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    let chrome = scene.layoutOf.panelOf("tests/chrome")
    check scene.rhythm.cells.len == 1 and scene.rhythm.cells[0].copy.isNil
    # A mark no run would leave: it survives only if nothing draws there.
    canvas[3, 35] = rgbx(9, 9, 9, 255)
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check chrome.runs == 2 and scene.runs == 1
    check canvas[3, 35] == rgbx(9, 9, 9, 255)
    check canvas.color(5, 5) == colored("#ff0000")

  test "a write the render did not make means the canvas no longer counts":
    let scene = newScene("tests/content")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 7
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    # Repainted: it draws again, its schedule untouched.
    check scene.runs == 2
    check abs(scene.rhythm.dueAt - 1600.0) < 0.001

  test "the other frame buffer holds the picture when this one is behind":
    let scene = newScene("tests/content")
    let a = newImage(W, H)
    let b = newImage(W, H)
    discard pass(scene, a)
    rhythmClockOverride = 1001.0
    discard pass(scene, b)
    check scene.runs == 1
    check b.color(5, 35) == colored("#0000ff") # out of the other buffer

suite "the frame's next wake":
  setup:
    rhythmClockOverride = 1000.0
    rhythmHoldFloor = false

  teardown:
    rhythmHoldFloor = false

  test "a layout follows its chrome on a real-time display":
    let scene = newScene("tests/content")
    discard pass(scene)
    check abs(scene.refreshInterval - 1.0) < 0.001

  test "e-paper and deep sleep keep a split's own interval as the fastest it wakes":
    rhythmHoldFloor = true
    let scene = newScene("tests/content")
    discard pass(scene)
    # The chrome's split waits out its own 300 s; the content (600 s) is later.
    check abs(scene.refreshInterval - 300.0) < 0.001

suite "<Scene> and <yield /> in JSX":
  setup:
    rhythmClockOverride = 1000.0

  test "a <Scene> draws as an image, gets its props as state, and renders on its schedule":
    let scene = newScene("tests/embed")
    let first = pass(scene)
    check first.color(5, 5) == rgbx(0, 0, 0, 255)
    check first.color(5, 30) == colored("#00ffff")
    let child = block:
      var found: FrameScene
      for key, value in InterpretedFrameScene(scene).sceneNodes:
        if key.int < 0: found = value
      found
    check child.state{"title"}.getStr() == "hello"
    check child.state{"count"}.getInt() == 3
    check child.runs == 1
    # Its 500 s is later than the scene's own 300 s, so the scene's wait stands.
    check abs(scene.refreshInterval - 300.0) < 0.001
    rhythmClockOverride = 1001.0
    let second = pass(scene)
    check child.runs == 1
    check second.color(5, 30) == colored("#00ffff")

  test "<yield /> in a JSX layout shows the scene it wraps":
    let scene = newScene("tests/inUiLayout")
    let image = pass(scene)
    check image.color(5, 5) == rgbx(255, 255, 255, 255)
    check image.color(5, 30) == colored("#0000ff")
    check scene.runs == 1
