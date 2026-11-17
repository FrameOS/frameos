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
from ../utils/memory import deviceMemoryBytesOverride, panelMemoryBytes
import ../events_gen
import system/sceneSettings/scene as sceneSettings

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  W = 800
  H = 480
  Layout = "layout-windows-98"
  Tiling = "layout-tiling"
  MacOS = "layout-macos"
  BeOS = "layout-beos"
  ClassicMac = "layout-classic-mac"
  NeXT = "layout-nextstep"
  Os2 = "layout-os2-warp"
  Omarchy = "layout-omarchy"
  Commander = "layout-commander"
  Teletext = "layout-teletext"
  EReader = "layout-e-reader"
  TerminalLayout = "layout-terminal"

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

# The "SD card image" sample, as it is built: a slideshow from a folder, every
# due run of its scene the next photo.
let photos = getTempDir() / "frameos-windows98-photos"
createDir(photos)
for (name, hex) in [("a.png", "#ff00ff"), ("b.png", "#00ffff"), ("c.png", "#ffff00")]:
  let photo = newImage(16, 16)
  photo.fill(parseHtmlColor(hex))
  photo.writeFile(photos / name)

proc slideshowPanel(id, name: string): JsonNode =
  %*{"id": id, "name": name, "settings": {"execution": "interpreted", "refreshInterval": 900,
      "backgroundColor": "#000000"},
    "fields": [{"name": "counter", "label": "counter", "type": "integer", "value": "0", "persist": "memory",
      "access": "private"}],
    "apps": {}, "layout": {"sceneId": Layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "data/localImage", "config": {"path": photos,
        "order": "alphabetical", "counterStateKey": "counter"}}},
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
let classicMac = parseFile(Samples / "Classic Mac layout" / "scenes.json")[0]
doAssert classicMac["id"].getStr() == ClassicMac
let nextstep = parseFile(Samples / "NeXTSTEP layout" / "scenes.json")[0]
doAssert nextstep["id"].getStr() == NeXT
let os2 = parseFile(Samples / "OS2 Warp layout" / "scenes.json")[0]
doAssert os2["id"].getStr() == Os2
let omarchy = parseFile(Samples / "Omarchy layout" / "scenes.json")[0]
doAssert omarchy["id"].getStr() == Omarchy
let commander = parseFile(Samples / "Commander layout" / "scenes.json")[0]
doAssert commander["id"].getStr() == Commander
let teletext = parseFile(Samples / "Teletext layout" / "scenes.json")[0]
doAssert teletext["id"].getStr() == Teletext
let eReader = parseFile(Samples / "E-reader layout" / "scenes.json")[0]
doAssert eReader["id"].getStr() == EReader
let terminalLayout = parseFile(Samples / "Terminal layout" / "scenes.json")[0]
doAssert terminalLayout["id"].getStr() == TerminalLayout
var allScenes = %*[layout, tiling, macos, beos, classicMac, nextstep, os2, omarchy, commander, teletext, eReader, terminalLayout,
  panel("tests/red", "Red", "#ff0000"), panel("tests/green", "Green", "#00ff00"),
  panel("tests/blue", "Blue", "#0000ff"),
  panel("tests/sky", "Sky", "#38bdf8", Tiling), panel("tests/grass", "Grass", "#4ade80", Tiling),
  panel("tests/sun", "Sun", "#facc15", Tiling), buttonPanel("tests/button", "Button"),
  panel("tests/apple", "Apple", "#ff0000", MacOS), panel("tests/lime", "Lime", "#00ff00", MacOS),
  panel("tests/ocean", "Ocean", "#0000ff", MacOS),
  panel("tests/be-red", "Red", "#ff0000", BeOS), panel("tests/be-green", "Green", "#00ff00", BeOS),
  panel("tests/be-blue", "Blue", "#0000ff", BeOS),
  panel("tests/cm-red", "Red", "#ff0000", ClassicMac), panel("tests/cm-green", "Green", "#00ff00", ClassicMac),
  panel("tests/cm-blue", "Blue", "#0000ff", ClassicMac),
  panel("tests/next-a", "Alpha", "#ff0000", NeXT), panel("tests/next-b", "Bravo", "#00ff00", NeXT),
  panel("tests/next-c", "Charlie", "#0000ff", NeXT),
  panel("tests/os2-red", "Red", "#ff0000", Os2), panel("tests/os2-green", "Green", "#00ff00", Os2),
  panel("tests/os2-blue", "Blue", "#0000ff", Os2),
  panel("tests/om-red", "Red", "#ff0000", Omarchy), panel("tests/om-green", "Green", "#00ff00", Omarchy),
  panel("tests/om-blue", "Blue", "#0000ff", Omarchy),
  # The scene store and the terminal, as each desktop finds them: by their names.
  panel("tests/store-98", "Scene store", "#3b82f6"), panel("tests/store-tiling", "Scene store", "#3b82f6", Tiling),
  panel("tests/store-mac", "Scene store", "#3b82f6", MacOS), panel("tests/store-be", "Scene store", "#3b82f6", BeOS),
  panel("tests/store-cm", "Scene store", "#3b82f6", ClassicMac), panel("tests/store-next", "Scene store", "#3b82f6", NeXT),
  panel("tests/store-os2", "Scene store", "#3b82f6", Os2), panel("tests/term-os2", "Terminal", "#111111", Os2),
  panel("tests/files-os2", "Files", "#a3e635", Os2),
  panel("tests/store-om", "Scene store", "#3b82f6", Omarchy), panel("tests/term-om", "Terminal", "#111111", Omarchy),
  panel("tests/files-om", "Files", "#a3e635", Omarchy),
  panel("tests/term-98", "Terminal", "#111111"), panel("tests/term-tiling", "Terminal", "#111111", Tiling),
  panel("tests/term-mac", "Terminal", "#111111", MacOS), panel("tests/term-be", "Terminal", "#111111", BeOS),
  panel("tests/term-cm", "Terminal", "#111111", ClassicMac), panel("tests/term-next", "Terminal", "#111111", NeXT),
  # Files (the sample once named Asset browser), as Windows 98 finds it: by its name.
  panel("tests/files-98", "Files", "#a3e635"),
  slideshowPanel("tests/photo", "SD card image"),
  panel("tests/nc-red", "Red", "#ff0000", Commander), panel("tests/nc-green", "Green", "#00ff00", Commander),
  panel("tests/nc-blue", "Blue", "#0000ff", Commander), buttonPanel("tests/nc-button", "Button", Commander),
  panel("tests/tt-red", "Red", "#ff0000", Teletext), panel("tests/tt-green", "Green", "#00ff00", Teletext),
  panel("tests/tt-blue", "Blue", "#0000ff", Teletext),
  panel("tests/er-red", "Red", "#ff0000", EReader), panel("tests/er-green", "Green", "#00ff00", EReader),
  panel("tests/er-blue", "Blue", "#0000ff", EReader),
  panel("tests/tl-red", "Red", "#ff0000", TerminalLayout)]
# Enough BeOS scenes for a Deskbar longer than the panel.
for i in 0 ..< 16: allScenes.add panel("tests/be-" & $i, "Scene " & $i, "#808080", BeOS)
setUploadedInterpretedScenes(parseInterpretedScenes($allScenes))
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
      var next = message[2]{"sceneId"}.getStr()
      let direction = message[2]{"direction"}.getStr()
      if next.len == 0 and direction.len > 0 and not windowSceneListing.isNil:
        # By `direction`: the host's scene order, walked as the dispatcher does.
        var order: seq[string]
        for scene in windowSceneListing(): order.add scene{"id"}.getStr()
        let at = order.find(current.id.string)
        if order.len > 0:
          next = order[if direction == "next": (at + 1) mod order.len else: (at + order.len - 1) mod order.len]
      if next.len > 0 and next != current.id.string:
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

proc withOwnSize(size: string, ids: varargs[string]): proc(): JsonNode {.closure, gcsafe.} =
  ## The scene listing as it is now, with `ids` (every scene, without any)
  ## saying a window size of their own (settings.windowSize, as the hosts list
  ## it in app.frame.scenes).
  let listing = windowSceneListing
  let only = @ids
  result = proc(): JsonNode {.closure, gcsafe.} =
    result = listing()
    for scene in result:
      if only.len == 0 or scene{"id"}.getStr() in only: scene["windowSize"] = %size

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
    let menuTop = H - 42 - (30 * (3 + 2) + 22)
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
    # Down the left: Programs, Control Panel (no store, no Files on this
    # frame), none of the scenes.
    let (ix, iy) = (48, 8 + 1 * 72 + 20)
    discard send("tap", at(ix, iy))
    check desk().state{"picked"}.getStr() == "system/sceneSettings"
    # Its name on the selection's blue.
    let picked = pass()
    shot(picked, "11-icons")
    var blue = false
    for y in 8 + 1 * 72 + 36 ..< 8 + 2 * 72:
      for x in 8 ..< 88:
        blue = blue or picked.color(x, y) == colored("#000080")
    check blue
    check send("doubleTap", at(ix, iy)).filterIt(it != "render") == @["sceneSettings"]
    check send("doubleTap", at(48, 8 + 20)).filterIt(it != "render") == @["sceneSwitcher"]
    # Blue from Start, for the tests after.
    discard click(20, H - 20)
    discard pass()
    let menuTop = H - 42 - (30 * (3 + 2) + 22)
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

  test "a window opens at its scene's own size where that fits, and where it was when it opens again":
    # 800x480, the default, does not fit this desktop; a smaller size of the
    # scene's own does.
    let listing = windowSceneListing
    windowSceneListing = withOwnSize("400x240", "tests/blue")
    desk().state.delete("boxes")
    let menuTop = H - 42 - (30 * (3 + 2) + 22)
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
    windowSceneListing = listing

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

  test "Start has the Control Panel, and no scene settings":
    discard click(20, H - 20) # Start
    let menu = pass()
    shot(menu, "13-start")
    # The last item, at the menu's bottom over the taskbar: Control Panel, the
    # frame's page.
    check click(80, H - 60).filterIt(it != "render") == @["sceneSettings"]
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
    # The store, a rule, the three programs, then Full screen and Control Panel.
    let menuTop = H - 42 - (30 * (3 + 2 + 1) + 22 + 8)
    check click(80, menuTop + 6 + 15).filterIt(it != "render") == @["setCurrentScene"]
    check current.id.string == "tests/store-98"
    discard pass()
    check not winOf("tests/store-98").isNil
    check problems.len == 0
    windowSceneListing = listing

  test "the terminal, where the frame has it, is at the top of Start and an icon on the desktop":
    let listing = windowSceneListing
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"},
        {"id": "tests/term-98", "name": "Terminal"}]
    discard pass()
    discard click(20, H - 20) # Start
    shot(pass(), "15-start-terminal")
    # The terminal, a rule, the three programs (not the terminal), then Full
    # screen and Control Panel.
    let menuTop = H - 42 - (30 * (3 + 2 + 1) + 22 + 8)
    check click(80, menuTop + 6 + 15).filterIt(it != "render") == @["setCurrentScene"]
    check current.id.string == "tests/term-98"
    discard pass()
    check not winOf("tests/term-98").isNil
    # Down the left, under its window: Programs, the terminal, Control Panel.
    var icons: seq[array[4, float32]]
    uiPressRects(Layout, icons)
    check icons.filterIt(it[0] == 8 and it[2] == 88).mapIt(int(it[1])) == @[8, 8 + 72, 8 + 2 * 72]
    check problems.len == 0
    windowSceneListing = listing

  test "Files, by its name or by its old one, is at the top of Start and an icon on the desktop":
    let listing = windowSceneListing
    for name in ["Files", "Asset browser"]:
      let named = name
      windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
        {.cast(gcsafe).}:
          result = %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"},
            {"id": "tests/blue", "name": "Blue"}, {"id": "tests/files-98", "name": named}]
      sendEvent("setCurrentScene", %*{"sceneId": "tests/red"}, eoScene)
      discard settle()
      discard pass()
      discard click(20, H - 20) # Start
      discard pass()
      # Files, a rule, the three programs (not Files), then Full screen and
      # Control Panel.
      let menuTop = H - 42 - (30 * (3 + 2 + 1) + 22 + 8)
      check click(80, menuTop + 6 + 15).filterIt(it != "render") == @["setCurrentScene"]
      check current.id.string == "tests/files-98"
      discard pass()
      check not winOf("tests/files-98").isNil
      # Down the left: Programs, Files, Control Panel.
      var icons: seq[array[4, float32]]
      uiPressRects(Layout, icons)
      check icons.filterIt(it[0] == 8 and it[2] == 88).mapIt(int(it[1])) == @[8, 8 + 72, 8 + 2 * 72]
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

  test "the top bar's prompt opens the terminal as a tile, and the + list leaves it out":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/sky", "name": "Sky"}, {"id": "tests/grass", "name": "Grass"}, {"id": "tests/sun", "name": "Sun"},
        {"id": "tests/button", "name": "Button"}, {"id": "tests/term-tiling", "name": "Terminal"}]
    discard pass()
    let bar = topBar()
    # +, the open tiles' names, the prompt, the arrangement, the gear.
    check acted(clickRect(bar[^3])) == @["setCurrentScene"]
    check current.id.string == "tests/term-tiling"
    discard pass()
    check "tests/term-tiling" in desk().state{"open"}.to(seq[string])
    check problems.len == 0

  test "the + list longer than the desktop scrolls: a finger drags it, a wheel turns it":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      result = %*[{"id": "tests/sky", "name": "Sky"}, {"id": "tests/grass", "name": "Grass"},
        {"id": "tests/sun", "name": "Sun"}, {"id": "tests/button", "name": "Button"}]
      for i in 0 ..< 16: result.add %*{"id": "tests/be-" & $i, "name": "Scene " & $i}
    discard pass()
    discard clickRect(topBar()[0])
    check desk().state{"adding"}.getBool()
    discard pass()
    proc rows(): seq[array[4, float32]] =
      var all: seq[array[4, float32]]
      uiPressRects(Tiling, all)
      # The list's rows, at the left under the bar (the tiles' bars start further right).
      all.filterIt(it[0] >= 8 and it[0] <= 12 and it[1] >= 24 and it[3] - it[1] < 60 and it[2] - it[0] > 40 and
        it[2] < 200).sorted(
        proc(a, b: array[4, float32]): int = cmp(a[1], b[1]))
    let first = rows()
    check first.len > 0
    check first[^1][3] <= float32(H) # what shows is cut to the desktop
    shot(pass(), "t9-long-list")
    # Dragged up by a finger: it follows, and nothing is opened.
    let x = int((first[0][0] + first[0][2]) / 2)
    var sent = send("pointerDown", at(x, 300))
    sent.add send("pointerMove", at(x, 260))
    sent.add send("pointerMove", at(x, 160))
    sent.add send("pointerUp", at(x, 160, %*{"buttons": 0}))
    check "setCurrentScene" notin sent
    check desk().state{"adding"}.getBool()
    discard pass()
    let dragged = rows()
    check dragged[1][1] < first[1][1] # the top one is cut to the box: the next moved up
    # A wheel turned back up over it brings the top back.
    discard send("wheel", %*{"x": x, "y": 200, "deltaX": 0, "deltaY": -10})
    discard pass()
    check rows()[1][1] == first[1][1]
    # A tap on a row still opens its scene.
    check "setCurrentScene" in clickRect(rows()[0])
    discard pass()
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
  ## The Dock's icons, left to right: Launchpad, the scenes with a window, System Settings.
  byX(rectsOf(MacOS).filterIt(it[1] >= float32(H - DockH)))

proc menuBar(): seq[array[4, float32]] =
  ## The menu bar's titles, left to right: the mark, Scenes, Settings, Window, the status icons.
  byX(rectsOf(MacOS).filterIt(it[3] <= MenuH.float32 and it[2] - it[0] < 400))

