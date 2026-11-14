## The Windows 98 and Tiling layouts as desktops (docs/scene-layouts.md
## "Windows"): the real samples on a frame that runs its scenes side by side, played the way the
## Pi's runner plays it — its scenes kept in a table, the layout carried from
## scene to scene — with the pointer and the keys a mouse and a keyboard send.

import std/[algorithm, json, os, sequtils, strutils, tables, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime
import ../layout_choice
from ../ui/events import uiPressRects

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  W = 800
  H = 480
  Layout = "layout-windows-98"
  Tiling = "layout-tiling"
  MacOS = "layout-macos"
  BeOS = "layout-beos"

proc panel(id, name, hex: string, layout = Layout): JsonNode =
  %*{"id": id, "name": name, "settings": {"execution": "interpreted", "refreshInterval": 600,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {}, "layout": {"sceneId": layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": hex}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}

# A scene whose whole picture is a button: it counts the presses and the clicks
# that reach it.
proc buttonPanel(id, name: string, layout = Tiling): JsonNode =
  let source = """
export function get(app) {
  return (
    <div className="w-full h-full bg-[#a855f7]"
      onPointerDown={() => frameos.setState('downs', (app.state.downs || 0) + 1)}
      onPointerMove={() => frameos.setState('moves', (app.state.moves || 0) + 1)}
      onPointerUp={() => frameos.setState('ups', (app.state.ups || 0) + 1)}
      onClick={() => frameos.setState('clicks', (app.state.clicks || 0) + 1)} />
  )
}
"""
  let app = %*{"origin": "button", "name": "button", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "button", "category": "data", "output": [{"name": "image", "type": "image"}],
        "fields": []})}}
  %*{"id": id, "name": name, "settings": {"execution": "interpreted", "refreshInterval": 3000,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {"button": app}, "layout": {"sceneId": layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "button", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}

let layout = parseFile(Samples / "Windows 98 layout" / "scenes.json")[0]
doAssert layout["id"].getStr() == Layout
let tiling = parseFile(Samples / "Tiling layout" / "scenes.json")[0]
doAssert tiling["id"].getStr() == Tiling
let macos = parseFile(Samples / "macOS layout" / "scenes.json")[0]
doAssert macos["id"].getStr() == MacOS
let beos = parseFile(Samples / "BeOS layout" / "scenes.json")[0]
doAssert beos["id"].getStr() == BeOS
setUploadedInterpretedScenes(parseInterpretedScenes($(%*[layout, tiling, macos, beos,
  panel("tests/red", "Red", "#ff0000"), panel("tests/green", "Green", "#00ff00"),
  panel("tests/blue", "Blue", "#0000ff"),
  panel("tests/sky", "Sky", "#38bdf8", Tiling), panel("tests/grass", "Grass", "#4ade80", Tiling),
  panel("tests/sun", "Sun", "#facc15", Tiling), buttonPanel("tests/button", "Button"),
  panel("tests/apple", "Apple", "#ff0000", MacOS), panel("tests/lime", "Lime", "#00ff00", MacOS),
  panel("tests/ocean", "Ocean", "#0000ff", MacOS),
  panel("tests/be-red", "Red", "#ff0000", BeOS), panel("tests/be-green", "Green", "#00ff00", BeOS),
  panel("tests/be-blue", "Blue", "#0000ff", BeOS),
  # The scene store, as each desktop finds it: by its name.
  panel("tests/store-98", "Scene store", "#3b82f6"), panel("tests/store-tiling", "Scene store", "#3b82f6", Tiling),
  panel("tests/store-mac", "Scene store", "#3b82f6", MacOS), panel("tests/store-be", "Scene store", "#3b82f6", BeOS)])))
resetInterpretedScenes()

let config = FrameConfig(name: "desktop", mode: "rpios", device: "framebuffer", width: W, height: H, rotate: 0,
  scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
  assetsPath: getTempDir() / "frameos-windows98-test")

var problems: seq[string]

proc logger(): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) =
    {.cast(gcsafe).}:
      if payload{"event"}.getStr().contains("error"):
        problems.add($payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

var
  hosted = initTable[string, FrameScene]()
  parked: FrameScene
  current: FrameScene

proc hostScene(id: string): FrameScene =
  result = hosted.getOrDefault(id, nil)
  if result.isNil:
    result = init(id.SceneId, config, logger(), %*{})
    hosted[id] = result

hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
  {.cast(gcsafe).}:
    hostScene(sceneId.string)
windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
  %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"}]
takeParkedLayout = proc(layoutId: string): FrameScene {.nimcall.} =
  {.cast(gcsafe).}:
    if not parked.isNil and parked.id.string == layoutId:
      result = parked
      parked = nil

var clock = 1000.0

proc pass(): Image =
  clock += 0.01
  rhythmClockOverride = clock
  let context = ExecutionContext(scene: current, event: "render", payload: %*{},
    image: newImage(W, H), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(current, context)

var payloads = initTable[string, JsonNode]()
  ## What each event the handlers sent last carried.

var settingsFrom = ""
  ## The scene showing when a `sceneSettings` came: what the dispatcher, taking
  ## the events in order, hands the settings as `state.from`.

proc settle(): seq[string] =
  ## What the handlers sent, the switches done the way runner.selectScene does.
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    result.add message[1]
    payloads[message[1]] = message[2]
    if message[1] == "sceneSettings":
      settingsFrom = current.id.string
    if message[1] == "setCurrentScene":
      let next = message[2]{"sceneId"}.getStr()
      if next != current.id.string:
        parked = current.wornLayout
        current.wornLayout = nil
        current = hostScene(next)
        # Put on at the switch, as the runner and the browser's host do.
        wearLayout(current)

proc send(event: string, payload: JsonNode): seq[string] =
  runEvent(current, ExecutionContext(scene: current, event: event, payload: payload, loopIndex: 0, loopKey: ".",
    nextSleep: -1))
  settle()

proc at(x, y: int, extra: JsonNode = nil): JsonNode =
  result = %*{"x": x, "y": y, "pointerId": 0, "pointerType": "mouse", "buttons": 1}
  if not extra.isNil:
    for k, v in extra.pairs: result[k] = v

proc click(x, y: int): seq[string] =
  result = send("pointerDown", at(x, y))
  result.add send("pointerUp", at(x, y, %*{"buttons": 0}))
  result.add send("tap", at(x, y))

proc color(image: Image, x, y: int): ColorRGBX = image.getPixel(image.dataIndex(x, y))
proc colored(hex: string): ColorRGBX = parseHtmlColor(hex).rgbx

proc desk(): FrameScene =
  ## The layout: on the scene shown, or parked for it until its next pass.
  if current.wornLayout.isNil: parked else: current.wornLayout

proc wins(): JsonNode = desk().state{"wins"}

proc winOf(id: string): JsonNode =
  for w in wins(): (if w{"id"}.getStr() == id: return w)

let shots = getEnv("FRAMEOS_DESKTOP_SHOTS")
proc shot(image: Image, name: string) =
  if shots.len > 0:
    createDir(shots)
    image.writeFile(shots / name & ".png")

suite "the Windows 98 desktop":
  test "the first scene fills the desktop, as the layout always looked":
    current = hostScene("tests/red")
    let image = pass()
    shot(image, "1-first")
    check problems.len == 0
    check wins().len == 1
    check winOf("tests/red"){"max"}.getBool()
    check image.color(W div 2, H div 2) == colored("#ff0000")
    # The taskbar's gray at the bottom.
    check image.color(W div 2, H - 3) == colored("#c0c0c0")
    var hole = false
    for slot in current.wornLayout.slots:
      hole = hole or slot.hole and slot.child == current
    check hole

  test "Start lists the frame's scenes and opens one in a window of its own":
    discard click(20, H - 20) # Start
    let menu = pass()
    shot(menu, "2-menu")
    check desk().state{"menu"}.getBool()
    # Green, the second item of the menu: its rows from the top of the menu.
    # Green is the menu's second row of 30 px, under its top border.
    let menuTop = H - 42 - (30 * (3 + 3) + 22)
    let sent = click(80, menuTop + 6 + 30 + 15)
    check "setCurrentScene" in sent
    check current.id.string == "tests/green"
    let two = pass()
    shot(two, "3-two-windows")
    check problems.len == 0
    check wins().len == 2
    check not winOf("tests/green"){"max"}.getBool()
    let g = winOf("tests/green")
    let (gx, gy, gw, gh) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt())
    # Green in its window, red behind it, both running.
    check two.color(gx + gw div 2, gy + gh div 2) == colored("#00ff00")
    check two.color(W - 10, H div 2) == colored("#ff0000")
    check hosted["tests/red"] in (block:
      var children: seq[FrameScene]
      for slot in current.wornLayout.slots: children.add slot.child
      children)

  test "a window behind that is sized runs at its new size, its old picture not stretched":
    let red = hosted["tests/red"]
    discard pass()
    let before = red.rhythm.scheduledPass
    discard pass()
    # Not due on its own: a ten-minute interval.
    check red.rhythm.scheduledPass == before
    proc setMax(on: bool) =
      let wins = desk().state["wins"]
      for w in wins:
        if w{"id"}.getStr() == "tests/red": w["max"] = %on
      desk().state["wins"] = wins
    setMax(false)
    discard pass()
    check red.rhythm.scheduledPass != before
    setMax(true)
    discard pass()

  test "a window dragged by its title bar follows the pointer":
    let g = winOf("tests/green")
    let (x0, y0) = (g{"x"}.getInt(), g{"y"}.getInt())
    let grabX = x0 + 60
    let grabY = y0 + 14
    discard send("pointerDown", at(grabX, grabY))
    discard send("pointerMove", at(grabX + 40, grabY + 30))
    discard send("pointerMove", at(grabX + 100, grabY + 50))
    discard send("pointerUp", at(grabX + 100, grabY + 50, %*{"buttons": 0}))
    let moved = winOf("tests/green")
    check moved{"x"}.getInt() == x0 + 100
    check moved{"y"}.getInt() == y0 + 50
    check desk().state{"drag"}.kind == JNull
    let image = pass()
    shot(image, "4-dragged")
    check image.color(x0 + 100 + 20, y0 + 50 + 60) == colored("#00ff00")

  test "a press on the window behind brings it forward, and a tap reaches no scene":
    let sent = click(W - 10, H div 2)
    check "setCurrentScene" in sent
    check current.id.string == "tests/red"
    let image = pass()
    shot(image, "5-red-forward")
    check image.color(W - 10, H div 2) == colored("#ff0000")
    check problems.len == 0

  test "the task button of the window in front minimizes it, and the next comes forward":
    # Task buttons follow Start; red was opened first.
    let image = pass()
    let red = winOf("tests/red")
    check not red{"min"}.getBool()
    discard click(140, H - 20)
    check winOf("tests/red"){"min"}.getBool()
    check current.id.string == "tests/green"
    shot(pass(), "6-minimized")
    discard image

  test "F11 gives the panel to the window in front and Escape takes it back":
    discard send("keyDown", %*{"key": "F11", "code": "F11", "repeat": false, "shift": false, "ctrl": false,
      "alt": false, "meta": false})
    check desk().state{"full"}.getBool()
    let full = pass()
    shot(full, "7-full")
    check full.color(W div 2, H - 3) == colored("#00ff00")
    check full.color(2, 2) == colored("#00ff00")
    discard send("keyDown", %*{"key": "Escape", "code": "Escape", "repeat": false, "shift": false, "ctrl": false,
      "alt": false, "meta": false})
    check not desk().state{"full"}.getBool()
    check pass().color(W div 2, H - 3) == colored("#c0c0c0")

  test "closing the window in front gives the focus to the next one":
    discard click(140, H - 20) # red's task button: restore it
    check current.id.string == "tests/red"
    discard pass()
    check not winOf("tests/red"){"min"}.getBool()
    # The red window fills the desktop: its close button is at the top right.
    let sent = click(W - 14, 12)
    check "setCurrentScene" in sent
    check current.id.string == "tests/green"
    check winOf("tests/red").isNil
    let image = pass()
    shot(image, "8-closed")
    check problems.len == 0

  test "a window dragged half off the desktop is cut at the edge, not squeezed into what shows":
    let g = winOf("tests/green")
    let (x, y, w) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt())
    discard send("pointerDown", at(x + 60, y + 14))
    discard send("pointerMove", at(W - 100, y + 14))
    discard send("pointerUp", at(W - 100, y + 14, %*{"buttons": 0}))
    let off = winOf("tests/green"){"x"}.getInt()
    check off + w > W
    discard pass()
    for slot in desk().slots:
      if slot.child == hosted["tests/green"]:
        check not slot.hole
        # The scene keeps its window's width: it starts at the window's left
        # edge, and what lies past the panel is cut.
        check slot.x.int >= off and slot.x.int < off + 10
    # Back where it was, for the tests after.
    discard send("pointerDown", at(W - 100, y + 14))
    discard send("pointerMove", at(x + 60, y + 14))
    discard send("pointerUp", at(x + 60, y + 14, %*{"buttons": 0}))
    check winOf("tests/green"){"x"}.getInt() == x
    discard pass()

  test "a window sized from its corner grows with the pointer":
    let g = winOf("tests/green")
    let (x, y, w, h) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt())
    discard send("pointerDown", at(x + w - 3, y + h - 3))
    discard send("pointerMove", at(x + w + 30, y + h + 20))
    discard send("pointerUp", at(x + w + 30, y + h + 20, %*{"buttons": 0}))
    let sized = winOf("tests/green")
    check sized{"x"}.getInt() == x
    check sized{"w"}.getInt() == w + 33
    check sized{"h"}.getInt() == h + 23

  test "let go at a side, a window takes that half, and dragged away it has its own size back":
    let g = winOf("tests/green")
    let (x, y, w) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt())
    discard send("pointerDown", at(x + 60, y + 14))
    discard send("pointerMove", at(1, y + 100))
    # Where it would go, drawn while it is held there.
    let held = pass()
    shot(held, "9-snapping")
    check held.color(1, 200) == colored("#404040")
    discard send("pointerUp", at(1, y + 100, %*{"buttons": 0}))
    check winOf("tests/green"){"snap"}.getStr() == "l"
    let half = pass()
    shot(half, "10-half")
    check half.color(20, 200) == colored("#00ff00")
    check half.color(W div 2 - 10, 200) == colored("#00ff00")
    check half.color(W div 2 + 20, 200) == colored("#008080")
    # Out of the half by its title bar: its own width again, under the pointer.
    discard send("pointerDown", at(100, 12))
    discard send("pointerMove", at(300, 100))
    discard send("pointerUp", at(300, 100, %*{"buttons": 0}))
    let freed = winOf("tests/green")
    check freed{"snap"}.kind == JNull
    check freed{"w"}.getInt() == w
    check freed{"x"}.getInt() > 100
    check problems.len == 0

  test "the desktop's icons are the frame's own apps, and a double click opens one":
    discard pass()
    # Down the left: Programs, Terminal, Control Panel (no store, no asset
    # browser on this frame), none of the scenes.
    let (ix, iy) = (48, 8 + 1 * 72 + 20)
    discard send("tap", at(ix, iy))
    check desk().state{"picked"}.getStr() == "system/terminal"
    # Its name on the selection's blue.
    let picked = pass()
    shot(picked, "11-icons")
    var blue = false
    for y in 8 + 1 * 72 + 36 ..< 8 + 2 * 72:
      for x in 8 ..< 88:
        blue = blue or picked.color(x, y) == colored("#000080")
    check blue
    check send("doubleTap", at(ix, iy)).filterIt(it != "render") == @["terminal"]
    check send("doubleTap", at(48, 8 + 20)).filterIt(it != "render") == @["sceneSwitcher"]
    # Blue from Start, for the tests after.
    discard click(20, H - 20)
    discard pass()
    let menuTop = H - 42 - (30 * (3 + 3) + 22)
    check "setCurrentScene" in click(80, menuTop + 6 + 2 * 30 + 15)
    check current.id.string == "tests/blue"
    discard pass()
    check wins().len == 2
    check problems.len == 0

  test "Alt+Tab goes back and forth between two windows, and Alt+F4 closes the one in front":
    proc key(name: string, alt = true): seq[string] =
      send("keyDown", %*{"key": name, "code": name, "repeat": false, "shift": false, "ctrl": false,
        "alt": alt, "meta": false})
    discard key("Tab")
    check current.id.string == "tests/green"
    discard pass()
    discard key("Tab")
    check current.id.string == "tests/blue"
    discard pass()
    discard key("F4")
    check current.id.string == "tests/green"
    check winOf("tests/blue").isNil

  test "let go at the top, a window fills the desktop":
    discard pass()
    let g = winOf("tests/green")
    let (x, y) = (g{"x"}.getInt(), g{"y"}.getInt())
    discard send("pointerDown", at(x + 60, y + 14))
    discard send("pointerMove", at(x + 60, 1))
    discard send("pointerUp", at(x + 60, 1, %*{"buttons": 0}))
    check winOf("tests/green"){"max"}.getBool()
    let image = pass()
    shot(image, "12-max")
    check image.color(W - 10, H div 2) == colored("#00ff00")

  test "a window opens at the layout's size where that fits, and where it was when it opens again":
    # 800x480, the default, does not fit this desktop; a smaller size does.
    desk().state["windowSize"] = %"400x240"
    desk().state.delete("boxes")
    let menuTop = H - 42 - (30 * (3 + 3) + 22)
    proc openBlue() =
      discard click(20, H - 20) # Start
      discard pass()
      check "setCurrentScene" in click(80, menuTop + 6 + 2 * 30 + 15)
      check current.id.string == "tests/blue"
      discard pass()
    openBlue()
    let b = winOf("tests/blue")
    check not b{"max"}.getBool()
    # The scene's 400x240, its borders and its title bar around it.
    check b{"w"}.getInt() == 400 + 8
    check b{"h"}.getInt() == 240 + 34
    # Moved, closed and opened again: where it was.
    let (x, y) = (b{"x"}.getInt(), b{"y"}.getInt())
    discard send("pointerDown", at(x + 60, y + 14))
    discard send("pointerMove", at(x + 90, y + 34))
    discard send("pointerUp", at(x + 90, y + 34, %*{"buttons": 0}))
    discard send("keyDown", %*{"key": "F4", "code": "F4", "repeat": false, "shift": false, "ctrl": false,
      "alt": true, "meta": false})
    check winOf("tests/blue").isNil
    discard pass()
    openBlue()
    let again = winOf("tests/blue")
    check again{"x"}.getInt() == x + 30
    check again{"y"}.getInt() == y + 20
    check again{"w"}.getInt() == 400 + 8
    check problems.len == 0

  test "the gear on a window's title bar opens its scene's settings, a window behind brought forward first":
    discard pass()
    # Blue in front: its gear, at the left of its title bar.
    let b = winOf("tests/blue")
    settingsFrom = ""
    var sent = click(b{"x"}.getInt() + 18, b{"y"}.getInt() + 16).filterIt(it != "render")
    check sent == @["sceneSettings"]
    check settingsFrom == "tests/blue"
    # Asked for: blue's own settings, which the dispatcher opens as their own.
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/blue"
    discard pass()
    # Green fills the desktop behind blue: its gear at the top left, which blue
    # does not cover. The press brings green forward, the tap opens its settings.
    check current.id.string == "tests/blue"
    settingsFrom = ""
    sent = click(18, 16).filterIt(it != "render")
    check sent == @["setCurrentScene", "sceneSettings"]
    check current.id.string == "tests/green"
    check settingsFrom == "tests/green"
    discard pass()
    check problems.len == 0

  test "Start has the Control Panel and the terminal, and no scene settings":
    discard click(20, H - 20) # Start
    let menu = pass()
    shot(menu, "13-start")
    # The last item, at the menu's bottom over the taskbar: Terminal.
    check click(80, H - 60).filterIt(it != "render") == @["terminal"]
    discard pass()
    discard click(20, H - 20)
    discard pass()
    # The one above it: Control Panel, the frame's page.
    check click(80, H - 90).filterIt(it != "render") == @["sceneSettings"]
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()

  test "the scene store, where the frame has it, sits at the top of Start and out of its programs":
    let listing = windowSceneListing
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"},
        {"id": "tests/store-98", "name": "Scene store"}]
    discard pass()
    discard click(20, H - 20) # Start
    shot(pass(), "14-start-store")
    # The store, a rule, the three programs, then Full screen, Control Panel, Terminal.
    let menuTop = H - 42 - (30 * (3 + 3 + 1) + 22 + 8)
    check click(80, menuTop + 6 + 15).filterIt(it != "render") == @["setCurrentScene"]
    check current.id.string == "tests/store-98"
    discard pass()
    check not winOf("tests/store-98").isNil
    check problems.len == 0
    windowSceneListing = listing

