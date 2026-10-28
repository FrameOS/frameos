import std/[json, options, os, strutils, times]
import pixie
import frameos/channels
import frameos/types
import frameos/events_gen
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

block the_grid_holds_every_scene_while_the_tiles_stay_readable:
  let few = switcherGrid(5, 800, 480, thumbnails = true)
  doAssert few.pages == 1 and few.perPage >= 5, $few
  doAssert few.cols == 3 and few.rows == 2, "a landscape frame: three across, two down " & $few
  let many = switcherGrid(20, 480, 480, thumbnails = false)
  doAssert many.perPage >= 9, $many
  doAssert many.tileW >= 96 and many.tileH >= 72, "names stay readable on a 4\" square " & $many
  doAssert many.pages == (20 + many.perPage - 1) div many.perPage
  let tiny = switcherGrid(3, 128, 64, thumbnails = false)
  doAssert tiny.perPage >= 1 and tiny.tileW > 0 and tiny.tileH > 0, "an OLED still gets a tile " & $tiny
  for (count, w, h) in [(1, 800, 480), (12, 720, 720), (20, 1920, 1080), (7, 480, 800)]:
    let grid = switcherGrid(count, w, h, thumbnails = true)
    doAssert grid.x0 + grid.cols * grid.tileW + (grid.cols - 1) * grid.gap <= w - grid.pad + 1, $grid
    doAssert grid.y0 + grid.rows * grid.tileH + (grid.rows - 1) * grid.gap <= h - grid.pad + 1, $grid

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
  # arrows walk the grid's rows.
  scene.send("button", %*{"label": "UP", "role": "up", "action": "press"})
  doAssert scene.highlightedId == "scene-5"
  let cols = switcherGrid(6, 800, 480, thumbnails = false).cols
  scene.send("keyDown", %*{"code": "ArrowDown", "key": "ArrowDown"})
  doAssert scene.highlightedId == "scene-" & $(((4 + cols) mod 6) + 1), scene.highlightedId
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
  let grid = switcherGrid(5, 800, 480, thumbnails = true)
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
  let grid = switcherGrid(6, 800, 480, thumbnails = false)
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

block more_scenes_than_fit_page_with_a_swipe:
  listed = entries(20)
  sent.setLen(0)
  let frameConfig = config(480, 480, "embedded")
  let scene = newSwitcher(frameConfig, opener = "scene-1")
  let grid = switcherGrid(20, 480, 480, thumbnails = false)
  doAssert grid.pages >= 2, $grid
  preview("switcher-480x480-lcd", scene.draw(newImage565(480, 480)))
  scene.send("swipe", %*{"direction": "left", "x": 100, "y": 200, "startX": 300, "startY": 200,
    "pointerId": 1, "pointerType": "touch"})
  doAssert scene.state{"page"}.getInt() == 1
  doAssert scene.highlightedId == "scene-" & $(grid.perPage + 1), scene.highlightedId
  # The keys cross pages as they walk.
  scene.send("button", %*{"label": "LEFT", "role": "prev", "action": "press"})
  doAssert scene.state{"page"}.getInt() == 0
  preview("switcher-480x480-lcd-page2", (block:
    scene.send("swipe", %*{"direction": "left", "x": 100, "y": 200, "startX": 300, "startY": 200})
    scene.draw(newImage565(480, 480))))
  # The header's arrows turn it too.
  discard scene.draw(newImage565(480, 480))
  let page = scene.state{"page"}.getInt()
  var turned = false
  for cx in countup(240, 480 - grid.pad, 3):
    scene.send("tap", %*{"x": cx, "y": grid.headerH div 2, "pointerId": 1, "pointerType": "touch"})
    if scene.state{"page"}.getInt() != page:
      turned = true
      break
  doAssert turned, "a page arrow in the header"

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