proc dropItems(title: array[4, float32]): seq[array[4, float32]] =
  ## The items of the menu open under a title, top to bottom.
  byY(rectsOf(MacOS).filterIt(it[1] >= MenuH.float32 - 2 and it[0] > title[0] and it[0] < title[0] + 20 and
    it[3] - it[1] < 30 and it[2] - it[0] > 150))

proc fromScenesMenu(index: int): seq[string] =
  ## The scene at `index` of the menu bar's Scenes opened (the Dock has only the open ones).
  let bar = menuBar()
  discard clickRect(bar[1])
  discard pass()
  acted(clickRect(dropItems(bar[1])[index]))

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
    check dockIcons().len == 3 # Launchpad, the one scene open, System Settings

  test "a scene opens in a window of its own, and the Dock has the ones open, a dot under each":
    check fromScenesMenu(1) == @["setCurrentScene"]
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
    check icons.len == 4 # Launchpad, apple, lime, System Settings: no ocean
    proc dot(r: array[4, float32]): ColorRGBX = image.color(int((r[0] + r[2]) / 2), int(r[3]) - 2)
    check dot(icons[0]) != colored("#1d1d1f")
    check dot(icons[1]) == colored("#1d1d1f")
    check dot(icons[2]) == colored("#1d1d1f")
    check acted(clickRect(icons[1])) == @["setCurrentScene"]
    check current.id.string == "tests/apple"
    discard pass()
    check acted(clickRect(dockIcons()[2])) == @["setCurrentScene"]
    check current.id.string == "tests/lime"
    discard pass()

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

  test "a window opens at its scene's own size where that fits, and where it was when it opens again":
    discard key("w", meta = true) # closes ocean
    check winOf("tests/ocean").isNil
    check current.id.string != "tests/ocean"
    windowSceneListing = withOwnSize("400x240", "tests/ocean")
    desk().state.delete("boxes")
    discard pass()
    check dockIcons().len == 4 # ocean's icon went with its window
    check fromScenesMenu(2) == @["setCurrentScene"]
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
    discard fromScenesMenu(2)
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

  test "the Dock has System Settings":
    discard pass()
    let icons = dockIcons()
    check acted(clickRect(icons[^1])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "the scene store is in the mark's menu, and in the Dock beside System Settings while open":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/apple", "name": "Apple"}, {"id": "tests/lime", "name": "Lime"},
        {"id": "tests/ocean", "name": "Ocean"}, {"id": "tests/store-mac", "name": "Scene store"}]
    discard pass()
    let before = dockIcons().len
    let bar = menuBar()
    discard clickRect(bar[0])
    discard pass()
    let items = dropItems(bar[0])
    check items.len == 3 # System Settings…, Scene Store…, Launchpad
    check acted(clickRect(items[1])) == @["setCurrentScene"]
    check current.id.string == "tests/store-mac"
    shot(pass(), "m5-store")
    check not winOf("tests/store-mac").isNil
    check dockIcons().len == before + 1
    discard focusOn("tests/apple")
    discard pass()
    check acted(clickRect(dockIcons()[^2])) == @["setCurrentScene"]
    check current.id.string == "tests/store-mac"
    discard pass()
    check problems.len == 0

  test "the terminal is in the mark's menu, and in the Dock beside System Settings while open":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/apple", "name": "Apple"}, {"id": "tests/lime", "name": "Lime"},
        {"id": "tests/ocean", "name": "Ocean"}, {"id": "tests/term-mac", "name": "Terminal"}]
    discard pass()
    let before = dockIcons().len
    let bar = menuBar()
    discard clickRect(bar[0])
    discard pass()
    let items = dropItems(bar[0])
    check items.len == 3 # System Settings…, Terminal, Launchpad
    check acted(clickRect(items[1])) == @["setCurrentScene"]
    check current.id.string == "tests/term-mac"
    shot(pass(), "m6-terminal")
    check not winOf("tests/term-mac").isNil
    check dockIcons().len == before + 1
    check problems.len == 0

const BarW = 156 ## the BeOS Deskbar in the corner at 800 x 480