proc topBar(): seq[array[4, float32]] =
  ## What takes a press on the tiling desktop's top bar, left to right: its +,
  ## the name of each tile, its gear.
  var rects: seq[array[4, float32]]
  uiPressRects(Tiling, rects)
  for r in rects:
    if r[3] <= 24:
      result.add r
  result.sort(proc(a, b: array[4, float32]): int = cmp(a[0], b[0]))

proc clickRect(r: array[4, float32]): seq[string] =
  click(int((r[0] + r[2]) / 2), int((r[1] + r[3]) / 2))

proc acted(sent: seq[string]): seq[string] = sent.filterIt(it != "render")

proc focusOn(id: string): seq[string] =
  ## The focus, as the layout's names in the top bar give it.
  sendEvent("setCurrentScene", %*{"sceneId": id}, eoScene)
  settle()

suite "the tiling desktop":
  # The top bar is 24 px and a tile's bar 17 at 800 x 480; the first tile is the
  # left 480 px, the others share the right 320, under the top bar.
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/sky", "name": "Sky"}, {"id": "tests/grass", "name": "Grass"}, {"id": "tests/sun", "name": "Sun"},
        {"id": "tests/button", "name": "Button"}]

  test "the first scene has the desktop, below the bar":
    current = hostScene("tests/sky")
    let image = pass()
    shot(image, "t1-first")
    check problems.len == 0
    check desk().state{"open"} == %*["tests/sky"]
    check image.color(W div 2, H div 2) == colored("#38bdf8")

  test "the bar's + opens a scene as a tile of its own, at the end, and every tile is a hole":
    discard click(14, 10)
    check desk().state{"adding"}.getBool()
    shot(pass(), "t2-adding")
    # Grass, the first scene not open, under the bar.
    let sent = click(40, 24 + 18)
    check "setCurrentScene" in sent
    check current.id.string == "tests/grass"
    discard pass()
    discard click(14, 10)
    discard pass()
    discard click(40, 24 + 18)
    check current.id.string == "tests/sun"
    let image = pass()
    shot(image, "t3-three")
    check problems.len == 0
    check desk().state{"open"} == %*["tests/sky", "tests/grass", "tests/sun"]
    # Sky keeps the left; the new ones share the column on the right, in order.
    check image.color(W div 4, H div 2) == colored("#38bdf8")
    check image.color(W - 40, 24 + 100) == colored("#4ade80")
    check image.color(W - 40, H - 40) == colored("#facc15")
    var holes = 0
    for slot in desk().slots:
      if slot.hole: inc holes
    check holes == 3

  test "a press in a tile reaches its scene at once and gives it the focus where it is":
    discard click(14, 10)
    discard pass()
    discard click(40, 24 + 18) # Button, the last scene not open
    check current.id.string == "tests/button"
    discard pass()
    # The focus to sky by a press in its picture: it stays on the left.
    check "setCurrentScene" in click(W div 4, H div 2)
    check current.id.string == "tests/sky"
    var image = pass()
    check image.color(W div 4, H div 2) == colored("#38bdf8")
    check desk().state{"open"} == %*["tests/sky", "tests/grass", "tests/sun", "tests/button"]
    # The button's tile, the bottom of the column: one press is its button's,
    # its release and its tap too, and the focus goes there with it.
    let button = hosted["tests/button"]
    check button.state{"downs"}.getInt(0) == 0
    check "setCurrentScene" in click(W - 160, 328 + 17 + 60)
    check current.id.string == "tests/button"
    check button.state{"downs"}.getInt(0) == 1
    check button.state{"clicks"}.getInt(0) == 1
    image = pass()
    shot(image, "t4-pressed-through")
    check desk().state{"open"} == %*["tests/sky", "tests/grass", "tests/sun", "tests/button"]
    check image.color(W div 4, H div 2) == colored("#38bdf8")
    check image.color(W - 160, 328 + 17 + 60) == colored("#a855f7")
    # Pressed again, in front now: its own, no switch.
    check acted(click(W - 160, 328 + 17 + 60)) == newSeq[string]()
    check button.state{"clicks"}.getInt(0) == 2
    check problems.len == 0

  test "a tile's bar dragged onto another swaps the two, and a short press on it gives the focus":
    discard pass()
    # Sky's bar, the top of the left tile, carried over grass.
    discard send("pointerDown", at(200, 24 + 10))
    discard send("pointerMove", at(400, 80))
    discard send("pointerMove", at(640, 100))
    check desk().state{"drag", "at"}.getStr() == "tests/grass"
    let held = pass()
    shot(held, "t5-dragging")
    # The outline over grass's tile, where sky would go.
    check held.color(483, 100) == colored("#ffffff")
    discard send("pointerUp", at(640, 100, %*{"buttons": 0}))
    check desk().state{"open"} == %*["tests/grass", "tests/sky", "tests/sun", "tests/button"]
    check current.id.string == "tests/button" # a swap moves no focus
    let image = pass()
    shot(image, "t6-swapped")
    check image.color(W div 4, H div 2) == colored("#4ade80")
    check image.color(W - 40, 24 + 100) == colored("#38bdf8")
    # Let go over its own tile, or over no tile: nothing.
    discard send("pointerDown", at(200, 24 + 10))
    discard send("pointerMove", at(220, 200))
    discard send("pointerUp", at(220, 200, %*{"buttons": 0}))
    discard send("pointerDown", at(200, 24 + 10))
    discard send("pointerMove", at(200, 4))
    discard send("pointerUp", at(200, 4, %*{"buttons": 0}))
    check desk().state{"open"} == %*["tests/grass", "tests/sky", "tests/sun", "tests/button"]
    discard pass()
    # A short press on sun's bar: the focus, nothing moved.
    check "setCurrentScene" in click(W - 160, 176 + 10)
    check current.id.string == "tests/sun"
    check desk().state{"open"} == %*["tests/grass", "tests/sky", "tests/sun", "tests/button"]

  test "the gear on a tile's bar opens its scene's own settings, the scene given the focus first":
    discard pass()
    settingsFrom = ""
    # Grass's gear, at the left of the left tile's bar.
    let sent = acted(click(12, 24 + 10))
    check sent == @["setCurrentScene", "sceneSettings"]
    check current.id.string == "tests/grass"
    check settingsFrom == "tests/grass"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/grass"

  test "the top bar's gear opens the frame's settings":
    discard pass()
    let bar = topBar()
    check bar.len == 7 # +, four names, the arrangement, the gear
    let sent = acted(clickRect(bar[^1]))
    check sent == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"

  test "a name in the top bar gives its tile the focus where it is":
    discard pass()
    let bar = topBar()
    # +, grass, sky, sun, button, the gear: sky's name.
    check acted(clickRect(bar[2])) == @["setCurrentScene"]
    check current.id.string == "tests/sky"
    let image = pass()
    check desk().state{"open"} == %*["tests/grass", "tests/sky", "tests/sun", "tests/button"]
    check image.color(W - 40, 24 + 100) == colored("#38bdf8")
    check problems.len == 0

  test "a bar let go over another tile's picture swaps the two, and that scene hears nothing of it":
    discard pass()
    # Button on the left, sky in front: button's bar carried over sky's picture.
    desk().state["open"] = %*["tests/grass", "tests/sky", "tests/sun", "tests/button"]
    discard pass()
    let button = hosted["tests/button"]
    let before = (button.state{"downs"}.getInt(0), button.state{"moves"}.getInt(0), button.state{"ups"}.getInt(0))
    # An earlier press left a scene captured here; the bar's press is still the bar's.
    InterpretedFrameScene(desk()).capturedChild = button
    InterpretedFrameScene(desk()).capturedPointer = 0
    # Grass's bar (the left tile) over the middle of button's picture.
    discard send("pointerDown", at(200, 24 + 10))
    for (x, y) in [(400, 200), (600, 380), (640, 420)]:
      discard send("pointerMove", at(x, y))
    check desk().state{"drag", "at"}.getStr() == "tests/button"
    discard pass()
    discard send("pointerUp", at(640, 420, %*{"buttons": 0}))
    check desk().state{"open"} == %*["tests/button", "tests/sky", "tests/sun", "tests/grass"]
    check (button.state{"downs"}.getInt(0), button.state{"moves"}.getInt(0), button.state{"ups"}.getInt(0)) == before
    check InterpretedFrameScene(desk()).capturedChild.isNil
    let image = pass()
    check image.color(W div 4, H div 2) == colored("#a855f7")
    check image.color(640, 420) == colored("#4ade80")

  test "the arrangement button steps through the arrangements, the tiles in their order in each":
    desk().state["open"] = %*["tests/grass", "tests/sky", "tests/sun"]
    discard focusOn("tests/sky")
    discard pass()
    # Below a tile's bar: the middle of its picture.
    proc tileAt(image: Image, x, y: int, hex: string): bool = image.color(x, y + 24) == colored(hex)
    proc step(): Image =
      let bar = topBar()
      check bar.len == 6 # +, three names, the arrangement, the gear
      discard clickRect(bar[^2])
      pass()
    var image = pass()
    check desk().state{"arrangement"}.isNil # the first, side by side
    check image.tileAt(240, 228, "#4ade80") and image.tileAt(640, 114, "#38bdf8") and image.tileAt(640, 342, "#facc15")
    image = step()
    check desk().state{"arrangement"}.getStr() == "top"
    check image.tileAt(400, 137, "#4ade80") and image.tileAt(200, 365, "#38bdf8") and image.tileAt(600, 365, "#facc15")
    image = step()
    check desk().state{"arrangement"}.getStr() == "grid"
    check image.tileAt(200, 114, "#4ade80") and image.tileAt(600, 114, "#38bdf8") and image.tileAt(400, 342, "#facc15")
    image = step()
    check desk().state{"arrangement"}.getStr() == "columns"
    check image.tileAt(133, 228, "#4ade80") and image.tileAt(400, 228, "#38bdf8") and image.tileAt(667, 228, "#facc15")
    image = step()
    check desk().state{"arrangement"}.getStr() == "rows"
    check image.tileAt(400, 76, "#4ade80") and image.tileAt(400, 228, "#38bdf8") and image.tileAt(400, 380, "#facc15")
    shot(image, "t7-rows")
    image = step()
    check desk().state{"arrangement"}.getStr() == "side"
    check current.id.string == "tests/sky" # no focus moved
    check problems.len == 0

  test "a gap dragged moves its split, the scenes drawn at their new sizes, and a press on it reaches no scene":
    desk().state["open"] = %*["tests/button", "tests/sky", "tests/sun"]
    discard pass()
    let button = hosted["tests/button"]
    let downs = button.state{"downs"}.getInt(0)
    proc widthOf(id: string): float32 =
      for slot in desk().slots:
        if slot.child == hosted[id]: return slot.visible[2] - slot.visible[0]
    check widthOf("tests/button") < 482
    # The gap between button (the left 480) and the column: pressed 3 px inside
    # button's picture, carried to 600.
    let sent = acted(send("pointerDown", at(477, 300)) & send("pointerMove", at(540, 300)) &
      send("pointerMove", at(600, 300)) & send("pointerUp", at(600, 300, %*{"buttons": 0})))
    check sent == newSeq[string]() # no focus moved
    check button.state{"downs"}.getInt(0) == downs
    check abs(desk().state{"splits", "side"}.getFloat() - 0.75) < 0.01
    let image = pass()
    shot(image, "t8-resized")
    check image.color(560, 300) == colored("#a855f7")
    check widthOf("tests/button") > 590
    # Kept for that arrangement: to columns and back, the same.
    desk().state["arrangement"] = %"columns"
    discard pass()
    desk().state["arrangement"] = %"side"
    check pass().color(560, 300) == colored("#a855f7")
    # No tile smaller than its least: carried to the edge, it stops short.
    discard send("pointerDown", at(600, 300))
    discard send("pointerMove", at(799, 300))
    discard send("pointerUp", at(799, 300, %*{"buttons": 0}))
    check desk().state{"splits", "side"}.getFloat() < 0.95
    check problems.len == 0

  test "a gap between the tiles beside the large one moves that split too":
    desk().state["arrangement"] = %"side"
    desk().state["open"] = %*["tests/button", "tests/sky", "tests/sun"]
    desk().state.delete("splits")
    discard pass()
    proc heightOf(id: string): float32 =
      for slot in desk().slots:
        if slot.child == hosted[id]: return slot.visible[3] - slot.visible[1]
    let before = heightOf("tests/sky")
    # Sky over sun on the right, the 456 px under the bar shared evenly: the gap
    # at 24 + 228, carried 100 down.
    let sent = acted(send("pointerDown", at(640, 24 + 228)) & send("pointerMove", at(640, 24 + 280)) &
      send("pointerMove", at(640, 24 + 328)) & send("pointerUp", at(640, 24 + 328, %*{"buttons": 0})))
    check sent == newSeq[string]()
    let rest = desk().state{"splits", "sideRest"}
    check not rest.isNil and rest.len == 2
    check abs(rest[0].getFloat() - 328 / 456) < 0.01
    let image = pass()
    shot(image, "t9-column-gap")
    check heightOf("tests/sky") > before + 90
    check image.color(640, 24 + 300) == colored("#38bdf8")
    check problems.len == 0

  test "the top bar's bag opens the scene store as a tile, and the + list leaves it out":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/sky", "name": "Sky"}, {"id": "tests/grass", "name": "Grass"}, {"id": "tests/sun", "name": "Sun"},
        {"id": "tests/button", "name": "Button"}, {"id": "tests/store-tiling", "name": "Scene store"}]
    discard pass()
    let bar = topBar()
    # +, the open tiles' names, the bag, the arrangement, the gear.
    check acted(clickRect(bar[^3])) == @["setCurrentScene"]
    check current.id.string == "tests/store-tiling"
    discard pass()
    check "tests/store-tiling" in desk().state{"open"}.to(seq[string])
    check problems.len == 0


