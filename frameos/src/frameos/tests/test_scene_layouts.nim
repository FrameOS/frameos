import std/[json, tables, unittest, os, strutils]
import pixie
import ../channels
import ../events_gen
import ../interpreter
import ../layout_choice
import ../scene_rhythm
import ../types
import system/sceneSwitcher/scene as switcher

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

proc splitScene(id, top, bottom: string, interval: float): string =
  ## A generated split with a scene in each row: what stays on the canvas.
  """{"id": "$1", "name": "$1", "settings": {"execution": "interpreted", "refreshInterval": $4,
    "backgroundColor": "#00ff00", "splitScreenLayout": {"root": {}}},
    "fields": [], "apps": {},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/split", "config": {"rows": 2, "columns": 1, "margin": "0", "gap": "0"}}},
      {"id": "3", "type": "scene", "data": {"keyword": "$2", "config": {}}},
      {"id": "4", "type": "scene", "data": {"keyword": "$3", "config": {}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "field/render_functions[1][1]", "target": "3", "targetHandle": "prev"},
      {"id": "3", "source": "2", "sourceHandle": "field/render_functions[2][1]", "target": "4", "targetHandle": "prev"}]}""" % [id, top, bottom, $interval]

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

# A clock bar's worth of chrome, counting its own runs.
const chromeUi = """
export function get(app) {
  frameos.setState("runs", (app.state.runs || 0) + 1)
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-[#ff0000]" />
      <yield />
    </div>
  )
}
"""

# A taskbar's worth of asking: the name of the scene inside, and two buttons
# that send events, one a scene may send and one it may not.
const taskbarUi = """
export function get(app) {
  frameos.setState("named", app.frame.sceneName)
  frameos.setState("uiRuns", (app.state.uiRuns || 0) + 1)
  frameos.setNextSleep(30)
  return (
    <div className="flex flex-col w-full h-full">
      <yield />
      <div className="flex h-[10px]">
        <div className="flex-1 bg-white" onClick={() => frameos.dispatch('sceneSwitcher')} />
        <div className="flex-1 bg-black" onClick={() => frameos.dispatch('reboot')} />
      </div>
    </div>
  )
}
"""

# Two scenes side by side under a bar, counting the UI's own runs.
const twoScenesUi = """
export function get(app) {
  frameos.setState("uiRuns", (app.state.uiRuns || 0) + 1)
  return (
    <div className="flex flex-col w-full h-full bg-white">
      <div className="h-[10px] bg-black" />
      <div className="flex flex-1">
        <Scene id="tests/child" />
        <Scene id="tests/fastChild" />
      </div>
    </div>
  )
}
"""

# The same with something painted over the first of them.
const coveredSceneUi = """
export function get(app) {
  return (
    <div className="relative w-full h-full bg-white">
      <div className="absolute inset-0 flex"><Scene id="tests/child" /></div>
      <div className="absolute top-[30px] left-[5px] w-[10px] h-[5px] bg-black" />
    </div>
  )
}
"""

const escapingUi = """
export function get(app) {
  if (app.frame.systemScene) return <yield />
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-white" />
      <yield />
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

# Counts its own runs in a state field, so a test can see a pass that did not
# enter it at all.
const countedYieldUi = """
export function get(app) {
  frameos.setState("uiRuns", (app.state.uiRuns || 0) + 1)
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-white" />
      <yield />
    </div>
  )
}
"""

const fadedYieldUi = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-white" />
      <div className="flex-1 opacity-50 flex"><yield /></div>
    </div>
  )
}
"""

const coveredYieldUi = """
export function get(app) {
  return (
    <div className="relative w-full h-full">
      <div className="absolute inset-0 flex"><yield /></div>
      <div className="absolute top-[30px] left-[5px] w-[10px] h-[5px] bg-white" />
    </div>
  )
}
"""