proc iconTop(windows: int): int =
  ## Where Tracker's first icon is under the Deskbar: its gem and tray (63), a
  ## row a window (26), and 14 below.
  63 + 26 * windows + 14

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
    # Under where the Deskbar reaches, one window's row: the disk and the scene
    # list (no store, no Files on this frame).
    let (ix, iy) = (W - BarW div 2, iconTop(1) + 1 * 66 + 20)
    discard send("tap", at(ix, iy))
    check desk().state{"picked"}.getStr() == "system/sceneSwitcher"
    check send("doubleTap", at(ix, iy)).filterIt(it != "render") == @["sceneSwitcher"]
    check send("doubleTap", at(ix, iconTop(1) + 20)).filterIt(it != "render") == @["sceneSettings"]
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

  test "the Be menu opens the frame's scenes and Preferences":
    proc gem() =
      discard click(W - BarW div 2, 17)
      check desk().state{"menu"}.getBool()
      discard pass()
    # Left of the Deskbar: the three scenes, a rule, Preferences, Scenes.
    let mx = W - BarW - 100
    gem()
    shot(pass(), "b4-menu")
    check acted(click(mx, 3 + 2 * 24 + 12)) == @["setCurrentScene"]
    check current.id.string == "tests/be-blue"
    discard pass()
    check wins().len == 3
    gem()
    check acted(click(mx, 3 + 3 * 24 + 8 + 12)) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "Alt+W closes the window in front, and a window opens at its scene's own size where that fits":
    discard key("w", alt = true)
    check winOf("tests/be-blue").isNil
    check current.id.string != "tests/be-blue"
    windowSceneListing = withOwnSize("400x240", "tests/be-blue")
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

  test "the Be menu has the terminal under the frame's scenes, and so do the icons under the Deskbar":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/be-red", "name": "Red"}, {"id": "tests/be-green", "name": "Green"},
        {"id": "tests/be-blue", "name": "Blue"}, {"id": "tests/term-be", "name": "Terminal"}]
    discard pass()
    discard click(W - BarW div 2, 17)
    check desk().state{"menu"}.getBool()
    shot(pass(), "b6-terminal-menu")
    # The three scenes, a rule, the terminal.
    check acted(click(W - BarW - 100, 3 + 3 * 24 + 8 + 12)) == @["setCurrentScene"]
    check current.id.string == "tests/term-be"
    discard pass()
    check not winOf("tests/term-be").isNil
    # Under the Deskbar, four windows' rows long now: the disk, the scene list, the
    # terminal, each below where it reaches.
    check wins().len == 4
    discard send("tap", at(W - BarW div 2, iconTop(4) + 2 * 66 + 20))
    check desk().state{"picked"}.getStr() == "tests/term-be"
    discard send("tap", at(W - BarW div 2, iconTop(4) + 20))
    check desk().state{"picked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "however long the Deskbar grows, Tracker's icons stay clear of it":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      result = newJArray()
      for i in 0 ..< 16: result.add %*{"id": "tests/be-" & $i, "name": "Scene " & $i}
      result.add %*{"id": "tests/term-be", "name": "Terminal"}
    for i in 0 ..< 16:
      discard focusOn("tests/be-" & $i)
      discard pass()
    let n = wins().len
    check n >= 16
    check iconTop(n) > H # the Deskbar runs off the panel: every icon goes left of it
    shot(pass(), "b7-long-deskbar")
    # The disk heads the column left of the Deskbar's, the scene list under it.
    discard send("tap", at(W - BarW - 4 - 88 div 2, 14 + 20))
    check desk().state{"picked"}.getStr() == "system/sceneSettings"
    discard send("tap", at(W - BarW - 4 - 88 div 2, 14 + 66 + 20))
    check desk().state{"picked"}.getStr() == "system/sceneSwitcher"
    check problems.len == 0

proc openIds(): seq[string] =
  ## What the desktop showing has open: its windows, or its tiles.
  let (wins, open) = (desk().state{"wins"}, desk().state{"open"})
  if not wins.isNil and wins.kind == JArray:
    for w in wins: result.add w{"id"}.getStr()
  elif not open.isNil and open.kind == JArray:
    for id in open: result.add id.getStr()
  result.sort()

const
  CMenuH = 20 ## the Classic Mac menu bar at 800 x 480, the desktop the 460 px under it
  CIconX = W - 4 - 42 ## the middle of the column of icons down the desktop's right
  CIconTop = CMenuH + 10 ## the first icon's top, one every 62 px

proc macTitles(): seq[array[4, float32]] =
  ## The menu bar's titles, left to right: the mark, File, Scenes, Special, the clock,
  ## the Application menu.
  byX(rectsOf(ClassicMac).filterIt(it[1] <= 1 and it[3] <= CMenuH.float32 and it[2] - it[0] < 200))

proc macDrop(title: array[4, float32], right = false): seq[array[4, float32]] =
  ## The items of the menu open under a title, top to bottom (rules take no press).
  byY(rectsOf(ClassicMac).filterIt(it[1] >= CMenuH.float32 - 2 and it[3] - it[1] < 25 and it[2] - it[0] > 150 and
    (if right: it[2] <= title[2] + 1 and it[2] >= title[2] - 6 else: it[0] >= title[0] and it[0] <= title[0] + 6)))

proc fromMacScenes(index: int): seq[string] =
  ## The scene at `index` of the menu bar's Scenes opened.
  let bar = macTitles()
  discard clickRect(bar[2])
  discard pass()
  acted(clickRect(macDrop(bar[2])[index]))

proc titleBoxes(win: JsonNode): seq[array[4, float32]] =
  ## The boxes on a window's title bar, left to right: close, the gear (on a
  ## scene's), zoom. Only the window in front has them.
  let maxed = win{"max"}.getBool()
  let x = (if maxed: 0 else: win{"x"}.getInt()).float32
  let y = (CMenuH + (if maxed: 0 else: win{"y"}.getInt())).float32
  byX(rectsOf(ClassicMac).filterIt(it[0] >= x and it[1] >= y and it[3] <= y + 22 and
    it[2] - it[0] >= 13 and it[2] - it[0] <= 17))

proc isHole(scene: FrameScene): bool =
  ## Whether the desktop draws a scene straight into its window (a hole), not as a picture.
  for slot in desk().slots:
    if slot.hole and slot.child == scene: return true

proc blackShare(image: Image, x0, y0, x1, y1: int): float =
  var black = 0
  for y in y0 ..< y1:
    for x in x0 ..< x1:
      if image.color(x, y) == colored("#000000"): inc black
  black / ((x1 - x0) * (y1 - y0))

proc dragBy(x, y, dx, dy: int) =
  discard send("pointerDown", at(x, y))
  discard send("pointerMove", at(x + dx div 2, y + dy div 2))
  discard send("pointerMove", at(x + dx, y + dy))
  discard send("pointerUp", at(x + dx, y + dy, %*{"buttons": 0}))

suite "the Classic Mac desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/cm-red", "name": "Red"}, {"id": "tests/cm-green", "name": "Green"},
        {"id": "tests/cm-blue", "name": "Blue"}]

  test "the first scene fills the desktop under the menu bar, the screen's corners rounded":
    current = hostScene("tests/cm-red")
    let image = pass()
    shot(image, "cm1-first")
    check problems.len == 0
    check wins().len == 1
    check winOf("tests/cm-red"){"max"}.getBool()
    check isHole(current)
    check image.color(W div 2, H div 2) == colored("#ff0000")
    check image.color(W div 2, 4) == colored("#ffffff") # the menu bar
    check image.color(W div 2, CMenuH - 1) == colored("#000000") # and its rule
    check image.color(0, 0) == colored("#000000")
    check image.color(W - 1, 0) == colored("#000000")
    check macTitles().len == 6

  test "Scenes in the menu bar opens a scene in a window of its own":
    let bar = macTitles()
    discard clickRect(bar[2])
    check desk().state{"menu"}.getStr() == "scenes"
    shot(pass(), "cm2-scenes-menu")
    let items = macDrop(bar[2])
    check items.len == 3
    check acted(clickRect(items[1])) == @["setCurrentScene"]
    check current.id.string == "tests/cm-green"
    check desk().state{"menu"}.kind == JNull
    let image = pass()
    check problems.len == 0
    check wins().len == 2
    check isHole(current)
    let g = winOf("tests/cm-green")
    check not g{"max"}.getBool()
    let (gx, gy, gw, gh) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt())
    check image.color(gx + gw div 2, CMenuH + gy + gh div 2) == colored("#00ff00")
    check image.color(W - 10, 300) == colored("#ff0000")

  test "a window dragged by its title bar follows the pointer":
    let g = winOf("tests/cm-green")
    let (x0, y0, w) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt())
    let (grabX, grabY) = (x0 + w div 2, CMenuH + y0 + 10)
    discard send("pointerDown", at(grabX, grabY))
    discard send("pointerMove", at(grabX + 40, grabY + 30))
    discard send("pointerMove", at(grabX + 100, grabY + 50))
    discard send("pointerUp", at(grabX + 100, grabY + 50, %*{"buttons": 0}))
    check winOf("tests/cm-green"){"x"}.getInt() == x0 + 100
    check winOf("tests/cm-green"){"y"}.getInt() == y0 + 50
    check pass().color(x0 + 100 + 30, CMenuH + y0 + 50 + 80) == colored("#00ff00")

  test "a press on a window behind brings it forward, and a tap reaches no scene":
    check "setCurrentScene" in click(W - 10, 300)
    check current.id.string == "tests/cm-red"
    check pass().color(W - 10, 300) == colored("#ff0000")

  test "a double click on a title bar rolls its window up, the next one taking the focus, and another rolls it down":
    # Red fills the desktop: its title bar across the top, right of green.
    check acted(send("doubleTap", at(W - 60, CMenuH + 10))) == @["setCurrentScene"]
    check winOf("tests/cm-red"){"shade"}.getBool()
    check current.id.string == "tests/cm-green"
    var image = pass()
    shot(image, "cm3-shade")
    check isHole(current)
    check image.color(W - 60, 300) == colored("#808080") # the desktop, under where red was
    check image.color(W - 60, CMenuH + 10) == colored("#ffffff") # red's title bar, behind: plain white
    check acted(send("doubleTap", at(W - 60, CMenuH + 10))) == @["setCurrentScene"]
    check not winOf("tests/cm-red"){"shade"}.getBool()
    check current.id.string == "tests/cm-red"
    image = pass()
    check image.color(W - 60, 300) == colored("#ff0000")
    check problems.len == 0

  test "the gear box on a scene's title bar opens its settings":
    let boxes = titleBoxes(winOf("tests/cm-red"))
    check boxes.len == 3
    settingsFrom = ""
    check acted(clickRect(boxes[1])) == @["sceneSettings"]
    check settingsFrom == "tests/cm-red"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/cm-red"
    discard pass()

  test "the zoom box gives a window its own box back, and the icons down the right are the frame's own apps":
    discard clickRect(titleBoxes(winOf("tests/cm-red"))[2])
    check not winOf("tests/cm-red"){"max"}.getBool()
    discard pass()
    # The disk and the scene list (no store, no Files, no terminal on this
    # frame), none of the scenes.
    discard send("tap", at(CIconX, CIconTop + 62 + 16))
    check desk().state{"picked"}.getStr() == "system/sceneSwitcher"
    let picked = pass()
    shot(picked, "cm4-icons")
    # Its name on black: the label under the folder, inverted.
    check picked.blackShare(CIconX - 20, CIconTop + 62 + 38, CIconX + 20, CIconTop + 62 + 50) > 0.5
    check picked.blackShare(CIconX - 14, CIconTop + 38, CIconX + 14, CIconTop + 50) < 0.5
    check send("doubleTap", at(CIconX, CIconTop + 62 + 16)).filterIt(it != "render") == @["sceneSwitcher"]
    check desk().state{"asked"}.getStr() == "system/sceneSwitcher"
    check send("doubleTap", at(CIconX, CIconTop + 16)).filterIt(it != "render") == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "the Application menu hides the window in front or the others, shows them all, and brings any forward":
    var bar = macTitles()
    discard clickRect(bar[^1])
    check desk().state{"menu"}.getStr() == "app"
    shot(pass(), "cm5-app-menu")
    var items = macDrop(bar[^1], right = true)
    check items.len == 5 # Hide Red, Hide Others, Show All, and the two windows
    discard clickRect(items[1]) # Hide Others
    check winOf("tests/cm-green"){"min"}.getBool()
    check not winOf("tests/cm-red"){"min"}.getBool()
    check pass().color(W - 10, CMenuH + 300) == colored("#808080")
    bar = macTitles()
    discard clickRect(bar[^1])
    discard pass()
    discard clickRect(macDrop(bar[^1], right = true)[2]) # Show All
    check not winOf("tests/cm-green"){"min"}.getBool()
    discard pass()
    discard clickRect(bar[^1])
    discard pass()
    check acted(clickRect(macDrop(bar[^1], right = true)[0])) == @["setCurrentScene"] # Hide Red
    check winOf("tests/cm-red"){"min"}.getBool()
    check current.id.string == "tests/cm-green"
    discard pass()
    discard clickRect(bar[^1])
    discard pass()
    items = macDrop(bar[^1], right = true)
    check items.len == 5
    check acted(clickRect(items[3])) == @["setCurrentScene"] # Red, hidden: brought back
    check current.id.string == "tests/cm-red"
    check not winOf("tests/cm-red"){"min"}.getBool()
    discard pass()
    check problems.len == 0

  test "Special gives the panel to the window in front, and cleans up the windows":
    var bar = macTitles()
    discard clickRect(bar[3])
    discard pass()
    var items = macDrop(bar[3])
    check items.len == 2 # Clean Up Windows, Full Screen
    discard clickRect(items[1])
    check desk().state{"full"}.getBool()
    let full = pass()
    shot(full, "cm6-full")
    check full.color(W div 2, 4) == colored("#ff0000")
    check full.color(W div 2, H - 4) == colored("#ff0000")
    discard key("Escape")
    check not desk().state{"full"}.getBool()
    discard pass()
    # Clean Up: every window cascades from the top left again, the one in front last.
    bar = macTitles()
    discard clickRect(bar[3])
    discard pass()
    discard clickRect(macDrop(bar[3])[0])
    check (winOf("tests/cm-green"){"x"}.getInt(), winOf("tests/cm-green"){"y"}.getInt()) == (24, 12)
    check (winOf("tests/cm-red"){"x"}.getInt(), winOf("tests/cm-red"){"y"}.getInt()) == (46, 34)
    check desk().state{"menu"}.kind == JNull
    discard pass()
    check problems.len == 0

  test "File gets the info of the window in front and closes it, and a window opens at its scene's own size and where it was":
    var bar = macTitles()
    discard clickRect(bar[1])
    discard pass()
    var items = macDrop(bar[1])
    check items.len == 3 # Open Scene…, Close Window, Get Info
    settingsFrom = ""
    check acted(clickRect(items[2])) == @["sceneSettings"]
    check settingsFrom == "tests/cm-red"
    discard pass()
    discard clickRect(bar[1])
    discard pass()
    check acted(clickRect(macDrop(bar[1])[1])) == @["setCurrentScene"]
    check winOf("tests/cm-red").isNil
    check current.id.string == "tests/cm-green"
    discard pass()
    windowSceneListing = withOwnSize("400x240", "tests/cm-blue")
    desk().state.delete("boxes")
    discard pass()
    check fromMacScenes(2) == @["setCurrentScene"]
    check current.id.string == "tests/cm-blue"
    discard pass()
    let o = winOf("tests/cm-blue")
    check not o{"max"}.getBool()
    check o{"w"}.getInt() == 400 + 3
    check o{"h"}.getInt() == 240 + 23
    check sceneSize("tests/cm-blue") == (400, 240)
    let (x, y) = (o{"x"}.getInt(), o{"y"}.getInt())
    dragBy(x + 200, CMenuH + y + 10, 30, 20)
    discard key("F4", alt = true)
    check winOf("tests/cm-blue").isNil
    discard pass()
    discard fromMacScenes(2)
    discard pass()
    check winOf("tests/cm-blue"){"x"}.getInt() == x + 30
    check winOf("tests/cm-blue"){"y"}.getInt() == y + 20
    check problems.len == 0

  test "Alt+Tab goes back and forth between two windows, and Cmd+H hides the one in front":
    let before = current.id.string
    discard key("Tab", alt = true)
    check current.id.string != before
    discard pass()
    discard key("Tab", alt = true)
    check current.id.string == before
    discard pass()
    discard key("h", meta = true)
    check winOf(before){"min"}.getBool()
    check current.id.string != before
    discard pass()
    discard key("w", meta = true)
    check wins().len == 1
    discard pass()

  test "the mark's menu has About This Frame, and the scene store and the terminal where the frame has them":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/cm-red", "name": "Red"}, {"id": "tests/cm-green", "name": "Green"},
        {"id": "tests/cm-blue", "name": "Blue"}, {"id": "tests/store-cm", "name": "Scene store"},
        {"id": "tests/term-cm", "name": "Terminal"}]
    # Every window at 400 x 240, as the desktop's own "Window size" had them
    # here since File's test: the icons down the right stay clear.
    windowSceneListing = withOwnSize("400x240")
    discard pass()
    let bar = macTitles()
    discard clickRect(bar[0])
    shot(pass(), "cm7-mark-menu")
    var items = macDrop(bar[0])
    check items.len == 4 # About This Frame…, Scene store, Terminal, Scenes…
    check acted(clickRect(items[0])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    discard pass()
    discard clickRect(bar[0])
    discard pass()
    check acted(clickRect(macDrop(bar[0])[1])) == @["setCurrentScene"]
    check current.id.string == "tests/store-cm"
    discard pass()
    check not winOf("tests/store-cm").isNil
    # Scenes has them under a rule, after the frame's scenes.
    discard clickRect(macTitles()[2])
    discard pass()
    check macDrop(macTitles()[2]).len == 5
    discard key("Escape")
    discard pass()
    # And so do the icons: the disk, the scene list, the store, the terminal.
    discard send("tap", at(CIconX, CIconTop + 3 * 62 + 16))
    check desk().state{"picked"}.getStr() == "tests/term-cm"
    check send("doubleTap", at(CIconX, CIconTop + 3 * 62 + 16)).filterIt(it != "render") == @["setCurrentScene"]
    check current.id.string == "tests/term-cm"
    shot(pass(), "cm8-terminal")
    check problems.len == 0

  test "two windows let go at the two sides take a half each, and both scenes are drawn as holes":
    # Two windows of 400 x 240, as the desktop's own "Window size" had them here
    # since File's test: each title bar where the drags below take it.
    windowSceneListing = withOwnSize("400x240")
    desk().state["wins"] = %*[]
    desk().state.delete("boxes")
    discard focusOn("tests/cm-red")
    discard pass()
    discard focusOn("tests/cm-green")
    discard pass()
    check wins().len == 2
    var r = winOf("tests/cm-red")
    dragBy(r{"x"}.getInt() + 150, CMenuH + r{"y"}.getInt() + 10, -(r{"x"}.getInt() + 150), 0)
    check winOf("tests/cm-red"){"snap"}.getStr() == "l"
    discard pass()
    let g = winOf("tests/cm-green")
    # Red, in front on the left half now, covers most of green's title bar: its right end.
    dragBy(g{"x"}.getInt() + 380, CMenuH + g{"y"}.getInt() + 10, W - 1 - (g{"x"}.getInt() + 380), 0)
    check winOf("tests/cm-green"){"snap"}.getStr() == "r"
    let image = pass()
    shot(image, "cm9-halves")
    check current.id.string == "tests/cm-green"
    check isHole(current)
    check isHole(hosted["tests/cm-red"])
    check image.color(W div 4, H div 2) == colored("#ff0000")
    check image.color(3 * W div 4, H div 2) == colored("#00ff00")
    check problems.len == 0

  test "where only two scenes run at once, a third opened closes the one that had the focus longest ago":
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 65536
    check windowLimit() == 2
    desk().state["wins"] = %*[]
    for id in ["tests/cm-red", "tests/cm-green", "tests/cm-blue"]:
      discard focusOn(id)
      discard pass()
    var open: seq[string]
    for w in wins(): open.add w{"id"}.getStr()
    check open.sorted() == @["tests/cm-blue", "tests/cm-green"]
    check desk().state{"openScenes"} == %*["tests/cm-green", "tests/cm-blue"]
    discard focusOn("tests/cm-red")
    discard pass()
    open = @[]
    for w in wins(): open.add w{"id"}.getStr()
    check open.sorted() == @["tests/cm-blue", "tests/cm-red"]
    check problems.len == 0
    deviceMemoryBytesOverride = 0

  test "the window limit counts what the panel leaves the scenes, not all of the PSRAM":
    # fos_display_render_psram_bytes less its 1.5 MiB headroom, plus the
    # 1 MiB emergency reserve, as embedded_runtime.nim hands it over.
    const MiB = 1024 * 1024
    deviceMemoryBytesOverride = 8 * MiB
    panelMemoryBytes = proc(): int {.nimcall, gcsafe, raises: [].} =
      1200 * 1600 * 2 + 1200 * 1600 div 2 + MiB # the E1004: a 565 canvas, its packed buffer
    check windowLimit() == 1
    panelMemoryBytes = proc(): int {.nimcall, gcsafe, raises: [].} =
      2 * ((1872 + 1) div 2) * 1404 + MiB # the E1003: a 4-bit canvas, its panel buffer
    check windowLimit() == 2
    panelMemoryBytes = proc(): int {.nimcall, gcsafe, raises: [].} =
      480 * 480 * 2 * 5 + MiB # the SenseCAP Indicator: canvas, packed buffer, three frame buffers
    check windowLimit() == 2
    deviceMemoryBytesOverride = 16 * MiB
    panelMemoryBytes = proc(): int {.nimcall, gcsafe, raises: [].} =
      800 * 480 * 4 + 800 * 480 div 2 + MiB
    check windowLimit() == 4
    panelMemoryBytes = nil
    deviceMemoryBytesOverride = 0
    check windowLimit() == 0

const
  NextMenuW = 118 ## the NeXTSTEP main menu's column at 800 x 480
  NextDockW = 64 ## and the Dock's, the desktop the 618 px between them
  NextDeskW = W - NextMenuW - NextDockW

proc nextMenu(): seq[array[4, float32]] =
  ## The main menu's items, top to bottom: Info, Scenes, Windows, (Services,) Hide.
  byY(rectsOf(NeXT).filterIt(it[0] <= 2 and it[2] <= NextMenuW.float32 + 1 and it[3] - it[1] < 30 and
    it[1] > 10))

proc nextSubmenu(): seq[array[4, float32]] =
  ## The items of the submenu open beside the main menu, top to bottom.
  byY(rectsOf(NeXT).filterIt(it[0] >= NextMenuW.float32 - 2 and it[0] <= NextMenuW.float32 + 4 and
    it[1] > 40 and it[3] - it[1] < 30 and it[2] - it[0] > 150))

proc nextDock(): seq[array[4, float32]] =
  ## The Dock's tiles, top to bottom: the mark, the scenes, the store / terminal, the clock.
  byY(rectsOf(NeXT).filterIt(it[0] >= float32(W - NextDockW - 1) and it[2] - it[0] >= 60))

proc nextMinis(): seq[array[4, float32]] =
  ## The miniwindows under the main menu.
  byY(rectsOf(NeXT).filterIt(it[2] <= NextMenuW.float32 and it[1] > 150 and it[3] - it[1] >= 50))

proc idle(image: Image, tile: array[4, float32]): bool =
  ## Whether a Dock tile has the ellipsis at its bottom left: a scene not running.
  for y in int(tile[3]) - 12 .. int(tile[3]) - 3:
    for x in int(tile[0]) + 3 .. int(tile[0]) + 22:
      if image.color(x, y) == colored("#000000"):
        return true

proc fromNextMenu(item, index: int): seq[string] =
  ## The item at `index` of the submenu under the main menu's `item` chosen.
  discard clickRect(nextMenu()[item])
  discard pass()
  acted(clickRect(nextSubmenu()[index]))

suite "the NeXTSTEP desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/next-a", "name": "Alpha"}, {"id": "tests/next-b", "name": "Bravo"},
        {"id": "tests/next-c", "name": "Charlie"}]

  test "the first scene fills the desktop between the main menu and the Dock":
    current = hostScene("tests/next-a")
    let image = pass()
    shot(image, "n1-first")
    check problems.len == 0
    check desk().id.string == NeXT
    check wins().len == 1
    check winOf("tests/next-a"){"max"}.getBool()
    check image.color(NextMenuW + NextDeskW div 2, H div 2) == colored("#ff0000")
    check image.color(NextMenuW + 4, H div 2) == colored("#ff0000")
    check image.color(W - NextDockW - 4, H div 2) == colored("#ff0000")
    # The workspace's grey under the menu, and the Dock's tiles on the right.
    check image.color(50, H - 20) == colored("#555555")
    check image.color(W - NextDockW + 6, 58) == colored("#aaaaaa")
    # Its title bar, black: the window has the focus.
    check image.color(NextMenuW + 200, 8) == colored("#000000")
    let tiles = nextDock()
    check tiles.len == 3 # the mark, Alpha, the clock: Bravo and Charlie have not run
    check not image.idle(tiles[1]) # Alpha runs
    check nextMenu().len == 4 # Info, Scenes, Windows, Hide: no Services on this frame
    # The scene is a hole in the desktop, drawn straight into the panel.
    check desk().slots.anyIt(it.hole and it.child == current)

  test "Scenes opens a scene in a window of its own, and a tile of its own in the Dock":
    discard clickRect(nextMenu()[1])
    check desk().state{"menu"}.getStr() == "scenes"
    shot(pass(), "n2-scenes")
    check nextSubmenu().len == 4 # the three scenes and the scene list
    check acted(clickRect(nextSubmenu()[1])) == @["setCurrentScene"]
    check current.id.string == "tests/next-b"
    check desk().state{"menu"}.kind == JNull
    let image = pass()
    check problems.len == 0
    check wins().len == 2
    let b = winOf("tests/next-b")
    check not b{"max"}.getBool()
    let (bx, by, bw, bh) = (b{"x"}.getInt(), b{"y"}.getInt(), b{"w"}.getInt(), b{"h"}.getInt())
    check image.color(NextMenuW + bx + bw div 2, by + bh div 2) == colored("#00ff00")
    check image.color(NextMenuW + NextDeskW - 10, H - 30) == colored("#ff0000")
    # Alpha's title bar behind, light grey; Bravo's black.
    check image.color(NextMenuW + NextDeskW - 60, 8) == colored("#aaaaaa")
    check image.color(NextMenuW + bx + bw div 2, by + 4) == colored("#000000")
    let tiles = nextDock()
    check tiles.len == 4 # the mark, Alpha, Bravo, the clock
    check not image.idle(tiles[1])
    check not image.idle(tiles[2])
    # The window in front's scene is a hole (Alpha's, under it, is a picture: Bravo
    # is painted over it).
    check desk().slots.anyIt(it.hole and it.child == current)

  test "a window dragged by its title bar follows the pointer":
    let b = winOf("tests/next-b")
    let (x0, y0, w) = (b{"x"}.getInt(), b{"y"}.getInt(), b{"w"}.getInt())
    let (grabX, grabY) = (NextMenuW + x0 + w div 2, y0 + 12)
    discard send("pointerDown", at(grabX, grabY))
    discard send("pointerMove", at(grabX + 40, grabY + 30))
    discard send("pointerMove", at(grabX + 100, grabY + 50))
    discard send("pointerUp", at(grabX + 100, grabY + 50, %*{"buttons": 0}))
    check winOf("tests/next-b"){"x"}.getInt() == x0 + 100
    check winOf("tests/next-b"){"y"}.getInt() == y0 + 50
    check pass().color(NextMenuW + x0 + 100 + 30, y0 + 50 + 80) == colored("#00ff00")

  test "a press on a window behind brings it forward, and a tap reaches no scene":
    check "setCurrentScene" in click(NextMenuW + 10, H - 30)
    check current.id.string == "tests/next-a"
    check pass().color(NextMenuW + 10, H - 30) == colored("#ff0000")

  test "the button at a title bar's left makes a miniwindow under the menu, and a click on it brings the window back":
    # Alpha fills the desktop: its button at the top left.
    check nextMinis().len == 0
    discard click(NextMenuW + 12, 12)
    check winOf("tests/next-a"){"min"}.getBool()
    check current.id.string == "tests/next-b"
    let image = pass()
    shot(image, "n3-miniwindow")
    let minis = nextMinis()
    check minis.len == 1
    # Its black strip with the name, and Alpha's picture gone from the desktop.
    check image.color(int(minis[0][0]) + 52, int(minis[0][1]) + 4) == colored("#000000")
    check image.color(NextMenuW + NextDeskW - 10, H - 30) != colored("#ff0000")
    check desk().slots.anyIt(it.hole and it.child == current)
    check acted(clickRect(minis[0])) == @["setCurrentScene"]
    check current.id.string == "tests/next-a"
    check not winOf("tests/next-a"){"min"}.getBool()
    discard pass()
    check nextMinis().len == 0
    # Hide does it to the window in front, and so does Cmd+H.
    discard clickRect(nextMenu()[^1])
    check winOf("tests/next-a"){"min"}.getBool()
    check current.id.string == "tests/next-b"
    discard pass()
    discard key("h", meta = true)
    check winOf("tests/next-b"){"min"}.getBool()
    discard pass()
    check nextMinis().len == 2
    discard clickRect(nextMinis()[0])
    discard pass()
    discard clickRect(nextMinis()[0])
    discard pass()
    check nextMinis().len == 0
    check problems.len == 0

  test "the gear on a scene's title bar opens its settings":
    discard focusOn("tests/next-a")
    discard pass()
    check winOf("tests/next-a"){"max"}.getBool()
    settingsFrom = ""
    check acted(click(NextMenuW + NextDeskW - 31, 12)) == @["sceneSettings"]
    check settingsFrom == "tests/next-a"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/next-a"
    discard pass()

  test "Info has the frame's page and the Inspector of the scene in front":
    check fromNextMenu(0, 0) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    desk().state["asked"] = newJNull()
    check fromNextMenu(0, 1) == @["sceneSettings"]
    check desk().state{"asked"}.getStr() == "system/sceneSettings#" & current.id.string
    discard pass()
    check problems.len == 0

  test "Windows lists the windows, and Full Screen gives the panel to the window in front":
    discard clickRect(nextMenu()[2])
    check desk().state{"menu"}.getStr() == "windows"
    shot(pass(), "n4-windows")
    let items = nextSubmenu()
    check items.len == 5 # the two windows, Full Screen, Miniaturize Window, Close Window
    discard clickRect(items[2])
    check desk().state{"full"}.getBool()
    let full = pass()
    shot(full, "n5-full")
    check full.color(W div 2, 4) == colored("#ff0000")
    check full.color(4, H - 4) == colored("#ff0000")
    check full.color(W - 4, H - 4) == colored("#ff0000")
    discard key("Escape")
    check not desk().state{"full"}.getBool()
    discard pass()
    check nextMenu().len == 4
    check problems.len == 0

  test "a window opens at its scene's own size where that fits, and where it was when it opens again":
    check fromNextMenu(1, 2) == @["setCurrentScene"]
    check current.id.string == "tests/next-c"
    discard pass()
    discard key("w", meta = true) # closes Charlie
    check winOf("tests/next-c").isNil
    check current.id.string != "tests/next-c"
    windowSceneListing = withOwnSize("400x240", "tests/next-c")
    desk().state.delete("boxes")
    discard pass()
    check fromNextMenu(1, 2) == @["setCurrentScene"]
    check current.id.string == "tests/next-c"
    discard pass()
    let c = winOf("tests/next-c")
    check not c{"max"}.getBool()
    check c{"w"}.getInt() == 400 + 2
    check c{"h"}.getInt() == 240 + 34
    check sceneSize("tests/next-c") == (400, 240)
    let (x, y) = (c{"x"}.getInt(), c{"y"}.getInt())
    # Moved away from the desktop's nearer side edge, where it may have opened, so
    # its close button stays clear of the Dock.
    let dx = (if x + c{"w"}.getInt() + 30 <= NextDeskW: 30 else: -30)
    discard send("pointerDown", at(NextMenuW + x + 200, y + 12))
    discard send("pointerMove", at(NextMenuW + x + 200 + dx, y + 32))
    discard send("pointerUp", at(NextMenuW + x + 200 + dx, y + 32, %*{"buttons": 0}))
    discard key("F4", alt = true)
    check winOf("tests/next-c").isNil
    discard pass()
    discard fromNextMenu(1, 2)
    discard pass()
    check winOf("tests/next-c"){"x"}.getInt() == x + dx
    check winOf("tests/next-c"){"y"}.getInt() == y + 20
    # Its close button: the window goes, and the next one down takes the focus.
    let c2 = winOf("tests/next-c")
    discard click(NextMenuW + c2{"x"}.getInt() + c2{"w"}.getInt() - 12, c2{"y"}.getInt() + 12)
    check winOf("tests/next-c").isNil
    check current.id.string != "tests/next-c"
    discard pass()
    check problems.len == 0

  test "Alt+Tab goes back and forth between two windows":
    let before = current.id.string
    discard key("Tab", alt = true)
    check current.id.string != before
    discard pass()
    discard key("Tab", alt = true)
    check current.id.string == before

  test "the Dock's mark opens the scene list, a scene's tile its scene, and the clock the frame's page":
    discard pass()
    var tiles = nextDock()
    check acted(clickRect(tiles[0])) == @["sceneSwitcher"]
    check desk().state{"asked"}.getStr() == "system/sceneSwitcher"
    discard pass()
    desk().state["asked"] = newJNull()
    check winOf("tests/next-c").isNil
    # Charlie ran before and was closed: in the Dock, the ellipsis under it.
    tiles = nextDock()
    check tiles.len == 5
    check pass().idle(tiles[3])
    check acted(clickRect(tiles[3])) == @["setCurrentScene"]
    check current.id.string == "tests/next-c"
    check not pass().idle(nextDock()[3])
    check acted(clickRect(nextDock()[^1])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"asked"}.getStr() == "system/sceneSettings"
    discard pass()
    check problems.len == 0

  test "Services has the scene store and the terminal, each in a window and in the Dock":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/next-a", "name": "Alpha"}, {"id": "tests/next-b", "name": "Bravo"},
        {"id": "tests/next-c", "name": "Charlie"}, {"id": "tests/store-next", "name": "Scene store"},
        {"id": "tests/term-next", "name": "Terminal"}]
    var image = pass()
    check nextMenu().len == 5 # Info, Scenes, Windows, Services, Hide
    # The mark, the three scenes, the clock: the store and the terminal have not
    # run, so they are not in the Dock yet.
    check nextDock().len == 5
    discard clickRect(nextMenu()[1])
    discard pass()
    check nextSubmenu().len == 4 # the three scenes and the scene list: not the store or the terminal
    discard clickRect(nextMenu()[1])
    discard pass()
    check fromNextMenu(3, 0) == @["setCurrentScene"]
    check current.id.string == "tests/store-next"
    image = pass()
    shot(image, "n6-store")
    check not winOf("tests/store-next").isNil
    check not image.idle(nextDock()[4])
    check fromNextMenu(3, 1) == @["setCurrentScene"]
    check current.id.string == "tests/term-next"
    discard pass()
    check not winOf("tests/term-next").isNil
    check problems.len == 0

  test "windows side by side are both holes, the one behind too":
    discard focusOn("tests/next-a")
    discard pass()
    var halves = newJArray()
    for w in wins():
      let id = w{"id"}.getStr()
      if id in ["tests/next-a", "tests/next-b"]:
        var win = copy(w)
        win["max"] = %false
        win["min"] = %false
        win["snap"] = %(if id == "tests/next-a": "l" else: "r")
        halves.add win
    desk().state["wins"] = halves
    let image = pass()
    shot(image, "n7-halves")
    check image.color(NextMenuW + 100, H div 2) == colored("#ff0000")
    check image.color(NextMenuW + NextDeskW - 100, H div 2) == colored("#00ff00")
    check desk().slots.anyIt(it.hole and it.child == current)
    check desk().slots.anyIt(it.hole and it.child == hosted["tests/next-b"])
    check problems.len == 0