proc rectsOf(layoutId: string): seq[array[4, float32]] =
  ## Where a press does something on a layout, as uiPressRects has it: x0, y0, x1, y1.
  uiPressRects(layoutId, result)

proc byX(rects: seq[array[4, float32]]): seq[array[4, float32]] =
  rects.sorted(proc(a, b: array[4, float32]): int = cmp(a[0], b[0]))

proc byY(rects: seq[array[4, float32]]): seq[array[4, float32]] =
  rects.sorted(proc(a, b: array[4, float32]): int = cmp(a[1], b[1]))

proc key(name: string, alt = false, meta = false): seq[string] =
  send("keyDown", %*{"key": name, "code": name, "repeat": false, "shift": false, "ctrl": false,
    "alt": alt, "meta": meta})

proc sceneSize(id: string): (int, int) =
  ## The size a window's scene is drawn at, from the layout's slot of it.
  for slot in desk().slots:
    if slot.child == hosted[id]:
      return (int(slot.visible[2] - slot.visible[0] + 0.5), int(slot.visible[3] - slot.visible[1] + 0.5))

const
  MenuH = 26 ## the macOS menu bar at 800 x 480
  DockH = 71 ## and its Dock, the desktop the 383 px between them

proc dockIcons(): seq[array[4, float32]] =
  ## The Dock's icons, left to right: Launchpad, the three scenes, System Settings, Terminal.
  byX(rectsOf(MacOS).filterIt(it[1] >= float32(H - DockH)))