# A layout that only moves its hole when told to.
const movingYieldUi = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className={app.config.tall ? "h-[30px] bg-white" : "h-[20px] bg-white"} />
      <yield />
    </div>
  )
}
"""

proc listeningScene(id, source, events: string): string =
  let app = %*{"origin": "listener", "name": "listener", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "listener", "category": "data", "output": [{"name": "image", "type": "image"}],
        "fields": [], "events": parseJson(events)})}}
  """{"id": "$1", "name": "$1", "settings": {"execution": "interpreted", "refreshInterval": 300, "backgroundColor": "#000000"},
    "fields": [], "apps": {"listener": $2},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "listener", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}""" %
    [id, $app]

const listenerUi = """
export function get(app) {
  return <div className="w-full h-full bg-black" />
}
export function onEvent(app, context) {
  const heard = app.state.heard || []
  heard.push(context.event + ":" + (context.payload.label || ""))
  frameos.setState("heard", heard)
  return context.payload.label === "redraw"
}
"""

# A <Scene> inside a box that clips, away from the canvas's corner.
const clippedSceneUi = """
export function get(app) {
  return (
    <div className="relative w-full h-full bg-black">
      <div className="absolute left-[10px] top-[10px] w-[20px] h-[20px] overflow-hidden flex">
        <Scene id="tests/tapTarget" />
      </div>
    </div>
  )
}
"""

# The same in a box that scrolls: the scene starts below what shows.
const scrolledSceneUi = """
export function get(app) {
  return (
    <div className="relative w-full h-full bg-black">
      <div className="absolute left-[10px] top-[10px] w-[20px] h-[20px] overflow-y-auto flex flex-col">
        <div className="h-[20px] shrink-0 bg-white" />
        <div className="h-[20px] shrink-0 flex"><Scene id="tests/tapTarget2" /></div>
      </div>
    </div>
  )
}
"""

const listenerYieldUi = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[20px] bg-white" />
      <yield />
    </div>
  )
}
export function onEvent(app, context) {
  return context.payload.label === "redraw"
}
"""