const
  Os2BarH = 28 ## the WarpCenter at 800 x 480, the desktop the 452 px under it
  Os2IconX = 8 + 42 ## the middle of the column of icons down the desktop's left
  Os2IconTop = Os2BarH + 8 ## the first icon's top, one every 70 px

proc warpCenter(): seq[array[4, float32]] =
  ## What takes a press on the WarpCenter, left to right: the Desktop menu, the
  ## Window List, the frame's own apps in its tray, the clock.
  byX(rectsOf(Os2).filterIt(it[3] <= Os2BarH.float32 and it[2] - it[0] < 400))

proc warpRows(): seq[array[4, float32]] =
  ## The rows of the menu open, top to bottom (rules and headings take no press).
  byY(rectsOf(Os2).filterIt(abs(it[3] - it[1] - 22) < 0.6 and it[2] - it[0] > 150))

proc warpTitle(win: JsonNode): seq[array[4, float32]] =
  ## What takes a press on a window's title bar, left to right: the system
  ## menu's icon, the gear (on a scene's), hide, maximize, close.
  let maxed = win{"max"}.getBool()
  let x = (if maxed: 0 else: win{"x"}.getInt()).float32
  let y = (Os2BarH + (if maxed: 0 else: win{"y"}.getInt())).float32
  let w = (if maxed: W else: win{"w"}.getInt()).float32
  byX(rectsOf(Os2).filterIt(it[0] >= x and it[2] <= x + w and it[1] >= y and it[3] <= y + 30 and
    it[2] - it[0] >= 18 and it[2] - it[0] <= 24 and it[3] - it[1] >= 18 and it[3] - it[1] <= 22))

proc launchButtons(): seq[array[4, float32]] =
  ## The LaunchPad's buttons, left to right: Windows, Scenes, the frame's own apps, Setup.
  byX(rectsOf(Os2).filterIt(abs(it[2] - it[0] - 56) < 0.6 and abs(it[3] - it[1] - 50) < 0.6))

proc drawerArrow(): array[4, float32] =
  ## The arrow over the LaunchPad's Scenes button.
  rectsOf(Os2).filterIt(abs(it[2] - it[0] - 56) < 0.6 and abs(it[3] - it[1] - 12) < 0.6)[0]

proc warpBare(): (int, int) =
  ## A point of bare desktop: no window, icon or LaunchPad over it.
  for (x, y) in [(W - 30, H - 30), (30, H - 30), (W - 30, Os2BarH + 200), (W div 2, H - 4)]:
    var free = x >= 100 or y > Os2BarH + 8 + 3 * 70
    if x >= 300 and x <= 500 and y >= Os2BarH + 372: free = false
    for w in wins():
      if w{"min"}.getBool(): continue
      let (wx, wy, ww, wh) = (if w{"max"}.getBool(): (0, 0, W, H - Os2BarH) else:
        (w{"x"}.getInt(), w{"y"}.getInt(), w{"w"}.getInt(), w{"h"}.getInt()))
      if x >= wx and x < wx + ww and y >= Os2BarH + wy and y < Os2BarH + wy + wh: free = false
    if free: return (x, y)
  doAssert false, "no bare desktop"

