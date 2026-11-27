import std/[json, options, os, strutils, times]
import pixie
import pixie/fileformats/svg
import frameos/channels
import frameos/types
import frameos/events_gen
import frameos/frame_settings_hooks
import frameos/utils/dither
import frameos/panel_shape
import frameos/ui/events
import frameos/ui/layout
import system/sceneSwitcher/scene as switcher

# The scene switcher (docs/scene-switcher.md): the grid it lays out, the
# keys that walk it, the taps that pick a scene, and what it hands the
# dispatcher. FRAMEOS_SWITCHER_PREVIEWS=<dir> also writes the pictures.

var listed: seq[SwitcherEntry]
proc testListing(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    listed

proc entries(count: int): seq[SwitcherEntry] =
  const names = ["Weather", "Kitchen clock", "Family photos", "Calendar", "Bus departures",
    "Plants", "Quote of the day", "Night sky", "Solar output", "Air quality", "Recipes",
    "Birds in the garden", "Chores", "Football", "News", "Moon phase", "Tides", "Stocks",
    "Countdown", "Guestbook"]
  for i in 0 ..< count:
    result.add SwitcherEntry(id: "scene-" & $(i + 1), name: names[i mod names.len])

var sent: seq[(string, JsonNode)]
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    doAssert origin == eoScene, "the switcher speaks as a scene"
    sent.add((event, payload))

proc config(width, height: int, device = "pimoroni.hyperpixel4sq_touch", rotate = 0): FrameConfig =
  FrameConfig(width: width, height: height, device: device, rotate: rotate, scalingMode: "cover",
    saveAssets: %*false)

var logger = Logger(enabled: true)
logger.log = proc(payload: JsonNode) = discard

proc newSwitcher(frameConfig: FrameConfig, opener = ""): SceneSwitcherScene =
  result = SceneSwitcherScene(switcher.exportedScene.init(SceneSwitcherId.SceneId, frameConfig, logger, %*{}))
  if opener.len > 0:
    switcher.exportedScene.runEvent(result, ExecutionContext(scene: result, event: "setCurrentScene",
      payload: %*{"sceneId": SceneSwitcherId, "state": {"from": opener}}))
  switcher.exportedScene.runEvent(result, ExecutionContext(scene: result, event: "open", payload: %*{"sceneId": SceneSwitcherId}))

proc send(scene: SceneSwitcherScene, event: string, payload: JsonNode) =
  switcher.exportedScene.runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload))

proc draw(scene: SceneSwitcherScene, image: Image): Image =
  switcher.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: image, hasImage: true))

proc highlightedId(scene: SceneSwitcherScene): string =
  scene.state{"highlight"}.getStr()

proc fakePicture(frameConfig: FrameConfig, sceneId: string, width, height: int): Image {.nimcall, gcsafe.} =
  ## A stand-in for a scene's snapshot: a sky, a sun and a hill, in its own colors.
  {.cast(gcsafe).}:
    let n = parseInt(sceneId.split("-")[^1])
    result = newImage(width, height)
    let hue = (n * 47) mod 360
    result.fill(hsl(hue.float32, 55, 62).color)
    let ctx = newContext(result)
    ctx.fillStyle = hsl(((hue + 40) mod 360).float32, 70, 85).color
    ctx.fillCircle(circle(vec2(width.float32 * 0.72, height.float32 * 0.34), min(width, height).float32 * 0.16))
    ctx.fillStyle = hsl(((hue + 180) mod 360).float32, 45, 32).color
    ctx.fillEllipse(vec2(width.float32 * 0.3, height.float32 * 1.05), width.float32 * 0.6, height.float32 * 0.45)

let previews = getEnv("FRAMEOS_SWITCHER_PREVIEWS")

proc oneBit(image: Image): Image =
  ## What a black-and-white panel shows: Floyd-Steinberg to two levels.
  var gray = newSeq[float](image.width * image.height)
  toGrayscaleFloat(image, gray)
  floydSteinberg(gray, image.width, image.height)
  result = newImage(image.width, image.height)
  for y in 0 ..< image.height:
    for x in 0 ..< image.width:
      let v = if gray[y * image.width + x] >= 0.5: 255'u8 else: 0'u8
      result.unsafe[x, y] = rgbx(v, v, v, 255)

proc preview(name: string, image: Image) =
  if previews.len > 0:
    createDir(previews)
    image.writeFile(previews / name & ".png")

sceneSwitcherListing = testListing

block the_tiles_keep_one_size_whatever_the_count:
  # The grid is the panel's alone: three scenes fill three of its slots, and
  # thirty scroll through the same.
  let few = switcherGrid(480, 800, thumbnails = true)
  doAssert few.cols == 5 and few.rows == 7 and not few.beside, "a folder's icons, five by seven on 480x800: " & $few
  let many = switcherGrid(480, 480, thumbnails = false)
  doAssert many.cols * many.rows >= 9, $many
  doAssert many.tileW >= 80 and many.text >= 12, "names stay readable on a 4\" square " & $many
  # A bigger window shows more icons, never larger ones: a folder's icon view.
  let small = switcherGrid(400, 640, thumbnails = false, unit = 400)
  let large = switcherGrid(900, 1400, thumbnails = false, unit = 400)
  doAssert small.tileW == large.tileW and small.icon == large.icon and small.text == large.text, $small & " " & $large
  doAssert large.cols > small.cols and large.rows > small.rows, $small & " " & $large
  doAssert small.tileW == 84 and small.icon == 40 and small.text == 12 and small.gap == 4, $small
  let tiny = switcherGrid(128, 64, thumbnails = false)
  doAssert tiny.cols >= 1 and tiny.tileW > 0 and tiny.tileH > 0, "an OLED still gets a tile " & $tiny
  for (w, h) in [(800, 480), (720, 720), (1920, 1080), (480, 800)]:
    let grid = switcherGrid(w, h, thumbnails = true)
    doAssert grid.x0 + grid.cols * grid.tileW + (grid.cols - 1) * grid.gap <= w - grid.pad + 1, $grid
    doAssert grid.y0 + grid.rows * grid.tileH + (grid.rows - 1) * grid.gap <= h, $grid
    # The list is under the header, the whole width, to the bottom edge.
    doAssert (grid.listX, grid.listY, grid.listW, grid.listH) == (0, grid.headerH, w, h - grid.headerH), $grid

block it_opens_on_the_scene_it_was_opened_from:
  listed = entries(6)
  let scene = newSwitcher(config(720, 720), opener = "scene-4")
  doAssert scene.state{"from"}.getStr() == "scene-4"
  doAssert scene.highlightedId == "scene-4"
  # Opened from nowhere it knows (a raw setCurrentScene, a scene gone since): the first.
  let fresh = newSwitcher(config(720, 720), opener = "elsewhere")
  doAssert fresh.highlightedId == "scene-1"
  doAssert fresh.state{"from"}.getStr() == "", "a scene not on the list is forgotten: Close goes to the first"
  # Left, and opened again by name (a setCurrentScene to it, no state): it
  # knows no scene it came from, whatever it was opened from before.
  scene.send("close", %*{})
  scene.send("open", %*{})
  doAssert scene.highlightedId == "scene-1" and scene.state{"from"}.getStr() == "", $scene.state