proc menuBar(): seq[array[4, float32]] =
  ## The menu bar's titles, left to right: the mark, Scenes, Settings, Window, the status icons.
  byX(rectsOf(MacOS).filterIt(it[3] <= MenuH.float32 and it[2] - it[0] < 400))

proc dropItems(title: array[4, float32]): seq[array[4, float32]] =
  ## The items of the menu open under a title, top to bottom.
  byY(rectsOf(MacOS).filterIt(it[1] >= MenuH.float32 - 2 and it[0] > title[0] and it[0] < title[0] + 20 and
    it[3] - it[1] < 30 and it[2] - it[0] > 150))

suite "the macOS desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/apple", "name": "Apple"}, {"id": "tests/lime", "name": "Lime"},
        {"id": "tests/ocean", "name": "Ocean"}]

  test "the first scene fills the desktop between the menu bar and the Dock":
    current = hostScene("tests/apple")
    let image = pass()
    shot(image, "m1-first")
    check problems.len == 0
    check wins().len == 1
    check winOf("tests/apple"){"max"}.getBool()
    check image.color(W div 2, H div 2 - 20) == colored("#ff0000")
    check image.color(W div 2, 10) != colored("#ff0000")
    check image.color(W div 2, H - 20) != colored("#ff0000")
    check dockIcons().len == 6

  test "the Dock opens a scene in a window of its own, a dot under each one open":
    check acted(clickRect(dockIcons()[2])) == @["setCurrentScene"]
    check current.id.string == "tests/lime"
    let image = pass()
    shot(image, "m2-two")
    check problems.len == 0
    check wins().len == 2
    let g = winOf("tests/lime")
    check not g{"max"}.getBool()
    let (gx, gy, gw, gh) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt())
    check image.color(gx + gw div 2, MenuH + gy + gh div 2) == colored("#00ff00")
    check image.color(W - 10, 200) == colored("#ff0000")
    let icons = dockIcons()
    proc dot(r: array[4, float32]): ColorRGBX = image.color(int((r[0] + r[2]) / 2), int(r[3]) - 2)
    check dot(icons[1]) == colored("#1d1d1f")
    check dot(icons[2]) == colored("#1d1d1f")
    check dot(icons[3]) != colored("#1d1d1f")

  test "a window dragged by its title bar follows the pointer":
    let g = winOf("tests/lime")
    let (x0, y0, w) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt())
    let (grabX, grabY) = (x0 + w div 2, MenuH + y0 + 16)
    discard send("pointerDown", at(grabX, grabY))
    discard send("pointerMove", at(grabX + 40, grabY + 30))
    discard send("pointerMove", at(grabX + 100, grabY + 50))
    discard send("pointerUp", at(grabX + 100, grabY + 50, %*{"buttons": 0}))
    check winOf("tests/lime"){"x"}.getInt() == x0 + 100
    check winOf("tests/lime"){"y"}.getInt() == y0 + 50
    check pass().color(x0 + 100 + 30, MenuH + y0 + 50 + 80) == colored("#00ff00")

  test "a press on a window behind brings it forward, and a tap reaches no scene":
    check "setCurrentScene" in click(W - 10, 200)
    check current.id.string == "tests/apple"
    check pass().color(W - 10, 200) == colored("#ff0000")

  test "the yellow light puts the window in front away, and its icon in the Dock brings it back":
    # Apple fills the desktop: its lights at the top left, yellow the second.
    discard click(40, MenuH + 17)
    check winOf("tests/apple"){"min"}.getBool()
    check current.id.string == "tests/lime"
    discard pass()
    check acted(clickRect(dockIcons()[1])) == @["setCurrentScene"]
    check current.id.string == "tests/apple"
    check not winOf("tests/apple"){"min"}.getBool()
    discard pass()

  test "the gear at the right of a scene's title bar opens its settings":
    settingsFrom = ""
    check acted(click(W - 23, MenuH + 17)) == @["sceneSettings"]
    check settingsFrom == "tests/apple"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/apple"
    discard pass()

  test "Scenes in the menu bar opens a scene, and Window gives the panel to the window in front":
    var bar = menuBar()
    check bar.len == 5
    discard clickRect(bar[1])
    check desk().state{"menu"}.getStr() == "scenes"
    shot(pass(), "m3-scenes-menu")
    var items = dropItems(bar[1])
    check items.len == 4 # the three scenes and Launchpad
    check acted(clickRect(items[2])) == @["setCurrentScene"]
    check current.id.string == "tests/ocean"
    check desk().state{"menu"}.kind == JNull
    discard pass()
    check wins().len == 3
    bar = menuBar()
    discard clickRect(bar[3])
    check desk().state{"menu"}.getStr() == "window"
    discard pass()
    items = dropItems(bar[3])
    check items.len == 6 # Minimize, Zoom, Enter Full Screen and the three windows
    discard clickRect(items[2])
    check desk().state{"full"}.getBool()
    let full = pass()
    shot(full, "m4-full")
    check full.color(W div 2, 4) == colored("#0000ff")
    check full.color(W div 2, H - 4) == colored("#0000ff")
    discard key("Escape")
    check not desk().state{"full"}.getBool()
    check problems.len == 0

  test "a window opens at the layout's size where that fits, and where it was when it opens again":
    discard key("w", meta = true) # closes ocean
    check winOf("tests/ocean").isNil
    check current.id.string != "tests/ocean"
    desk().state["windowSize"] = %"400x240"
    desk().state.delete("boxes")
    discard pass()
    check acted(clickRect(dockIcons()[3])) == @["setCurrentScene"]
    check current.id.string == "tests/ocean"
    discard pass()
    let o = winOf("tests/ocean")
    check not o{"max"}.getBool()
    check o{"w"}.getInt() == 400 + 4
    check o{"h"}.getInt() == 240 + 48
    check sceneSize("tests/ocean") == (400, 240)
    let (x, y) = (o{"x"}.getInt(), o{"y"}.getInt())
    discard send("pointerDown", at(x + 200, MenuH + y + 16))
    discard send("pointerMove", at(x + 230, MenuH + y + 36))
    discard send("pointerUp", at(x + 230, MenuH + y + 36, %*{"buttons": 0}))
    discard key("F4", alt = true)
    check winOf("tests/ocean").isNil
    discard pass()
    discard clickRect(dockIcons()[3])
    discard pass()
    check winOf("tests/ocean"){"x"}.getInt() == x + 30
    check winOf("tests/ocean"){"y"}.getInt() == y + 20
    check problems.len == 0

  test "Alt+Tab goes back and forth between two windows":
    let before = current.id.string
    discard key("Tab", alt = true)
    check current.id.string != before
    discard pass()
    discard key("Tab", alt = true)
    check current.id.string == before

  test "the Dock has System Settings and the terminal":
    discard pass()
    let icons = dockIcons()
    check acted(clickRect(icons[4])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check acted(clickRect(icons[5])) == @["terminal"]
    check desk().state{"asked"}.getStr() == "system/terminal"
    discard pass()
    check problems.len == 0

  test "the scene store sits in the Dock beside System Settings, and in the mark's menu":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/apple", "name": "Apple"}, {"id": "tests/lime", "name": "Lime"},
        {"id": "tests/ocean", "name": "Ocean"}, {"id": "tests/store-mac", "name": "Scene store"}]
    discard pass()
    let icons = dockIcons()
    check icons.len == 7 # Launchpad, the three scenes, the store, System Settings, Terminal
    check acted(clickRect(icons[4])) == @["setCurrentScene"]
    check current.id.string == "tests/store-mac"
    shot(pass(), "m5-store")
    check not winOf("tests/store-mac").isNil
    let bar = menuBar()
    discard clickRect(bar[0])
    discard pass()
    check dropItems(bar[0]).len == 4 # System Settings…, Scene Store…, Launchpad, Terminal
    discard key("Escape")
    check problems.len == 0

