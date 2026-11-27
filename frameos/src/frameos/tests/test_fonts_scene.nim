## The Fonts sample (repo/scenes/samples/Fonts): the fonts in the frame's
## fonts folder, a page at a time with each name in its own face, and a
## specimen of the one picked (docs/esp32-fonts.md). Here the folder is the
## collection FrameOS ships (assets/copied/fonts), as a Pi has it after a
## deploy and an ESP32 after "Sync fonts". "Get fonts" lists a catalog and
## downloads a family a range at a time (the network is jsHttpRequestHook).
##
## FRAMEOS_FONTS_SHOT=<file.png> writes the picture, for the sample's image.

import std/[json, os, strutils, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../ui/events
import ../ui/layout
import ../utils/font
import ../utils/http_client
import ../utils/memory
import ../js_runtime/app_runtime

const
  Root = normalizedPath(currentSourcePath().parentDir() / ".." / ".." / ".." / "..")
  Samples = Root / "repo" / "scenes" / "samples"
  Assets = Root / "frameos" / "assets" / "copied"
  Id = "fonts"
  Catalog = "https://fonts.test/catalog.txt"

suite "the Fonts scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error" or
        payload{"event"}.getStr() == "font:fallback":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, assets: string): FrameConfig =
    FrameConfig(name: "fonts", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  proc draw(scene: FrameScene, config: FrameConfig): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig, state = %*{}): FrameScene =
    setSvgFontAssetsPath(config.assetsPath)
    setUploadedInterpretedScenes(parseInterpretedScenes($parseFile(Samples / "Fonts" / "scenes.json")))
    resetInterpretedScenes()
    logger.frameConfig = config
    init(Id.SceneId, config, logger, state)

  proc target(): UiTarget =
    for node in 0 .. 64:
      result = uiTarget(Id, node, create = false)
      if not result.isNil: return

  proc taps(): seq[(float32, float32)] =
    let ui = target()
    for r in ui.regions:
      if r.handlers[ueClick] > 0:
        result.add((r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY))

  proc tap(scene: FrameScene, at: (float32, float32)) =
    scene.send("tap", %*{"x": at[0], "y": at[1], "pointerId": 0, "pointerType": "touch"})

  proc tapsIn(x0, x1, y0: float32): seq[(float32, float32)] =
    for t in taps():
      if t[0] >= x0 and t[0] < x1 and t[1] >= y0:
        result.add t

  test "lists the frame's fonts, each in its face, and a tap picks one for the specimen":
    problems = @[]
    let config = frame(800, 480, Assets)
    let scene = load(config)
    let first = scene.draw(config)
    # Get fonts in the bar, a row a font on the page, and the two page buttons.
    let rows = taps()
    check rows.len >= 9
    check rows[0][1] < 48
    # The third tap is the first font file, by name: pick it.
    scene.tap(rows[2])
    let picked = scene.state{"font"}.getStr()
    check picked.endsWith(".ttf")
    check fileExists(Assets / "fonts" / picked)
    let second = scene.draw(config)
    check first.data != second.data
    # The next page shows other fonts; the specimen stays.
    scene.tap(taps()[^1])
    check scene.state{"page"}.getInt() == 1
    let third = scene.draw(config)
    check third.data != second.data
    check scene.state{"font"}.getStr() == picked
    check problems.len == 0
    if problems.len > 0: echo problems
    let shot = getEnv("FRAMEOS_FONTS_SHOT")
    if shot.len > 0:
      scene.tap(taps()[1])
      discard scene.draw(config)
      scene.tap(taps()[3])
      scene.draw(config).writeFile(shot)

  test "a frame with no fonts shows the built-in face":
    problems = @[]
    let config = frame(480, 800, getTempDir() / "frameos-fonts-scene-none")
    let scene = load(config)
    discard scene.draw(config)
    # Narrow: Get fonts and the list (one row, the built-in face; one page,
    # so no page buttons), the specimen under them.
    check taps().len == 2
    scene.tap(taps()[1])
    check scene.state{"font"}.getStr() == ""
    check scene.state{"page"}.getInt() == 0 # the list stays, the specimen shows under it
    discard scene.draw(config)
    check problems.len == 0

  test "Get fonts: a family from the catalog, downloaded a range at a time, drawn at once":
    problems = @[]
    let assets = getTempDir() / "frameos-fonts-scene-get"
    removeDir(assets)
    createDir(assets / "fonts")
    copyFile(Assets / "fonts" / "Galindo-Regular.ttf", assets / "fonts" / "Galindo-Regular.ttf")
    let regular = readFile(Assets / "fonts" / "Peralta-Regular.ttf")
    let bold = readFile(Assets / "fonts" / "PTSans-Bold.ttf")
    var ranges: seq[string]
    var catalogAsked = 0
    asyncPumped = false # useFetch answers in the render, through httpRequest
    setSimulatedEmbedded(true) # 64 KB a request, as on an ESP32
    jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
      if url == Catalog:
        inc catalogAsked
        return (200, "# a test catalog\nbase https://fonts.test/s/\n" &
          "Test Sans\tSans Serif\tOFL\tRegular a/1.ttf " & $regular.len & "\tBold b/1.ttf " & $bold.len & "\n" &
          "Gone Font\tDisplay\tOFL\tRegular gone.ttf 1000\n" &
          "Galindo\tDisplay\tOFL\tRegular https://elsewhere.test/g.ttf 1000\n")
      let file = if url == "https://fonts.test/s/a/1.ttf": regular
        elif url == "https://fonts.test/s/b/1.ttf": bold
        else: ""
      if file.len == 0:
        return (404, "")
      for (name, value) in headers:
        if name.toLowerAscii() == "range":
          ranges.add value
          let span = value["bytes=".len .. ^1].split('-')
          return (206, file[parseInt(span[0]) .. min(parseInt(span[1]), file.len - 1)])
      (200, file)
    defer:
      jsHttpRequestHook = nil
      asyncPumped = true
      setSimulatedEmbedded(false)
      removeDir(assets)

    let config = frame(800, 480, assets)
    let scene = load(config, %*{"catalog": Catalog})
    discard scene.draw(config)
    scene.tap(taps()[0]) # Get fonts
    check scene.state{"view"}.getStr() == "get"
    discard scene.draw(config)
    check catalogAsked == 1
    # The families on the left (under the bar and the kind and search row),
    # the first of them Test Sans.
    let list = tapsIn(0, 320, 100)
    check list.len == 3 # three families, on one page: no page buttons
    scene.tap(list[0])
    check scene.state{"family"}.getStr() == "Test Sans"
    discard scene.draw(config)
    # Nothing of it here: the card's one button is Get.
    let card = tapsIn(340, 800, 0)
    check card.len == 1
    scene.tap(card[0])
    check scene.state{"getting"}{"files"}.len == 2
    discard scene.draw(config)
    # Both files, in 64 KB ranges, the job over and the specimen in its face.
    check scene.state{"getting"}.kind == JNull
    check ranges.len == 1 + (bold.len + 65535) div 65536
    check ranges[0] == "bytes=0-" & $(regular.len - 1)
    check ranges[1] == "bytes=0-65535"
    check readFile(assets / "fonts" / "TestSans-Regular.ttf") == regular
    check readFile(assets / "fonts" / "TestSans-Bold.ttf") == bold
    check svgFontFileFor("TestSans-Regular.ttf") == "TestSans-Regular.ttf"
    check catalogAsked == 1
    # Its styles can be tapped now: Regular opens the specimen.
    let styles = tapsIn(340, 800, 0)
    check styles.len == 3 # Regular, Bold, Remove
    scene.tap(styles[0])
    check scene.state{"view"}.getStr() == ""
    check scene.state{"font"}.getStr() == "TestSans-Regular.ttf"
    discard scene.draw(config)

    # Remove, after a confirm.
    scene.state["view"] = %"get"
    discard scene.draw(config)
    scene.tap(tapsIn(340, 800, 0)[^1])
    discard scene.draw(config)
    scene.tap(tapsIn(340, 800, 0)[^1])
    check not fileExists(assets / "fonts" / "TestSans-Regular.ttf")
    check not fileExists(assets / "fonts" / "TestSans-Bold.ttf")
    check scene.state{"font"}.getStr() == ""

    # A file the server does not have: tried at three renders, then said.
    discard scene.draw(config)
    scene.tap(tapsIn(0, 320, 100)[1])
    check scene.state{"family"}.getStr() == "Gone Font"
    discard scene.draw(config)
    scene.tap(tapsIn(340, 800, 0)[0])
    for i in 0 ..< 3:
      discard scene.draw(config)
    check scene.state{"getting"}{"error"}.getStr().contains("the server answered 404")
    check not fileExists(assets / "fonts" / "GoneFont-Regular.ttf")
    # A family the frame has is marked so, and Get is not offered.
    scene.tap(tapsIn(0, 320, 100)[2])
    check scene.state{"family"}.getStr() == "Galindo"
    discard scene.draw(config)
    check tapsIn(340, 800, 0).len == 2 # its style and Remove
    check problems.len == 0
    if problems.len > 0: echo problems