block the_keys_walk_the_tiles_and_every_press_counts:
  listed = entries(6)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-2")
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert scene.highlightedId == "scene-3"
  # Two quick taps are one doublePress to the button layer: two steps here.
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "doublePress"})
  doAssert scene.highlightedId == "scene-5"
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert scene.highlightedId == "scene-1", "wraps around: " & scene.highlightedId
  scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "press"}) # the input state gives every button its role
  doAssert scene.highlightedId == "scene-6"
  # A long press is the frame's (LEFT held: the previous scene), not a step.
  scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "longPress"})
  doAssert scene.highlightedId == "scene-6"
  doAssert sent.len == 0
  scene.send("button", %*{"label": "REFRESH", "role": "refresh", "action": "press"})
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene and sent[0][1]["sceneId"].getStr() == "scene-6", $sent
  scene.send("button", %*{"label": "D", "role": "back", "action": "press"})
  doAssert sent.len == 2 and sent[1][0] == evSceneSwitcher, "back is the dispatcher's toggle: " & $sent
  # Up and down are a step too (the reTerminal Sticky's keys); a keyboard's
  # arrows walk the grid's rows, from the last one around to the first.
  scene.send("button", %*{"label": "UP", "role": "up", "action": "press"})
  doAssert scene.highlightedId == "scene-5"
  let cols = switcherGrid(800, 480, thumbnails = false).cols
  scene.send("keyDown", %*{"code": "ArrowDown", "key": "ArrowDown"})
  # The row below in its column, or the last of a shorter row, or round to the first.
  let below = if 4 + cols < 6: "scene-" & $(5 + cols) elif 4 div cols < 5 div cols: "scene-6" else: "scene-1"
  doAssert scene.highlightedId == below, scene.highlightedId
  sent.setLen(0)
  scene.send("keyDown", %*{"code": "Enter", "key": "Enter"})
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene
  # Tab walks the tiles one by one, as the buttons do: a tile is one stop, its
  # icon and its name no stops of their own (docs/jsx-ui.md "Keys").
  let at = scene.highlightedId
  scene.send("keyDown", %*{"code": "Tab", "key": "Tab"})
  scene.send("keyDown", %*{"code": "Tab", "key": "Tab", "shift": true})
  doAssert scene.highlightedId == at, scene.highlightedId
  scene.send("keyDown", %*{"code": "Tab", "key": "Tab", "shift": true})
  doAssert scene.highlightedId != at

block a_tap_shows_the_scene_under_the_finger:
  listed = entries(5)
  sent.setLen(0)
  sceneSwitcherThumbnail = fakePicture
  let frameConfig = config(800, 480, "framebuffer")
  let scene = newSwitcher(frameConfig, opener = "scene-1")
  let image = scene.draw(newImage(800, 480))
  doAssert scene.refreshInterval > 1 and scene.refreshInterval <= IdleSecondsFast
  preview("switcher-800x480-lcd", image)
  let grid = switcherGrid(800, 480, thumbnails = true)
  # The third tile: second column, first row.
  let x = grid.x0 + (grid.tileW + grid.gap) * 2 + grid.tileW div 2
  let y = grid.y0 + grid.tileH div 2
  let at = %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch"}
  scene.send("pointerDown", at)
  doAssert sent.len == 1 and sent[0][0] == evRender, "a press shows on an LCD: " & $sent
  scene.send("pointerUp", at)
  sent.setLen(0)
  scene.send("tap", at)
  doAssert sent.len >= 1 and sent[0][0] == evSetCurrentScene and sent[0][1]["sceneId"].getStr() == "scene-3", $sent
  # Close, in the header's right end.
  sent.setLen(0)
  discard scene.draw(newImage(800, 480))
  var closed = false
  for cx in countdown(800 - grid.pad - 2, 600, 4):
    sent.setLen(0)
    scene.send("tap", %*{"x": cx, "y": grid.headerH div 2, "pointerId": 1, "pointerType": "touch"})
    if sent.len > 0 and sent[0][0] == evSceneSwitcher:
      closed = true
      break
  doAssert closed, "Close is in the header"
  # A tap between the tiles is nothing.
  sent.setLen(0)
  scene.send("tap", %*{"x": grid.x0 + grid.tileW + grid.gap div 2, "y": y, "pointerId": 1, "pointerType": "touch"})
  doAssert sent.len == 0, $sent

block e_paper_takes_the_tap_and_shows_no_press:
  listed = entries(6)
  sent.setLen(0)
  sceneSwitcherThumbnail = nil
  let scene = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-2")
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  let image = scene.draw(newImage(800, 480))
  doAssert scene.refreshInterval > IdleSecondsFast, "e-paper waits longer before it goes back"
  preview("switcher-800x480-eink-bw", oneBit(image))
  # The highlighted cell is inverted: its corner is ink, a plain cell's paper.
  let grid = switcherGrid(800, 480, thumbnails = false)
  let lit = image[grid.x0 + (grid.tileW + grid.gap) * 2 + 3, grid.y0 + grid.tileH - 3]
  let plain = image[grid.x0 + 3, grid.y0 + grid.tileH - 3]
  doAssert lit.r < 40 and plain.r > 215, $lit & " " & $plain
  let at = %*{"x": grid.x0 + grid.tileW div 2, "y": grid.y0 + grid.tileH div 2, "pointerId": 1,
    "pointerType": "touch"}
  scene.send("pointerDown", at)
  doAssert sent.len == 0, "no render for a finger going down on e-paper: " & $sent
  scene.send("tap", at)
  doAssert sent.len == 1 and sent[0][1]["sceneId"].getStr() == "scene-1", $sent
  # And with the pictures a Pi keeps (the Linux runner's snapshots).
  sceneSwitcherThumbnail = fakePicture
  preview("switcher-800x480-eink-bw-thumbnails", oneBit(scene.draw(newImage(800, 480))))
  sceneSwitcherThumbnail = nil

proc listRegion(): UiRegion =
  ## The list's region: the box that scrolls (none while it all fits).
  for r in uiTarget(SceneSwitcherId, 1).regions:
    if r.scrollY > 0:
      return r

proc tileRegion(index: int): int =
  ## The index of the tile's region (its handler, the tile's index), -1 when
  ## the list shows none of it.
  result = -1
  for i, r in uiTarget(SceneSwitcherId, 1).regions:
    if r.handlers[ueClick] == index + 1:
      return i

proc shownWhole(index: int): bool =
  ## Whether the list shows all of the tile.
  let i = tileRegion(index)
  if i >= 0:
    let r = uiTarget(SceneSwitcherId, 1).regions[i]
    result = r.visible[1] == r.y and r.visible[3] == r.y + r.h

proc touchAt(x, y: float): JsonNode =
  %*{"x": x, "y": y, "pointerId": 1, "pointerType": "touch"}

proc drag(scene: SceneSwitcherScene, x, fromY, toY: float) =
  ## A finger down at (x, fromY), moved to (x, toY) in steps, and lifted.
  scene.send("pointerDown", touchAt(x, fromY))
  for i in 1 .. 8:
    scene.send("pointerMove", touchAt(x, fromY + (toY - fromY) * i.float / 8))
  scene.send("pointerUp", touchAt(x, toY))

block more_scenes_than_fit_scroll_under_a_finger:
  # One list that scrolls, no pages: a finger drags it, and a tap after that
  # opens the tile under it.
  listed = entries(40)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-1")
  let grid = switcherGrid(480, 480, thumbnails = false)
  preview("switcher-480x480-lcd", scene.draw(newImage565(480, 480)))
  let list = listRegion()
  doAssert list.scrollY > 0, "20 scenes are more than fit: " & $list
  doAssert listScroll() == 0
  let below = grid.cols * grid.rows # the first tile of the first row out of sight
  doAssert not shownWhole(below)
  scene.drag(240, 470, 60)
  doAssert listScroll() == list.scrollY, "dragged as far as it goes: " & $listScroll() & " " & $list
  doAssert sent.len > 0 and sent[^1][0] == evRender, "an LCD shows the list follow the finger: " & $sent
  for (event, _) in sent:
    doAssert event == evRender, "a drag picks nothing: " & $sent
  preview("switcher-480x480-lcd-scrolled", scene.draw(newImage565(480, 480)))
  # The tile now where the finger lifted: the row that was out of sight.
  doAssert shownWhole(below), "the next row in sight"
  let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(below)]
  sent.setLen(0)
  scene.send("tap", touchAt(r.x + r.w / 2, r.y + r.h / 2))
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene and
    sent[0][1]["sceneId"].getStr() == "scene-" & $(below + 1), $sent
  # Where the list was at the top, the tile now there: never the first one.
  sent.setLen(0)
  scene.send("tap", touchAt(float(grid.x0 + grid.tileW div 2), float(grid.y0 + grid.tileH div 2)))
  doAssert sent.len == 1 and sent[0][1]["sceneId"].getStr() != "scene-1", $sent
  # A swipe across it is the list's (a drag), never a scene or a page.
  sent.setLen(0)
  scene.send("swipe", %*{"direction": "left", "x": 100, "y": 200, "startX": 300, "startY": 200,
    "pointerId": 1, "pointerType": "touch"})
  doAssert sent.len == 0, $sent

