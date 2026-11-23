## The frame's keyboard (docs/jsx-ui.md "The frame's keyboard"): a field of the
## scene a layout wraps types on a keyboard the frame draws, not one inside the
## scene. On a small screen it is docked at the bottom of the panel and the
## whole layout is laid out above it; on a desktop of windows it is a window
## over every other, whose keys type into the window in front without moving
## the focus or the windows.

import std/[json, os, strutils, tables, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime
import ../ui/events as ui_events
import ../ui/layout
import ../ui/keyboard

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  Small = (w: 480, h: 320)
  Desk = (w: 800, h: 480)
  Win98 = "layout-windows-98"

proc jsxScene(id, source: string, extra = "", events: seq[string] = @[]): JsonNode =
  let app = %*{"origin": "ui", "name": "ui", "category": "data", "version": "1.0.0", "fields": [],
    "output": [{"name": "image", "type": "image"}], "sources": {"app.tsx": source,
      "config.json": $(%*{"name": "ui", "category": "data", "output": [{"name": "image", "type": "image"}],
        "fields": [], "events": events})}}
  result = %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 3000,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {"ui": app},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "ui", "config": {}}},
      {"id": "3", "type": "app", "data": {"keyword": "render/image", "config": {"placement": "stretch"}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "3", "targetHandle": "prev"},
      {"id": "2", "source": "2", "sourceHandle": "fieldOutput", "target": "3", "targetHandle": "fieldInput/image"}]}
  if extra.len > 0:
    for key, value in parseJson(extra).pairs:
      result[key] = value

