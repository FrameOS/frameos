import std/[json, tables, unittest, os, strutils, sequtils]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime

# Windows (docs/scene-layouts.md "Windows"): on a host that keeps every scene
# it ran (the Pi's runner), a layout's <Scene id> is that host's own scene, so
# the frame's scenes run side by side and each is the same one when it comes
# forward. These tests play the host: a table of scenes, and a parked layout.

const
  W = 40
  H = 40

proc panel(id, hex: string, interval: float): string =
  """{"id": "$1", "name": "Panel $1", "settings": {"execution": "interpreted", "refreshInterval": $3, "backgroundColor": "#000000"},
    "fields": [], "apps": {},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": "$2"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}""" %
    [id, hex, $interval]

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

# The scene it wraps on the left half, every other open one on the right
# half, and, when asked, a strip over the top of the right half that takes a
# tap (a window's title bar, a menu).
const deskUi = """
export function get(app) {
  frameos.setState("seenId", app.frame.sceneId)
  frameos.setState("seenScenes", (app.frame.scenes || []).map((s) => s.id).join(","))
  return (
    <div className="relative w-full h-full bg-white">
      <div className="absolute left-0 top-0 w-[20px] h-[40px] flex"><yield /></div>
      {(app.state.open || []).map((id) => (
        <div className="absolute left-[20px] top-0 w-[20px] h-[40px] flex"><Scene id={id} marker="layout" /></div>
      ))}
      {app.state.cover ? (
        <div className="absolute left-[20px] top-0 w-[20px] h-[10px]"
          onClick={() => frameos.setState("covered", (app.state.covered || 0) + 1)} />
      ) : null}
    </div>
  )
}
"""

const counterUi = """
let taps = 0
export function get(app) {
  return <div className={`w-full h-full ${taps ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => { taps++ }} />
}
"""

let scenesJson = "[" & [
  jsxScene("tests/desk", deskUi, 300.0, ""","isLayout": true"""),
  panel("tests/blue", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/yellow"]}"""),
  panel("tests/yellow", "#ffff00", 600.0).withLayout("tests/desk"),
  panel("tests/twice", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/twice", "tests/yellow", "tests/yellow"]}"""),
  panel("tests/front", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/counter"]}"""),
  panel("tests/covered", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/counter2"], "cover": true}"""),
  jsxScene("tests/counter", counterUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/counter2", counterUi, 3000.0).withLayout("tests/desk"),
].join(",") & "]"

let parsed = parseInterpretedScenes(scenesJson)
setUploadedInterpretedScenes(parsed)
setUploadedSceneOrder(@["tests/blue".SceneId, "tests/yellow".SceneId])
resetInterpretedScenes()

let config = FrameConfig(name: "windows", mode: "rpios", width: W, height: H, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-windows-test-assets")

var logged: seq[JsonNode] = @[]

proc logger(): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) = logged.add(payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

# The host: every scene it has run, and the layout the last one left.
var
  hosted = initTable[string, FrameScene]()
  parked: FrameScene

proc hostScene(id: string): FrameScene =
  result = hosted.getOrDefault(id, nil)
  if result.isNil:
    result = init(id.SceneId, config, logger(), %*{})
    hosted[id] = result

hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
  {.cast(gcsafe).}:
    hostScene(sceneId.string)
windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
  %*[{"id": "tests/blue", "name": "Blue"}, {"id": "tests/yellow", "name": "Yellow"}]
takeParkedLayout = proc(layoutId: string): FrameScene {.nimcall.} =
  {.cast(gcsafe).}:
    if not parked.isNil and parked.id.string == layoutId:
      result = parked
      parked = nil

proc switchTo(fromScene: FrameScene, id: string): FrameScene =
  ## What runner.carryLayout does: the layout goes along.
  parked = fromScene.wornLayout
  fromScene.wornLayout = nil
  hostScene(id)

proc pass(scene: FrameScene, canvas = newImage(W, H)): Image =
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(scene, context)

proc tap(scene: FrameScene, x, y: int) =
  let payload = %*{"x": x, "y": y, "pointerId": 0, "pointerType": "mouse"}
  runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: payload, loopIndex: 0, loopKey: ".",
    nextSleep: -1))