block the_wheel_scrolls_the_list:
  listed = entries(60)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-1")
  discard scene.draw(newImage(800, 480))
  scene.send("wheel", %*{"x": 400, "y": 300, "deltaX": 0, "deltaY": 1, "pointerType": "mouse"})
  doAssert listScroll() == 72, "a notch: " & $listScroll()
  doAssert sent.len == 1 and sent[0][0] == evRender, $sent
  scene.send("wheel", %*{"x": 400, "y": 300, "deltaX": 0, "deltaY": -3, "pointerType": "mouse"})
  doAssert listScroll() == 0

block the_keys_scroll_the_list_to_the_highlight:
  # E-paper has the keys alone to follow: every tile they walk onto shows
  # whole, and back at the first the list is at its top again.
  listed = entries(50)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-1")
  discard scene.draw(newImage(800, 480))
  var scrolled = false
  for i in 1 ..< 50:
    scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
    doAssert scene.highlighted() == i
    discard scene.draw(newImage(800, 480))
    doAssert shownWhole(i), "tile " & $i & " in sight at " & $listScroll()
    if listScroll() > 0: scrolled = true
  doAssert scrolled
  preview("switcher-800x480-eink-scrolled", oneBit(scene.draw(newImage(800, 480))))
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert scene.highlighted() == 0 and listScroll() == 0, "around to the first, at the top"
  scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "press"})
  discard scene.draw(newImage(800, 480))
  doAssert scene.highlighted() == 49 and shownWhole(49), "back to the last, at the bottom"
  # Opened again, the list starts at its top and scrolls to the scene it was
  # opened from.
  let again = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-2")
  doAssert listScroll() == 0
  discard again.draw(newImage(800, 480))
  let deep = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-48")
  discard deep.draw(newImage(800, 480))
  doAssert listScroll() > 0 and shownWhole(47), $listScroll()
  for (event, _) in sent:
    doAssert event != evSetCurrentScene and event != evSceneSwitcher, event

block it_opens_scrolled_to_the_scene_showing_in_a_layouts_hole:
  # The reTerminal Sticky's home screen: the list in the hole its layout
  # leaves on the 800x480 panel (a big clock over it, the keys' help under
  # it). The open knows the panel alone; the first render scrolls in the
  # hole, the scene showing in the middle of the list.
  listed = entries(40)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-30")
  discard scene.draw(newImage(800, 300))
  doAssert listScroll() > 0 and shownWhole(29), "the scene showing in sight at " & $listScroll()
  let list = listRegion()
  let tile = uiTarget(SceneSwitcherId, 1).regions[tileRegion(29)]
  doAssert abs((tile.y + tile.h / 2) - (list.y + list.h / 2)) <= tile.h,
    "in the middle of the list: " & $tile & " " & $list
  preview("switcher-800x300-eink-opened", oneBit(scene.draw(newImage(800, 300))))
  # Scrolled by a finger after that, the list stays where it was put.
  let held = listScroll()
  discard scene.draw(newImage(800, 300))
  doAssert listScroll() == held
  # One in the first screenful: the list stays at its top.
  let near = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-3")
  discard near.draw(newImage(800, 300))
  doAssert listScroll() == 0 and shownWhole(2)

block forward_and_back_move_a_screenful:
  # What turned a page (the frame's forward, a swipe in from the right edge,
  # and a scene direction, which the dispatcher hands the switcher as
  # forward or back with its `direction`): the highlight a screenful on or
  # back, the list with it, wrapping at the ends, and no scene switch. A
  # plain back is the way out (the next block).
  listed = entries(40)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-1")
  discard scene.draw(newImage565(480, 480))
  let grid = switcherGrid(480, 480, thumbnails = false)
  let screen = grid.cols * grid.rows
  scene.send(evForward, %*{})
  doAssert scene.highlighted() == screen, $scene.highlighted()
  discard scene.draw(newImage565(480, 480))
  doAssert listScroll() > 0 and shownWhole(screen)
  scene.send(evBack, %*{"direction": "prev"})
  doAssert scene.highlighted() == 0 and listScroll() == 0
  scene.send(evBack, %*{"direction": "prev"})
  doAssert scene.highlighted() == 39, "back from the first: the last"
  scene.send(evForward, %*{})
  doAssert scene.highlighted() == 0, "on from the last: the first"
  # Every screenful, the last tile, then around to the first.
  var turns = 0
  while turns < 30:
    scene.send(evForward, %*{})
    inc turns
    if scene.highlighted() == 0:
      break
  doAssert turns == (39 + screen - 1) div screen + 1, $turns
  for (event, _) in sent:
    doAssert event != evSetCurrentScene and event != evSceneSwitcher, event
  # A keyboard's Page Down and Up are the same.
  scene.send("keyDown", %*{"code": "PageDown", "key": "PageDown"})
  doAssert scene.highlighted() == screen
  scene.send("keyDown", %*{"code": "PageUp", "key": "PageUp"})
  doAssert scene.highlighted() == 0

block back_leaves:
  # The frame's back (its Back key, two keys held together, a swipe in from
  # the left edge) goes back to the scene it was opened from, as on a phone.
  listed = entries(10)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-3")
  discard scene.draw(newImage565(480, 480))
  scene.send(evBack, %*{})
  doAssert sent.len == 1 and sent[0][0] == evSceneSwitcher, $sent

block e_paper_scrolls_where_the_finger_lifts:
  # The reTerminal E1003 (1872x1404, sixteen greys): no render while the
  # finger moves (each is seconds of refresh), one where it lifts, and a tap
  # after that opens the tile it lands on. At its automatic scale of 2 (its
  # display says a 10.3" panel: 227 ppi) its screen holds fifty tiles and more
  # (GridUnitMax): four hundred scroll.
  listed = entries(400)
  sent.setLen(0)
  let e1003 = config(1872, 1404, "embedded")
  e1003.panelInches = 10.3
  let scene = newSwitcher(e1003, opener = "scene-1")
  discard scene.draw(newImageGray8(1872, 1404))
  doAssert scene.paper and scene.slow
  let (roomW, roomH) = uiRoom(scene.frameConfig, 1872, 1404)
  doAssert (roomW, roomH) == (936, 702), $(roomW, roomH)
  scene.send("pointerDown", touchAt(900, 1200))
  for i in 1 .. 8:
    scene.send("pointerMove", touchAt(900, 1200 - 100 * i.float))
  doAssert sent.len == 0, "nothing drawn while the finger moves: " & $sent
  scene.send("pointerUp", touchAt(900, 400))
  doAssert sent.len == 1 and sent[0][0] == evRender, "where it lifted: " & $sent
  doAssert listScroll() > 0 and listScroll() <= listRegion().scrollY, $listScroll()
  discard scene.draw(newImageGray8(1872, 1404))
  let grid = switcherGrid(roomW, roomH, thumbnails = false, unit = 1404)
  let below = grid.cols * grid.rows
  doAssert shownWhole(below)
  # The regions are the layout's; a finger is on the glass, twice as far.
  let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(below)]
  sent.setLen(0)
  scene.send("tap", touchAt((r.x + r.w / 2) * 2, (r.y + r.h / 2) * 2))
  doAssert sent.len == 1 and sent[0][1]["sceneId"].getStr() == "scene-" & $(below + 1), $sent
  # All of it fits: nothing scrolls, and a drag asks for nothing.
  listed = entries(3)
  let few = newSwitcher(config(1872, 1404, "embedded"), opener = "scene-1")
  discard few.draw(newImageGray8(1872, 1404))
  doAssert listRegion().scrollY == 0
  sent.setLen(0)
  few.drag(900, 1200, 400)
  doAssert sent.len == 0 and listScroll() == 0, $sent

