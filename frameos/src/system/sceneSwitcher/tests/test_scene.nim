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
  let few = switcherGrid(800, 480, thumbnails = true)
  doAssert few.cols == 6 and few.rows == 4, "as dense as stays readable, six by four on 800x480: " & $few
  let many = switcherGrid(480, 480, thumbnails = false)
  doAssert many.cols * many.rows >= 9, $many
  doAssert many.tileW >= 96 and many.tileH >= 72, "names stay readable on a 4\" square " & $many
  let tiny = switcherGrid(128, 64, thumbnails = false)
  doAssert tiny.cols >= 1 and tiny.tileW > 0 and tiny.tileH > 0, "an OLED still gets a tile " & $tiny
  for (w, h) in [(800, 480), (720, 720), (1920, 1080), (480, 800)]:
    let grid = switcherGrid(w, h, thumbnails = true)
    doAssert grid.x0 + grid.cols * grid.tileW + (grid.cols - 1) * grid.gap <= w - grid.pad + 1, $grid
    doAssert grid.y0 + grid.rows * grid.tileH + (grid.rows - 1) * grid.gap <= h - grid.pad + 1, $grid
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
  doAssert scene.highlightedId == (if 4 + cols < 6: "scene-" & $(5 + cols) else: "scene-1"), scene.highlightedId
  sent.setLen(0)
  scene.send("keyDown", %*{"code": "Enter", "key": "Enter"})
  doAssert sent.len == 1 and sent[0][0] == evSetCurrentScene

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
  # The highlighted tile is inverted: its middle is ink, a plain tile's paper.
  let grid = switcherGrid(800, 480, thumbnails = false)
  let lit = image[grid.x0 + (grid.tileW + grid.gap) * 2 + grid.tileW div 2, grid.y0 + grid.tileH - 14]
  let plain = image[grid.x0 + grid.tileW div 2, grid.y0 + grid.tileH - 14]
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
  listed = entries(20)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-1")
  let grid = switcherGrid(480, 480, thumbnails = false)
  preview("switcher-480x480-lcd", scene.draw(newImage565(480, 480)))
  let list = listRegion()
  doAssert list.scrollY > 0, "20 scenes are more than fit: " & $list
  doAssert listScroll() == 0
  let below = grid.cols * grid.rows # the first tile of the first row out of sight
  doAssert not shownWhole(below)
  scene.drag(240, 400, 150)
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
  listed = entries(30)
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
  listed = entries(30)
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-1")
  discard scene.draw(newImage(800, 480))
  var scrolled = false
  for i in 1 ..< 30:
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
  doAssert scene.highlighted() == 29 and shownWhole(29), "back to the last, at the bottom"
  # Opened again, the list starts at its top and scrolls to the scene it was
  # opened from.
  let again = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-2")
  doAssert listScroll() == 0
  discard again.draw(newImage(800, 480))
  let deep = newSwitcher(config(800, 480, "waveshare.EPD_7in5_V2"), opener = "scene-28")
  discard deep.draw(newImage(800, 480))
  doAssert listScroll() > 0 and shownWhole(27), $listScroll()
  for (event, _) in sent:
    doAssert event != evSetCurrentScene and event != evSceneSwitcher, event

block forward_and_back_move_a_screenful:
  # What turned a page (the frame's forward and back, a swipe in from an
  # edge, a scene direction, which the dispatcher hands the switcher as
  # them): the highlight a screenful on or back, the list with it, wrapping
  # at the ends, and no scene switch.
  listed = entries(20)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "embedded"), opener = "scene-1")
  discard scene.draw(newImage565(480, 480))
  let grid = switcherGrid(480, 480, thumbnails = false)
  let screen = grid.cols * grid.rows
  scene.send(evForward, %*{})
  doAssert scene.highlighted() == screen, $scene.highlighted()
  discard scene.draw(newImage565(480, 480))
  doAssert listScroll() > 0 and shownWhole(screen)
  scene.send(evBack, %*{})
  doAssert scene.highlighted() == 0 and listScroll() == 0
  scene.send(evBack, %*{})
  doAssert scene.highlighted() == 19, "back from the first: the last"
  scene.send(evForward, %*{})
  doAssert scene.highlighted() == 0, "on from the last: the first"
  # Every screenful, the last tile, then around to the first.
  var turns = 0
  while turns < 30:
    scene.send(evForward, %*{})
    inc turns
    if scene.highlighted() == 0:
      break
  doAssert turns == (19 + screen - 1) div screen + 1, $turns
  for (event, _) in sent:
    doAssert event != evSetCurrentScene and event != evSceneSwitcher, event
  # A keyboard's Page Down and Up are the same.
  scene.send("keyDown", %*{"code": "PageDown", "key": "PageDown"})
  doAssert scene.highlighted() == screen
  scene.send("keyDown", %*{"code": "PageUp", "key": "PageUp"})
  doAssert scene.highlighted() == 0