suite "the OS/2 Warp desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/os2-red", "name": "Red"}, {"id": "tests/os2-green", "name": "Green"},
        {"id": "tests/os2-blue", "name": "Blue"}]

  test "the first scene fills the desktop under the WarpCenter":
    current = hostScene("tests/os2-red")
    let image = pass()
    shot(image, "w1-first")
    check problems.len == 0
    check desk().id.string == Os2
    check wins().len == 1
    check winOf("tests/os2-red"){"max"}.getBool()
    check isHole(current)
    check image.color(W div 2, H div 2) == colored("#ff0000")
    check image.color(W div 2, 14) == colored("#cccccc") # the WarpCenter
    check image.color(W div 2, Os2BarH - 1) == colored("#404040") # and its line
    check image.color(W div 2 + 150, Os2BarH + 14) == colored("#20406f") # the title bar of the window in front
    check warpCenter().len == 3 # the Desktop menu, the Window List, the clock
    check launchButtons().len == 3 # Windows, Scenes, Setup: under the window

  test "the Desktop menu opens a scene in a window of its own":
    discard clickRect(warpCenter()[0])
    check desk().state{"menu"}.getStr() == "scenes"
    shot(pass(), "w2-desktop-menu")
    let rows = warpRows()
    check rows.len == 6 # Red, Green, Blue, Scenes - Icon View, Full screen, System Setup
    check acted(clickRect(rows[1])) == @["setCurrentScene"]
    check current.id.string == "tests/os2-green"
    check desk().state{"menu"}.kind == JNull
    let image = pass()
    check problems.len == 0
    check wins().len == 2
    check isHole(current)
    let g = winOf("tests/os2-green")
    check not g{"max"}.getBool()
    let (gx, gy, gw, gh) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt())
    check image.color(gx + gw div 2, Os2BarH + gy + gh div 2) == colored("#00ff00")

  test "a window dragged by its title bar follows the pointer":
    let g = winOf("tests/os2-green")
    let (x0, y0, w) = (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt())
    let (grabX, grabY) = (x0 + w div 2, Os2BarH + y0 + 16)
    discard send("pointerDown", at(grabX, grabY))
    discard send("pointerMove", at(grabX + 20, grabY + 10))
    discard send("pointerMove", at(grabX + 40, grabY + 30))
    discard send("pointerUp", at(grabX + 40, grabY + 30, %*{"buttons": 0}))
    check winOf("tests/os2-green"){"x"}.getInt() == x0 + 40
    check winOf("tests/os2-green"){"y"}.getInt() == y0 + 30
    check pass().color(x0 + 40 + 30, Os2BarH + y0 + 30 + 80) == colored("#00ff00")

  test "a press on a window behind brings it forward, and a tap reaches no scene":
    let x = (if winOf("tests/os2-green"){"x"}.getInt() > 30: 15 else: W - 15)
    check "setCurrentScene" in click(x, 300)
    check current.id.string == "tests/os2-red"
    check pass().color(x, 300) == colored("#ff0000")

  test "the system menu hides a window, and the Window List shows it grey and brings it back":
    let parts = warpTitle(winOf("tests/os2-red"))
    check parts.len == 5 # the system menu's icon, the gear, hide, maximize, close
    discard clickRect(parts[0])
    check desk().state{"menu"}.getStr() == "sys"
    check desk().state{"sysOf"}.getStr() == "tests/os2-red"
    shot(pass(), "w3-system-menu")
    var rows = warpRows()
    check rows.len == 6 # Restore, Hide, Maximize, Settings, Window list, Close
    check acted(clickRect(rows[1])) == @["setCurrentScene"] # Hide
    check winOf("tests/os2-red"){"min"}.getBool()
    check current.id.string == "tests/os2-green"
    let (bx, by) = warpBare()
    check pass().color(bx, by) == colored("#3b7090") # the desktop where red was
    discard clickRect(warpCenter()[1])
    check desk().state{"menu"}.getStr() == "windows"
    shot(pass(), "w4-window-list")
    rows = warpRows()
    check rows.len == 5 # Red (hidden), Green, Tile, Cascade, Show all
    check acted(clickRect(rows[0])) == @["setCurrentScene"]
    check current.id.string == "tests/os2-red"
    check not winOf("tests/os2-red"){"min"}.getBool()
    check desk().state{"menu"}.kind == JNull
    discard pass()
    check problems.len == 0

  test "the gear on a scene's title bar opens its settings":
    let parts = warpTitle(winOf("tests/os2-red"))
    settingsFrom = ""
    check acted(clickRect(parts[1])) == @["sceneSettings"]
    check settingsFrom == "tests/os2-red"
    check desk().state{"asked"}.getStr() == "system/sceneSettings#tests/os2-red"
    discard pass()

  test "the maximize button and a double click on the title bar size a window back and fill the desktop again":
    discard clickRect(warpTitle(winOf("tests/os2-red"))[3])
    check not winOf("tests/os2-red"){"max"}.getBool()
    discard pass()
    let r = winOf("tests/os2-red")
    discard send("doubleTap", at(r{"x"}.getInt() + 60, Os2BarH + r{"y"}.getInt() + 16))
    check winOf("tests/os2-red"){"max"}.getBool()
    discard pass()
    discard send("doubleTap", at(60, Os2BarH + 16))
    check not winOf("tests/os2-red"){"max"}.getBool()
    discard pass()
    check problems.len == 0

  test "a right click or a long press on bare desktop opens its pop-up menu":
    let (bx, by) = warpBare()
    discard send("pointerDown", at(bx, by, %*{"button": 1, "buttons": 2}))
    discard send("pointerUp", at(bx, by, %*{"button": 1, "buttons": 0}))
    check desk().state{"menu"}.getStr() == "popup"
    shot(pass(), "w5-popup")
    let rows = warpRows()
    check rows.len == 6 # Scenes - Icon View, Window list, Tile, Cascade, Show all, System Setup
    check acted(clickRect(rows[5])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check desk().state{"menu"}.kind == JNull
    discard pass()
    discard send("longPress", at(bx, by))
    check desk().state{"menu"}.getStr() == "popup"
    discard key("Escape")
    check desk().state{"menu"}.kind == JNull
    # A left press there opens nothing.
    discard click(bx, by)
    check desk().state{"menu"}.kind == JNull
    discard pass()
    check problems.len == 0

  test "the icons down the left are the frame's own apps, and a double click opens one":
    # The scenes' folder and System Setup (no store, no Files, no terminal here).
    check byY(rectsOf(Os2).filterIt(it[0] == 8 and it[2] == 92)).len == 2
    discard send("tap", at(Os2IconX, Os2IconTop + 70 + 16))
    check desk().state{"picked"}.getStr() == "system/sceneSettings"
    shot(pass(), "w6-icons")
    check acted(send("doubleTap", at(Os2IconX, Os2IconTop + 70 + 16))) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    check acted(send("doubleTap", at(Os2IconX, Os2IconTop + 16))) == @["sceneSwitcher"]
    check desk().state{"asked"}.getStr() == "system/sceneSwitcher"
    discard pass()
    check problems.len == 0

  test "the LaunchPad opens the Window List, the scene list and System Setup, and its drawer the frame's scenes":
    check launchButtons().len == 3
    discard clickRect(launchButtons()[0])
    check desk().state{"menu"}.getStr() == "windows"
    discard key("Escape")
    discard pass()
    check acted(clickRect(launchButtons()[1])) == @["sceneSwitcher"]
    discard pass()
    check acted(clickRect(launchButtons()[2])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    discard pass()
    discard clickRect(drawerArrow())
    check desk().state{"menu"}.getStr() == "drawer"
    shot(pass(), "w7-drawer")
    let rows = warpRows()
    check rows.len == 3 # Red, Green, Blue
    check rows[^1][3] <= drawerArrow()[1] + 1 # over the LaunchPad
    check acted(clickRect(rows[2])) == @["setCurrentScene"]
    check current.id.string == "tests/os2-blue"
    discard pass()
    check problems.len == 0

  test "the Window List tiles the windows side by side, each scene a hole, and cascades them":
    discard clickRect(warpCenter()[1])
    discard pass()
    var rows = warpRows()
    check rows.len == 6 # Red, Green, Blue, Tile, Cascade, Show all
    discard clickRect(rows[3])
    check desk().state{"menu"}.kind == JNull
    let image = pass()
    shot(image, "w8-tiled")
    # Blue, in front, the top left quarter; the others beside it and under it.
    let b = winOf("tests/os2-blue")
    check (b{"x"}.getInt(), b{"y"}.getInt(), b{"w"}.getInt(), b{"h"}.getInt()) == (0, 0, 400, 226)
    for id in ["tests/os2-red", "tests/os2-green", "tests/os2-blue"]:
      check isHole(hosted[id])
      let w = winOf(id)
      check image.color(w{"x"}.getInt() + w{"w"}.getInt() div 2, Os2BarH + w{"y"}.getInt() + w{"h"}.getInt() div 2) ==
        colored(if id == "tests/os2-red": "#ff0000" elif id == "tests/os2-green": "#00ff00" else: "#0000ff")
    discard clickRect(warpCenter()[1])
    discard pass()
    rows = warpRows()
    discard clickRect(rows[4])
    # Down and right from the top left, blue, in front, last.
    check (winOf("tests/os2-blue"){"x"}.getInt(), winOf("tests/os2-blue"){"y"}.getInt()) == (76, 64)
    discard pass()
    check problems.len == 0

  test "OS/2's keys: Ctrl+Esc, Alt+F10, Alt+F5, F11 and Escape, Alt+F9 and Alt+F4":
    discard send("keyDown", %*{"key": "Escape", "code": "Escape", "repeat": false, "shift": false, "ctrl": true,
      "alt": false, "meta": false})
    check desk().state{"menu"}.getStr() == "windows"
    discard key("Escape")
    check desk().state{"menu"}.kind == JNull
    discard key("F10", alt = true)
    check winOf("tests/os2-blue"){"max"}.getBool()
    discard key("F5", alt = true)
    check not winOf("tests/os2-blue"){"max"}.getBool()
    discard key("F11")
    check desk().state{"full"}.getBool()
    let full = pass()
    shot(full, "w9-full")
    check full.color(W div 2, 4) == colored("#0000ff")
    check full.color(W div 2, H - 4) == colored("#0000ff")
    discard key("Escape")
    check not desk().state{"full"}.getBool()
    discard pass()
    discard key("F9", alt = true)
    check winOf("tests/os2-blue"){"min"}.getBool()
    check current.id.string != "tests/os2-blue"
    discard pass()
    let next = current.id.string
    discard key("F4", alt = true)
    check winOf(next).isNil
    check current.id.string != next
    check wins().len == 2
    discard pass()
    check problems.len == 0

  test "a window opens at its scene's own size where that fits, and where it was when it opens again":
    windowSceneListing = withOwnSize("400x240", "tests/os2-blue")
    desk().state["wins"] = %*[]
    desk().state["boxes"] = %*{}
    discard focusOn("tests/os2-red")
    discard pass()
    discard focusOn("tests/os2-blue")
    discard pass()
    let o = winOf("tests/os2-blue")
    check not o{"max"}.getBool()
    check o{"w"}.getInt() == 400 + 8
    check o{"h"}.getInt() == 240 + 34
    check sceneSize("tests/os2-blue") == (400, 240)
    let (x, y) = (o{"x"}.getInt(), o{"y"}.getInt())
    dragBy(x + 150, Os2BarH + y + 16, 30, 20)
    discard key("F4", alt = true)
    check winOf("tests/os2-blue").isNil
    discard pass()
    discard focusOn("tests/os2-blue")
    discard pass()
    check winOf("tests/os2-blue"){"x"}.getInt() == x + 30
    check winOf("tests/os2-blue"){"y"}.getInt() == y + 20
    check problems.len == 0

  test "the scene store, Files and the terminal are in the Desktop menu, the WarpCenter's tray, the icons and the LaunchPad":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/os2-red", "name": "Red"}, {"id": "tests/os2-green", "name": "Green"},
        {"id": "tests/os2-blue", "name": "Blue"}, {"id": "tests/store-os2", "name": "Scene store"},
        {"id": "tests/files-os2", "name": "Files"}, {"id": "tests/term-os2", "name": "Terminal"}]
    # Windows of 400 x 240, which leave the icons and the LaunchPad clear.
    windowSceneListing = withOwnSize("400x240")
    desk().state["wins"] = %*[]
    desk().state["boxes"] = %*{}
    discard pass()
    check warpCenter().len == 6 # the Desktop menu, the Window List, the store, Files, the terminal, the clock
    check launchButtons().len == 6 # Windows, Scenes, the store, Files, the terminal, Setup
    discard clickRect(warpCenter()[0])
    shot(pass(), "w10-apps-menu")
    check warpRows().len == 3 + 3 + 3 # the three apps, the three scenes, the folder, Full screen, System Setup
    discard key("Escape")
    discard pass()
    check acted(clickRect(warpCenter()[2])) == @["setCurrentScene"]
    check current.id.string == "tests/store-os2"
    discard pass()
    check acted(clickRect(launchButtons()[4])) == @["setCurrentScene"]
    check current.id.string == "tests/term-os2"
    discard pass()
    # The icons: the scenes' folder, the store, Files, the terminal, System Setup.
    check byY(rectsOf(Os2).filterIt(it[0] == 8 and it[2] == 92)).len == 5
    check acted(send("doubleTap", at(Os2IconX, Os2IconTop + 2 * 70 + 16))) == @["setCurrentScene"]
    check current.id.string == "tests/files-os2"
    shot(pass(), "w11-files")
    check problems.len == 0

  test "two windows let go at the two sides take a half each, and both scenes are drawn as holes":
    windowSceneListing = withOwnSize("400x240")
    desk().state["wins"] = %*[]
    desk().state["boxes"] = %*{}
    discard focusOn("tests/os2-red")
    discard pass()
    discard focusOn("tests/os2-green")
    discard pass()
    check wins().len == 2
    # Green, in front, to the right; then red, whose title bar it leaves free, to the left.
    let g = winOf("tests/os2-green")
    dragBy(g{"x"}.getInt() + 60, Os2BarH + g{"y"}.getInt() + 16, W - 1 - (g{"x"}.getInt() + 60), 0)
    check winOf("tests/os2-green"){"snap"}.getStr() == "r"
    discard pass()
    let r = winOf("tests/os2-red")
    dragBy(r{"x"}.getInt() + 60, Os2BarH + r{"y"}.getInt() + 16, -(r{"x"}.getInt() + 60), 0)
    check winOf("tests/os2-red"){"snap"}.getStr() == "l"
    let image = pass()
    shot(image, "w12-halves")
    check current.id.string == "tests/os2-red"
    check isHole(current)
    check isHole(hosted["tests/os2-green"])
    check image.color(W div 4, H div 2) == colored("#ff0000")
    check image.color(3 * W div 4, H div 2) == colored("#00ff00")
    check problems.len == 0

  test "with Windows off, the WarpCenter and one window around the scene, its settings from the gear":
    desk().state["windows"] = %false
    let image = pass()
    shot(image, "w13-one-scene")
    check desk().state{"openScenes"} == %*[]
    check image.color(W div 2, H div 2 + 20) == colored("#ff0000")
    check image.color(W div 2 + 150, Os2BarH + 14) == colored("#20406f") # its title bar
    let center = warpCenter()
    check center.len == 4 # the scene list, the scene's button, the gear, the clock
    check acted(clickRect(center[0])) == @["sceneSwitcher"]
    check acted(clickRect(center[2])) == @["sceneSettings"]
    check acted(clickRect(center[3])) == @["sceneSettings"]
    check payloads["sceneSettings"] == %*{"page": "frame"}
    desk().state["windows"] = %true
    discard pass()
    check problems.len == 0

const
  OmBarH = 26 ## the Omarchy bar at 800 x 480, the desktop the 454 px under it
  OmAccent = "#7aa2f7" ## Tokyo Night's, the tile with the focus
  OmMuted = "#565f89" ## and the others'

proc omKey(name: string, shift = false, ctrl = false, alt = false, code = ""): seq[string] =
  ## A key with Super held.
  send("keyDown", %*{"key": name, "code": (if code.len > 0: code else: name), "repeat": false, "shift": shift,
    "ctrl": ctrl, "alt": alt, "meta": true})

proc omRows(): seq[array[4, float32]] =
  ## The rows of the menu, top to bottom (headings take no press).
  byY(rectsOf(Omarchy).filterIt(abs(it[3] - it[1] - 28) < 0.6 and it[2] - it[0] > 150))

proc omField(): array[4, float32] =
  ## The menu's field.
  rectsOf(Omarchy).filterIt(abs(it[3] - it[1] - 36) < 0.6 and it[2] - it[0] > 150)[0]

proc omMenu(): seq[string] =
  ## The bar's menu ring, pressed.
  click(18, 13)

proc omTile(id: string): (int, int) =
  ## The middle of a window's tile, on the panel.
  let slot = desk().slots.filterIt(it.child == hosted[id])
  if slot.len == 0: return (-1, -1)
  let v = slot[0].visible
  (int((v[0] + v[2]) / 2), int((v[1] + v[3]) / 2))

proc omDrawn(): seq[string] =
  ## The scenes drawn on the desktop now, by id.
  for slot in desk().slots:
    if slot.child.id.string.startsWith("tests/"): result.add slot.child.id.string
  result.sort()

suite "the Omarchy desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/om-red", "name": "Red"}, {"id": "tests/om-green", "name": "Green"},
        {"id": "tests/om-blue", "name": "Blue"}]

  test "the first scene is one tile under the bar, its border the accent":
    current = hostScene("tests/om-red")
    let image = pass()
    shot(image, "o1-first")
    check problems.len == 0
    check desk().id.string == Omarchy
    check wins().len == 1
    check isHole(current)
    check image.color(W div 2, H div 2) == colored("#ff0000")
    check image.color(11, 200) == colored(OmAccent) # its border, 10 px in from the edge
    check image.color(650, 13) == colored("#16161e") # the bar
    check desk().state{"ws"}.isNil or desk().state{"ws"}.getInt() == 1

  test "the menu opens a scene as a tile beside the other, and a third under it":
    discard omMenu()
    check desk().state{"menu"}.getStr() == "palette"
    shot(pass(), "o2-menu")
    var rows = omRows()
    check rows.len == 10 # Red, Green, Blue, Setup, Scenes, Window, Layout, Theme, Transparent bar, Keybindings
    check acted(clickRect(rows[1])) == @["setCurrentScene"]
    check current.id.string == "tests/om-green"
    check desk().state{"menu"}.kind == JNull
    var image = pass()
    check isHole(current) and isHole(hosted["tests/om-red"])
    check image.color(202, 253) == colored("#ff0000")
    check image.color(597, 253) == colored("#00ff00")
    check image.color(406, 253) == colored(OmAccent) # green's border
    check image.color(394, 253) == colored(OmMuted) # red's
    discard omMenu()
    discard pass()
    check acted(clickRect(omRows()[2])) == @["setCurrentScene"]
    image = pass()
    shot(image, "o3-three")
    check image.color(202, 253) == colored("#ff0000")
    check image.color(597, 152) == colored("#00ff00")
    check image.color(597, 374) == colored("#0000ff")
    check problems.len == 0

  test "a press in a tile gives it the focus, and the arrows with Super move it and swap the tiles":
    check "setCurrentScene" in click(202, 253)
    check current.id.string == "tests/om-red"
    discard pass()
    check acted(omKey("ArrowRight")) == @["setCurrentScene"]
    check current.id.string == "tests/om-green"
    discard pass()
    check acted(omKey("ArrowDown")) == @["setCurrentScene"]
    check current.id.string == "tests/om-blue"
    discard pass()
    discard omKey("ArrowLeft", shift = true) # blue and red trade places
    let image = pass()
    check current.id.string == "tests/om-blue"
    check image.color(202, 253) == colored("#0000ff")
    check image.color(597, 374) == colored("#ff0000")
    check problems.len == 0

  test "workspaces: Super+2 shows an empty one, Super+Shift+2 takes the window there, the bar's numbers go back":
    discard omKey("2", code = "Digit2")
    check desk().state{"ws"}.getInt() == 2
    var image = pass()
    shot(image, "o4-empty")
    check omDrawn().len == 0
    discard omKey("1", code = "Digit1")
    check desk().state{"ws"}.getInt() == 1
    discard pass()
    check omDrawn() == @["tests/om-blue", "tests/om-green", "tests/om-red"]
    discard omKey("@", shift = true, code = "Digit2") # blue, with the focus, to workspace 2
    check winOf("tests/om-blue"){"ws"}.getInt() == 2
    check desk().state{"ws"}.getInt() == 2
    image = pass()
    check omDrawn() == @["tests/om-blue"]
    check image.color(W div 2, H div 2) == colored("#0000ff")
    # The bar's 1 shows workspace 1 again, its window that had the focus last forward.
    check acted(click(48, 13)) == @["setCurrentScene"]
    image = pass()
    check omDrawn() == @["tests/om-green", "tests/om-red"]
    check problems.len == 0

  test "Super+L goes from dwindle to scrolling, a strip that scrolls to the window with the focus, and to floating":
    discard focusOn("tests/om-blue")
    discard pass()
    discard omKey("!", shift = true, code = "Digit1") # blue back to workspace 1, last in its order
    discard pass()
    check omDrawn().len == 3
    discard omKey("l")
    check desk().state{"layouts"}{"1"}.getStr() == "scrolling"
    var image = pass()
    shot(image, "o5-scrolling")
    # Columns in the windows' order (blue first since it swapped with red): blue
    # has the focus, in the first; red, the third, is off the strip.
    check omDrawn() == @["tests/om-blue", "tests/om-green"]
    check image.color(202, 253) == colored("#0000ff")
    check acted(omKey("ArrowRight")) == @["setCurrentScene"]
    discard pass()
    # Red is off the strip: Alt+Tab-like, the menu brings it; the strip follows.
    discard omMenu()
    discard pass()
    check acted(clickRect(omRows()[0])) == @["setCurrentScene"]
    check current.id.string == "tests/om-red"
    image = pass()
    shot(image, "o5b-scrolled")
    check omDrawn() == @["tests/om-green", "tests/om-red"]
    check image.color(202, 253) == colored("#00ff00")
    check image.color(597, 253) == colored("#ff0000")
    discard omKey("l")
    check desk().state{"layouts"}{"1"}.getStr() == "floating"
    image = pass()
    shot(image, "o6-floating")
    check problems.len == 0

  test "a floating window has a title bar, goes into the dock with Super+M and comes back from it":
    let r = winOf("tests/om-red")
    check not r.isNil
    # The dock: the windows open (no frame's own apps here) and the whole menu.
    let dock = byX(rectsOf(Omarchy).filterIt(abs(it[2] - it[0] - 42) < 0.6 and it[1] > float32(H - 70)))
    check dock.len == 4
    discard omKey("m")
    check winOf("tests/om-red"){"min"}.getBool()
    check current.id.string != "tests/om-red"
    discard pass()
    check "tests/om-red" notin omDrawn()
    # The dock lists the windows in their order: blue, green, red, then the menu.
    check acted(clickRect(dock[2])) == @["setCurrentScene"]
    check current.id.string == "tests/om-red"
    check not winOf("tests/om-red"){"min"}.getBool()
    discard pass()
    # Back to dwindle for what follows.
    discard omKey("l")
    discard pass()
    check desk().state{"layouts"}{"1"}.getStr() == "dwindle"
    check problems.len == 0

  test "the menu's field filters it, and the theme page changes the colours":
    discard omMenu()
    discard pass()
    discard clickRect(omField())
    discard send("textInput", %*{"text": "gre"})
    discard pass()
    check omRows().len == 1
    check acted(send("keyDown", %*{"key": "Enter", "code": "Enter", "repeat": false, "shift": false, "ctrl": false,
      "alt": false, "meta": false})) == @["setCurrentScene"]
    check current.id.string == "tests/om-green"
    discard pass()
    discard omMenu()
    discard pass()
    discard clickRect(omRows()[7]) # Theme
    check desk().state{"page"}.getStr() == "theme"
    discard pass()
    let themes = omRows()
    check themes.len == 12 # Back and eleven themes
    discard clickRect(themes[9]) # Nord
    check desk().state{"scheme"}.getStr() == "nord"
    discard key("Escape")
    var image = pass()
    shot(image, "o7-nord")
    let (gx, gy) = omTile("tests/om-green")
    check gx > 0
    discard omKey(" ", shift = true, ctrl = true, code = "Space") # the next theme
    check desk().state{"scheme"}.getStr() == "ristretto"
    desk().state["scheme"] = %"tokyo-night"
    discard pass()
    check problems.len == 0

  test "Super+W closes, Super+F gives the panel to the window and Escape takes it back":
    let front = current.id.string
    discard omKey("f")
    check desk().state{"full"}.getBool()
    var image = pass()
    check image.color(W div 2, 4) == image.color(W div 2, H div 2)
    discard key("Escape")
    check not desk().state{"full"}.getBool()
    discard pass()
    check acted(omKey("w")) == @["setCurrentScene"]
    check winOf(front).isNil
    discard pass()
    check problems.len == 0

  test "a double click on the bar's empty stretch makes it transparent, a swipe across it goes to the next workspace":
    discard send("doubleTap", at(650, 13))
    check desk().state{"clear"}.getBool()
    let image = pass()
    check image.color(650, 13) != colored("#16161e")
    discard send("doubleTap", at(650, 13))
    check not desk().state{"clear"}.getBool()
    discard send("swipe", %*{"x": 400, "y": 13, "startX": 500, "startY": 13, "direction": "left", "pointerId": 0,
      "pointerType": "touch"})
    check desk().state{"ws"}.getInt() == 2
    discard omKey("1", code = "Digit1")
    discard pass()
    check problems.len == 0

  test "the scene store, Files and the terminal: in the menu, and Super+Return and Super+Shift+F":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/om-red", "name": "Red"}, {"id": "tests/om-green", "name": "Green"},
        {"id": "tests/om-blue", "name": "Blue"}, {"id": "tests/store-om", "name": "Scene store"},
        {"id": "tests/files-om", "name": "Files"}, {"id": "tests/term-om", "name": "Terminal"}]
    discard pass()
    discard omMenu()
    discard pass()
    # The frame's own apps first, then the scenes and the commands.
    check acted(clickRect(omRows()[0])) == @["setCurrentScene"]
    check current.id.string == "tests/store-om"
    discard pass()
    check acted(omKey("Enter")) == @["setCurrentScene"]
    check current.id.string == "tests/term-om"
    discard pass()
    check acted(omKey("F", shift = true, code = "KeyF")) == @["setCurrentScene"]
    check current.id.string == "tests/files-om"
    discard pass()
    check problems.len == 0

  test "with Windows off, the bar and one tile around the scene":
    desk().state["windows"] = %false
    let image = pass()
    shot(image, "o8-one-scene")
    check desk().state{"openScenes"} == %*[]
    check image.color(W div 2, H div 2) == image.color(W div 2, H div 2 + 40)
    check image.color(11, 200) == colored(OmAccent)
    check acted(click(18, 13)) == @["sceneSwitcher"]
    desk().state["windows"] = %true
    discard pass()
    check problems.len == 0