block a_layout_hole_scrolls_by_the_grid_it_drew:
  # Inside a layout the switcher is drawn in the hole the layout leaves, not
  # on the whole panel: a screenful is the hole's (the reTerminal E1003 in a
  # Windows 98 window, 2026-11-10, when a page turn lit a tile of the page
  # after the one it showed).
  listed = entries(400)
  let scene = newSwitcher(config(1872, 1404, "embedded"), opener = "scene-1")
  discard scene.draw(newImageGray8(900, 600))
  let (roomW, roomH) = uiRoom(scene.frameConfig, 900, 600)
  # Its sizes are the panel's (sizeUnit: a window keeps the frame's letters),
  # its room the hole's.
  let drawn = switcherGrid(roomW, roomH, thumbnails = false, unit = 1404)
  let whole = switcherGrid(uiRoom(scene.frameConfig, 1872, 1404)[0], uiRoom(scene.frameConfig, 1872, 1404)[1],
    thumbnails = false, unit = 1404)
  doAssert drawn.cols * drawn.rows < whole.cols * whole.rows, $drawn & " " & $whole
  scene.send(evForward, %*{})
  doAssert scene.highlighted() == drawn.cols * drawn.rows, $scene.highlighted()
  discard scene.draw(newImageGray8(900, 600))
  doAssert shownWhole(drawn.cols * drawn.rows)

proc categorized(): seq[SwitcherEntry] =
  result = entries(9)
  for (i, category) in [(0, ""), (1, "Clocks"), (2, "photos"), (3, "Other"), (4, "  Clocks "), (5, "Garden"),
      (6, "Photos"), (7, "\xC3\x89clairs"), (8, "\xC3\xA9a")]:
    result[i].category = category

proc crowded(): seq[SwitcherEntry] =
  ## `categorized` and fifteen more, five each in Clocks, Garden and Photos:
  ## a list longer than the screen.
  result = categorized()
  for i in 0 ..< 15:
    result.add SwitcherEntry(id: "scene-" & $(10 + i), name: "Extra " & $i,
      category: ["Clocks", "Garden", "Photos"][i div 5])

proc headings(tree: SvgNode): seq[string] =
  ## The headings in the list (the root's first child), in order: a heading
  ## starts with its span of text and a rule, a cell with its icon.
  for child in tree.children[0].children:
    if child.children.len >= 1 and child.children[0].tag == "span":
      result.add child.children[0].children[0].text

block categories_head_their_scenes_and_other_comes_last:
  # As the desktops' `grouped`: the categories by name with case aside
  # (Latin-1's capitals too), the raw name breaking a tie, trimmed, "Other"
  # the same as none and last; in the list's order within each.
  let order = grouped(categorized())
  var ids, names: seq[string]
  for entry in order:
    ids.add entry.id
    names.add entry.category
  doAssert ids == @["scene-2", "scene-5", "scene-6", "scene-7", "scene-3", "scene-9", "scene-8", "scene-1",
    "scene-4"], $ids
  doAssert names == @["Clocks", "Clocks", "Garden", "Photos", "photos", "\xC3\xA9a", "\xC3\x89clairs", "", ""],
    $names
  # No category anywhere: the list as it is.
  doAssert grouped(entries(5)) == entries(5)
  # System first, in any case (the frame's own apps), then the rest by name,
  # Other last: as every desktop's `grouped`.
  var system = entries(6)
  for (i, category) in [(0, "Weather"), (1, "System"), (2, ""), (3, "Apps"), (4, "system "), (5, "Systems")]:
    system[i].category = category
  var systemOrder: seq[string]
  for entry in grouped(system):
    systemOrder.add entry.id & ":" & entry.category
  doAssert systemOrder == @["scene-2:System", "scene-5:system", "scene-4:Apps", "scene-6:Systems",
    "scene-1:Weather", "scene-3:"], $systemOrder
  listed = categorized()
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-6")
  let image = scene.draw(newImage(800, 480))
  preview("switcher-800x480-lcd-few-categories", image)
  # Seven categories for nine scenes: a heading over each all the same
  # (2026-11-25; before, only from a dozen scenes and two a category).
  doAssert scene.tree(800, 480, false).headings ==
    @["Clocks", "Garden", "Photos", "photos", "\xC3\xA9a", "\xC3\x89clairs", "Other"]
  let grid = switcherGrid(800, 480, thumbnails = false)
  var spots = scene.spots(grid)
  # Garden starts a row of its own under its heading.
  doAssert spots[2].col == 0 and spots[2].top > spots[0].top, $spots
  doAssert scene.highlighted() == 2, "scene-6 is third, in Garden"
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert scene.highlightedId == "scene-7"
  # The first cell is the first category's first scene.
  discard scene.draw(newImage(800, 480))
  let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(0)]
  scene.send("tap", touchAt(r.x + r.w / 2, r.y + r.h / 2))
  doAssert sent.len == 1 and sent[0][1]["sceneId"].getStr() == "scene-2", $sent
  # Twenty-four scenes in the same seven: a heading over each category's
  # first cells, small, and the categories flow on one after another.
  listed = crowded()
  sent.setLen(0)
  let many = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-6")
  preview("switcher-800x480-lcd-categories", many.draw(newImage(800, 480)))
  doAssert many.tree(800, 480, false).headings ==
    @["Clocks", "Garden", "Photos", "photos", "\xC3\xA9a", "\xC3\x89clairs", "Other"]
  spots = many.spots(grid)
  doAssert spots[0].top == grid.y0 - grid.listY + grid.headingH
  # Garden starts a row of its own under its heading, below the row Clocks
  # ends in, and only a category's first row has a heading's strip.
  doAssert spots[7].col == 0 and spots[7].top == spots[6].top + grid.tileH + grid.gap + grid.headingH, $spots
  doAssert spots[8].col == 1 and spots[8].top == spots[7].top, $spots
  doAssert many.highlightedId == "scene-6"
  # One scene, with a category: its heading.
  var lone = entries(1)
  lone[0].category = "System"
  listed = lone
  let one = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-1")
  discard one.draw(newImage(800, 480))
  doAssert one.tree(800, 480, false).headings == @["System"]
  # No scene with a category: no headings, not even Other.
  listed = entries(9)
  let plain = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-1")
  discard plain.draw(newImage(800, 480))
  doAssert plain.tree(800, 480, false).headings.len == 0
  doAssert plain.tree(800, 480, false).children[0].children.len == 9
  # E-paper, with the keys on a scene under a heading further down.
  listed = categorized()
  let paper = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-4")
  preview("switcher-800x480-eink-categories", oneBit(paper.draw(newImage(800, 480))))
  doAssert shownWhole(paper.highlighted())
  # And the twenty-four, with their headings.
  listed = crowded()
  let groups = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-6")
  preview("switcher-800x480-eink-groups", oneBit(groups.draw(newImage(800, 480))))
  doAssert groups.tree(800, 480, true).headings.len == 7

