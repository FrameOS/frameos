## The Scene store sample (repo/scenes/samples/Scene store, docs/scene-store.md)
## on a stubbed host: what it asks the host for, what it draws, and where it
## comes back to. The covers are data URLs, so nothing reaches the network.
## FRAMEOS_STORE_SHOTS=<dir> writes each picture there.

import std/[base64, json, os, strutils, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../scene_store_hooks
import ../types
import ../js_runtime/app_runtime
import ../utils/http_client

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

proc sample(name: string): JsonNode =
  parseFile(Samples / name / "scenes.json")[0]

proc coverUrl(color: string): string =
  let image = newImage(80, 60)
  image.fill(parseHtmlColor(color).rgbx)
  "data:image/png;base64," & encode(image.encodeImage(PngFormat))

var
  facts = %*{"url": "https://store.test", "version": "2026.11.8", "busy": "", "error": "", "done": "",
    "params": "", "listing": nil, "installed": [], "preview": nil, "removeAny": false}
  asked: seq[(string, string, JsonNode)]

proc listing(names: openArray[string], more = false, categories = true): JsonNode =
  result = %*{"page": 1, "more": more, "scenes": []}
  for i, name in names:
    result["scenes"].add %*{"id": "0000000" & $i & "-0000-4000-8000-00000000000" & $i, "name": name,
      "category": (if i == 0: "realtime" else: "weather"), "version": 3, "by": "FrameOS",
      "about": name & " on the frame, all day long.",
      "image": coverUrl(["#ef4444", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#14b8a6"][i mod 6])}
  if categories:
    result["categories"] = %*[{"slug": "photos", "title": "Photos"}, {"slug": "weather", "title": "Weather"},
      {"slug": "realtime", "title": "Real time"}, {"slug": "layouts", "title": "Layouts"}]

var fetched: seq[string]
jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  fetched.add url
  (200, $listing(["Weather", "Calendar", "Photos"]))

sceneStoreRead = proc(asker: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    $facts
sceneStoreAction = proc(asker, action, args: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      asked.add((asker, action, parseJson(args)))
    except CatchableError:
      discard

suite "the Scene store scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    let event = payload{"event"}.getStr()
    if event.contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "store", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: getTempDir() / "frameos-store-scene-test")

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_STORE_SHOTS")
    if dir.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc tap(scene: FrameScene, x, y: int) =
    let payload = %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"}
    runEvent(scene, ExecutionContext(scene: scene, event: "tap", payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample("Scene store")])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("scene-store".SceneId, config, logger, %*{})

  test "asks the host for the first page of its grid, and draws it when it comes":
    asked = @[]
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "loading")
    check asked.len == 1
    check asked[0][0] == "scene-store" and asked[0][1] == "browse"
    let params = asked[0][2]{"params"}.getStr()
    # A fast panel puts the scenes that move first; the shelves come with the
    # first page; the page is the grid's.
    check "prefer=realtime" in params and "categories=1" in params and "page=1" in params
    check "limit=8" in params
    check validStoreParams(params)

    facts["params"] = %params
    facts["listing"] = listing(["Bouncing logo", "Rain radar", "Forecast", "Moon", "Tides", "Sunrise"], more = true)
    let first = draw(scene, config, "page")
    # Covers come one a pass after the page shows: the first pass draws none.
    discard draw(scene, config, "cover-1")
    for i in 0 ..< 6:
      discard draw(scene, config, "covers")
    # The next page is asked for while nothing else runs.
    check asked[^1][1] == "browse" and "page=2" in asked[^1][2]{"params"}.getStr()
    check problems.len == 0
    if problems.len > 0: echo problems
    check first.width == 800

  test "opens a scene's page, installs it without leaving, and comes back to the same spot":
    asked = @[]
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    discard draw(scene, config, "again")
    # The first card: past the 220 px shelves, under the 76 px header.
    scene.tap(300, 150)
    discard draw(scene, config, "detail")
    check scene.state{"spot"}{"detail"}{"name"}.getStr() == "Bouncing logo"
    # Install sits right of Preview under the description.
    var installed = false
    for x in countup(420, 780, 20):
      for y in countup(40, 470, 10):
        scene.tap(x, y)
        if asked.len > 0 and asked[^1][1] == "install":
          installed = true
          break
      if installed: break
    check installed
    if installed:
      check asked[^1][2]{"show"}.getBool(true) == false
      check asked[^1][2]{"store"}.getStr().len == 36
    facts["busy"] = %"install"
    discard draw(scene, config, "installing")
    facts["busy"] = %""
    facts["done"] = %"install"
    facts["installed"] = %*[{"id": "bounce", "store": scene.state{"spot"}{"detail"}{"id"}.getStr(), "v": 2}]
    discard draw(scene, config, "installed-older")

    # A new scene object, as after a preview or a switch: it opens on the
    # scene's page it was on, drawn from the spot on disk.
    let spot = scene.state{"spot"}
    check not spot.isNil
    scene = load(config)
    scene.state["spot"] = spot
    discard draw(scene, config, "reopened")
    check scene.state{"spot"}{"detail"}{"name"}.getStr() == "Bouncing logo"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "a preview offers Install and Discard":
    asked = @[]
    let config = frame(800, 480)
    let scene = load(config)
    facts["installed"] = %*[]
    let id = "00000001-0000-4000-8000-000000000001"
    facts["preview"] = %*{"store": id, "id": "radar", "name": "Rain radar"}
    scene.state["spot"] = %*{"page": 1, "detail": facts["listing"]["scenes"][1]}
    discard draw(scene, config, "preview")
    var discarded = false
    for x in countup(420, 780, 20):
      for y in countup(40, 470, 10):
        scene.tap(x, y)
        if asked.len > 0 and asked[^1][1] == "discard":
          discarded = true
          break
      if discarded: break
    check discarded
    facts["preview"] = newJNull()

  test "a square screen gets the shelves as a select and a smaller grid":
    asked = @[]
    problems = @[]
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "square")
    check asked.len > 0 and "limit=" in asked[^1][2]{"params"}.getStr()
    check problems.len == 0

  test "e-paper is not offered the scenes that move, and fetches its own page":
    asked = @[]
    problems = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "paper")
    # One refresh an answer: no browse through the host (it would draw twice).
    for (_, action, _) in asked:
      check action != "browse"
    check fetched.len > 0 and "exclude=realtime" in fetched[^1] and "prefer=realtime" notin fetched[^1]
    check problems.len == 0

  test "with no host it browses on its own and installs nothing":
    let read = sceneStoreRead
    sceneStoreRead = nil
    fetched = @[]
    asked = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "no-host")
    check fetched.len == 1 and fetched[0].startsWith("https://cloud.frameos.net/api/store/device/scenes?")
    check asked.len == 0
    sceneStoreRead = read