const
  KeyY = H - 10 ## the Commander's function keys at 800 x 480, ten of them 80 px wide
  LeftPanel = (200, 200) ## a point inside each of its panels' scenes
  RightPanel = (600, 200)

proc fKey(n: int): seq[string] =
  ## Function key `n`, tapped on the Commander's bar.
  acted(click(80 * (n - 1) + 50, KeyY))

proc panelsNow(): seq[string] =
  for id in desk().state{"panels"}: result.add id.getStr()

suite "the Commander desktop":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/nc-red", "name": "Red"}, {"id": "tests/nc-green", "name": "Green"},
        {"id": "tests/nc-blue", "name": "Blue"}]

  test "the scene fills the left panel, and the next of the frame's scenes runs in the right":
    current = hostScene("tests/nc-red")
    let image = pass()
    shot(image, "c1-first")
    check problems.len == 0
    check panelsNow() == @["tests/nc-red", "tests/nc-green"]
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#ff0000")
    check image.color(RightPanel[0], RightPanel[1]) == colored("#00ff00")
    var hole = false
    var embedded: seq[FrameScene]
    var holes = 0
    for slot in current.wornLayout.slots:
      hole = hole or slot.hole and slot.child == current
      embedded.add slot.child
      if slot.hole: inc holes
    check hole
    check holes == 2 # the other panel's scene too
    check hosted["tests/nc-green"] in embedded
    # What a desktop chosen in its place opens: green, then red with the focus.
    check desk().state{"openScenes"} == %*["tests/nc-green", "tests/nc-red"]

  test "a press on the other panel gives it the focus, and Tab gives it back":
    check acted(click(RightPanel[0], RightPanel[1])) == @["setCurrentScene"]
    check current.id.string == "tests/nc-green"
    discard pass()
    check desk().state{"side"}.getInt() == 1
    check panelsNow() == @["tests/nc-red", "tests/nc-green"]
    check acted(key("Tab")) == @["setCurrentScene"]
    check current.id.string == "tests/nc-red"
    discard pass()
    check desk().state{"side"}.getInt() == 0

  test "F5 swaps the panels, the focus going with its scene":
    check acted(key("F5")).len == 0
    let image = pass()
    check panelsNow() == @["tests/nc-green", "tests/nc-red"]
    check desk().state{"side"}.getInt() == 1
    check current.id.string == "tests/nc-red"
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#00ff00")
    check image.color(RightPanel[0], RightPanel[1]) == colored("#ff0000")
    discard fKey(5)
    discard pass()
    check panelsNow() == @["tests/nc-red", "tests/nc-green"]

  test "F10 turns the other panel into the Info panel, and back to its scene":
    check fKey(10).len == 0
    var image = pass()
    shot(image, "c2-info")
    check panelsNow() == @["tests/nc-red", ""]
    check image.color(RightPanel[0], RightPanel[1]) == colored("#0000aa")
    check desk().state{"openScenes"} == %*["tests/nc-red"]
    discard key("F10")
    image = pass()
    check panelsNow() == @["tests/nc-red", "tests/nc-green"]
    check image.color(RightPanel[0], RightPanel[1]) == colored("#00ff00")

  test "F6 puts the next scene in the panel with the focus, past the one in the other":
    check fKey(6) == @["setCurrentScene"]
    check current.id.string == "tests/nc-blue"
    let image = pass()
    check panelsNow() == @["tests/nc-blue", "tests/nc-green"]
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#0000ff")
    # From blue, past green, round to red.
    discard fKey(6)
    discard pass()
    check panelsNow() == @["tests/nc-red", "tests/nc-green"]

  test "a scene brought forward from outside goes into the panel with the focus":
    discard focusOn("tests/nc-blue")
    discard pass()
    check panelsNow() == @["tests/nc-blue", "tests/nc-green"]
    discard focusOn("tests/nc-green")
    discard pass()
    check panelsNow() == @["tests/nc-blue", "tests/nc-green"]
    check desk().state{"side"}.getInt() == 1

  test "the keys open the frame's page, the scene list and the scene's settings":
    settingsFrom = ""
    check fKey(1) == @["sceneSettings"]
    check payloads["sceneSettings"]{"page"}.getStr() == "frame"
    check fKey(2) == @["sceneSwitcher"]
    check fKey(4) == @["sceneSettings"]
    check settingsFrom == "tests/nc-green"
    # No store, terminal or Files on this frame: their keys are blank.
    check fKey(7).len == 0
    check fKey(8).len == 0
    discard pass()

  test "F3 gives the panel with the focus the screen, the keys kept, and Escape takes it back":
    discard key("F3")
    var image = pass()
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#00ff00")
    check image.color(RightPanel[0], RightPanel[1]) == colored("#00ff00")
    discard key("Escape")
    image = pass()
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#0000ff")
    check problems.len == 0

  test "a press on the other panel's scene reaches no scene, and one on its own panel does":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/nc-red", "name": "Red"}, {"id": "tests/nc-button", "name": "Button"}]
    discard focusOn("tests/nc-red")
    discard pass()
    desk().state["panels"] = %*["tests/nc-red", "tests/nc-button"]
    discard pass()
    let button = hostScene("tests/nc-button")
    check acted(click(RightPanel[0], RightPanel[1])) == @["setCurrentScene"]
    check current.id.string == "tests/nc-button"
    discard pass()
    check button.state{"clicks"}.getInt() == 0
    discard click(RightPanel[0], RightPanel[1])
    discard pass()
    check button.state{"clicks"}.getInt() == 1
    check problems.len == 0

suite "the Teletext page":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/tt-red", "name": "Red"}, {"id": "tests/tt-green", "name": "Green"},
        {"id": "tests/tt-blue", "name": "Blue"}]

  test "the scene under the band, and the Fastext links: red before, green after, yellow the index, cyan its settings":
    current = hostScene("tests/tt-green")
    let image = pass()
    shot(image, "t1-page")
    check problems.len == 0
    check current.wornLayout.slots.anyIt(it.hole and it.child == current)
    check image.color(W div 2, H div 2) == colored("#00ff00")
    check image.color(W - 20, 40) == colored("#0000ff") # the band
    check acted(click(30, H - 12)) == @["setCurrentScene"]
    check payloads["setCurrentScene"]{"direction"}.getStr() == "prev"
    check current.id.string == "tests/tt-red"
    check pass().color(W div 2, H div 2) == colored("#ff0000")
    check acted(click(230, H - 12)) == @["setCurrentScene"]
    check payloads["setCurrentScene"]{"direction"}.getStr() == "next"
    check current.id.string == "tests/tt-green"
    discard pass()
    check acted(click(430, H - 12)) == @["sceneSwitcher"]
    settingsFrom = ""
    check acted(click(630, H - 12)) == @["sceneSettings"]
    check settingsFrom == "tests/tt-green"
    # The clock in the header: the frame's page.
    check acted(click(W - 30, 9)) == @["sceneSettings"]
    check payloads["sceneSettings"]{"page"}.getStr() == "frame"
    check problems.len == 0

suite "the E-reader page":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/er-red", "name": "Red"}, {"id": "tests/er-green", "name": "Green"},
        {"id": "tests/er-blue", "name": "Blue"}]

  test "the scene on a white page, the footer's halves turning to the scene before and after":
    current = hostScene("tests/er-green")
    let image = pass()
    shot(image, "e1-page")
    check problems.len == 0
    check current.wornLayout.slots.anyIt(it.hole and it.child == current)
    check image.color(W div 2, H div 2) == colored("#00ff00")
    check image.color(W div 2, 4) == colored("#ffffff")
    check acted(click(W div 4, H - 28)) == @["setCurrentScene"]
    check payloads["setCurrentScene"]{"direction"}.getStr() == "prev"
    check current.id.string == "tests/er-red"
    discard pass()
    check acted(click(3 * W div 4, H - 28)) == @["setCurrentScene"]
    check payloads["setCurrentScene"]{"direction"}.getStr() == "next"
    check current.id.string == "tests/er-green"
    discard pass()
    # The name: the scene list; the clock: the frame's page.
    check acted(click(60, 19)) == @["sceneSwitcher"]
    check acted(click(W div 2, 19)) == @["sceneSettings"]
    check payloads["sceneSettings"]{"page"}.getStr() == "frame"
    check problems.len == 0
    chooseLayout("")
    discard pass()