const BarW = 156 ## the BeOS Deskbar in the corner at 800 x 480

proc tabBoxes(win: JsonNode): seq[array[4, float32]] =
  ## The boxes on a window's tab, left to right: close, the gear (on a scene's), zoom.
  let (x, y) = (win{"x"}.getInt().float32, win{"y"}.getInt().float32)
  byX(rectsOf(BeOS).filterIt(it[1] >= y and it[3] <= y + 26 and it[0] >= x and
    it[2] - it[0] >= 15 and it[2] - it[0] <= 19))

suite "the BeOS desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/be-red", "name": "Red"}, {"id": "tests/be-green", "name": "Green"},
        {"id": "tests/be-blue", "name": "Blue"}]

  test "the first scene fills the desktop beside the Deskbar":
    current = hostScene("tests/be-red")
    let image = pass()
    shot(image, "b1-first")
    check problems.len == 0
    check wins().len == 1
    check winOf("tests/be-red"){"max"}.getBool()
    check image.color(300, 240) == colored("#ff0000")
    check image.color(W - BarW - 20, H div 2) == colored("#ff0000")
    check image.color(W - BarW + 6, H - 10) == colored("#336698")
    # Its row in the Deskbar, under the gem and the tray, pressed in.
    check image.color(W - BarW + 4, 75) == colored("#b8b8b8")

  test "the icons under the Deskbar are the frame's own apps, and the Be menu opens its scenes":
    # Under the Deskbar, with room for three of its rows: the disk, the scene list,
    # the terminal (no store, no asset browser on this frame).
    let (ix, iy) = (W - BarW div 2, 155 + 2 * 66 + 20)
    discard send("tap", at(ix, iy))
    check desk().state{"picked"}.getStr() == "system/terminal"
    check send("doubleTap", at(ix, iy)).filterIt(it != "render") == @["terminal"]
    check send("doubleTap", at(ix, 155 + 20)).filterIt(it != "render") == @["sceneSettings"]
    discard pass()
    # Green, the Be menu's second scene.
    discard click(W - BarW div 2, 17)
    discard pass()
    check "setCurrentScene" in click(W - BarW - 100, 3 + 24 + 12)
    check current.id.string == "tests/be-green"
    let image = pass()
    shot(image, "b2-two")
    check problems.len == 0
    check wins().len == 2
    let g = winOf("tests/be-green")
    check not g{"max"}.getBool()
    check image.color(g{"x"}.getInt() + 150, g{"y"}.getInt() + 120) == colored("#00ff00")
    check image.color(W - BarW - 20, H - 20) == colored("#ff0000")

  test "a window dragged by its tab follows the pointer":
    let g = winOf("tests/be-green")
    let (x0, y0) = (g{"x"}.getInt(), g{"y"}.getInt())
    discard send("pointerDown", at(x0 + 40, y0 + 12))
    discard send("pointerMove", at(x0 + 80, y0 + 42))
    discard send("pointerMove", at(x0 + 140, y0 + 62))
    discard send("pointerUp", at(x0 + 140, y0 + 62, %*{"buttons": 0}))
    check winOf("tests/be-green"){"x"}.getInt() == x0 + 100
    check winOf("tests/be-green"){"y"}.getInt() == y0 + 50
    check pass().color(x0 + 100 + 150, y0 + 50 + 120) == colored("#00ff00")

  test "the gear box on a scene's tab opens its settings, and the zoom box fills the desktop beside the Deskbar":
    let boxes = tabBoxes(winOf("tests/be-green"))
    check boxes.len == 3
    settingsFrom = ""
    check acted(clickRect(boxes[1])) == @["sceneSettings"]
    check settingsFrom == "tests/be-green"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/be-green"
    discard pass()
    discard clickRect(boxes[2])
    check winOf("tests/be-green"){"max"}.getBool()
    let image = pass()
    shot(image, "b3-zoomed")
    check image.color(W - BarW - 20, H div 2) == colored("#00ff00")
    check image.color(W - BarW + 6, H - 10) == colored("#336698")

  test "a window's row in the Deskbar puts it away while in front, and brings it back":
    # Red's row, then green's, under the gem and the tray.
    discard click(W - BarW div 2, 62 + 26 + 13)
    check winOf("tests/be-green"){"min"}.getBool()
    check current.id.string == "tests/be-red"
    discard pass()
    check acted(click(W - BarW div 2, 62 + 26 + 13)) == @["setCurrentScene"]
    check current.id.string == "tests/be-green"
    check not winOf("tests/be-green"){"min"}.getBool()
    discard pass()

  test "the Be menu opens the frame's scenes, Preferences and the terminal":
    proc gem() =
      discard click(W - BarW div 2, 17)
      check desk().state{"menu"}.getBool()
      discard pass()
    # Left of the Deskbar: the three scenes, a rule, Preferences, Scenes, Terminal.
    let mx = W - BarW - 100
    gem()
    shot(pass(), "b4-menu")
    check acted(click(mx, 3 + 2 * 24 + 12)) == @["setCurrentScene"]
    check current.id.string == "tests/be-blue"
    discard pass()
    check wins().len == 3
    gem()
    check acted(click(mx, 3 + 3 * 24 + 8 + 2 * 24 + 12)) == @["terminal"]
    discard pass()
    gem()
    check acted(click(mx, 3 + 3 * 24 + 8 + 12)) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "Alt+W closes the window in front, and a window opens at the layout's size where that fits":
    discard key("w", alt = true)
    check winOf("tests/be-blue").isNil
    check current.id.string != "tests/be-blue"
    desk().state["windowSize"] = %"400x240"
    desk().state.delete("boxes")
    discard pass()
    discard click(W - BarW div 2, 17)
    discard pass()
    check acted(click(W - BarW - 100, 3 + 2 * 24 + 12)) == @["setCurrentScene"]
    check current.id.string == "tests/be-blue"
    discard pass()
    let b = winOf("tests/be-blue")
    check not b{"max"}.getBool()
    check b{"w"}.getInt() == 400 + 12
    check b{"h"}.getInt() == 240 + 36
    check sceneSize("tests/be-blue") == (400, 240)
    check problems.len == 0

  test "the Be menu has the scene store under the frame's scenes":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/be-red", "name": "Red"}, {"id": "tests/be-green", "name": "Green"},
        {"id": "tests/be-blue", "name": "Blue"}, {"id": "tests/store-be", "name": "Scene store"}]
    discard pass()
    discard click(W - BarW div 2, 17)
    check desk().state{"menu"}.getBool()
    shot(pass(), "b5-store-menu")
    # The three scenes, a rule, the store.
    check acted(click(W - BarW - 100, 3 + 3 * 24 + 8 + 12)) == @["setCurrentScene"]
    check current.id.string == "tests/store-be"
    discard pass()
    check not winOf("tests/store-be").isNil
    check problems.len == 0