# A bar on top and one at the bottom, the scene between them.
const barsLayout = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[30px] bg-[#ff0000]" />
      <yield />
      <div className="h-[20px] bg-[#0000ff]" />
    </div>
  )
}
"""

# The bars again, counting the frame's `back` it hears.
const backBarsLayout = """
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <div className="h-[30px] bg-[#ff0000]" />
      <yield />
      <div className="h-[20px] bg-[#0000ff]" />
    </div>
  )
}
export function onEvent(app, context) {
  if (context.event !== 'back') return false
  frameos.setState('backs', (app.state.backs || 0) + 1)
  return true
}
"""

# A layout with a field of its own (a launcher's search) over the scene.
const searchLayout = """
let q = ''
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full">
      <input className="h-[30px] px-2 bg-[#fde047] text-black" value={q}
        onChange={(e) => { q = e.value; frameos.setState('q', q) }} />
      <yield />
      <div className="h-[20px] bg-[#0000ff]" />
    </div>
  )
}
"""

# A form whose field is at its bottom, what it typed in its state.
const formUi = """
let text = ''
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full bg-white">
      <div className="flex-1 bg-[#22c55e]" />
      <input className="h-[40px] px-2 bg-[#fde047] text-black" value={text}
        onChange={(e) => { text = e.value; frameos.setState('text', text) }} />
    </div>
  )
}
"""

# The form, with a page before it that the frame's `back` goes back to.
const backFormUi = """
let text = ''
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full bg-white">
      <div className="flex-1 bg-[#22c55e]" />
      <input className="h-[40px] px-2 bg-[#fde047] text-black" value={text}
        onChange={(e) => { text = e.value; frameos.setState('text', text) }} />
    </div>
  )
}
export function onEvent(app, context) {
  if (context.event !== 'back') return false
  frameos.setState('backs', (app.state.backs || 0) + 1)
  return true
}
"""

# A field at the top of the window, the rest a page to tap on.
const windowFormUi = """
let text = ''
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full bg-[#22c55e]">
      <input className="h-[40px] px-2 bg-[#fde047] text-black" value={text}
        onChange={(e) => { text = e.value; frameos.setState('text', text) }} />
      <div className="flex-1" onClick={() => frameos.setState('page', (app.state.page || 0) + 1)} />
    </div>
  )
}
"""

proc panel(id, hex: string, layout: string): JsonNode =
  %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 600,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {}, "layout": {"sceneId": layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": hex}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}

let win98 = parseFile(Samples / "Windows 98 layout" / "scenes.json")[0]
doAssert win98["id"].getStr() == Win98
let scenes = %*[
  jsxScene("tests/bars", barsLayout, """{"settings": {"execution": "interpreted", "refreshInterval": 600,
    "backgroundColor": "#000000", "isLayout": true}}"""),
  jsxScene("tests/form", formUi, """{"layout": {"sceneId": "tests/bars"}}"""),
  jsxScene("tests/bareForm", formUi),
  jsxScene("tests/backBars", backBarsLayout, """{"settings": {"execution": "interpreted", "refreshInterval": 600,
    "backgroundColor": "#000000", "isLayout": true}}""", @["back"]),
  jsxScene("tests/backForm", backFormUi, """{"layout": {"sceneId": "tests/backBars"}}""", @["back"]),
  jsxScene("tests/search", searchLayout, """{"settings": {"execution": "interpreted", "refreshInterval": 600,
    "backgroundColor": "#000000", "isLayout": true}}"""),
  win98,
  panel("tests/red", "#ff0000", Win98),
  panel("tests/searched", "#22c55e", "tests/search"),
  jsxScene("tests/windowForm", windowFormUi, """{"layout": {"sceneId": "$1"}}""" % Win98)]
setUploadedInterpretedScenes(parseInterpretedScenes($scenes))
resetInterpretedScenes()

var problems: seq[string]

proc configOf(size: tuple[w, h: int]): FrameConfig =
  FrameConfig(name: "keyboard", mode: "rpios", device: "framebuffer", width: size.w, height: size.h, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
    assetsPath: getTempDir() / "frameos-keyboard-test")

proc logger(config: FrameConfig): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) =
    {.cast(gcsafe).}:
      if payload{"event"}.getStr().contains("error"):
        problems.add($payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

var clock = 1000.0

proc pass(scene: FrameScene, size: tuple[w, h: int]): Image =
  clock += 0.01
  rhythmClockOverride = clock
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: newImage(size.w, size.h), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(scene, context)

proc freshPass(scene: FrameScene, size: tuple[w, h: int]): Image =
  ## A render from nothing, that takes nothing from a canvas kept between renders.
  let saved = rhythmCanvasGeneration
  rhythmCanvasGeneration = nil
  result = pass(scene, size)
  rhythmCanvasGeneration = saved

proc settle(): seq[string] =
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    result.add message[1]

proc send(scene: FrameScene, event: string, x, y: float, pid = 0, extra: JsonNode = nil): seq[string] =
  let payload = %*{"x": x, "y": y, "pointerId": pid, "pointerType": "touch", "button": 0,
    "buttons": (if event == "pointerDown" or event == "pointerMove": 1 else: 0)}
  if not extra.isNil:
    for k, v in extra.pairs: payload[k] = v
  runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0, loopKey: ".",
    nextSleep: -1))
  settle()

proc tap(scene: FrameScene, x, y: float): seq[string] =
  result = scene.send("pointerDown", x, y)
  result.add scene.send("pointerUp", x, y)
  result.add scene.send("tap", x, y)

proc color(image: Image, x, y: int): ColorRGBX = image.getPixel(image.dataIndex(x, y))
proc colored(hex: string): ColorRGBX = parseHtmlColor(hex).rgbx

proc keyAt(sceneId: string, code: char, node = 2): tuple[x, y: float] =
  ## Where the frame's keyboard drew key `code`, on the frame's canvas.
  let target = uiTarget(sceneId, node, create = false)
  doAssert not target.isNil
  let scale = if target.scale > 0: target.scale else: 1'f32
  for r in target.regions:
    if r.handlers[ueClick] - 1 == KeyBase + ord(code):
      return (float(frameKeyboard.sceneX + target.offsetX + (r.x + r.w / 2) * scale),
        float(frameKeyboard.sceneY + target.offsetY + (r.y + r.h / 2) * scale))
  doAssert false, "no key " & $code

let shots = getEnv("FRAMEOS_KEYBOARD_SHOTS")
proc shot(image: Image, name: string) =
  if shots.len > 0:
    createDir(shots)
    image.writeFile(shots / name & ".png")

proc holeOf(layout: FrameScene, child: FrameScene): tuple[x, y, w, h: int] =
  for slot in layout.slots:
    if slot.child == child:
      return (slot.x.int, slot.y.int, int(slot.visible[2] - slot.x), int(slot.visible[3] - slot.y))

var small: FrameScene

suite "the frame's keyboard on a small screen":
  test "it takes the bottom of the panel, the whole layout is laid out above it, and the field shows":
    forgetTypedKeys()
    let config = configOf(Small)
    small = init("tests/form".SceneId, config, logger(config), %*{})
    let scene = small
    let before = pass(scene, Small)
    shot(before, "small-1-before")
    let layout = scene.wornLayout
    check holeOf(layout, scene) == (0, 30, Small.w, Small.h - 50)
    check before.color(10, Small.h - 10) == colored("#0000ff")
    # The field is the form's last 40 px: a tap on it brings the keyboard up.
    discard scene.tap(100, float(Small.h - 20 - 20))
    check keyboardShown("tests/form")
    let open = pass(scene, Small)
    shot(open, "small-2-keyboard")
    let (top, tall) = keyboardBox(Small.w, Small.h)
    check frameKeyboard.sceneId == "tests/form"
    check frameKeyboard.grip == 0 and frameKeyboard.y == top.float32 and frameKeyboard.h == tall.float32
    # The layout above it: its top bar where it was, the scene and the bottom
    # bar pushed up, the bottom bar ending where the keyboard starts.
    check holeOf(layout, scene) == (0, 30, Small.w, top - 50)
    check open.color(10, 10) == colored("#ff0000")
    check open.color(10, top - 10) == colored("#0000ff")
    # The field still shows, right above the bar.
    check open.color(Small.w - 10, top - 20 - 5) == colored("#fde047")
    # The keyboard across the whole width under it, in its own look.
    check open.color(2, top + 2) == colored("#18181b")
    check open.color(Small.w - 3, Small.h - 3) == colored("#18181b")
    check problems.len == 0

  test "a key typed on it goes into the field, which keeps the keyboard":
    let scene = small
    let a = keyAt("tests/form", 'a')
    check a.y > frameKeyboard.y.float
    discard scene.tap(a.x, a.y)
    let h = keyAt("tests/form", 'h')
    discard scene.tap(h.x, h.y)
    check scene.state{"text"}.getStr() == "ah"
    check keyboardShown("tests/form")
    let typed = pass(scene, Small)
    shot(typed, "small-3-typed")
    check frameKeyboard.sceneId == "tests/form"
    # A held key's accents come up over the layout, and go again.
    let e = keyAt("tests/form", 'e')
    discard scene.send("pointerDown", e.x, e.y)
    discard scene.send("longPress", e.x, e.y)
    let held = pass(scene, Small)
    shot(held, "small-4-accents")
    check frameKeyboard.accents[2] > 0
    check frameKeyboard.accents[1] < frameKeyboard.y
    discard scene.send("pointerUp", e.x, e.y)
    check scene.state{"text"}.getStr() == "ah3" # its symbol, first and lit
    discard pass(scene, Small)
    check frameKeyboard.accents[2] == 0
    # Enter: the field is done, and the layout has the panel again.
    var enter = (x: 0.0, y: 0.0)
    let target = uiTarget("tests/form", 2, create = false)
    for r in target.regions:
      if r.handlers[ueClick] - 1 == KeyBase + ord(kEnter):
        enter = (float(frameKeyboard.sceneX + (r.x + r.w / 2) * target.scale),
          float(frameKeyboard.sceneY + (r.y + r.h / 2) * target.scale))
    discard scene.tap(enter.x, enter.y)
    check not keyboardShown("tests/form")
    let after = pass(scene, Small)
    shot(after, "small-5-done")
    check frameKeyboard.sceneId == ""
    check holeOf(scene.wornLayout, scene) == (0, 30, Small.w, Small.h - 50)
    check after.color(10, Small.h - 10) == colored("#0000ff")
    check problems.len == 0

  test "the frame's back puts the keyboard away, and the scene and its layout hear nothing of it":
    # A Sticky's Action key pressed twice, a swipe in from the left edge: as on a
    # phone, back with the keyboard up is the keyboard's.
    forgetTypedKeys()
    let config = configOf(Small)
    let scene = init("tests/backForm".SceneId, config, logger(config), %*{})
    discard pass(scene, Small)
    let layout = scene.wornLayout
    check not layout.isNil
    proc back(): seq[string] =
      runEvent(scene, ExecutionContext(scene: scene, event: "back", payload: %*{}, loopIndex: 0, loopKey: ".",
        nextSleep: -1))
      settle()
    # Nothing up: back is the scene's, and its layout's.
    discard back()
    check scene.state{"backs"}.getInt() == 1 and layout.state{"backs"}.getInt() == 1
    discard scene.tap(100, float(Small.h - 20 - 20))
    check keyboardShown("tests/backForm")
    pass(scene, Small).shot("back-1-keyboard")
    check frameKeyboard.sceneId == "tests/backForm"
    let heard = back()
    check not keyboardShown("tests/backForm")
    check uiTarget("tests/backForm", 2, create = false).input.focus == 0
    check "render" in heard
    check scene.state{"backs"}.getInt() == 1 and layout.state{"backs"}.getInt() == 1
    let after = pass(scene, Small)
    after.shot("back-2-gone")
    check frameKeyboard.sceneId == ""
    check holeOf(layout, scene) == (0, 30, Small.w, Small.h - 50)
    check after.color(10, Small.h - 10) == colored("#0000ff")
    # The keyboard gone, back is the scene's again.
    discard back()
    check scene.state{"backs"}.getInt() == 2 and layout.state{"backs"}.getInt() == 2
    check problems.len == 0

  test "on a canvas kept between renders, a key's row leaves nothing over the layout":
    # As an LCD's frame buffer: what a render does not draw stays from the last,
    # and the layout's bars, not due, are not drawn again.
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0
    defer: rhythmCanvasGeneration = nil
    let scene = small
    let kept = newImage(Small.w, Small.h)
    proc keptPass() =
      clock += 0.01
      rhythmClockOverride = clock
      discard render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
        image: kept, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
    keptPass()
    discard scene.tap(100, float(Small.h - 40))
    keptPass()
    keptPass()
    let bars = scene.wornLayout.rhythm.chromePass
    keptPass()
    check scene.wornLayout.rhythm.chromePass == bars # not due: the bars stay as they are
    let e = keyAt("tests/form", 'e')
    discard scene.send("pointerDown", e.x, e.y)
    discard scene.send("longPress", e.x, e.y)
    keptPass()
    let row = frameKeyboard.accents
    check row[2] > 0 and row[1] < frameKeyboard.y
    # Lifted far from the row, it stays for a tap; a tap on a key takes it away.
    discard scene.send("pointerMove", e.x, e.y + 300)
    discard scene.send("pointerUp", e.x, e.y + 300)
    keptPass()
    let w = keyAt("tests/form", 'w')
    discard scene.tap(w.x, w.y)
    keptPass()
    shot(kept, "small-6-kept-row-gone")
    check frameKeyboard.accents[2] == 0
    let fresh = freshPass(scene, Small)
    var stale = 0
    for y in int(row[1]) ..< int(row[1] + row[3]):
      for x in int(row[0]) ..< int(row[0] + row[2]):
        if kept.color(x, y) != fresh.color(x, y): inc stale
    check stale == 0
    # The field lets go: the layout has the panel again, nothing of the keyboard left.
    discard scene.tap(100, 50)
    keptPass()
    check frameKeyboard.sceneId == ""
    check kept.color(10, Small.h - 10) == colored("#0000ff")
    check kept.color(Small.w div 2, Small.h - 100) == colored("#22c55e")

  test "a field of the layout's own types on it too, the layout above it":
    let config = configOf(Small)
    let scene = init("tests/searched".SceneId, config, logger(config), %*{})
    discard pass(scene, Small)
    discard scene.tap(100, 15)
    check keyboardShown("tests/search")
    let open = pass(scene, Small)
    shot(open, "small-7-layout-field")
    let (top, _) = keyboardBox(Small.w, Small.h)
    check frameKeyboard.sceneId == "tests/search"
    check open.color(10, top - 10) == colored("#0000ff")
    check open.color(Small.w - 10, 15) == colored("#fde047")
    let k = keyAt("tests/search", 'k', node = 2)
    check k.y > top.float
    discard scene.tap(k.x, k.y)
    check scene.wornLayout.state{"q"}.getStr() == "k"
    # A tap on the layout's own bar: the field lets go.
    discard scene.tap(10, float(top - 10))
    check not keyboardShown("tests/search")
    let after = pass(scene, Small)
    check frameKeyboard.sceneId == ""
    check after.color(10, Small.h - 10) == colored("#0000ff")
    check problems.len == 0

# ------------------------------------------------------------ its rows

proc rowsOf(sceneId: string): seq[tuple[y, left, right: float32]] =
  ## The keyboard's rows as its keys were laid out: each row's top, and its
  ## first key's left edge and its last key's right edge, top row first.
  let target = uiTarget(sceneId, 2, create = false)
  doAssert not target.isNil
  for r in target.regions:
    let code = r.handlers[ueClick] - 1 - KeyBase
    if code <= 0 or code >= 256:
      continue # not a key: the app's, or the keyboard's own box
    var found = false
    for row in result.mitems:
      if abs(row.y - r.y) < 1:
        row.left = min(row.left, r.x)
        row.right = max(row.right, r.x + r.w)
        found = true
    if not found:
      result.add (r.y, r.x, r.x + r.w)
  for i in 1 ..< result.len:
    var j = i
    while j > 0 and result[j].y < result[j - 1].y:
      swap(result[j], result[j - 1])
      dec j

proc rowsMatch(sceneId: string): bool =
  ## The bottom row (123, comma, space, period, Enter) as wide as the top row
  ## of letters (or of symbols), the same left and right edges.
  let rows = rowsOf(sceneId)
  doAssert rows.len == 4, $rows
  result = abs(rows[^1].left - rows[0].left) <= 1 and abs(rows[^1].right - rows[0].right) <= 1
  if not result:
    echo sceneId, " rows: ", rows

proc pressKey(scene: FrameScene, sceneId: string, code: int, dx, dy: float32) =
  ## A tap on key `code` of the scene's keyboard, its canvas `dx`, `dy` on the frame's.
  let target = uiTarget(sceneId, 2, create = false)
  let scale = if target.scale > 0: target.scale else: 1'f32
  for r in target.regions:
    if r.handlers[ueClick] - 1 == KeyBase + code:
      discard scene.tap(float(dx + target.offsetX + (r.x + r.w / 2) * scale),
        float(dy + target.offsetY + (r.y + r.h / 2) * scale))
      return
  doAssert false, "no key " & $code

suite "the keyboard's rows":
  for size in [(w: 1872, h: 1404), (w: 800, h: 480)]:
    let tag = $size.w & "x" & $size.h
    test "on a " & tag & " panel its bottom row is as wide as the rows above it, in a scene and docked":
      forgetTypedKeys()
      let config = configOf(size)
      # A scene of its own: the keyboard inside its UI, as before.
      let bare = init("tests/bareForm".SceneId, config, logger(config), %*{})
      discard pass(bare, size)
      discard bare.tap(100, float(size.h - 20))
      check keyboardShown("tests/bareForm")
      shot(pass(bare, size), "rows-" & tag & "-scene")
      check frameKeyboard.sceneId == ""
      check rowsMatch("tests/bareForm")
      bare.pressKey("tests/bareForm", ord(kSymbols), 0, 0)
      shot(pass(bare, size), "rows-" & tag & "-scene-symbols")
      check rowsMatch("tests/bareForm")
      bare.pressKey("tests/bareForm", ord(kMore), 0, 0)
      discard pass(bare, size)
      check rowsMatch("tests/bareForm")
      # Inside a layout: the frame's, docked under it.
      let docked = init("tests/form".SceneId, config, logger(config), %*{})
      discard pass(docked, size)
      discard docked.tap(100, float(size.h - 20 - 20))
      check keyboardShown("tests/form")
      shot(pass(docked, size), "rows-" & tag & "-docked")
      check frameKeyboard.sceneId == "tests/form" and frameKeyboard.w == size.w.float32
      check rowsMatch("tests/form")
      docked.pressKey("tests/form", ord(kSymbols), frameKeyboard.sceneX, frameKeyboard.sceneY)
      shot(pass(docked, size), "rows-" & tag & "-docked-symbols")
      check rowsMatch("tests/form")
      # Done: the next test starts with no field that has it.
      docked.pressKey("tests/form", ord(kEnter), frameKeyboard.sceneX, frameKeyboard.sceneY)
      discard pass(docked, size)
      check not keyboardShown("tests/form")
      bare.pressKey("tests/bareForm", ord(kEnter), 0, 0)
      check not keyboardShown("tests/bareForm")
      check problems.len == 0

# ------------------------------------------------------------ a desktop

var
  hosted = initTable[string, FrameScene]()
  parked: FrameScene
  current: FrameScene

let deskConfig = configOf(Desk)

proc hostScene(id: string): FrameScene =
  result = hosted.getOrDefault(id, nil)
  if result.isNil:
    result = init(id.SceneId, deskConfig, logger(deskConfig), %*{})
    hosted[id] = result

proc switchTo(id: string) =
  parked = current.wornLayout
  current.wornLayout = nil
  current = hostScene(id)
  wearLayout(current)

proc desk(): FrameScene =
  if current.wornLayout.isNil: parked else: current.wornLayout

suite "the frame's keyboard on a desktop":
  setup:
    hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        hostScene(sceneId.string)
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      %*[{"id": "tests/red", "name": "Red"}, {"id": "tests/windowForm", "name": "Form"}]
    takeParkedLayout = proc(layoutId: string): FrameScene {.nimcall.} =
      {.cast(gcsafe).}:
        if not parked.isNil and parked.id.string == layoutId:
          result = parked
          parked = nil

  test "it is a window over every other, and its keys type into the window in front":
    forgetTypedKeys()
    current = hostScene("tests/red")
    discard pass(current, Desk)
    switchTo("tests/windowForm")
    let two = pass(current, Desk)
    shot(two, "desk-1-windows")
    let form = hostScene("tests/windowForm")
    let win = holeOf(desk(), form)
    check win.w > 0 and win.w < Desk.w
    # The field is the window's top 40 px.
    discard current.tap(float(win.x + win.w div 2), float(win.y + 20))
    check keyboardShown("tests/windowForm")
    let open = pass(current, Desk)
    shot(open, "desk-2-keyboard")
    let k = frameKeyboard
    check k.sceneId == "tests/windowForm"
    check k.grip > 0
    check k.w < Desk.w.float32 and k.x > 0 and k.y + k.h <= Desk.h.float32
    check rowsMatch("tests/windowForm")
    # Over every window: in its own look (the desktop's theme) where the
    # window behind was.
    check two.color(int(k.x + 2), int(k.y + k.h / 2)) == colored("#ff0000")
    check open.color(int(k.x + 2), int(k.y + k.h / 2)) != colored("#ff0000")
    # The window's field still shows: the keyboard is not drawn in the window.
    check open.color(win.x + 6, win.y + 20) == colored("#fde047")
    let order = $desk().state{"wins"}
    # A key over the window behind types into the field in front: no window
    # comes forward, none moves, the focus stays.
    let a = keyAt("tests/windowForm", 'a')
    let sent = current.tap(a.x, a.y)
    check "setCurrentScene" notin sent
    check current.id.string == "tests/windowForm"
    check form.state{"text"}.getStr() == "a"
    check keyboardShown("tests/windowForm")
    let z = keyAt("tests/windowForm", 'z')
    discard current.tap(z.x, z.y)
    check form.state{"text"}.getStr() == "az"
    check $desk().state{"wins"} == order
    check form.state{"page"}.isNil # nothing under it heard the taps
    let typed = pass(current, Desk)
    shot(typed, "desk-3-typed")
    check $desk().state{"wins"} == order
    check problems.len == 0

  test "dragged by its bar, it moves and nothing under it hears the drag":
    let k = frameKeyboard
    let (gx, gy) = (float(k.x + k.w / 2), float(k.y + k.grip / 2))
    let order = $desk().state{"wins"}
    discard current.send("pointerDown", gx, gy)
    discard current.send("pointerMove", gx - 120, gy - 150)
    discard current.send("pointerUp", gx - 120, gy - 150)
    discard current.send("tap", gx, gy, extra = %*{"startX": gx, "startY": gy})
    let moved = pass(current, Desk)
    shot(moved, "desk-4-dragged")
    check abs(frameKeyboard.x - (k.x - 120)) < 1 and abs(frameKeyboard.y - (k.y - 150)) < 1
    check current.id.string == "tests/windowForm"
    check $desk().state{"wins"} == order
    check keyboardShown("tests/windowForm")
    # Where it was is the desktop's again.
    check moved.color(int(k.x + k.w - 2), int(k.y + k.h / 2)) == colored("#ff0000")
    # Its keys still type.
    let b = keyAt("tests/windowForm", 'b')
    discard current.tap(b.x, b.y)
    check hostScene("tests/windowForm").state{"text"}.getStr() == "azb"

  test "a tap elsewhere in the window takes the field's focus, and the keyboard goes":
    let form = hostScene("tests/windowForm")
    let win = holeOf(desk(), form)
    # Below the field, away from where the keyboard is now.
    var (x, y) = (win.x + 10, win.y + win.h - 10)
    let k = frameKeyboard
    if float32(x) >= k.x and float32(x) < k.x + k.w and float32(y) >= k.y and float32(y) < k.y + k.h:
      x = win.x + win.w - 10
    discard current.tap(float(x), float(y))
    check not keyboardShown("tests/windowForm")
    let gone = pass(current, Desk)
    shot(gone, "desk-5-gone")
    check frameKeyboard.sceneId == ""
    check form.state{"page"}.getInt() == 1
    check gone.color(int(k.x + 2), int(k.y + k.h / 2)) == colored("#ff0000")
    check problems.len == 0

  test "a window behind keeps its field's focus but no keyboard, and brought forward has it again":
    let form = hostScene("tests/windowForm")
    var win = holeOf(desk(), form)
    discard current.tap(float(win.x + win.w div 2), float(win.y + 20))
    discard pass(current, Desk)
    check frameKeyboard.sceneId == "tests/windowForm"
    # Red, behind, on the right of the desktop, brought forward by a press on
    # it where the keyboard is not.
    let wins = desk().state["wins"]
    for w in wins:
      if w{"id"}.getStr() == "tests/red":
        w["max"] = %false
        w["x"] = %440
        w["y"] = %40
        w["w"] = %340
        w["h"] = %300
    desk().state["wins"] = wins
    discard pass(current, Desk)
    var spot = (x: Desk.w - 40, y: 200)
    let k = frameKeyboard
    if float32(spot.x) >= k.x and float32(spot.x) < k.x + k.w and float32(spot.y) >= k.y and float32(spot.y) < k.y + k.h:
      spot = (x: Desk.w - 40, y: 70)
    var sent = current.tap(float(spot.x), float(spot.y))
    if "setCurrentScene" in sent:
      switchTo("tests/red")
    check current.id.string == "tests/red"
    let behind = pass(current, Desk)
    shot(behind, "desk-6-behind")
    check frameKeyboard.sceneId == ""
    check keyboardShown("tests/windowForm") # its field still has it, for later
    win = holeOf(desk(), form)
    check win.w > 0
    # Not in its window either: its picture is its own, its keys none.
    check behind.color(win.x + 10, win.y + win.h - 10) == colored("#22c55e")
    for r in uiTarget("tests/windowForm", 2, create = false).regions:
      check r.handlers[ueClick] - 1 < KeyBase
    # Forward again: the frame's keyboard is back for its field.
    switchTo("tests/windowForm")
    discard pass(current, Desk)
    check frameKeyboard.sceneId == "tests/windowForm"

  test "on a canvas kept between renders, nothing of it stays where it no longer is":
    # As an LCD's frame buffer: what a render does not draw stays from the last.
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0
    defer: rhythmCanvasGeneration = nil
    let kept = newImage(Desk.w, Desk.h)
    proc keptPass() =
      clock += 0.01
      rhythmClockOverride = clock
      let context = ExecutionContext(scene: current, event: "render", payload: %*{},
        image: kept, hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard render(current, context)
    proc same(box: array[4, float32]): bool =
      ## The kept canvas shows in `box` what a render from nothing shows.
      let fresh = freshPass(current, Desk)
      for y in int(box[1]) ..< int(box[1] + box[3]):
        for x in int(box[0]) ..< int(box[0] + box[2]):
          if x >= 0 and y >= 0 and x < Desk.w and y < Desk.h and kept.color(x, y) != fresh.color(x, y):
            return false
      true
    let form = hostScene("tests/windowForm")
    let win = holeOf(desk(), form)
    keptPass()
    discard current.tap(float(win.x + win.w div 2), float(win.y + 20))
    keptPass()
    keptPass() # nothing due: the chrome and the windows stay as they are
    check frameKeyboard.sceneId == "tests/windowForm"
    # A held key's row, over the windows, and gone again.
    let q = keyAt("tests/windowForm", 'q')
    discard current.send("pointerDown", q.x, q.y)
    discard current.send("longPress", q.x, q.y)
    keptPass()
    shot(kept, "desk-6-kept-row")
    let row = frameKeyboard.accents
    check row[2] > 0
    discard current.send("pointerMove", q.x, q.y + 400) # far from the row: it stays for a tap
    discard current.send("pointerUp", q.x, q.y + 400)
    keptPass()
    let k = frameKeyboard
    # A tap on its key `w`: the row goes and `w` is typed.
    let w = keyAt("tests/windowForm", 'w')
    discard current.tap(w.x, w.y)
    keptPass()
    shot(kept, "desk-7-kept-row-gone")
    check frameKeyboard.accents[2] == 0
    check form.state{"text"}.getStr().endsWith("w")
    check same(row)
    # Dragged away: where it was is the desktop's again.
    let (gx, gy) = (float(k.x + k.w / 2), float(k.y + k.grip / 2))
    discard current.send("pointerDown", gx, gy)
    discard current.send("pointerMove", gx + 60, gy + 40)
    discard current.send("pointerUp", gx + 60, gy + 40)
    keptPass()
    shot(kept, "desk-8-kept-dragged")
    check frameKeyboard.x == k.x + 60
    check same([k.x, k.y, k.w, k.h])
    # Gone with the field's focus: nothing of it stays.
    let now = frameKeyboard
    var spot = (x: -1, y: -1)
    for (x, y) in [(win.x + 10, win.y + 45), (win.x + win.w - 10, win.y + win.h - 10), (win.x + 10, win.y + win.h - 10)]:
      if not (float32(x) >= now.x and float32(x) < now.x + now.w and float32(y) >= now.y and float32(y) < now.y + now.h):
        spot = (x, y)
        break
    check spot.x >= 0
    discard current.tap(float(spot.x), float(spot.y))
    keptPass()
    shot(kept, "desk-9-kept-gone")
    check frameKeyboard.sceneId == ""
    check same([now.x, now.y, now.w, now.h])
    check problems.len == 0