block an_esp32_lcd_with_a_few_scenes:
  # The SenseCAP Indicator: 480x480 RGB565, names only.
  listed = entries(5)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-2")
  scene.send("button", %*{"label": "BUTTON", "role": "next", "action": "press"})
  preview("switcher-480x480-esp32-lcd", scene.draw(newImage565(480, 480)))
  doAssert not scene.paper

block an_lcd_720_square_with_pictures:
  listed = entries(9)
  sceneSwitcherThumbnail = fakePicture
  let scene = newSwitcher(config(720, 720, "pimoroni.hyperpixel4sq_touch"), opener = "scene-3")
  preview("switcher-720x720-lcd", scene.draw(newImage(720, 720)))
  sceneSwitcherThumbnail = nil

block nobody_there_goes_back:
  listed = entries(3)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-2")
  scene.state["touchedAt"] = %(epochTime() - IdleSecondsFast - 1)
  discard scene.draw(newImage(800, 480))
  doAssert sent.len == 1 and sent[0][0] == evSceneSwitcher, $sent

block no_scenes_says_so:
  listed = @[]
  let scene = newSwitcher(config(800, 480, "framebuffer"))
  doAssert scene.highlighted() == -1
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  discard scene.draw(newImage(800, 480))

proc onTheGlass(where: string) =
  ## Every region the switcher hit-tests, where it shows, inside the circle.
  for r in uiTarget(SceneSwitcherId, 1).regions:
    let v = r.visible
    for (x, y) in [(v[0], v[1]), (v[2] - 1, v[1]), (v[0], v[3] - 1), (v[2] - 1, v[3] - 1)]:
      doAssert insideRound(480, 480, int(x), int(y), RoundInset),
        where & ": a region reaches off the glass at " & $(x, y) & " " & $r

block a_round_panel_keeps_everything_on_the_glass:
  # The HyperPixel 2.1" Round: only the circle inscribed in its 480x480 shows
  # and takes a touch, and its bezel covers the rim. Every region the switcher
  # hit-tests and every pixel it draws stays RoundInset in from the rim, with
  # names or pictures, with categories or none, at the top of the list and
  # scrolled to its end, with a tile highlighted and one pressed.
  let roundConfig = config(480, 480, "pimoroni.hyperpixel2r")
  doAssert panelIsRound(roundConfig.device)
  for pictures in [false, true]:
    for count in [1, 5, 9, 20]:
      for headed in [false, true]:
        listed = entries(count)
        if headed:
          for i in 0 ..< count:
            listed[i].category = (if i mod 3 == 0: "Photos" elif i mod 3 == 1: "Clocks" else: "")
        sceneSwitcherThumbnail = if pictures: fakePicture else: nil
        let scene = newSwitcher(roundConfig, opener = "scene-1")
        let grid = switcherGrid(480, 480, pictures, round = true)
        doAssert grid.round and grid.cols * grid.rows >= min(count, 4), $grid
        doAssert (grid.listY, grid.listW, grid.listH) == (grid.y0, grid.side, grid.side), $grid
        # The columns in the middle of the square inside the circle.
        let used = grid.cols * (grid.tileW + grid.gap) - grid.gap
        doAssert abs((grid.x0 - grid.listX) - (grid.side - (grid.x0 - grid.listX) - used)) <= 1, $grid
        # The first tile, then the last (the list scrolled to its end where
        # it does not fit), so the ring is drawn at both ends.
        for last in [0, count - 1]:
          let where = $count & " scenes, tile " & $(last + 1) & (if pictures: ", pictures" else: "") &
            (if headed: ", categories" else: "")
          scene.state["highlight"] = %scene.entries[last].id
          scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
          scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "press"})
          discard scene.draw(newImage(480, 480))
          if count == 20:
            doAssert listRegion().scrollY > 0, where & ": 20 scenes scroll on a round panel"
          let lit = scene.highlighted()
          doAssert shownWhole(lit), where & ": the highlighted tile in sight at " & $listScroll()
          onTheGlass(where)
          # Press the highlighted tile, draw again: the ring, the pressed tile,
          # the bar and Close all inside.
          let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(lit)]
          let at = touchAt(r.x + r.w / 2, r.y + r.h / 2)
          scene.send("pointerDown", at)
          let image = scene.draw(newImage(480, 480))
          let background = image[0, 0]
          var inside = 0
          for y in 0 ..< 480:
            for x in 0 ..< 480:
              if insideRound(480, 480, x, y, RoundInset):
                if image[x, y] != background:
                  inc inside
              else:
                doAssert image[x, y] == background,
                  where & ": drawn off the glass at " & $(x, y) & ": " & $image[x, y]
          doAssert inside > 1000, where & ": nothing drawn"
          scene.send("pointerUp", at)
  sceneSwitcherThumbnail = nil

block a_round_panel_scrolls_inside_its_square:
  # A finger drags the list inside the square; Close at 6 goes back.
  listed = entries(20)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "pimoroni.hyperpixel2r"), opener = "scene-1")
  discard scene.draw(newImage(480, 480))
  let grid = switcherGrid(480, 480, false, round = true)
  scene.drag(240, float(grid.y0 + grid.side - 20), float(grid.y0 + 20))
  doAssert listScroll() > 0
  discard scene.draw(newImage(480, 480))
  onTheGlass("scrolled")
  sent.setLen(0)
  scene.send("tap", touchAt(240, float(grid.y0 + grid.side + grid.gap div 2 + 10)))
  doAssert sent.len == 1 and sent[0][0] == evSceneSwitcher, "Close at 6 o'clock: " & $sent
  # The square grid is no smaller than it must be: each tile at least a
  # fifth of the circle across.
  doAssert grid.tileW >= 80 and grid.tileH >= 64, $grid

proc offered(): JsonNode {.nimcall, gcsafe, raises: [].} =
  ## A host whose frame page is on (its facts do not matter here).
  {.cast(gcsafe).}:
    result = %*{"rotate": 0, "renderScale": 0}

proc turnedOff(): JsonNode {.nimcall, gcsafe, raises: [].} =
  ## The frame's control plane turned the settings on the screen off.
  nil

proc gearRegion(count: int): int =
  ## The index of the gear's region (handler count + 1), -1 for none.
  result = -1
  for i, r in uiTarget(SceneSwitcherId, 1).regions:
    if r.handlers[ueClick] == count + 1 + 1:
      return i