proc color(image: Image, x, y: int): ColorRGBX = image.getPixel(image.dataIndex(x, y))

proc colored(hex: string): ColorRGBX = parseHtmlColor(hex).rgbx

suite "windows":
  setup:
    rhythmClockOverride = 1000.0
    hosted.clear()
    parked = nil
    logged = @[]

  test "a <Scene> in the layout is the host's own scene, not a copy":
    let blue = hostScene("tests/blue")
    let image = pass(blue)
    check image.color(5, 20) == colored("#0000ff")
    check image.color(30, 20) == colored("#ffff00")
    check hosted.hasKey("tests/yellow")
    check InterpretedFrameScene(blue.wornLayout).sceneNodes.len == 0
    var shown: seq[FrameScene]
    for slot in blue.wornLayout.slots:
      shown.add slot.child
    check hosted["tests/yellow"] in shown
    # The scene as it is: a copy's props would be its state, the scene's own is not touched.
    check hosted["tests/yellow"].state{"marker"}.isNil

  test "the scene it wraps and a scene twice are drawn once":
    let twice = hostScene("tests/twice")
    discard pass(twice)
    var ids: seq[string]
    for slot in twice.wornLayout.slots:
      ids.add slot.child.id.string
    check ids.count("tests/twice") == 1
    check ids.count("tests/yellow") == 1

  test "a layout is told the id of the scene it wraps and the scenes it can open":
    let blue = hostScene("tests/blue")
    discard pass(blue)
    check blue.wornLayout.state{"seenId"}.getStr() == "tests/blue"
    check blue.wornLayout.state{"seenScenes"}.getStr() == "tests/blue,tests/yellow"

  test "a tap on a window is that scene's, and it is the same scene when it comes forward":
    let front = hostScene("tests/front")
    check pass(front).color(30, 30) == colored("#ef4444")
    front.tap(30, 30)
    rhythmClockOverride = 1000.01
    check pass(front).color(30, 30) == colored("#22c55e")
    # The counter comes forward: the instance that was tapped, now in the yield.
    let counter = front.switchTo("tests/counter")
    check counter == hosted["tests/counter"]
    rhythmClockOverride = 1000.02
    let image = pass(counter)
    check image.color(5, 30) == colored("#22c55e")

  test "something of the layout's drawn over a window takes the pointer there":
    let covered = hostScene("tests/covered")
    discard pass(covered)
    covered.tap(30, 5)
    check covered.wornLayout.state{"covered"}.getInt() == 1
    rhythmClockOverride = 1000.01
    check pass(covered).color(30, 30) == colored("#ef4444")
    # Below the strip the window has it.
    covered.tap(30, 30)
    check covered.wornLayout.state{"covered"}.getInt() == 1
    rhythmClockOverride = 1000.02
    check pass(covered).color(30, 30) == colored("#22c55e")

  test "the layout goes along from scene to scene with what it keeps":
    let blue = hostScene("tests/blue")
    discard pass(blue)
    let layout = blue.wornLayout
    layout.state["kept"] = %"windows"
    let yellow = blue.switchTo("tests/yellow")
    rhythmClockOverride = 1000.01
    let image = pass(yellow)
    check yellow.wornLayout == layout
    check layout.state{"kept"}.getStr() == "windows"
    check layout.state{"seenId"}.getStr() == "tests/yellow"
    # The new scene in the yield; the open list still names yellow, which is
    # now the scene it wraps, so the right half shows nothing of it.
    check image.color(5, 20) == colored("#ffff00")
    check image.color(30, 20) == colored("#ffffff")
    check blue.wornLayout.isNil
