## The Files sample (repo/scenes/samples/Files) over a folder of pictures: the
## folder's own entries a page at a time, as thumbnails decoded at their tile's
## size or as a list, a picture on the whole screen, the spot it comes back to,
## a folder made on the keyboard, and a desktop's look. FRAMEOS_ASSET_SHOTS=<dir>
## writes each picture there.

import std/[json, os, strutils, times, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../ui/theme

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let assets = getTempDir() / "frameos-files-scene-" & $epochTime().int

proc picture(path, color: string, width = 1200, height = 800) =
  createDir(path.parentDir)
  let image = newImage(width, height)
  image.fill(parseHtmlColor(color).rgbx)
  image.writeFile(path)

picture(assets / "photos" / "beach.png", "#0ea5e9")
picture(assets / "photos" / "forest.png", "#16a34a", 800, 1200)
picture(assets / "photos" / "sunset.png", "#f97316")
picture(assets / "photos" / "2024" / "snow.png", "#e2e8f0")
picture(assets / "logo.png", "#a855f7", 400, 400)
createDir(assets / "fonts")
writeFile(assets / "fonts" / "Ubuntu.ttf", "not really a font")
writeFile(assets / "notes.txt", "hello")
writeFile(assets / ".hidden.png", "never listed")

var given: JsonNode # the theme a desktop around the scene would give

proc givenTheme(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    result = given

suite "the Files scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "assets", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_ASSET_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc tap(scene: FrameScene, x, y: int) =
    scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  proc swipe(scene: FrameScene, direction: string) =
    scene.send("swipe", %*{"x": 400, "y": 240, "direction": direction, "pointerId": 0, "pointerType": "touch"})

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "Files" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("asset-browser".SceneId, config, logger, %*{})

  proc spot(scene: FrameScene): JsonNode = scene.state{"spot"}

  test "is the Files scene, under the id the desktops find it by":
    let scene = parseFile(Samples / "Files" / "scenes.json")[0]
    check scene["id"].getStr() == "asset-browser"
    check scene["name"].getStr() == "Files"
    check parseFile(Samples / "Files" / "template.json")["name"].getStr() == "Files"

  test "lists the folder's own entries, folders first, nothing hidden":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let image = draw(scene, config, "top")
    check image.width == 800
    check problems.len == 0
    if problems.len > 0: echo problems
    # The first tile is the folder "fonts", then "photos": open "photos".
    var opened = false
    for x in countup(20, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"dir"}.getStr() == "photos":
        opened = true
        break
      if scene.spot{"dir"}.getStr() == "fonts":
        scene.tap(36, 30) # up
        discard draw(scene, config, "back-up")
    check opened
    for i in 0 ..< 6:
      discard draw(scene, config, "photos")
    check scene.spot{"dir"}.getStr() == "photos"

  test "opens a picture on the whole screen, swipes to the next, and comes back where it was":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1}
    discard draw(scene, config, "photos-again")
    discard draw(scene, config, "photos-thumbs")
    # The folder "2024", then beach, forest and sunset: past the folder's tile.
    var opened = false
    for x in countup(200, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"open"}.getStr().len > 0:
        opened = true
        break
    check opened
    let first = scene.spot{"open"}.getStr()
    check first.startsWith("photos/") and first.endsWith(".png")
    discard draw(scene, config, "viewer")
    scene.swipe("left")
    discard draw(scene, config, "viewer-next")
    check scene.spot{"open"}.getStr() != first
    let open = scene.spot{"open"}.getStr()

    let kept = scene.spot
    scene = load(config)
    scene.state["spot"] = kept
    discard draw(scene, config, "reopened")
    check scene.spot{"open"}.getStr() == open
    scene.swipe("down")
    discard draw(scene, config, "closed")
    check scene.spot{"open"}.getStr() == ""
    check scene.spot{"dir"}.getStr() == "photos"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "the list view is a choice it keeps, and opens what a row names":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    discard draw(scene, config, "grid")
    check scene.spot{"view"}.getStr() == "grid"
    # The two view buttons sit left of New folder in the header.
    var switched = false
    for x in countdown(640, 420, 10):
      scene.tap(x, 30)
      if scene.spot{"view"}.getStr() == "list":
        switched = true
        break
    check switched
    discard draw(scene, config, "list")
    # Rows: "fonts", then "photos", each 48 px under the 60 px header.
    scene.tap(200, 60 + 48 + 24)
    check scene.spot{"dir"}.getStr() == "photos"
    discard draw(scene, config, "list-photos")
    let kept = scene.spot
    scene = load(config)
    scene.state["spot"] = kept
    discard draw(scene, config, "list-reopened")
    check scene.spot{"view"}.getStr() == "list"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "New folder makes a folder where you are, from a name typed on the keyboard":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1}
    discard draw(scene, config, "before-new")
    scene.tap(760, 30) # New folder, the header's last button
    discard draw(scene, config, "naming")
    # A dot name is refused, in words, and nothing is made.
    scene.tap(100, 90) # the name's field, under the header
    scene.send("textInput", %*{"text": ".cache"})
    discard draw(scene, config, "dot-name")
    scene.send("keyDown", %*{"key": "Enter"})
    discard draw(scene, config, "dot-refused")
    check not dirExists(assets / "photos" / ".cache")
    # A name it takes.
    scene.tap(100, 90)
    for i in 0 ..< 6: scene.send("keyDown", %*{"key": "Backspace"})
    scene.send("textInput", %*{"text": "Trips"})
    discard draw(scene, config, "typed")
    scene.send("keyDown", %*{"key": "Enter"})
    discard draw(scene, config, "made")
    check dirExists(assets / "photos" / "Trips")
    check scene.spot{"dir"}.getStr() == "photos"
    # It lists, after "2024", and opens.
    discard draw(scene, config, "listed")
    var opened = false
    for x in countup(20, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"dir"}.getStr() == "photos/Trips":
        opened = true
        break
      if scene.spot{"dir"}.getStr() != "photos":
        scene.tap(36, 30) # up
        discard draw(scene, config, "back-up")
    check opened
    check problems.len == 0
    if problems.len > 0: echo problems
    removeDir(assets / "photos" / "Trips")

  test "on a desktop it takes the desktop's look, else its own":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.state["spot"] = %*{"dir": "", "page": 1, "view": "grid"}
    var image = draw(scene, config, "own-look")
    check image[400, 470] == rgbx(0x0b, 0x0e, 0x14, 255) # its own page
    # What interpreter.layoutTheme hands over during a desktop's pass.
    let before = themeSource
    themeSource = givenTheme
    given = %*{"page": "bg-[#c0c0c0] text-black", "button": "bg-[#dfdfdf]", "selected": "bg-[#000080]",
      "accent": "bg-[#000080]"}
    scene = load(config)
    scene.state["spot"] = %*{"dir": "", "page": 1, "view": "grid"}
    image = draw(scene, config, "desktop-look")
    themeSource = before
    check image[400, 470] == rgbx(0xc0, 0xc0, 0xc0, 255) # the desktop's page
    # The view button lit is the theme's selected, somewhere in the header.
    var lit = false
    for x in countup(400, 790, 2):
      if image[x, 30] == rgbx(0, 0, 0x80, 255):
        lit = true
    check lit
    check problems.len == 0
    if problems.len > 0: echo problems

  test "inside a desktop layout it wears that desktop's theme":
    problems = @[]
    let config = frame(800, 480)
    proc count(image: Image, color: ColorRGBX): int =
      for y in 0 ..< image.height:
        for x in 0 ..< image.width:
          if image[x, y] == color: inc result
    const Own = rgbx(0x0b, 0x0e, 0x14, 255) # its own page
    for (folder, id, page, view) in [
        ("Windows 98 layout", "layout-windows-98", rgbx(0xc0, 0xc0, 0xc0, 255), "grid"),
        ("macOS layout", "layout-macos", rgbx(0xec, 0xec, 0xec, 255), "list")]:
      var files = parseFile(Samples / "Files" / "scenes.json")[0]
      files["layout"] = %*{"sceneId": id}
      setUploadedInterpretedScenes(parseInterpretedScenes($(%*[files,
        parseFile(Samples / folder / "scenes.json")[0]])))
      resetInterpretedScenes()
      logger.frameConfig = config
      let scene = init("asset-browser".SceneId, config, logger, %*{})
      scene.state["spot"] = %*{"dir": "", "page": 1, "view": view}
      var image: Image
      for i in 0 ..< 3:
        image = draw(scene, config, "in-" & id)
      checkpoint folder
      check count(image, Own) == 0
      check count(image, page) > 800 * 480 div 4
    check problems.len == 0
    if problems.len > 0: echo problems

  test "e-paper draws its thumbnails in the same pass":
    problems = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1}
    discard draw(scene, config, "paper")
    check problems.len == 0

  test "a folder that went away goes back to the top":
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "gone/away", "page": 3}
    discard draw(scene, config, "gone")
    check scene.spot{"dir"}.getStr() == ""
    check scene.spot{"page"}.getInt() == 1

removeDir(assets)