suite "the Terminal layout":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/tl-red", "name": "Red"}]

  proc settingsButton(): array[4, float32] =
    ## Where a press does something along the top: the prompt, then settings.
    let top = byX(rectsOf(TerminalLayout).filterIt(it[3] < float32(H div 8)))
    doAssert top.len == 2, $top
    top[1]

  proc keyF2(panel: FrameScene, alt = false): seq[string] =
    ## F2 while the settings show: the key goes to them, then to the layout.
    let payload = %*{"key": "F2", "code": "F2", "repeat": false, "shift": false, "ctrl": false, "alt": alt,
      "meta": false}
    sceneSettings.exportedScene.runEvent(panel, ExecutionContext(scene: panel, event: "keyDown", payload: payload,
      loopIndex: 0, loopKey: ".", nextSleep: -1))
    acted(settle())

  test "settings at the top right opens the settings of the scene it wraps, and so does F2":
    current = hostScene("tests/tl-red")
    let image = pass()
    shot(image, "tl1-terminal")
    check problems.len == 0
    check current.wornLayout.slots.anyIt(it.hole and it.child == current)
    check image.color(W div 2, H div 2) == colored("#ff0000")
    let button = settingsButton()
    check button[2] > float32(W - 20) and button[2] - button[0] < 160
    # Not lit: the terminal's black in its padding.
    check image.color(int(button[2]) - 2, int((button[1] + button[3]) / 2)) == colored("#0b0f0c")
    settingsFrom = ""
    check acted(clickRect(button)) == @["sceneSettings"]
    check settingsFrom == "tests/tl-red"
    check payloads["sceneSettings"]{"page"}.isNil
    check acted(key("F2")) == @["sceneSettings"]
    check acted(key("F2", alt = true)).len == 0
    # The prompt is still the scene list, and the status line the frame's page.
    check acted(click(20, 14)) == @["sceneSwitcher"]
    check acted(click(20, H - 14)) == @["sceneSettings"]
    check payloads["sceneSettings"]{"page"}.getStr() == "frame"
    check problems.len == 0

  test "while the settings show, the button is lit, and it or F2 goes back to the scene":
    let panel = sceneSettings.exportedScene.init(SceneSettingsId.SceneId, config, logger(), %*{})
    sceneSettings.exportedScene.runEvent(panel, ExecutionContext(scene: panel, event: "setCurrentScene",
      payload: %*{"state": {"from": "tests/tl-red", "layout": {"sceneId": TerminalLayout}}},
      loopIndex: 0, loopKey: ".", nextSleep: -1))
    let image = sceneSettings.exportedScene.render(panel, ExecutionContext(scene: panel, event: "render",
      payload: %*{}, image: newImage(W, H), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
    shot(image, "tl2-settings")
    check not panel.wornLayout.isNil
    let button = settingsButton()
    check image.color(int(button[2]) - 2, int((button[1] + button[3]) / 2)) == colored("#52f27b")
    check panel.keyF2() == @["sceneSettings"]
    check panel.keyF2(alt = true).len == 0
    check problems.len == 0

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
    for (layoutId, name) in [(MacOS, "15-to-macos"), (Tiling, "16-to-tiling"), (BeOS, "17-to-beos"),
        (ClassicMac, "17a-to-classic-mac"), (NeXT, "17b-to-nextstep"), (Os2, "17c-to-os2-warp"), (Omarchy, "17d-to-omarchy"), (Layout, "18-back")]:
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

  test "puts each window where it was on the glass (`openPlaces`), whatever bars the new desktop has":
    chooseLayout(Layout)
    discard pass()
    check desk().id.string == Layout
    # Green moved to a place of its own on Windows 98 (no bar above its desktop).
    var moved = newJArray()
    for w in wins():
      var win = copy(w)
      if win{"id"}.getStr() == "tests/green":
        win["x"] = %200
        win["y"] = %100
        win["w"] = %300
        win["h"] = %200
        win["max"] = %false
        win["snap"] = newJNull()
      moved.add win
    desk().state["wins"] = moved
    discard pass()
    let place = desk().state{"openPlaces"}{"tests/green"}
    check place{"x"}.getFloat() == 0.25
    check place{"w"}.getFloat() == 0.375
    # macOS: the same place on the panel, its desktop under the menu bar.
    chooseLayout(MacOS)
    discard pass()
    var g = winOf("tests/green")
    check (g{"x"}.getInt(), MenuH + g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    # And back again, through BeOS (its Deskbar in the corner, the desktop from the top).
    chooseLayout(BeOS)
    discard pass()
    g = winOf("tests/green")
    check (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    # Classic Mac, under its menu bar; NeXTSTEP, its desk right of the main menu.
    chooseLayout(ClassicMac)
    discard pass()
    g = winOf("tests/green")
    check (g{"x"}.getInt(), CMenuH + g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    chooseLayout(NeXT)
    discard pass()
    g = winOf("tests/green")
    check (NextMenuW + g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    # OS/2 Warp, under its WarpCenter.
    chooseLayout(Os2)
    discard pass()
    g = winOf("tests/green")
    check (g{"x"}.getInt(), Os2BarH + g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    chooseLayout(Layout)
    discard pass()
    g = winOf("tests/green")
    check (g{"x"}.getInt(), g{"y"}.getInt(), g{"w"}.getInt(), g{"h"}.getInt()) == (200, 100, 300, 200)
    check problems.len == 0
    chooseLayout("")
    discard pass()

  test "the Commander opens the two the desktop before it had in front, and hands them on as halves":
    chooseLayout(MacOS)
    discard pass()
    for id in ["tests/red", "tests/green", "tests/blue"]:
      discard focusOn(id)
      discard pass()
    check desk().id.string == MacOS
    chooseLayout(Commander)
    let image = pass()
    shot(image, "19-to-commander")
    check desk().id.string == Commander
    check current.id.string == "tests/blue"
    check panelsNow() == @["tests/blue", "tests/green"]
    check image.color(LeftPanel[0], LeftPanel[1]) == colored("#0000ff")
    check image.color(RightPanel[0], RightPanel[1]) == colored("#00ff00")
    # Back on macOS: those two, side by side.
    chooseLayout(MacOS)
    discard pass()
    check openIds() == @["tests/blue", "tests/green"]
    check winOf("tests/blue"){"snap"}.getStr() == "l"
    check winOf("tests/green"){"snap"}.getStr() == "r"
    check problems.len == 0
    chooseLayout("")
    discard pass()

suite "a scene's own window size (settings.windowSize)":
  # Each listed with its size, as the hosts list it (app.frame.scenes).
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red", "windowSize": "300x200"},
        {"id": "tests/green", "name": "Green", "windowSize": "1200x1200"}, {"id": "tests/blue", "name": "Blue"}]

  test "opens at it on every desktop of windows, and one too big for the desktop smaller and its shape kept":
    for layoutId in [Layout, MacOS, BeOS, ClassicMac, NeXT, Os2]:
      # A desktop of its own, blue in front: nothing carried over, no window kept from before.
      discard focusOn("tests/blue")
      desk().state["openScenes"] = %*[]
      chooseLayout(layoutId)
      discard pass()
      desk().state["boxes"] = %*{}
      desk().state["wins"] = %*[]
      # What a frame kept of the desktop's old "Window size", "The whole
      # desktop" included: nothing reads it any more.
      desk().state["windowSize"] = %"max"
      discard pass()
      check desk().id.string == layoutId
      check current.id.string == "tests/blue"
      check winOf("tests/blue"){"max"}.getBool() # the first window fills the desktop, as always
      discard focusOn("tests/red")
      discard pass()
      check sceneSize("tests/red") == (300, 200)
      # Too big for the desktop, and not the first: a window of its shape.
      discard focusOn("tests/green")
      discard pass()
      check not winOf("tests/green"){"max"}.getBool()
      let (w, h) = sceneSize("tests/green")
      check abs(w - h) <= 1
      check h > 200 and h < H
      check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

  test "is the same function, word for word, in every desktop of windows, and no desktop has a size of its own":
    # A scene cannot share code with another: each carries its own copy.
    var copies: seq[string]
    for scene in [layout, macos, beos, classicMac, nextstep, os2, omarchy, tiling, commander]:
      for field in scene["fields"]: check field["name"].getStr() != "windowSize"
      var source = ""
      for _, app in scene["apps"]: source = app["sources"]["app.tsx"].getStr()
      check "state.windowSize" notin source
      let start = source.find("// The scene's own area in a new window")
      if scene["id"].getStr() in [Tiling, Commander]:
        check start < 0 # tiles and panels, no window sizes
        continue
      check start >= 0
      copies.add source[start ..< source.find("\n}\n", start)]
    check copies.len == 7
    for text in copies: check text == copies[0]

proc boxOf(win: JsonNode): (int, int, int, int) =
  (win{"x"}.getInt(), win{"y"}.getInt(), win{"w"}.getInt(), win{"h"}.getInt())

proc covered(a, b: (int, int, int, int)): int =
  ## How much of box b the box a covers.
  let across = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
  let deep = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
  if across > 0 and deep > 0: across * deep else: 0

suite "where a new window opens (each desktop's freeSpot)":
  # Six scenes whose windows are small enough that four fit side by side on every
  # desktop at 800 x 480, and the next two do not.
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      result = newJArray()
      for (id, name) in [("tests/red", "Red"), ("tests/green", "Green"), ("tests/blue", "Blue"),
          ("tests/apple", "Apple"), ("tests/lime", "Lime"), ("tests/ocean", "Ocean")]:
        result.add %*{"id": id, "name": name, "windowSize": "200x120"}

  test "on bare desktop while there is room, clear of the icons, and never right over another window":
    let none: seq[(int, int, int, int)] = @[]
    # Each desktop's own: where its windows may go (x, y, w, h in its own pixels,
    # as it keeps its windows), and its icons there.
    let desks = @[
      (Layout, (0, 0, W, H - 42), @[(8, 8, 80, 2 * 72)]),
      (MacOS, (0, 0, W, H - MenuH - DockH), none),
      (BeOS, (0, 0, W - BarW, H), none),
      (ClassicMac, (0, 0, W, H - CMenuH), @[(W - 4 - 84, 10, 84, 2 * 62)]),
      (NeXT, (0, 0, NextDeskW, H), none),
      (Os2, (0, 0, W, H - Os2BarH), @[(8, 8, 84, 2 * 70), (307, 372, 186, 72)])]
    let ids = ["tests/red", "tests/green", "tests/blue", "tests/apple", "tests/lime", "tests/ocean"]
    for (layoutId, area, icons) in desks:
      # A desktop of its own: nothing carried over, no window kept from before.
      discard focusOn(ids[0])
      desk().state["openScenes"] = %*[]
      chooseLayout(layoutId)
      discard pass()
      desk().state["boxes"] = %*{}
      desk().state["wins"] = %*[]
      discard pass()
      check desk().id.string == layoutId
      for i, id in ids:
        if i > 0:
          discard focusOn(id)
          discard pass()
        let win = winOf(id)
        check not win.isNil
        check not win{"max"}.getBool()
        check sceneSize(id) == (200, 120)
        let box = boxOf(win)
        # All of it on the desktop.
        check box[0] >= area[0] and box[1] >= area[1]
        check box[0] + box[2] <= area[0] + area[2] and box[1] + box[3] <= area[1] + area[3]
        var over = 0
        for other in wins():
          if other{"id"}.getStr() == id: continue
          let o = boxOf(other)
          over += covered(box, o)
          # Never right over another: a part of every title bar stays in reach.
          check not (box[0] <= o[0] and box[0] + box[2] >= o[0] + o[2] and box[1] <= o[1] and
            box[1] + box[3] >= o[1] + 22)
        if i < 4:
          # Room for it: none of it over another window or an icon.
          check over == 0
          for icon in icons: check covered(box, icon) == 0
        if i == 3:
          # Side by side, every scene is drawn straight into its window: none is
          # a picture of its own.
          for j in 0 .. 3: check isHole(hosted[ids[j]])
      shot(pass(), "placed-" & layoutId.replace("/", "-"))
      check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

  test "is the same function, word for word, in every desktop of windows":
    # A scene cannot share code with another: each carries its own copy.
    var copies: seq[string]
    for scene in [layout, macos, beos, classicMac, nextstep, os2, omarchy]:
      var source = ""
      for _, app in scene["apps"]: source = app["sources"]["app.tsx"].getStr()
      let start = source.find("// Where a new window w by h goes")
      check start >= 0
      copies.add source[start ..< source.find("\n}\n", start)]
    for text in copies: check text == copies[0]

proc copiesOf(start: string, scenes: openArray[JsonNode]): seq[string] =
  ## A function's text in each scene's app, from its comment to its end.
  for scene in scenes:
    var source = ""
    for _, app in scene["apps"]: source = app["sources"]["app.tsx"].getStr()
    let at = source.find(start)
    result.add (if at < 0: "" else: source[at ..< source.find("\n}\n", at)])

const GroupedStart = "// A list of scenes in groups by their category"

proc probe(source: string): JsonNode =
  ## The state a JS app with this source leaves after one render.
  let scene = FrameScene(id: "tests/probe".SceneId, frameConfig: config, state: %*{}, logger: logger())
  let owner = AppRoot(nodeId: 1.NodeId, nodeName: "probe", scene: scene, frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = source, sourceName = "app.tsx")
  discard runtime.get(owner, %*{}, ExecutionContext(scene: scene, event: "render", payload: %*{}, loopIndex: 0,
    loopKey: ".", nextSleep: -1))
  scene.state

proc groupedBy(scenes: string): JsonNode =
  ## What the layouts' `grouped` makes of `scenes` (a JS literal): [title, ids...] a group.
  let fn = copiesOf(GroupedStart, [layout])[0] & "\n}\n"
  probe(fn & "export function get(app) {\n  frameos.setState('out', grouped(" & scenes &
    ").map((g) => [g.title].concat(g.scenes.map((s) => s.id))))\n  return <div />\n}\n"){"out"}

suite "a long list of scenes, by category (each desktop's grouped)":
  test "is the same function, word for word, in every desktop with a list of scenes":
    let copies = copiesOf(GroupedStart, [layout, macos, beos, classicMac, nextstep, os2, omarchy, tiling])
    check copies[0].len > 0
    for text in copies: check text == copies[0]

  test "goes by each category's own name, the groups by name, Other last; without any, the list as it was":
    # The names are the scenes' own text (settings.category): a store title or
    # anything else, trimmed, sorted whatever the case; "Other" is none.
    let scenes = "[{id: 'a', category: 'Fun & comics'}, {id: 'b'}, {id: 'c', category: 'Photos'}, " &
      "{id: 'd', category: ' Fun & comics'}, {id: 'e', category: 'clocks'}, {id: 'f', category: 'Other'}]"
    check groupedBy(scenes) == %*[["clocks", "e"], ["Fun & comics", "a", "d"], ["Photos", "c"], ["Other", "b", "f"]]
    # No scene with a category (an older runtime lists none): one group, no
    # title, the frame's order.
    check groupedBy("[{id: 'x'}, {id: 'y', category: ''}]") == %*[[nil, "x", "y"]]

  # Forty scenes, longer than the screen in every list: the sixteen numbered ones
  # take turns at Weather, Fun & comics, none and Art & galleries, so the art
  # (Scene 3, 7, ...) comes first in a list by category; the rest have none.
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      result = newJArray()
      for i in 0 ..< 16:
        result.add %*{"id": "tests/be-" & $i, "name": "Scene " & $i,
          "category": ["Weather", "Fun & comics", "", "Art & galleries"][i mod 4]}
      for id in ["tests/red", "tests/green", "tests/blue", "tests/apple", "tests/lime", "tests/ocean", "tests/sky",
          "tests/grass", "tests/sun", "tests/be-red", "tests/be-green", "tests/be-blue", "tests/cm-red", "tests/cm-green",
          "tests/cm-blue", "tests/next-a", "tests/next-b", "tests/next-c", "tests/nc-red", "tests/nc-green",
          "tests/nc-blue", "tests/tt-red", "tests/tt-green", "tests/tt-blue"]:
        result.add %*{"id": id, "name": id}

  test "every desktop's list scrolls under a finger, and goes by category":
    # Each desktop: how its list of scenes opens, the rows of it (what takes a
    # press, top to bottom), and whether it is still open.
    proc rowsIn(layoutId: string, x0, x1: float32): seq[array[4, float32]] =
      byY(rectsOf(layoutId).filterIt(it[0] >= x0 and it[0] <= x1 and it[3] - it[1] >= 20 and
        it[3] - it[1] <= 34 and it[2] - it[0] > 150))
    proc openList(layoutId: string) =
      case layoutId
      of Layout: discard click(20, H - 20) # Start
      of MacOS: discard clickRect(menuBar()[1]) # Scenes
      of BeOS: discard click(W - BarW div 2, 17) # the gem
      of ClassicMac: discard clickRect(macTitles()[2]) # Scenes
      of NeXT: discard clickRect(nextMenu()[1]) # Scenes
      of Os2: discard clickRect(warpCenter()[0]) # the Desktop menu
      of Omarchy: discard omMenu() # the menu
      else: discard clickRect(topBar()[0]) # Tiling's +
    proc rows(layoutId: string): seq[array[4, float32]] =
      case layoutId
      of Layout: rowsIn(Layout, 20, 40).filterIt(it[3] <= float32(H - 42))
      of MacOS: dropItems(menuBar()[1])
      of BeOS: rowsIn(BeOS, float32(W - BarW - 220), float32(W - BarW - 200))
      of ClassicMac: macDrop(macTitles()[2])
      of NeXT: nextSubmenu()
      of Os2: warpRows()
      of Omarchy: omRows()
      else: byY(rectsOf(Tiling).filterIt(it[0] >= 8 and it[0] <= 12 and it[1] >= 24 and it[3] - it[1] < 60 and
        it[2] - it[0] > 40 and it[2] < 200))
    proc isOpen(layoutId: string): bool =
      case layoutId
      of Layout, BeOS: desk().state{"menu"}.getBool()
      of Omarchy: desk().state{"menu"}.getStr() == "palette"
      of Tiling: desk().state{"adding"}.getBool()
      else: desk().state{"menu"}.getStr() == "scenes"
    for layoutId in [Layout, MacOS, BeOS, ClassicMac, NeXT, Os2, Omarchy, Tiling]:
      # A desktop of its own, one window open.
      discard focusOn("tests/red")
      desk().state["openScenes"] = %*[]
      chooseLayout(layoutId)
      discard pass()
      desk().state["boxes"] = %*{}
      desk().state["wins"] = %*[]
      if layoutId == Tiling: desk().state["open"] = %*["tests/red"]
      discard pass()
      check desk().id.string == layoutId
      openList(layoutId)
      shot(pass(), "list-" & layoutId.replace("/", "-"))
      check isOpen(layoutId)
      let first = rows(layoutId)
      check first.len > 4
      check first[^1][3] <= float32(H) # what shows is cut to the screen
      # Dragged up by a finger: the list follows, and nothing is opened.
      let (x, y) = (int((first[2][0] + first[2][2]) / 2), int((first[2][1] + first[2][3]) / 2))
      var sent = send("pointerDown", at(x, y))
      sent.add send("pointerMove", at(x, y - 40))
      sent.add send("pointerMove", at(x, y - 170))
      sent.add send("pointerUp", at(x, y - 170, %*{"buttons": 0}))
      check "setCurrentScene" notin sent
      check isOpen(layoutId)
      discard pass()
      # 170 px is no whole number of rows in any of them: every row moved.
      check rows(layoutId).mapIt(it[1]) != first.mapIt(it[1])
      # Scrolled back to the top: its first row is the first scene of the
      # first category by name, Art & galleries, not the frame's first scene.
      discard send("wheel", %*{"x": x, "y": y, "deltaX": 0, "deltaY": -40})
      discard pass()
      check acted(clickRect(rows(layoutId)[0])) == @["setCurrentScene"]
      check current.id.string == "tests/be-3"
      discard pass()
      check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

suite "a scene's own icon (app.frame.scenes[i].icon)":
  # Red and Blue have an icon of their own, a square that fills its box; Green
  # has none.
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red", "icon": "M0 0H24V24H0Z"}, {"id": "tests/green", "name": "Green"},
        {"id": "tests/blue", "name": "Blue", "icon": "M0 0H24V24H0Z"}]

  test "is the same function, word for word, in every desktop that draws its scenes' icons":
    let copies = copiesOf("// A scene's own icon (`icon` on its entry", [layout, macos, beos, classicMac, nextstep, os2, omarchy, tiling])
    check copies[0].len > 0
    for text in copies: check text == copies[0]

  test "is drawn where a desktop draws a scene's icon, and the desktop's own where a scene has none":
    proc fresh(layoutId: string) =
      discard focusOn("tests/green")
      desk().state["openScenes"] = %*[]
      chooseLayout(layoutId)
      discard pass()
      desk().state["boxes"] = %*{}
      desk().state["wins"] = %*[]
      discard pass()
      check desk().id.string == layoutId
    # Windows 98's Start: the programs, each with its icon 8 px in from the
    # row's left, black as the row's text where it is the scene's own, the
    # window (white inside) where it is not.
    fresh(Layout)
    discard click(20, H - 20)
    let start = pass()
    let rows = byY(rectsOf(Layout).filterIt(it[0] >= 20 and it[0] <= 40 and it[3] - it[1] >= 20 and
      it[3] - it[1] <= 34 and it[2] - it[0] > 150 and it[3] <= float32(H - 42)))
    proc iconMiddle(row: array[4, float32]): (int, int) = (int(row[0]) + 16, int((row[1] + row[3]) / 2))
    check start.color(iconMiddle(rows[0])[0], iconMiddle(rows[0])[1]) == colored("#000000") # Red
    check start.color(iconMiddle(rows[1])[0], iconMiddle(rows[1])[1]) == colored("#ffffff") # Green
    discard click(20, H - 20)
    # NeXTSTEP's Dock: Red's tile has its icon, white on the dark grey, where
    # Green's has its letter, which does not reach so far up.
    fresh(NeXT)
    discard focusOn("tests/red")
    let dock = pass()
    let tiles = nextDock() # the mark, Red, Green, the clock
    check tiles.len == 4
    proc offMiddle(tile: array[4, float32]): (int, int) =
      (int((tile[0] + tile[2]) / 2) - 10, int((tile[1] + tile[3]) / 2) - 10)
    check dock.color(offMiddle(tiles[1])[0], offMiddle(tiles[1])[1]) == colored("#ffffff")
    check dock.color(offMiddle(tiles[2])[0], offMiddle(tiles[2])[1]) == colored("#555555")
    shot(dock, "icons-nextstep")
    check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

  test "gives way to the desktop's own drawing of the frame's own apps (layouts may override them)":
    # Windows 98's desktop icon of the terminal, and its taskbar button once it
    # is open: the same pixels with an icon of its own (a square filling its
    # box) as without one. Red keeps its own square in Start (above).
    proc desktopWith(icon: string): (Image, Image) =
      let own = icon
      windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
        {.cast(gcsafe).}:
          result = %*[{"id": "tests/red", "name": "Red", "icon": "M0 0H24V24H0Z"},
            {"id": "tests/term-98", "name": "Terminal"}]
          if own.len > 0: result[1]["icon"] = %own
      discard focusOn("tests/red")
      desk().state["openScenes"] = %*[]
      chooseLayout(Layout)
      discard pass()
      desk().state["boxes"] = %*{}
      desk().state["wins"] = %*[]
      let desktop = pass()
      discard focusOn("tests/term-98")
      (desktop, pass())
    let (plainDesk, plainBar) = desktopWith("")
    let (iconDesk, iconBar) = desktopWith("M0 0H24V24H0Z")
    var icons: seq[array[4, float32]]
    uiPressRects(Layout, icons)
    let terminal = icons.filterIt(it[0] == 8 and it[2] == 88)[1] # Programs, the terminal, Control Panel
    proc same(a, b: Image, x0, y0, x1, y1: int): bool =
      for y in y0 ..< y1:
        for x in x0 ..< x1:
          if a.color(x, y) != b.color(x, y): return false
      true
    check same(plainDesk, iconDesk, int(terminal[0]), int(terminal[1]), int(terminal[2]), int(terminal[3]))
    # The taskbar: Start, then the terminal's button with its prompt.
    check same(plainBar, iconBar, 0, H - 40, W, H)
    check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

suite "where only two scenes run at once (an ESP32 with 8 MB)":
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"}]

  test "a third scene opened closes the one that had the focus longest ago, on every desktop":
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 65536
    check windowLimit() == 2
    for layoutId in [Layout, MacOS, BeOS, Tiling, ClassicMac, NeXT, Os2, Omarchy]:
      # A desktop of its own, nothing carried over from the one before.
      desk().state["openScenes"] = %*[]
      chooseLayout(layoutId)
      discard pass()
      check desk().id.string == layoutId
      for id in ["tests/red", "tests/green", "tests/blue"]:
        discard focusOn(id)
        discard pass()
      check openIds() == @["tests/blue", "tests/green"]
      check desk().state{"openScenes"} == %*["tests/green", "tests/blue"]
      # Brought back, red closes green, which had the focus longest ago now.
      discard focusOn("tests/red")
      discard pass()
      check openIds() == @["tests/blue", "tests/red"]
      check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()
    deviceMemoryBytesOverride = 0

suite "a slideshow in a window (the SD card image sample)":
  # Its window dragged across the Windows 98 desktop went from photo to photo on
  # the bench (2026-11-16): every pass of the drag ran it as if it were due.
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/blue", "name": "Blue"}, {"id": "tests/photo", "name": "SD card image"}]

  test "dragged by its title bar, it keeps its photo, and its slideshow its schedule":
    desk().state["openScenes"] = %*[]
    chooseLayout(Layout)
    discard focusOn("tests/blue")
    discard pass()
    discard focusOn("tests/photo")
    check current.id.string == "tests/photo"
    let first = pass()
    let photo = hosted["tests/photo"]
    let w = winOf("tests/photo")
    check not w{"max"}.getBool()
    let (x0, y0, ww, wh) = (w{"x"}.getInt(), w{"y"}.getInt(), w{"w"}.getInt(), w{"h"}.getInt())
    let shown = first.color(x0 + ww div 2, y0 + wh div 2)
    check shown in [colored("#ff00ff"), colored("#00ffff"), colored("#ffff00")]
    var hole = false
    for slot in desk().slots:
      hole = hole or slot.hole and slot.child == photo
    check hole
    let counter = photo.state{"counter"}.getInt()
    let scheduled = photo.rhythm.scheduledPass
    discard pass()
    check photo.rhythm.scheduledPass == scheduled # not due: fifteen minutes
    # Drawn after every move, as a frame does while the pointer drags.
    discard send("pointerDown", at(x0 + 60, y0 + 14))
    for (dx, dy) in [(10, 5), (40, 30), (70, 40), (100, 50)]:
      discard send("pointerMove", at(x0 + 60 + dx, y0 + 14 + dy))
      let image = pass()
      check winOf("tests/photo"){"x"}.getInt() == x0 + dx
      check image.color(x0 + dx + ww div 2, y0 + dy + wh div 2) == shown
      check photo.state{"counter"}.getInt() == counter
      check photo.rhythm.scheduledPass == scheduled
    discard send("pointerUp", at(x0 + 160, y0 + 64, %*{"buttons": 0}))
    check pass().color(x0 + 100 + ww div 2, y0 + 50 + wh div 2) == shown
    check photo.state{"counter"}.getInt() == counter
    # Sized, its picture is the wrong shape: it runs, and the slideshow steps on.
    let sized = winOf("tests/photo")
    discard send("pointerDown", at(sized{"x"}.getInt() + ww - 3, sized{"y"}.getInt() + wh - 3))
    discard send("pointerMove", at(sized{"x"}.getInt() + ww + 30, sized{"y"}.getInt() + wh + 20))
    discard send("pointerUp", at(sized{"x"}.getInt() + ww + 30, sized{"y"}.getInt() + wh + 20, %*{"buttons": 0}))
    discard pass()
    check photo.rhythm.scheduledPass != scheduled
    check problems.len == 0
    desk().state["openScenes"] = %*[]
    chooseLayout("")
    discard pass()

suite "a new render scale on a desktop of windows":
  # The windows' boxes are in the desktop's pixels, and the desktop is the
  # panel over the render scale: at 0.5 it has twice the room, at 2 half. The
  # boxes made for one scale sat in a quarter of the panel at 0.5 and off it at
  # 2, the window gone (the frame page's Scale, 2026-11-16). Each desktop keeps
  # them where they were on the glass (`refit`).
  setup:
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/green", "name": "Green"}, {"id": "tests/blue", "name": "Blue"}]

  proc shown(): seq[(string, array[4, float32])] =
    ## Where each open scene is drawn on the panel: its hole or its picture.
    for slot in desk().slots:
      if slot.child.id.string.startsWith("tests/"): result.add((slot.child.id.string, slot.visible))
    result.sort(proc(a, b: (string, array[4, float32])): int = cmp(a[0], b[0]))

  test "keeps every window where it was on the panel, in every desktop of windows":
    for layoutId in [Layout, MacOS, BeOS, ClassicMac, NeXT, Os2, Omarchy]:
      checkpoint layoutId
      config.renderScale = 0.0
      chooseLayout(layoutId)
      parked = nil
      for scene in hosted.values: scene.wornLayout = nil
      for id in ["tests/red", "tests/green", "tests/blue", "tests/green"]:
        discard focusOn(id)
        discard pass()
      discard pass()
      let before = shown()
      check before.len == 3
      for scale in [0.5, 2.0, 1.0]:
        checkpoint $scale
        config.renderScale = scale
        discard pass()
        let image = pass()
        shot(image, "scale-" & layoutId & "-" & $scale)
        let now = shown()
        check now.len == before.len
        for i in 0 ..< min(now.len, before.len):
          check now[i][0] == before[i][0]
          # The title bars and borders are the desktop's size over the scale,
          # so what is inside them moves a little; the window does not.
          let (a, b) = (before[i][1], now[i][1])
          checkpoint now[i][0] & " " & $a & " -> " & $b
          if winOf(now[i][0]){"max"}.getBool():
            # It fills the desktop, whose bars may move with its size (BeOS's
            # Deskbar along the top of a narrow one).
            continue
          check abs((a[0] + a[2]) - (b[0] + b[2])) / 2 <= 40 and abs((a[1] + a[3]) - (b[1] + b[3])) / 2 <= 40
          let area = (b[2] - b[0]) * (b[3] - b[1]) / max((a[2] - a[0]) * (a[3] - a[1]), 1)
          check area > 0.6 and area < 1.6
      check problems.len == 0
      desk().state["openScenes"] = %*[]
    config.renderScale = 0.0
    chooseLayout("")
    discard pass()

  test "is the same function, word for word, in every desktop of windows":
    let copies = copiesOf("// The windows' boxes are in the desktop's pixels", [layout, macos, beos, classicMac, nextstep, os2, omarchy])
    check copies[0].len > 0
    for text in copies: check text == copies[0]
