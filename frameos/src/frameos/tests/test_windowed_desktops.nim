## The Windows 98 and Tiling layouts as desktops (docs/scene-layouts.md
## "Windows"): the real samples on a frame that runs its scenes side by side, played the way the
## Pi's runner plays it — its scenes kept in a table, the layout carried from
## scene to scene — with the pointer and the keys a mouse and a keyboard send.

import std/[json, os, strutils, tables, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  W = 800
  H = 480
  Layout = "layout-windows-98"
  Tiling = "layout-tiling"

proc panel(id, name, hex: string, layout = Layout): JsonNode =
  %*{"id": id, "name": name, "settings": {"execution": "interpreted", "refreshInterval": 600,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {}, "layout": {"sceneId": layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": hex}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}

let layout = parseFile(Samples / "Windows 98 layout" / "scenes.json")[0]
doAssert layout["id"].getStr() == Layout
let tiling = parseFile(Samples / "Tiling layout" / "scenes.json")[0]
doAssert tiling["id"].getStr() == Tiling
setUploadedInterpretedScenes(parseInterpretedScenes($(%*[layout, tiling,
  panel("tests/red", "Red", "#ff0000"), panel("tests/green", "Green", "#00ff00"),
  panel("tests/blue", "Blue", "#0000ff"),
  panel("tests/sky", "Sky", "#38bdf8", Tiling), panel("tests/grass", "Grass", "#4ade80", Tiling),
  panel("tests/sun", "Sun", "#facc15", Tiling)])))
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

proc settle(): seq[string] =
  ## What the handlers sent, the switches done the way runner.selectScene does.
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    result.add message[1]
    if message[1] == "setCurrentScene":
      let next = message[2]{"sceneId"}.getStr()
      if next != current.id.string:
        parked = current.wornLayout
        current.wornLayout = nil
        current = hostScene(next)

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

  test "a double click on a desktop icon opens its scene":
    discard pass()
    # Blue is the third icon in the column at the top left.
    let (ix, iy) = (48, 8 + 2 * 72 + 20)
    discard send("tap", at(ix, iy))
    check desk().state{"picked"}.getStr() == "tests/blue"
    # Its name on the selection's blue.
    let picked = pass()
    var blue = false
    for y in 8 + 2 * 72 + 36 ..< 8 + 3 * 72:
      for x in 8 ..< 88:
        blue = blue or picked.color(x, y) == colored("#000080")
    check blue
    let sent = send("doubleTap", at(ix, iy))
    check "setCurrentScene" in sent
    check current.id.string == "tests/blue"
    let image = pass()
    shot(image, "11-icon-opened")
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

suite "the tiling desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/sky", "name": "Sky"}, {"id": "tests/grass", "name": "Grass"}, {"id": "tests/sun", "name": "Sun"}]

  test "the first scene has the desktop, below the bar":
    current = hostScene("tests/sky")
    let image = pass()
    shot(image, "t1-first")
    check problems.len == 0
    check desk().state{"open"} == %*["tests/sky"]
    check image.color(W div 2, H div 2) == colored("#38bdf8")

  test "the bar's + opens a scene beside it, and every tile is a hole":
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
    # Sun large on the left, the other two in a column on the right.
    check image.color(W div 4, H div 2) == colored("#facc15")
    check image.color(W - 40, H div 3) == colored("#38bdf8")
    check image.color(W - 40, H - 40) == colored("#4ade80")
    var holes = 0
    for slot in desk().slots:
      if slot.hole: inc holes
    check holes == 3

  test "a press on a tile brings it to the left":
    let sent = click(W - 40, H div 3)
    check "setCurrentScene" in sent
    check current.id.string == "tests/sky"
    let image = pass()
    shot(image, "t4-sky")
    check image.color(W div 4, H div 2) == colored("#38bdf8")