block e_paper_scrolls_where_the_finger_lifts:
  # The reTerminal E1003 (1872x1404, sixteen greys): no render while the
  # finger moves (each is seconds of refresh), one where it lifts, and a tap
  # after that opens the tile it lands on.
  listed = entries(40)
  sent.setLen(0)
  let scene = newSwitcher(config(1872, 1404, "embedded"), opener = "scene-1")
  discard scene.draw(newImageGray8(1872, 1404))
  doAssert scene.paper and scene.slow
  scene.send("pointerDown", touchAt(900, 1200))
  for i in 1 .. 8:
    scene.send("pointerMove", touchAt(900, 1200 - 100 * i.float))
  doAssert sent.len == 0, "nothing drawn while the finger moves: " & $sent
  scene.send("pointerUp", touchAt(900, 400))
  doAssert sent.len == 1 and sent[0][0] == evRender, "where it lifted: " & $sent
  doAssert listScroll() > 0 and listScroll() == listRegion().scrollY, $listScroll()
  discard scene.draw(newImageGray8(1872, 1404))
  let grid = switcherGrid(1872, 1404, thumbnails = false)
  let below = grid.cols * grid.rows
  doAssert shownWhole(below)
  let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(below)]
  sent.setLen(0)
  scene.send("tap", touchAt(r.x + r.w / 2, r.y + r.h / 2))
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
  listed = entries(40)
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

proc headings(tree: SvgNode): seq[string] =
  ## The headings in the list (the root's first child), in order: a heading
  ## is a box with one span of text, a tile has more.
  for child in tree.children[0].children:
    if child.children.len == 1 and child.children[0].tag == "span":
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
  listed = categorized()
  sent.setLen(0)
  let scene = newSwitcher(config(800, 480, "framebuffer"), opener = "scene-6")
  let image = scene.draw(newImage(800, 480))
  preview("switcher-800x480-lcd-categories", image)
  doAssert scene.tree(800, 480, false).headings ==
    @["Clocks", "Garden", "Photos", "photos", "\xC3\xA9a", "\xC3\x89clairs", "Other"]
  # A category starts a row of its own, under its heading; the tiles are
  # numbered in the order shown, and the keys walk that order.
  let grid = switcherGrid(800, 480, thumbnails = false)
  let spots = scene.spots(grid)
  doAssert spots[2].col == 0 and spots[2].top > spots[1].top + grid.tileH, $spots
  doAssert spots[0].top == grid.y0 - grid.listY + grid.headingH
  doAssert scene.highlighted() == 2, "scene-6 is third, under Garden"
  scene.send("button", %*{"label": "RIGHT", "role": "next", "action": "press"})
  doAssert scene.highlightedId == "scene-7"
  scene.send("keyDown", %*{"code": "ArrowUp", "key": "ArrowUp"})
  doAssert scene.highlightedId == "scene-6", "the row above, in its column: " & scene.highlightedId
  scene.send("keyDown", %*{"code": "ArrowUp", "key": "ArrowUp"})
  doAssert scene.highlightedId == "scene-2"
  # The first tile is the first category's first scene.
  discard scene.draw(newImage(800, 480))
  let r = uiTarget(SceneSwitcherId, 1).regions[tileRegion(0)]
  scene.send("tap", touchAt(r.x + r.w / 2, r.y + r.h / 2))
  doAssert sent.len == 1 and sent[0][1]["sceneId"].getStr() == "scene-2", $sent
  # No scene with a category: no headings.
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
        doAssert (grid.listX, grid.listY, grid.listW, grid.listH) == (grid.x0, grid.y0, grid.side, grid.side), $grid
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
      for (x, y) in [(r.x, r.y), (r.x + r.w - 1, r.y), (r.x, r.y + r.h - 1), (r.x + r.w - 1, r.y + r.h - 1)]:
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
  # Full screen a built-in scene's sizes are a share of the panel; in a desktop's
  # window (a layout keeping `openScenes`) those of a desktop's apps, twice that
  # on a 4K screen at scale 1.
  let canvas = newImage(800, 480)
  let saved = onDesktop
  onDesktop = nil
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 902
  onDesktop = proc(): bool {.nimcall, gcsafe.} = true
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 400
  doAssert panelUnit(config(800, 480, "web_only"), canvas) == 400
  doAssert panelUnit(config(3840, 2160, "web_only"), canvas) == 800
  onDesktop = proc(): bool {.nimcall, gcsafe.} = false
  doAssert panelUnit(config(1316, 902, "web_only"), canvas) == 902
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

block a_scene_icon_on_its_tile:
  # A scene's icon (docs/scene-icons.md) goes above its name on a name card,
  # and where a Pi has no picture of the scene yet, in the picture's place.
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
  # A Pi's LCD: the icon where the picture would be, in the muted text color.
  sceneSwitcherThumbnail = noPicture
  let lcd = config(800, 480, "framebuffer")
  let pictures = switcherGrid(800, 480, thumbnails = true)
  listed = entries(6)
  let numbered = newSwitcher(lcd, opener = "scene-2").draw(newImage(800, 480))
  listed[0].icon = Square
  listed[4].icon = House
  let marked = newSwitcher(lcd, opener = "scene-2").draw(newImage(800, 480))
  preview("switcher-800x480-lcd-icons", marked)
  doAssert marked.inkIn(pictures, 0, light = true) > numbered.inkIn(pictures, 0, light = true) + 400
  doAssert marked.inkIn(pictures, 2, light = true) == numbered.inkIn(pictures, 2, light = true)
  sceneSwitcherThumbnail = nil

localEventSink = nil
echo "scene switcher: ok"
