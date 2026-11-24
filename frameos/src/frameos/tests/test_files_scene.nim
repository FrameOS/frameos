## The Files sample (repo/scenes/samples/Files) over a folder of pictures: the
## folder's own entries a page at a time, as thumbnails decoded at their tile's
## size or as a list, a picture on the whole screen, the spot it comes back to,
## a folder made on the keyboard, and a desktop's look. FRAMEOS_ASSET_SHOTS=<dir>
## writes each picture there.

import std/[json, os, strutils, times, unittest]
import pixie
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types
import ../ui/theme
import ../file_transfer_hooks
import ../file_transfer_preview
import ../channels

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
# The header's Reload button on an 800x480 frame, left of the grid and list toggles.
const ReloadX = 534

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
        discard draw(scene, config, "fonts")
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

  test "a frame with a TF card and internal storage shows both as places, each browsed on its own":
    problems = @[]
    let internal = getTempDir() / "frameos-files-internal-" & $epochTime().int
    picture(internal / "Saved" / "kept.png", "#dc2626", 600, 400)
    storageInternalPath = internal
    storageCardMounted = true
    defer:
      storageInternalPath = ""
      storageCardMounted = false
      removeDir(internal)
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "places")
    check scene.spot{"storage"}.getStr() == ""
    # Two places side by side: the TF card on the left, the internal storage on the right.
    scene.tap(560, 240)
    discard draw(scene, config, "internal")
    check scene.spot{"storage"}.getStr() == "internal"
    check scene.spot{"dir"}.getStr() == ""
    # Its one folder, then its picture.
    var opened = false
    for x in countup(20, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"dir"}.getStr() == "Saved":
        opened = true
        break
    check opened
    discard draw(scene, config, "internal-saved")
    for i in 0 ..< 3:
      discard draw(scene, config, "internal-thumbs")
    var shown = false
    for x in countup(20, 780, 30):
      scene.tap(x, 140)
      if scene.spot{"open"}.getStr() == "Saved/kept.png":
        shown = true
        break
    check shown
    let viewer = draw(scene, config, "internal-viewer")
    let red = viewer[400, 240]
    check red.r > 180 and red.g < 80
    # Down closes it; up from the storage's top is the places again.
    scene.swipe("down")
    discard draw(scene, config, "internal-closed")
    scene.tap(36, 30) # up
    discard draw(scene, config, "internal-up")
    check scene.spot{"dir"}.getStr() == ""
    scene.tap(36, 30) # up
    discard draw(scene, config, "places-again")
    check scene.spot{"storage"}.getStr() == ""
    # The card: the assets folder, as before.
    scene.tap(240, 240)
    discard draw(scene, config, "card")
    check scene.spot{"storage"}.getStr() == "assets"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "a storage that cannot be read says so, keeps where you were, and is listed again":
    problems = @[]
    let internal = getTempDir() / "frameos-files-unready-" & $epochTime().int
    removeDir(internal)
    storageInternalPath = internal
    storageCardMounted = true
    defer:
      storageInternalPath = ""
      storageCardMounted = false
      removeDir(internal)
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"storage": "internal", "dir": "Saved", "page": 1, "open": "Saved/kept.png"}
    var image = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: image,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    image = render(scene, context)
    let dir = getEnv("FRAMEOS_ASSET_SHOTS")
    if dir.len > 0:
      image.writeFile(dir / "unreadable.png")
    # Not an empty folder: the spot stays, and it is tried again in a moment.
    check scene.spot{"storage"}.getStr() == "internal"
    check scene.spot{"dir"}.getStr() == "Saved"
    check scene.spot{"open"}.getStr() == "Saved/kept.png"
    check context.nextSleep > 0 and context.nextSleep <= 5
    # Six tries in all, counted in the spot (kept on disk), so a frame that
    # sleeps between them stops too.
    for i in 0 ..< 6:
      let again = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: newImage(800, 480),
        hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
      discard render(scene, again)
      rhythmClockOverride += 1.0
      check (again.nextSleep > 0 and again.nextSleep <= 5) == (i < 5)
    check scene.spot{"tries"}.getInt() == 6
    # The storage comes: the next render shows the picture it was on.
    picture(internal / "Saved" / "kept.png", "#dc2626", 600, 400)
    let viewer = draw(scene, config, "readable-again")
    let red = viewer[400, 240]
    check red.r > 180 and red.g < 80
    check scene.spot{"tries"}.isNil
    check problems.len == 0
    if problems.len > 0: echo problems

  test "Reload lists the folder showing again":
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "photos/2024", "page": 1, "view": "list"}
    discard draw(scene, config, "reload-before")
    # The one row: snow.png.
    scene.tap(200, 60 + 24)
    check scene.spot{"open"}.getStr() == "photos/2024/snow.png"
    scene.swipe("down")
    discard draw(scene, config, "reload-closed")
    # A picture that came since: the listing kept is the one before.
    picture(assets / "photos" / "2024" / "rain.png", "#64748b")
    defer: removeFile(assets / "photos" / "2024" / "rain.png")
    discard draw(scene, config, "reload-kept")
    scene.tap(200, 60 + 24)
    check scene.spot{"open"}.getStr() == "photos/2024/snow.png"
    scene.swipe("down")
    discard draw(scene, config, "reload-closed-again")
    scene.tap(ReloadX, 30)
    discard draw(scene, config, "reload-after")
    scene.tap(200, 60 + 24)
    check scene.spot{"open"}.getStr() == "photos/2024/rain.png"

  test "a file that is no picture opens in the scene that opens its kind, or says none does":
    problems = @[]
    let papers = getTempDir() / "frameos-files-open-" & $epochTime().int
    createDir(papers)
    writeFile(papers / "manual.pdf", "%PDF-1.4")
    writeFile(papers / "notes.txt", "hello")
    writeFile(papers / "song.mp3", "ID3")
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        result = %*[{"id": "asset-browser", "name": "Files"},
          {"id": "pdf-viewer", "name": "PDF viewer", "opens": "pdf"},
          {"id": "code-editor", "name": "Code editor", "opens": "txt md, .JSON"}]
    defer:
      windowSceneListing = nil
      removeDir(papers)
    proc sent(): seq[JsonNode] =
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        if message[1] == "setCurrentScene": result.add message[2]
    discard sent()
    let config = frame(800, 480)
    config.assetsPath = papers
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "", "page": 1, "view": "list"}
    let before = draw(scene, config, "open-with")
    # The rows: manual.pdf, notes.txt, song.mp3.
    proc row(i: int): int = 60 + 48 * i + 24
    scene.tap(200, row(0))
    var asked = sent()
    check asked.len == 1
    if asked.len == 1:
      check asked[0]{"sceneId"}.getStr() == "pdf-viewer"
      check asked[0]{"state"}{"file"}.getStr() == "assets:manual.pdf"
    scene.tap(200, row(1))
    asked = sent()
    check asked.len == 1 and asked[0]{"sceneId"}.getStr() == "code-editor"
    # Nothing opens an .mp3: a card says so, and a tap anywhere puts it away.
    scene.tap(200, row(2))
    check sent().len == 0
    let card = draw(scene, config, "cannot-open")
    check card[400, 240] != before[400, 240]
    scene.tap(200, row(1))
    check sent().len == 0
    let gone = draw(scene, config, "cannot-open-gone")
    check gone[400, 240] == before[400, 240]
    scene.tap(200, row(1))
    check sent().len == 1
    check problems.len == 0
    if problems.len > 0: echo problems

  test "on a frame there is no Upload or Download: the host has none":
    check fileTransfer.isNil
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "", "page": 1, "view": "list"}
    discard draw(scene, config, "no-transfer")
    # notes.txt, the list's last row at the top (fonts, photos, logo.png, notes.txt):
    # a file it cannot show, and nothing to save it with.
    scene.tap(200, 60 + 48 * 3 + 24)
    discard draw(scene, config, "no-transfer-tapped")
    check scene.spot{"open"}.getStr() == ""

  test "in the browser preview, Upload asks the page for files and lists them once they are in":
    problems = @[]
    var sent {.global.}: seq[JsonNode]
    sent = @[]
    proc page(request: string) {.nimcall, gcsafe, raises: [].} =
      {.cast(gcsafe).}:
        try: sent.add(parseJson(request))
        except Exception: discard
    resetFileTransferPreviewForTests()
    enableFileTransferPreview(page)
    defer: resetFileTransferPreviewForTests()
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"dir": "photos", "page": 1, "view": "list"}
    discard draw(scene, config, "transfer")
    # Upload, the header's last button now.
    scene.tap(750, 30)
    check sent.len == 1
    check sent[^1]{"op"}.getStr() == "upload"
    check sent[^1]{"path"}.getStr() == assets / "photos"
    discard draw(scene, config, "upload-asked")
    # The page put a file in: the scene that asked is drawn again, and lists it.
    writeFile(assets / "photos" / "uploaded.txt", "from the computer")
    defer: removeFile(assets / "photos" / "uploaded.txt")
    check fileTransferDone(sent[^1]{"id"}.getInt(), true, 1, "") == "asset-browser"
    discard draw(scene, config, "uploaded")
    # Rows: 2024, then beach, forest, sunset, then uploaded.txt.
    scene.tap(200, 60 + 48 * 4 + 24)
    check sent.len == 2
    check sent[^1]{"op"}.getStr() == "download"
    check sent[^1]{"path"}.getStr() == assets / "photos" / "uploaded.txt"
    discard fileTransferDone(sent[^1]{"id"}.getInt(), false, 0, "cancelled")
    # The picture open has Download in its bar, left of the slideshow's button.
    scene.state["spot"] = %*{"dir": "photos", "page": 1, "view": "list", "open": "photos/beach.png"}
    discard draw(scene, config, "viewer-transfer")
    var asked = false
    for x in countdown(740, 560, 10):
      scene.tap(x, 28)
      if sent.len == 3:
        asked = true
        break
    check asked
    check sent[^1]{"op"}.getStr() == "download"
    check sent[^1]{"path"}.getStr() == assets / "photos" / "beach.png"
    check scene.spot{"open"}.getStr() == "photos/beach.png"
    check problems.len == 0
    if problems.len > 0: echo problems

removeDir(assets)