let scenesJson = "[" & [
  panel("tests/chrome", "#ff0000", 1.0),
  jsxScene("tests/layout", chromeUi, 1.0, ""","isLayout": true"""),
  panel("tests/splitContent", "#0000ff", 600.0),
  splitScene("tests/split", "tests/chrome", "tests/splitContent", 300.0),
  panel("tests/content", "#0000ff", 600.0).withLayout("tests/layout"),
  panel("tests/alone", "#0000ff", 600.0).withLayout("tests/nowhere"),
  panel("tests/child", "#00ffff", 500.0),
  jsxScene("tests/embed", sceneUi, 300.0),
  jsxScene("tests/counter", counterUi, 3000.0).withLayout("tests/layout"),
  jsxScene("tests/uiLayout", yieldUi, 300.0, ""","isLayout": true"""),
  panel("tests/inUiLayout", "#0000ff", 600.0).withLayout("tests/uiLayout"),
  panel("tests/styled", "#0000ff", 600.0).withLayout("tests/layout", """{"title": "Mine"}"""),
  jsxScene("tests/holeLayout", countedYieldUi, 1.0, ""","isLayout": true"""),
  panel("tests/inHole", "#0000ff", 600.0).withLayout("tests/holeLayout"),
  panel("tests/fastInHole", "#0000ff", 0.05).withLayout("tests/holeLayout"),
  jsxScene("tests/counter2", counterUi, 3000.0).withLayout("tests/holeLayout"),
  jsxScene("tests/escaping", escapingUi, 1.0, ""","isLayout": true"""),
  panel("tests/fastChild", "#ff00ff", 1.0),
  jsxScene("tests/twoHoles", twoScenesUi, 300.0),
  jsxScene("tests/coveredScene", coveredSceneUi, 300.0),
  jsxScene("tests/twoHolesInLayout", twoScenesUi, 300.0).withLayout("tests/holeLayout"),
  jsxScene("tests/taskbar", taskbarUi, 1.0, ""","isLayout": true"""),
  panel("tests/inTaskbar", "#0000ff", 600.0).withLayout("tests/taskbar"),
  jsxScene("tests/fadedLayout", fadedYieldUi, 300.0, ""","isLayout": true"""),
  panel("tests/inFaded", "#0000ff", 600.0).withLayout("tests/fadedLayout"),
  jsxScene("tests/coveredLayout", coveredYieldUi, 300.0, ""","isLayout": true"""),
  panel("tests/inCovered", "#0000ff", 600.0).withLayout("tests/coveredLayout"),
  listeningScene("tests/named", listenerUi, """["button"]"""),
  listeningScene("tests/everything", listenerUi, """["*"]"""),
  listeningScene("tests/bothWays", listenerUi, """["*", "pointerMove", "button"]"""),
  listeningScene("tests/noHandler", """export function get(app) { return <div className="w-full h-full" /> }""", """["button"]"""),
  listeningScene("tests/layoutHears", listenerUi, """["button"]""").replace(""""refreshInterval": 300""", """"refreshInterval": 300, "isLayout": true"""),
  panel("tests/wearsListener", "#0000ff", 600.0).withLayout("tests/layoutHears"),
  jsxScene("tests/tapTarget", counterUi, 3000.0),
  jsxScene("tests/tapTarget2", counterUi, 3000.0),
  jsxScene("tests/clippedScene", clippedSceneUi, 300.0),
  jsxScene("tests/scrolledScene", scrolledSceneUi, 300.0),
  listeningScene("tests/holeHears", listenerYieldUi, """["button"]""").replace(""""refreshInterval": 300""", """"refreshInterval": 300, "isLayout": true"""),
  panel("tests/wearsHoleListener", "#0000ff", 600.0).withLayout("tests/holeHears"),
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

proc holeIn(scene: FrameScene): tuple[found: bool, x, y, w, h: int] =
  for slot in scene.slots:
    if slot.hole:
      return (true, slot.x.int, slot.y.int, int(slot.visible[2] - slot.x), int(slot.visible[3] - slot.y))

proc layoutOf(scene: FrameScene): FrameScene =
  scene.wornLayout

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
    check first.color(5, 5) == colored("#ff0000")
    check first.color(5, 35) == colored("#0000ff")
    check layout.runs == 1 and scene.runs == 1
    # What a host reads: the chrome is due in a second, the content in ten minutes.
    check abs(scene.refreshInterval - 1.0) < 0.001
    rhythmClockOverride = 1001.0
    let second = pass(scene)
    check layout.runs == 2 and scene.runs == 1
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
    check image.color(5, 5) == colored("#ff0000")
    check image.color(5, 35) == rgbx(0, 0, 0, 255)

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

  test "a layout is told the name of the scene it wraps":
    let scene = newScene("tests/inTaskbar")
    discard pass(scene)
    check scene.layoutOf.state{"named"}.getStr() == "tests/inTaskbar"

  test "a handler can send what a scene may send, and only that":
    let scene = newScene("tests/inTaskbar")
    discard pass(scene)
    proc tapped(x: int): seq[string] =
      let tap = %*{"x": x, "y": 35, "pointerId": 0, "pointerType": "mouse"}
      runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: tap, loopIndex: 0, loopKey: ".", nextSleep: -1))
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        result.add message[1]
    check "sceneSwitcher" in tapped(5)
    check "reboot" notin tapped(35)
    check ($logged).contains("runtimeVerb")

  test "a layout makes the dispatcher build pointer events for the scene inside it":
    # The content has handlers; the top scene's own list does not know that.
    let scene = newScene("tests/counter")
    discard pass(scene)
    check sceneListensTo(scene, "tap")

  test "an event nobody on the way listens for ends the asking":
    # The layout's panel is the scene that wears it: asking round that circle
    # overflowed the stack on every tap an ESP32 had no listener for.
    let scene = newScene("tests/content")
    discard pass(scene)
    check not sceneListensTo(scene, "pointerDown")
    # And a <yield /> in a JSX layout, whose slot is made while it draws.
    let inUi = newScene("tests/inUiLayout")
    discard pass(inUi)
    check not sceneListensTo(inUi, "swipe")

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
    let scene = newScene("tests/split")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    let chrome = scene.panelOf("tests/chrome")
    let content = scene.panelOf("tests/splitContent")
    check not content.rhythm.cells.isNil and content.rhythm.cells.next.isNil and content.rhythm.cells.copy.isNil
    # A mark no run would leave: it survives only if nothing draws there.
    canvas[3, 35] = rgbx(9, 9, 9, 255)
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check chrome.runs == 2 and content.runs == 1
    check canvas[3, 35] == rgbx(9, 9, 9, 255)
    check canvas.color(5, 5) == colored("#ff0000")

  test "a write the render did not make means the canvas no longer counts":
    let scene = newScene("tests/split")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    let content = scene.panelOf("tests/splitContent")
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 7
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    # Repainted: it draws again, its schedule untouched.
    check content.runs == 2
    check abs(content.rhythm.dueAt - 1600.0) < 0.001

  test "the other frame buffer holds the picture when this one is behind":
    let scene = newScene("tests/split")
    let a = newImage(W, H)
    let b = newImage(W, H)
    discard pass(scene, a)
    rhythmClockOverride = 1001.0
    discard pass(scene, b)
    check scene.panelOf("tests/splitContent").runs == 1
    check b.color(5, 35) == colored("#0000ff") # out of the other buffer

  test "a built-in scene drawn over the canvas leaves nothing to keep":
    # Back from the switcher, a panel that is not due must not stay as the
    # switcher's picture: the switcher draws outside the rhythm.
    let scene = newScene("tests/split")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    let built = switcher.exportedScene.init(SceneSwitcherId.SceneId, config, logger(), %*{})
    discard switcher.exportedScene.render(built, ExecutionContext(scene: built, event: "render",
      payload: %*{}, image: canvas, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check scene.panelOf("tests/splitContent").runs == 2
    check canvas.color(5, 35) == colored("#0000ff")

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
    let scene = newScene("tests/split")
    discard pass(scene)
    check abs(scene.refreshInterval - 300.0) < 0.001

  test "e-paper and deep sleep do not wake for a layout's clock":
    rhythmHoldFloor = true
    let scene = newScene("tests/content")
    discard pass(scene)
    check abs(scene.refreshInterval - 600.0) < 0.001

suite "the loading mark and a layout":
  setup:
    rhythmClockOverride = 1000.0
    rhythmHoldFloor = false

  test "a pass that only ticks the clock bar is not waited for; one that runs the scene is":
    let scene = newScene("tests/content")
    discard pass(scene)
    check scene.layoutPaced
    check not rhythmAwaited(scene)
    rhythmClockOverride = 1001.0
    check not rhythmAwaited(scene)
    rhythmClockOverride = 1599.0
    check rhythmAwaited(scene)

  test "somebody asking for a render waits for it":
    let scene = newScene("tests/content")
    discard pass(scene)
    rhythmRequestFreshPass()
    check rhythmAwaited(scene)
    rhythmClockOverride = 1001.0
    discard pass(scene) # the pass that request asked for

  test "a scene that repeats within seconds is not waited for, layout or none":
    let inLayout = newScene("tests/fastInHole")
    discard pass(inLayout)
    rhythmClockOverride = 1001.0
    check not rhythmAwaited(inLayout)
    let bare = newScene("tests/chrome")
    discard pass(bare)
    check not rhythmAwaited(bare)

  test "a slow scene without a layout is waited for":
    let scene = newScene("tests/child")
    discard pass(scene)
    check rhythmAwaited(scene)

suite "a <yield /> that is a hole":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  teardown:
    rhythmCanvasGeneration = nil

  proc uiRuns(scene: FrameScene): int = scene.layoutOf.state{"uiRuns"}.getInt()

  test "the content draws in the canvas and the chrome around it":
    let scene = newScene("tests/inHole")
    let canvas = newImage(W, H)
    let image = pass(scene, canvas)
    check image == canvas
    check image.color(5, 5) == rgbx(255, 255, 255, 255)
    check image.color(5, 30) == colored("#0000ff")
    check scene.layoutOf.holeIn.y == 20 and scene.layoutOf.holeIn.h == 20
    # No picture of it was made to composite.
    check scene.rhythm.isNil or scene.rhythm.embedImage.isNil

  test "a pass for the content alone does not enter the layout":
    let scene = newScene("tests/fastInHole")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check scene.uiRuns == 1 and scene.runs == 1
    for tick in 1 .. 5:
      rhythmClockOverride = 1000.0 + tick.float * 0.1
      discard pass(scene, canvas)
    check scene.uiRuns == 1 and scene.runs == 6
    # Its second is up: the chrome draws again, once.
    rhythmClockOverride = 1001.2
    discard pass(scene, canvas)
    check scene.uiRuns == 2
    check canvas.color(5, 5) == rgbx(255, 255, 255, 255)
    check canvas.color(5, 30) == colored("#0000ff")

  test "the frame wakes for what is due first, chrome or content":
    let scene = newScene("tests/inHole")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check abs(scene.refreshInterval - 1.0) < 0.001
    let fast = newScene("tests/fastInHole")
    discard pass(fast, canvas)
    check abs(fast.refreshInterval - 0.05) < 0.001

  test "the chrome is left alone when it is not due, and so is the content":
    let scene = newScene("tests/inHole")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    canvas[3, 3] = rgbx(9, 9, 9, 255)
    canvas[3, 35] = rgbx(8, 8, 8, 255)
    # The pass a tap or a render of its own would start; nothing is due.
    rhythmClockOverride = 1000.2
    discard pass(scene, canvas)
    check scene.uiRuns == 1 and scene.runs == 1
    check canvas[3, 3] == rgbx(9, 9, 9, 255)
    check canvas[3, 35] == rgbx(8, 8, 8, 255)

  test "a <Scene> is a hole, and a UI that is not due sits out when only it is":
    let scene = newScene("tests/twoHoles")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check scene.state{"uiRuns"}.getInt() == 1
    check scene.slots.len == 2 and scene.slots[0].hole and scene.slots[1].hole
    let slow = scene.panelOf("tests/child")
    let fast = scene.panelOf("tests/fastChild")
    check slow.rhythm.embedImage.isNil and fast.rhythm.embedImage.isNil
    check canvas.color(5, 25) == colored("#00ffff")
    check canvas.color(35, 25) == colored("#ff00ff")
    check canvas.color(5, 5) == colored("#000000")
    canvas[3, 3] = rgbx(9, 9, 9, 255)
    canvas[5, 25] = rgbx(8, 8, 8, 255)
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check scene.state{"uiRuns"}.getInt() == 1
    check fast.runs == 2 and slow.runs == 1
    check canvas[3, 3] == rgbx(9, 9, 9, 255)   # the chrome was not touched
    check canvas[5, 25] == rgbx(8, 8, 8, 255)  # nor the scene that was not due
    rhythmClockOverride = 1300.0
    discard pass(scene, canvas)
    check scene.state{"uiRuns"}.getInt() == 2

  test "a <Scene> inside a scene inside a layout's hole is a hole too":
    let scene = newScene("tests/twoHolesInLayout")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check scene.state{"uiRuns"}.getInt() == 1
    check scene.slots.len == 2 and scene.slots[1].hole
    let fast = scene.panelOf("tests/fastChild")
    let first = fast.runs
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check scene.state{"uiRuns"}.getInt() == 1
    check fast.runs == first + 1
    check canvas.color(35, 35) == colored("#ff00ff")

  test "a <Scene> with something over it stays a picture":
    let scene = newScene("tests/coveredScene")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check not scene.slots[0].hole
    check canvas.color(20, 20) == colored("#00ffff")
    check canvas.color(10, 32) == colored("#000000")

  test "chrome that sets its next sleep is left alone until then":
    let scene = newScene("tests/inTaskbar")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check scene.uiRuns == 1
    rhythmClockOverride = 1005.0
    discard pass(scene, canvas)
    check scene.uiRuns == 1
    rhythmClockOverride = 1031.0
    discard pass(scene, canvas)
    check scene.uiRuns == 2

  test "chrome that ticks leaves the content's pixels":
    let scene = newScene("tests/inHole")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    canvas[3, 35] = rgbx(8, 8, 8, 255)
    rhythmClockOverride = 1001.0
    discard pass(scene, canvas)
    check scene.uiRuns == 2 and scene.runs == 1
    check canvas[3, 35] == rgbx(8, 8, 8, 255)

  test "another frame buffer's chrome is copied around the hole":
    let scene = newScene("tests/inHole")
    let a = newImage(W, H)
    let b = newImage(W, H)
    discard pass(scene, a)
    rhythmClockOverride = 1000.2
    discard pass(scene, b)
    check scene.uiRuns == 1
    check b.color(5, 5) == rgbx(255, 255, 255, 255)
    check b.color(5, 30) == colored("#0000ff") # the content's, from a's hole as a panel's

  test "something drawn over the canvas means the chrome runs again":
    let scene = newScene("tests/inHole")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    rhythmForgetCanvases()
    rhythmClockOverride = 1000.2
    discard pass(scene, canvas)
    check scene.uiRuns == 2

  test "taps reach the content through the hole, on a pass the layout sat out too":
    let scene = newScene("tests/counter2")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    rhythmClockOverride = 1000.1
    discard pass(scene, canvas)
    let tap = %*{"x": 5, "y": 35, "pointerId": 0, "pointerType": "mouse"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: tap, loopIndex: 0, loopKey: ".", nextSleep: -1))
    rhythmClockOverride = 1000.2
    discard pass(scene, canvas)
    check canvas.color(5, 35) == colored("#22c55e")
    check scene.uiRuns == 1

  test "a yield under opacity or under something else is composited instead":
    let faded = newScene("tests/inFaded")
    let image = pass(faded, newImage(W, H))
    check not faded.layoutOf.holeIn.found
    check image.color(5, 30) != colored("#0000ff") # half through
    let covered = newScene("tests/inCovered")
    let picture = pass(covered, newImage(W, H))
    check not covered.layoutOf.holeIn.found
    check picture.color(5, 5) == colored("#0000ff")
    check picture.color(7, 32) == rgbx(255, 255, 255, 255) # the overlay, on top

suite "apps that subscribe to events":
  setup:
    rhythmClockOverride = 1000.0

  proc fire(scene: FrameScene, event: string, payload = %*{"label": "A"}) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload,
      loopIndex: 0, loopKey: ".", nextSleep: -1))

  proc heard(scene: FrameScene): seq[string] =
    for item in scene.state{"heard"}.getElems():
      result.add item.getStr()

  test "an app hears the events its config.json names":
    let scene = newScene("tests/named")
    check sceneListensTo(scene, "button")
    check not sceneListensTo(scene, "keyDown")
    scene.fire("button")
    scene.fire("keyDown")
    check scene.heard == @["button:A"]

  test "* hears what a scene can listen for, not motion, not old names, not its own render":
    let scene = newScene("tests/everything")
    for event in ["button", "tap", "keyDown", "open"]:
      check sceneListensTo(scene, event)
    # (its render is the scene's own event node, which is why it is not here)
    for event in ["pointerMove", "mouseMove", "mouseDown", "uiTimer", "init", "setSceneState"]:
      check not sceneListensTo(scene, event)
    discard pass(scene)
    check scene.heard.len == 0
    check sceneListensTo(scene, "myOwnEvent") # a custom event
    scene.fire("myOwnEvent")
    scene.fire("pointerMove", %*{"label": "moved"})
    check scene.heard == @["myOwnEvent:A"]

  test "a name next to * is heard, and only once":
    let scene = newScene("tests/bothWays")
    check sceneListensTo(scene, "pointerMove")
    scene.fire("pointerMove", %*{"label": "moved"})
    scene.fire("button")
    check scene.heard == @["pointerMove:moved", "button:A"]

  test "returning true draws a layout with a hole again, whatever its interval":
    let scene = newScene("tests/wearsHoleListener")
    discard pass(scene)
    check scene.layoutOf.holeIn.found
    check scene.layoutOf.rhythm.chromeDueAt > 1000.0
    scene.fire("button", %*{"label": "nothing"})
    check scene.layoutOf.rhythm.chromeDueAt > 1000.0
    scene.fire("button", %*{"label": "redraw"})
    check scene.layoutOf.rhythm.dueAt == 0

  test "an app that lists events and has no onEvent says so and nothing breaks":
    let scene = newScene("tests/noHandler")
    scene.fire("button")
    var said = false
    for entry in logged:
      if ($entry).contains("has no onEvent"): said = true
    check said

  test "a layout's app hears a button after the scene it wraps":
    let scene = newScene("tests/wearsListener")
    discard pass(scene)
    check sceneListensTo(scene, "button")
    scene.fire("button")
    check scene.layoutOf.heard == @["button:A"]