block the_gear_opens_the_frame_page:
  # The header's gear is the way to the frame page (and its Layout) from the
  # switcher, which may be all a broken layout left reachable: by touch, and
  # by the keys, after the last tile.
  listed = entries(3)
  sent.setLen(0)
  frameSettingsRead = offered
  let lcd = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-2")
  preview("switcher-800x480-lcd-gear", lcd.draw(newImage(800, 480)))
  let gear = gearRegion(3)
  doAssert gear >= 0, "a gear in the header"
  let r = uiTarget(SceneSwitcherId, 1).regions[gear]
  let grid = switcherGrid(800, 480, thumbnails = false)
  doAssert r.y + r.h <= grid.headerH.float32, $r
  lcd.send("tap", %*{"x": r.x + r.w / 2, "y": r.y + r.h / 2, "pointerId": 1, "pointerType": "touch"})
  doAssert sent.len == 1 and sent[0][0] == evSceneSettings and sent[0][1] == %*{"page": "frame"}, $sent
  # The keys: after the last tile the gear, inverted on e-paper, then the first.
  sent.setLen(0)
  let paper = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-3")
  let plain = paper.draw(newImage(800, 480))
  let at = uiTarget(SceneSwitcherId, 1).regions[gearRegion(3)]
  proc ink(image: Image): int =
    for y in int(at.y) ..< int(at.y + at.h):
      for x in int(at.x) ..< int(at.x + at.w):
        if image[x, y].r < 128: inc result
  paper.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert paper.highlighted() == 3
  let lit = paper.draw(newImage(800, 480))
  preview("switcher-800x480-eink-gear", oneBit(lit))
  doAssert lit.ink > plain.ink * 3 div 2, "the gear the keys are on is inverted: " & $lit.ink & " " & $plain.ink
  paper.send("button", %*{"label": "REFRESH", "role": "refresh", "action": "press"})
  doAssert sent.len == 1 and sent[0][0] == evSceneSettings and sent[0][1] == %*{"page": "frame"}, $sent
  paper.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert paper.highlightedId == "scene-1", "and on to the first: " & paper.highlightedId
  paper.send("button", %*{"label": "LEFT", "role": "prev", "action": "press"})
  doAssert paper.highlighted() == 3, "back from the first: the gear"
  # With no scenes, the gear is what the keys are on.
  listed = @[]
  let empty = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"))
  doAssert empty.highlighted() == 0
  sent.setLen(0)
  empty.send("button", %*{"label": "REFRESH", "role": "refresh", "action": "press"})
  doAssert sent.len == 1 and sent[0][0] == evSceneSettings, $sent
  # Turned off by the frame's control plane: no gear, and the keys walk the
  # tiles alone, as before.
  frameSettingsRead = turnedOff
  listed = entries(3)
  let off = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-3")
  discard off.draw(newImage(800, 480))
  doAssert gearRegion(3) < 0, "no gear while the frame page is off"
  off.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert off.highlightedId == "scene-1"
  # A round panel: the gear beside Close at 6 o'clock, on the glass.
  frameSettingsRead = offered
  for count in [1, 20]:
    listed = entries(count)
    let round = newSwitcher(config(480, 480, "pimoroni.hyperpixel2r"), opener = "scene-1")
    round.state["highlight"] = %"\1"
    let image = round.draw(newImage(480, 480))
    preview("switcher-480x480-round-gear-" & $count, image)
    let g = gearRegion(count)
    doAssert g >= 0, $count
    for r in uiTarget(SceneSwitcherId, 1).regions:
      for (x, y) in [(r.visible[0], r.visible[1]), (r.visible[2] - 1, r.visible[1]), (r.visible[0], r.visible[3] - 1), (r.visible[2] - 1, r.visible[3] - 1)]:
        doAssert insideRound(480, 480, int(x), int(y), RoundInset), $count & ": off the glass at " & $(x, y)
    let background = image[0, 0]
    for y in 0 ..< 480:
      for x in 0 ..< 480:
        if not insideRound(480, 480, x, y, RoundInset):
          doAssert image[x, y] == background, $count & ": drawn off the glass at " & $(x, y)
    sent.setLen(0)
    let r = uiTarget(SceneSwitcherId, 1).regions[g]
    round.send("tap", %*{"x": r.x + r.w / 2, "y": r.y + r.h / 2, "pointerId": 1, "pointerType": "touch"})
    doAssert sent.len == 1 and sent[0][0] == evSceneSettings, $sent
  frameSettingsRead = nil

block it_is_a_built_in_scene:
  doAssert isBuiltInScene(SceneSwitcherId)
  doAssert not isBuiltInScene("system/index")
  doAssert switcher.exportedScene.name == "Scene switcher"
  doAssert paperPanel(config(800, 480, "embedded"), newImage565(8, 8)) == false, "an ESP32 LCD"
  doAssert paperPanel(config(800, 480, "embedded"), newImageGray8(8, 8)), "an ESP32 e-paper"
  doAssert not paperPanel(config(800, 480, "pimoroni.hyperpixel4"))
  doAssert paperPanel(config(800, 480, "pimoroni.inky_impression_7"))
  # What a press costs is asked apart from the look; today they are opposites.
  doAssert fastPanel(config(800, 480, "embedded"), newImage565(8, 8)), "an ESP32 LCD"
  doAssert not fastPanel(config(800, 480, "embedded"), newImageGray8(8, 8)), "an ESP32 e-paper"
  doAssert fastPanel(config(800, 480, "pimoroni.hyperpixel4"))
  doAssert not fastPanel(config(800, 480, "pimoroni.inky_impression_7"))

block desktopUnit:
  # Full screen a built-in scene's sizes are a share of the panel up to 480 px
  # (the render scale is what makes them larger); in a desktop's window (a
  # layout keeping `openScenes`) those of a desktop's apps, whatever the panel.
  let canvas = newImage(800, 480)
  let saved = onDesktop
  onDesktop = nil
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 480
  doAssert panelUnit(config(800, 480, "web_only"), canvas) == 480
  doAssert panelUnit(config(240, 296, "web_only"), canvas) == 240
  doAssert panelEdge(config(1316, 902, "web_only"), canvas) == 902
  onDesktop = proc(): bool {.nimcall, gcsafe.} = true
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 400
  doAssert panelUnit(config(800, 480, "web_only"), canvas) == 400
  doAssert panelUnit(config(3840, 2160, "web_only"), canvas) == 400
  onDesktop = proc(): bool {.nimcall, gcsafe.} = false
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 480
  onDesktop = saved

proc noPicture(frameConfig: FrameConfig, sceneId: string, width, height: int): Image {.nimcall, gcsafe.} =
  nil

proc inkIn(image: Image, grid: SwitcherGrid, slot: int, light = false): int =
  ## How many of a tile's pixels are dark (light: bright).
  let x0 = grid.x0 + (slot mod grid.cols) * (grid.tileW + grid.gap)
  let y0 = grid.y0 + (slot div grid.cols) * (grid.tileH + grid.gap)
  for y in y0 ..< y0 + grid.tileH:
    for x in x0 ..< x0 + grid.tileW:
      if (image[x, y].r < 128) != light:
        inc result

proc differIn(a, b: Image, grid: SwitcherGrid, slot: int): int =
  ## How many of a cell's pixels differ between two pictures.
  let x0 = grid.x0 + (slot mod grid.cols) * (grid.tileW + grid.gap)
  let y0 = grid.y0 + (slot div grid.cols) * (grid.tileH + grid.gap)
  for y in y0 ..< y0 + grid.tileH:
    for x in x0 ..< x0 + grid.tileW:
      if a[x, y] != b[x, y]:
        inc result

block a_scene_icon_in_its_cell:
  # A scene's icon (docs/scene-icons.md) is its cell's icon, over its name;
  # without one, its first letter on a square in its category's color.
  const Square = "M0 0h24v24H0z"
  const House = "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"
  listed = entries(6)
  sceneSwitcherThumbnail = nil
  let paper = config(800, 480, "waveshare.EPD_7in5_V2")
  let cards = switcherGrid(800, 480, thumbnails = false)
  let plain = newSwitcher(paper, opener = "scene-2").draw(newImage(800, 480))
  listed[0].icon = Square
  listed[3].icon = House
  let image = newSwitcher(paper, opener = "scene-2").draw(newImage(800, 480))
  preview("switcher-800x480-eink-icons", oneBit(image))
  doAssert image.inkIn(cards, 0) > plain.inkIn(cards, 0) + 400, "the square is ink on paper"
  doAssert image.inkIn(cards, 3) > plain.inkIn(cards, 3)
  doAssert image.inkIn(cards, 2) == plain.inkIn(cards, 2), "a scene without one is drawn as before"
  # The highlighted tile is inverted, its icon with it: paper on ink.
  listed[1].icon = Square
  let lit = newSwitcher(paper, opener = "scene-2").draw(newImage(800, 480))
  doAssert lit.inkIn(cards, 1, light = true) > image.inkIn(cards, 1, light = true) + 150
  # An LCD: the icon in its category's color where the letter was. A host's
  # pictures (a Pi's snapshots) are not drawn any more.
  sceneSwitcherThumbnail = noPicture
  let lcd = config(800, 480, "framebuffer")
  listed = entries(6)
  let lettered = newSwitcher(lcd, opener = "scene-2").draw(newImage(800, 480))
  listed[0].icon = Square
  listed[4].icon = House
  let marked = newSwitcher(lcd, opener = "scene-2").draw(newImage(800, 480))
  preview("switcher-800x480-lcd-icons", marked)
  doAssert differIn(marked, lettered, cards, 0) > cards.icon * cards.icon div 4, $differIn(marked, lettered, cards, 0)
  doAssert differIn(marked, lettered, cards, 2) == 0
  sceneSwitcherThumbnail = nil