block a_round_panel_keeps_everything_on_the_glass:
  # The HyperPixel 2.1" Round: only the circle inscribed in its 480x480 shows
  # and takes a touch, and its bezel covers the rim. Every region the switcher
  # hit-tests and every pixel it draws stays RoundInset in from the rim, with
  # names or pictures, on every page, with a tile highlighted and one pressed.
  let roundConfig = config(480, 480, "pimoroni.hyperpixel2r")
  doAssert panelIsRound(roundConfig.device)
  for pictures in [false, true]:
    for count in [1, 5, 9, 20]:
      listed = entries(count)
      sceneSwitcherThumbnail = if pictures: fakePicture else: nil
      let scene = newSwitcher(roundConfig, opener = "scene-1")
      let grid = switcherGrid(count, 480, 480, pictures, round = true)
      doAssert grid.round and grid.perPage >= min(count, 4), $grid
      if count == 20:
        doAssert grid.pages >= 2, "20 scenes page on a round panel: " & $grid
      for page in 0 ..< grid.pages:
        let where = $count & " scenes, page " & $(page + 1) & (if pictures: ", pictures" else: "")
        # Highlight the page's last tile, so the ring is drawn where the
        # page's corner would be.
        let last = min((page + 1) * grid.perPage, count) - 1
        scene.state["page"] = %page
        scene.state["highlight"] = %("scene-" & $(last + 1))
        discard scene.draw(newImage(480, 480))
        let regions = uiTarget(SceneSwitcherId, 1).regions
        doAssert regions.len >= min(count - page * grid.perPage, grid.perPage) + 1, where
        for r in regions:
          for (x, y) in [(r.x, r.y), (r.x + r.w - 1, r.y), (r.x, r.y + r.h - 1), (r.x + r.w - 1, r.y + r.h - 1)]:
            doAssert insideRound(480, 480, int(x), int(y), RoundInset),
              where & ": a region reaches off the glass at " & $(x, y) & " " & $r
        # Press the highlighted tile, draw again: the ring, the pressed tile
        # and the arrows and Close all inside.
        let tile = regions[regions.len - 1]
        var pressed = -1
        for i, r in regions:
          if r.handlers[ueClick] == last + 1:
            pressed = i
        doAssert pressed >= 0, where & ": the highlighted tile takes a tap"
        let at = %*{"x": int(regions[pressed].x + regions[pressed].w / 2),
          "y": int(regions[pressed].y + regions[pressed].h / 2), "pointerId": 1, "pointerType": "touch"}
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
        discard tile
  sceneSwitcherThumbnail = nil

block a_round_panel_pages_with_its_arrows:
  # The arrows at 9 and 3 o'clock turn the page; Close at 6 goes back.
  listed = entries(20)
  sent.setLen(0)
  let scene = newSwitcher(config(480, 480, "pimoroni.hyperpixel2r"), opener = "scene-1")
  discard scene.draw(newImage(480, 480))
  let grid = switcherGrid(20, 480, 480, false, round = true)
  scene.send("tap", %*{"x": grid.x0 + grid.side + grid.gap div 2 + 10, "y": 240, "pointerId": 1, "pointerType": "touch"})
  doAssert scene.state{"page"}.getInt() == 1, "the arrow at 3 o'clock"
  discard scene.draw(newImage(480, 480))
  scene.send("tap", %*{"x": grid.x0 - grid.gap div 2 - 10, "y": 240, "pointerId": 1, "pointerType": "touch"})
  doAssert scene.state{"page"}.getInt() == 0, "the arrow at 9 o'clock"
  discard scene.draw(newImage(480, 480))
  sent.setLen(0)
  scene.send("tap", %*{"x": 240, "y": grid.y0 + grid.side + grid.gap div 2 + 10, "pointerId": 1, "pointerType": "touch"})
  doAssert sent.len == 1 and sent[0][0] == evSceneSwitcher, "Close at 6 o'clock: " & $sent
  # The square grid is no smaller than it must be: a third of the scenes'
  # tiles on a page at least, each at least a fifth of the circle across.
  doAssert grid.tileW >= 80 and grid.tileH >= 64, $grid

block it_is_a_built_in_scene:
  doAssert isBuiltInScene(SceneSwitcherId)
  doAssert not isBuiltInScene("system/index")
  doAssert switcher.exportedScene.name == "Scene switcher"
  doAssert paperPanel(config(800, 480, "embedded"), newImage565(8, 8)) == false, "an ESP32 LCD"
  doAssert paperPanel(config(800, 480, "embedded"), newImageGray8(8, 8)), "an ESP32 e-paper"
  doAssert not paperPanel(config(800, 480, "pimoroni.hyperpixel4"))
  doAssert paperPanel(config(800, 480, "pimoroni.inky_impression_7"))

localEventSink = nil
echo "scene switcher: ok"