suite "the layout chosen on the frame":
  setup:
    rhythmClockOverride = 1000.0

  teardown:
    chooseLayout("")

  test "it goes on every scene, whatever each was given, and can take them all off":
    let wears = newScene("tests/content")
    let bare = newScene("tests/child")
    chooseLayout("tests/uiLayout")
    discard pass(wears)
    discard pass(bare)
    check wears.layoutOf.id.string == "tests/uiLayout"
    check bare.layoutOf.id.string == "tests/uiLayout"
    chooseLayout(NoLayout)
    rhythmClockOverride = 1001.0
    discard pass(wears)
    check wears.wornLayout.isNil
    chooseLayout("")
    rhythmClockOverride = 1002.0
    discard pass(wears)
    check wears.layoutOf.id.string == "tests/layout"

  test "what was set on the frame for a layout is what it starts from":
    saveLayoutState("tests/uiLayout", %*{"title": "From the frame"})
    chooseLayout("tests/uiLayout")
    let scene = newScene("tests/content")
    discard pass(scene)
    check scene.layoutOf.state{"title"}.getStr() == "From the frame"
    saveLayoutState("tests/uiLayout", %*{})

suite "a layout around the built-in scenes":
  setup:
    rhythmClockOverride = 1000.0
    logged = @[]

  proc opened(layoutId: string): FrameScene =
    result = switcher.exportedScene.init(SceneSwitcherId.SceneId, config, logger(), %*{})
    switcher.exportedScene.runEvent(result, ExecutionContext(scene: result, event: "setCurrentScene",
      payload: %*{"state": {"from": "tests/content", "layout": {"sceneId": layoutId}}},
      loopIndex: 0, loopKey: ".", nextSleep: -1))

  proc drawn(scene: FrameScene): Image =
    switcher.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
      image: newImage(W, H), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))

  test "the scene list is drawn inside the layout of the scene it was opened from":
    let scene = opened("tests/uiLayout")
    let canvas = drawn(scene)
    check canvas.color(5, 5) == colored("#ffffff")
    check not scene.wornLayout.isNil and scene.wornLayout.holeIn.found
    check scene.wornLayout.holeIn.y == 20
    check canvas.color(20, 30) != colored("#ffffff")

  test "a layout can give a built-in scene the whole panel":
    let scene = opened("tests/escaping")
    let canvas = drawn(scene)
    check canvas.color(5, 5) != colored("#ffffff")
    check scene.wornLayout.holeIn.y == 0 and scene.wornLayout.holeIn.h == H

  test "opened from a scene with no layout it wears none":
    let scene = switcher.exportedScene.init(SceneSwitcherId.SceneId, config, logger(), %*{})
    discard drawn(scene)
    check scene.wornLayout.isNil