block tiles_keep_their_size_on_a_bigger_screen:
  # Past a 480 px screen a tile is the size it is on one, and a screen holds
  # more of them (GridUnitMax, 2026-11-20): the 10" E1003 shows its scenes in
  # tiles the 7.5" E1001's size, not in four tiles a row.
  let small = switcherGrid(800, 480, thumbnails = false)
  let large = switcherGrid(1872, 1404, thumbnails = false)
  let scaled = switcherGrid(936, 702, thumbnails = false, unit = 1404)
  doAssert large.cols * large.rows > small.cols * small.rows * 3, $large
  doAssert large.tileW < small.tileW * 5 div 4 and large.tileH < small.tileH * 5 div 4, $large & " " & $small
  doAssert large.headerH == small.headerH and large.pad == small.pad, $large
  # At a render scale of 2 it is laid out on half the pixels: still more
  # tiles than the E1001's, each as large there, so twice as large on the glass.
  doAssert scaled.cols * scaled.rows > small.cols * small.rows and scaled.tileW < small.tileW * 5 div 4, $scaled

block a_board_of_keys_alone_has_no_buttons_to_tap:
  # The reTerminal E1001: e-paper, its frame's map binds its keys and no
  # swipe, so no finger reaches the header: no Close, no gear.
  listed = entries(80)
  frameSettingsRead = proc(): JsonNode {.nimcall, gcsafe.} = %*{"wifi": {}}
  var keys = config(800, 480, "embedded")
  keys.eventMap = %*[
    {"event": "button", "match": {"label": "LEFT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "prev"}},
    {"event": "button", "match": {"label": "RIGHT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "next"}}]
  doAssert takesNoTaps(keys, paper = true)
  doAssert not takesNoTaps(keys, paper = false), "an LCD may have a finger or a mouse"
  var touch = config(800, 480, "embedded")
  touch.eventMap = %*[
    {"event": "button", "match": {"label": "LEFT", "action": "longPress"}, "emit": "setCurrentScene", "as": {"direction": "prev"}},
    {"event": "edgeSwipe", "match": {"edge": "bottom"}, "emit": "sceneSwitcher", "as": {}}]
  doAssert not takesNoTaps(touch, paper = true), "a map with swipes is a touch screen's"
  doAssert not takesNoTaps(config(800, 480, "embedded"), paper = true), "no map: maybe a finger"
  let scene = newSwitcher(keys, opener = "scene-1")
  discard scene.draw(newImageGray8(800, 480))
  doAssert scene.paper and scene.keysOnly and not scene.gear
  let grid = switcherGrid(800, 480, thumbnails = false)
  for cx in countup(grid.pad, 800 - grid.pad, 3):
    sent.setLen(0)
    scene.send("tap", %*{"x": cx, "y": grid.headerH div 2, "pointerId": 1, "pointerType": "touch"})
    doAssert sent.len == 0, "nothing in the header at " & $cx & ": " & $sent
  # Its keys walk, open, and a long press of the key that opens goes back
  # (the E1004's REFRESH, which the frame's map leaves free).
  sent.setLen(0)
  scene.send("button", %*{"label": "REFRESH", "role": "refresh", "action": "longPress"})
  doAssert sent.len == 1 and sent[0][0] == evSceneSwitcher, $sent
  sent.setLen(0)
  scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "longPress"})
  doAssert sent.len == 0, "an arrow held is the frame's, else nothing: " & $sent
  frameSettingsRead = nil

block on_a_desktop_a_pick_keeps_the_list_open:
  # A scene picked opens beside the list on a desktop (builtInScenesStay): the
  # focus leaves it as for any window, so it stays open (app.frame.keptOpen)
  # until it is closed. Without a desktop a pick is going back, as always.
  listed = entries(6)
  let grid = switcherGrid(800, 480, thumbnails = false)
  let at = touchAt(float(grid.x0 + grid.tileW div 2), float(grid.y0 + grid.tileH div 2))
  proc pick(scene: SceneSwitcherScene) =
    discard scene.draw(newImage(800, 480))
    scene.send("pointerDown", at)
    scene.send("pointerUp", at)
    sent.setLen(0)
    scene.send("tap", at)
  for stay in [true, false]:
    builtInScenesStay = stay
    builtInsAway.setLen(0)
    sent.setLen(0)
    let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-2")
    scene.pick()
    doAssert sent.len >= 1 and sent[0][0] == evSetCurrentScene and sent[0][1]["sceneId"].getStr() == "scene-1", $sent
    scene.send("close", %*{})
    doAssert builtInsAway.contains(SceneSwitcherId) == stay, $stay & " " & $builtInsAway
    doAssert scene.state{"away"}.getBool() == stay, $scene.state
    if stay:
      # Brought forward from its window: as it was left, not back at the
      # scene it was opened from. Picked again: still open. Its Close ends it.
      scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "doublePress"})
      let lit = scene.highlightedId
      doAssert lit notin ["scene-1", "scene-2"], lit # neither the pick nor the opener
      scene.send("open", %*{})
      doAssert scene.highlightedId == lit, scene.highlightedId & " " & lit
      scene.pick()
      scene.send("close", %*{})
      doAssert builtInsAway.contains(SceneSwitcherId)
      scene.send("open", %*{})
      discard scene.draw(newImage(800, 480))
      var closed = false
      for cx in countdown(800 - grid.pad - 2, 600, 4):
        sent.setLen(0)
        scene.send("tap", %*{"x": cx, "y": grid.headerH div 2, "pointerId": 1, "pointerType": "touch"})
        if sent.len > 0 and sent[0][0] == evSceneSwitcher:
          closed = true
          break
      doAssert closed, "Close is in the header"
      scene.send("close", %*{})
      doAssert not builtInsAway.contains(SceneSwitcherId), "its Close ends it"
  builtInScenesStay = false
  builtInsAway.setLen(0)

block the_header_searches_the_scenes:
  # A search field in the header keeps the scenes whose name or category
  # holds what is typed, the first of them lit; Enter shows it, and the
  # switcher opened again lists them all.
  listed = entries(20)
  sent.setLen(0)
  frameSettingsRead = nil
  let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-1")
  discard scene.draw(newImage(800, 480))
  var field = -1
  for i, r in uiTarget(SceneSwitcherId, 1).regions:
    if r.field == 1:
      field = i
  doAssert field >= 0, "a search field in the header"
  let r = uiTarget(SceneSwitcherId, 1).regions[field]
  doAssert r.y + r.h <= switcherGrid(800, 480, thumbnails = false).headerH.float32, $r
  # A tap on it (an ESP32's glass focuses a field on the tap alone): the
  # keyboard, and a picture asked for to show it, no scene switch.
  scene.send("tap", %*{"x": r.x + r.w / 2, "y": r.y + r.h / 2, "pointerId": 1, "pointerType": "touch"})
  doAssert sent.len == 1 and sent[0][0] == evRender, $sent
  doAssert uiTarget(SceneSwitcherId, 1).input.focus > 0, "the field has the keyboard"
  sent.setLen(0)
  scene.send("textInput", %*{"text": "CLOCK"})
  doAssert scene.state{"query"}.getStr() == "CLOCK"
  doAssert scene.entries.len == 1 and scene.entries[0].name == "Kitchen clock", $scene.entries.len
  doAssert scene.highlightedId() == "scene-2"
  discard scene.draw(newImage(800, 480))
  # Nothing matches: the list says so.
  scene.send("textInput", %*{"text": "zzz"})
  doAssert scene.entries.len == 0
  discard scene.draw(newImage(800, 480))
  scene.send("keyDown", %*{"key": "Backspace", "code": "Backspace"})
  scene.send("keyDown", %*{"key": "Backspace", "code": "Backspace"})
  scene.send("keyDown", %*{"key": "Backspace", "code": "Backspace"})
  doAssert scene.state{"query"}.getStr() == "CLOCK", scene.state{"query"}.getStr()
  sent.setLen(0)
  scene.send("keyDown", %*{"key": "Enter", "code": "Enter"})
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene and sent[0][1]{"sceneId"}.getStr() == "scene-2", $sent
  # Opened again: no search, every scene.
  scene.send("keyDown", %*{"key": "Escape", "code": "Escape"})
  scene.send("open", %*{"sceneId": SceneSwitcherId})
  doAssert scene.entries.len == 20 and not scene.state.hasKey("query")

block the_frames_home_stays:
  # What an ESP32 that takes taps starts on with nothing picked and no scene
  # marked default (docs/scene-switcher.md "The frame's home"): nothing to
  # go back to, so no Close, no timeout, and back stays. A pick ends it.
  listed = entries(5)
  sent.setLen(0)
  let scene = SceneSwitcherScene(switcher.exportedScene.init(SceneSwitcherId.SceneId,
    config(800, 480, "framebuffer"), logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneSwitcherId, "state": {"home": true}})
  scene.send("open", %*{"sceneId": SceneSwitcherId})
  doAssert scene.state{"home"}.getBool() and scene.state{"from"}.getStr() == ""
  scene.state["touchedAt"] = %(epochTime() - IdleSecondsSlow - 1)
  discard scene.draw(newImage(800, 480))
  doAssert sent.len == 0, "home does not go back by itself: " & $sent
  doAssert scene.refreshInterval > IdleSecondsSlow, $scene.refreshInterval
  let grid = switcherGrid(800, 480, thumbnails = false)
  for cx in countdown(800 - grid.pad - 2, 600, 4):
    scene.send("tap", %*{"x": cx, "y": grid.headerH div 2, "pointerId": 1, "pointerType": "touch"})
  for (event, _) in sent:
    doAssert event != evSceneSwitcher, "no Close at home: " & $sent
  sent.setLen(0)
  scene.send("button", %*{"label": "LEFT", "role": "back", "action": "press"})
  scene.send("keyDown", %*{"key": "Escape", "code": "Escape"})
  for (event, _) in sent:
    doAssert event != evSceneSwitcher, "back stays home: " & $sent
  sent.setLen(0)
  scene.send("button", %*{"label": "REFRESH", "role": "refresh", "action": "press"})
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene, $sent
  doAssert not scene.state.hasKey("home"), "a pick ends home"
  # Opened from a scene, it is the usual switcher, whatever it was before.
  scene.state["home"] = %true
  scene.send("setCurrentScene", %*{"sceneId": SceneSwitcherId, "state": {"from": "scene-2"}})
  scene.send("open", %*{"sceneId": SceneSwitcherId})
  doAssert not scene.state.hasKey("home")

block the_frames_home_on_a_portrait_e_paper:
  # A reTerminal Sticky fresh from the flasher, as it starts: its set's
  # categories as headings, System first, and no Close.
  listed = @[
    SwitcherEntry(id: "clock", name: "Clock", category: "Clocks & time"),
    SwitcherEntry(id: "scene-store", name: "Scene store", category: "System"),
    SwitcherEntry(id: "flip-clock", name: "Flip clock", category: "Clocks & time"),
    SwitcherEntry(id: "asset-browser", name: "Files", category: "System"),
    SwitcherEntry(id: "pixel-toys", name: "Pixel toys", category: "Fun & animations"),
    SwitcherEntry(id: "terminal-app", name: "Terminal", category: "System"),
    SwitcherEntry(id: "weather", name: "Weather", category: "Weather"),
    SwitcherEntry(id: "calculator", name: "Calculator", category: "System")]
  sent.setLen(0)
  let scene = SceneSwitcherScene(switcher.exportedScene.init(SceneSwitcherId.SceneId,
    config(800, 480, "waveshare.EPD_7in5_V2", rotate = 90), logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneSwitcherId, "state": {"home": true}})
  scene.send("open", %*{"sceneId": SceneSwitcherId})
  doAssert scene.entries[0].category == "System", scene.entries[0].name
  preview("switcher-home-480x800-eink-bw", oneBit(scene.draw(newImage(480, 800))))
  doAssert sent.len == 0, $sent

localEventSink = nil
echo "scene switcher: ok"

block a_wide_room_puts_each_name_beside_its_icon:
  # Wider than 5:4 the height runs out long before the width (the Sticky held
  # sideways showed 9 of 43 scenes, 19 upright; the UX bench, 2026-11-27):
  # each name beside its icon, a row half as tall, the tiles widened to fill
  # the row. Every category keeps its heading over a row of its own.
  let wide = switcherGrid(800, 480, thumbnails = false)
  let tall = switcherGrid(480, 800, thumbnails = false)
  doAssert wide.beside and not tall.beside, $wide
  doAssert wide.tileH * 2 <= tall.tileH + 4, "half as tall: " & $wide & " " & $tall
  doAssert wide.cols == 5 and wide.rows >= 8, $wide
  doAssert wide.x0 + wide.cols * (wide.tileW + wide.gap) - wide.gap in 800 - wide.pad - wide.cols .. 800 - wide.pad,
    "the row filled: " & $wide
  doAssert not switcherGrid(720, 720, thumbnails = false).beside
  doAssert not switcherGrid(466, 466, thumbnails = false, round = true).beside
  # The 5.79" strip, a desktop's landscape window: the same.
  doAssert switcherGrid(792, 272, thumbnails = false).beside
  doAssert switcherGrid(640, 400, thumbnails = false, unit = 400).beside

block a_name_is_never_broken_inside_a_word:
  # A word wider than its cell is set smaller, down to 9 px, rather than
  # broken ("Countdow/n", "Sketchboo/k" on a small icon view).
  listed = @[SwitcherEntry(id: "countdown", name: "Countdown"), SwitcherEntry(id: "sketchbook", name: "Sketchbook")]
  for (w, h) in [(272, 792), (240, 296), (792, 272)]:
    let s = newSwitcher(config(w, h, "waveshare.EPD_5in79_BW"), opener = "countdown")
    preview("switcher-" & $w & "x" & $h & "-names", s.draw(newImage(w, h)))
    let grid = switcherGrid(w, h, thumbnails = false)
    let room = if grid.beside: grid.tileW - (grid.icon + 2 * grid.inner) - 3 * grid.inner else: grid.tileW
    proc labelOf(n: SvgNode, name: string): SvgNode =
      if n.tag == "span" and n.children.len == 1 and n.children[0].text == name: return n
      for c in n.children:
        result = labelOf(c, name)
        if not result.isNil: return
    for name in ["Countdown", "Sketchbook"]:
      let label = labelOf(s.tree(w, h, true), name)
      doAssert not label.isNil, name
      let classes = label.attrs[0][1]
      var size = grid.text
      var pad = 0
      for part in classes.split(' '):
        if part.startsWith("text-[") and part.endsWith("px]"): size = parseInt(part[6 ..< ^3])
        if part.startsWith("px-[") and part.endsWith("px]"): pad = parseInt(part[4 ..< ^3])
      let h2 = measureText([name, "x"], "leading-tight font-bold text-[" & $size & "px]", float32(room - 2 * pad))
      doAssert h2[0] <= h2[1] * 1.5, name & " wraps at " & $size & " px in " & $w & "x" & $h & ": " & classes
