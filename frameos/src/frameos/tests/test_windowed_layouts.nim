import std/[json, tables, unittest, os, strutils, sequtils]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime
import ../ui/events as ui_events
import ../ui/layout as ui_layout
import ../utils/memory

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
  frameos.setState("seenCategories", (app.frame.categories || []).slice(0, 3).map((c) => c.id + "=" + c.name).join(","))
  return (
    <div className="relative w-full h-full bg-white">
      <div className="absolute left-0 top-0 w-[20px] h-[40px] flex"><yield /></div>
      {(app.state.open || []).map((id) => (
        <div className="absolute left-[20px] top-0 w-[20px] h-[40px] flex">
          {app.state.hearing ? (
            <Scene id={id} onPointerDown={() => frameos.setState("heard", (app.state.heard || 0) + 1)} />
          ) : (
            <Scene id={id} />
          )}
        </div>
      ))}
      {(app.state.copies || []).map((id) => (
        <div className="absolute left-[20px] top-0 w-[20px] h-[40px] flex"><Scene id={id} city="Oslo" /></div>
      ))}
      {app.state.cover ? (
        <div className="absolute left-[20px] top-0 w-[20px] h-[10px]"
          onClick={() => frameos.setState("covered", (app.state.covered || 0) + 1)} />
      ) : null}
      {app.state.pressCover ? (
        <div className="absolute left-[20px] top-0 w-[20px] h-[40px]"
          onPointerDown={() => frameos.setState("pressed", (app.state.pressed || 0) + 1)} />
      ) : null}
      {(app.state.offLeft || []).map((id) => (
        <div className="absolute left-[-10px] top-0 w-[20px] h-[40px] flex"><Scene id={id} /></div>
      ))}
      {(app.state.offRight || []).map((id) => (
        <div className="absolute left-[30px] top-0 w-[20px] h-[40px] flex"><Scene id={id} /></div>
      ))}
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

# A list taller than its box, which scrolls.
const scrollerUi = """
export function get(app) {
  return (
    <div className="w-full h-full overflow-y-auto bg-white">
      {Array.from({ length: 20 }, (_, i) => <div className="h-[10px] bg-black">{String(i)}</div>)}
    </div>
  )
}
"""

# A line to type into, the box around it red until something is typed.
const typerUi = """
let text = ''
export function get(app) {
  return (
    <div className={`w-full h-full flex flex-col ${text ? 'bg-green-500' : 'bg-red-500'}`}>
      <textarea className="w-full h-[10px]" value={text} onChange={(e) => { text = String(e.target.value) }} />
    </div>
  )
}
"""

let scenesJson = "[" & [
  jsxScene("tests/desk", deskUi, 300.0, ""","isLayout": true"""),
  panel("tests/blue", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/yellow"]}"""),
  panel("tests/yellow", "#ffff00", 600.0).withLayout("tests/desk"),
  panel("tests/copier", "#0000ff", 600.0).withLayout("tests/desk", """{"copies": ["tests/yellow"]}"""),
  panel("tests/twice", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/twice", "tests/yellow", "tests/yellow"]}"""),
  panel("tests/front", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/counter"]}"""),
  panel("tests/covered", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/counter2"], "cover": true}"""),
  panel("tests/pressing", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/counter3"], "pressCover": true}"""),
  panel("tests/hanging", "#0000ff", 600.0).withLayout("tests/desk", """{"offLeft": ["tests/yellow"]}"""),
  panel("tests/green", "#00ff00", 600.0).withLayout("tests/desk"),
  panel("tests/tight", "#0000ff", 600.0).withLayout("tests/desk", """{"offRight": ["tests/green"]}"""),
  panel("tests/fast", "#00ff00", 0.05).withLayout("tests/desk"),
  panel("tests/paced", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/fast"]}"""),
  jsxScene("tests/counter3", counterUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/counter", counterUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/counter2", counterUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/scroller", scrollerUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/counter4", counterUi, 3000.0).withLayout("tests/desk"),
  jsxScene("tests/typer", typerUi, 86400.0).withLayout("tests/desk"),
  panel("tests/hearing", "#0000ff", 600.0).withLayout("tests/desk", """{"open": ["tests/counter4"], "hearing": true}"""),
  panel("tests/wheeling", "#0000ff", 600.0).withLayout("tests/desk",
    """{"open": ["tests/scroller"], "pressCover": true}"""),
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

proc wheel(scene: FrameScene, x, y: int, notches: float) =
  let payload = %*{"x": x, "y": y, "deltaX": 0, "deltaY": notches, "pointerId": 0, "pointerType": "mouse"}
  runEvent(scene, ExecutionContext(scene: scene, event: "wheel", payload: payload, loopIndex: 0, loopKey: ".",
    nextSleep: -1))

proc scrolledY(sceneId: string): float32 =
  ## How far the box that scrolls in a scene's UI is scrolled.
  let target = uiTarget(sceneId, 2, create = false)
  if target.isNil:
    return -1
  for r in target.regions:
    if r.scrollY > 0:
      return target.input.scrolled(r.key)[1]

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

  test "a <Scene> given props is a copy those props set, as anywhere":
    let copier = hostScene("tests/copier")
    let image = pass(copier)
    check image.color(30, 20) == colored("#ffff00")
    let copies = toSeq(InterpretedFrameScene(copier.wornLayout).sceneNodes.values)
    check copies.len == 1
    check copies[0].state{"city"}.getStr() == "Oslo"
    check not hosted.hasKey("tests/yellow") or copies[0] != hosted["tests/yellow"]

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
    # And the categories to group them by, with their names (docs/scene-categories.json).
    check blue.wornLayout.state{"seenCategories"}.getStr() == "photos=Photos,art=Art,calendar=Calendars"

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

  test "a press the layout took over a window keeps its tap from the scene there":
    let pressing = hostScene("tests/pressing")
    discard pass(pressing)
    proc send(event: string) =
      let payload = %*{"x": 30, "y": 30, "pointerId": 0, "pointerType": "mouse"}
      runEvent(pressing, ExecutionContext(scene: pressing, event: event, payload: payload, loopIndex: 0,
        loopKey: ".", nextSleep: -1))
    send("pointerDown")
    send("pointerUp")
    send("tap")
    check pressing.wornLayout.state{"pressed"}.getInt() == 1
    rhythmClockOverride = 1000.01
    check pass(pressing).color(30, 30) == colored("#ef4444") # the counter heard no tap

  test "a window hanging off the left edge is cut there, not squeezed into what shows":
    let hanging = hostScene("tests/hanging")
    discard pass(hanging)
    var found = false
    for slot in hanging.wornLayout.slots:
      if slot.child == hosted["tests/yellow"]:
        found = true
        check not slot.hole
    check found

  test "a window's picture with no room for it is left out, not an out-of-memory abort":
    # An ESP32 whose largest free block under the reserve is smaller than the
    # window's picture (20x40 RGBX, 3200 bytes): asking for it anyway is an
    # abort and, a few of those on, a restart (the reTerminal E1002's macOS
    # desktop, a 798x340 window behind the one in front). The window shows
    # nothing, the rest of the frame is drawn, and it is said once.
    setSimulatedEmbedded(true)
    availableRenderBytesOverride = 1024
    defer:
      availableRenderBytesOverride = 0
      setSimulatedEmbedded(false)
    logged.setLen(0)
    let tight = hostScene("tests/tight")
    var image = pass(tight)
    var slotted = false
    for slot in tight.wornLayout.slots:
      if slot.child == hosted["tests/green"]:
        slotted = true
        check not slot.hole
    check slotted
    check image.color(35, 20) == colored("#ffffff")
    check image.color(5, 20) == colored("#0000ff") # the scene in front, in its hole
    check hosted["tests/green"].rhythm.embedImage.isNil
    rhythmClockOverride = 1000.01
    image = pass(tight)
    check logged.filterIt(it{"event"}.getStr() == "scene:embed:noMemory").len == 1
    check logged.filterIt(it{"event"}.getStr() == "scene:embed:noMemory")[0]{"bytes"}.getInt() == 3200
    # With the room back, the window shows again.
    availableRenderBytesOverride = 0
    rhythmClockOverride = 1000.02
    image = pass(tight)
    check image.color(35, 20) == colored("#00ff00")

  test "a window paces the frame by its own interval":
    let paced = hostScene("tests/paced")
    discard pass(paced)
    rhythmClockOverride = 1000.01
    discard pass(paced)
    check paced.refreshInterval < 1.0

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

  test "the wheel scrolls the box under the pointer, in the scene in front and in a window behind":
    # In front, in the <yield />: its own box, in its own coordinates.
    let scroller = hostScene("tests/scroller")
    discard pass(scroller)
    check scrolledY("tests/scroller") == 0
    scroller.wheel(5, 20, 1)
    check scrolledY("tests/scroller") == 72 # a notch, about three lines
    scroller.wheel(5, 20, -0.5) # a trackpad's half of a notch
    check scrolledY("tests/scroller") == 36
    # In a window behind, under a cover that brings it forward on a press: the
    # wheel scrolls it there, and the cover hears nothing.
    let wheeling = switchTo(scroller, "tests/wheeling")
    discard pass(wheeling)
    wheeling.wheel(30, 20, 1)
    check scrolledY("tests/scroller") == 108
    check wheeling.wornLayout.state{"pressed"}.getInt(0) == 0
    # Its end reached, the wheel goes to the box around it: here none, nothing.
    wheeling.wheel(30, 20, 10)
    check scrolledY("tests/scroller") > 108
    wheeling.wheel(30, 20, 1)
    # A wheel over the layout's own white beside nothing scrolls nothing.
    wheeling.wheel(10, 39, 1)
    check wheeling.wornLayout.state{"pressed"}.getInt(0) == 0

  test "a handler on a <Scene> is the layout's: it hears the press the scene has, and makes no copy":
    let hearing = hostScene("tests/hearing")
    discard pass(hearing)
    check InterpretedFrameScene(hearing.wornLayout).sceneNodes.len == 0
    let counter = hosted["tests/counter4"]
    var image = pass(hearing)
    check image.color(30, 20) == colored("#ef4444")
    # One press: the scene in the window has it, and the layout hears it there.
    for event in ["pointerDown", "pointerUp", "tap"]:
      runEvent(hearing, ExecutionContext(scene: hearing, event: event,
        payload: %*{"x": 30, "y": 20, "pointerId": 0, "pointerType": "mouse", "buttons": (if event == "pointerDown": 1 else: 0)},
        loopIndex: 0, loopKey: ".", nextSleep: -1))
    check hearing.wornLayout.state{"heard"}.getInt(0) == 1
    rhythmClockOverride = 1000.5
    image = pass(hearing)
    check image.color(30, 20) == colored("#22c55e") # the tap reached its button
    check counter == hosted["tests/counter4"]
    # On the scene in front, whose <yield /> has no handler: nothing heard.
    hearing.tap(10, 39)
    check hearing.wornLayout.state{"heard"}.getInt(0) == 1

  test "a key typed into a field of the scene in front is drawn without a tap after it":
    # The Terminal's bug: a scene that renders once a day, in a layout's
    # <yield />, put back its last picture after every key until a tap.
    let typer = hostScene("tests/typer")
    check pass(typer).color(5, 30) == colored("#ef4444")
    typer.tap(5, 2) # focus the field
    rhythmClockOverride = 1000.01
    discard pass(typer)
    rhythmClockOverride = 1000.02
    discard pass(typer) # nothing asked since: the copy
    runEvent(typer, ExecutionContext(scene: typer, event: "textInput", payload: %*{"text": "a"},
      loopIndex: 0, loopKey: ".", nextSleep: -1))
    rhythmClockOverride = 1000.03
    check pass(typer).color(5, 30) == colored("#22c55e")