suite "the starter layouts":
  # Every sample that is a layout, on the runtime it ships for: its chrome and
  # the scene it wraps, the content straight in the canvas.
  setup:
    rhythmClockOverride = 1000.0

  teardown:
    setUploadedInterpretedScenes(parsed)
    resetInterpretedScenes()

  let samples = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  var found = 0
  for kind, path in walkDir(samples):
    if kind != pcDir or not fileExists(path / "scenes.json"):
      continue
    let starter = parseJson(readFile(path / "scenes.json"))[0]
    if not starter{"settings"}{"isLayout"}.getBool(false):
      continue
    inc found
    test path.extractFilename & " is a hole":
      let content = parseJson(panel("tests/starterContent", "#0000ff", 600.0))
      content["layout"] = %*{"sceneId": starter["id"].getStr()}
      setUploadedInterpretedScenes(parseInterpretedScenes($(%*[starter, content])))
      resetInterpretedScenes()
      let scene = newScene("tests/starterContent")
      let canvas = newImage(W, H)
      discard pass(scene, canvas)
      let layout = scene.layoutOf
      let hole = layout.holeIn
      check hole.found and hole.w > 0 and hole.h > 0 and hole.w * hole.h < W * H
      check canvas.color(hole.x + hole.w div 2, hole.y + hole.h div 2) == colored("#0000ff")
      check not ($logged).contains("error")
  test "there are starters to check":
    check found >= 3

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

  proc tapAt(scene: FrameScene, x, y: int) =
    let tap = %*{"x": x, "y": y, "pointerId": 0, "pointerType": "mouse"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: tap, loopIndex: 0, loopKey: ".", nextSleep: -1))

  test "a tap finds a <Scene> where it shows, in a box that clips":
    let scene = newScene("tests/clippedScene")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    check canvas.color(15, 15) == colored("#ef4444")
    # Where the box's offset counted twice: nothing there.
    scene.tapAt(35, 35)
    rhythmClockOverride = 1000.01
    discard pass(scene, canvas)
    check canvas.color(15, 15) == colored("#ef4444")
    # In its own coordinates, 5,5 of a 20 x 20 scene.
    scene.tapAt(15, 15)
    rhythmClockOverride = 1000.02
    discard pass(scene, canvas)
    check canvas.color(15, 15) == colored("#22c55e")

  test "a tap finds a <Scene> where its box has scrolled it to, and not outside the box":
    let scene = newScene("tests/scrolledScene")
    let canvas = newImage(W, H)
    discard pass(scene, canvas)
    # Below the box, where the scene lies but does not show.
    scene.tapAt(15, 35)
    rhythmClockOverride = 1000.01
    discard pass(scene, canvas)
    runEvent(scene, ExecutionContext(scene: scene, event: "wheel",
      payload: %*{"x": 15, "y": 15, "deltaY": 1, "pointerId": 0, "pointerType": "mouse"},
      loopIndex: 0, loopKey: ".", nextSleep: -1))
    rhythmClockOverride = 1000.02
    discard pass(scene, canvas)
    check canvas.color(15, 15) == colored("#ef4444") # scrolled into sight, not tapped yet
    scene.tapAt(15, 15)
    rhythmClockOverride = 1000.03
    discard pass(scene, canvas)
    check canvas.color(15, 15) == colored("#22c55e")

  test "<yield /> in a JSX layout shows the scene it wraps":
    let scene = newScene("tests/inUiLayout")
    let image = pass(scene)
    check image.color(5, 5) == rgbx(255, 255, 255, 255)
    check image.color(5, 30) == colored("#0000ff")
    check scene.runs == 1