proc openIds(): seq[string] =
  ## What the desktop showing has open: its windows, or its tiles.
  let (wins, open) = (desk().state{"wins"}, desk().state{"open"})
  if not wins.isNil and wins.kind == JArray:
    for w in wins: result.add w{"id"}.getStr()
  elif not open.isNil and open.kind == JArray:
    for id in open: result.add id.getStr()
  result.sort()

suite "another layout chosen on the frame":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"}]

  test "opens what the desktop before it had open, the same scenes, the one with the focus in front":
    # Windows 98 from the start, with red, green and blue open, green in front.
    chooseLayout(Layout)
    parked = nil
    for scene in hosted.values: scene.wornLayout = nil
    for id in ["tests/red", "tests/green", "tests/blue", "tests/green"]:
      discard focusOn(id)
      discard pass()
    check desk().id.string == Layout
    check desk().state{"openScenes"} == %*["tests/red", "tests/blue", "tests/green"]
    let all = @["tests/blue", "tests/green", "tests/red"]
    for (layoutId, name) in [(MacOS, "15-to-macos"), (Tiling, "16-to-tiling"), (BeOS, "17-to-beos"), (Layout, "18-back")]:
      chooseLayout(layoutId)
      let image = pass()
      shot(image, name)
      check desk().id.string == layoutId
      check openIds() == all
      check current.id.string == "tests/green"
      # The scenes themselves, not new ones: red and blue are in the desktop.
      var embedded: seq[FrameScene]
      for slot in desk().slots: embedded.add slot.child
      check hosted["tests/blue"] in embedded
      check problems.len == 0
    # On macOS the windows cascade in their order, green's on top.
    chooseLayout(MacOS)
    discard pass()
    let g = winOf("tests/green")
    check pass().color(g{"x"}.getInt() + g{"w"}.getInt() div 2, MenuH + g{"y"}.getInt() + g{"h"}.getInt() div 2) ==
      colored("#00ff00")
    chooseLayout("")
    discard pass()
