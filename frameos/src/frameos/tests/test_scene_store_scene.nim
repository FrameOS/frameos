## The Scene store sample (repo/scenes/samples/Scene store, docs/scene-store.md)
## on a stubbed host: what it fetches, what it asks the host for, what it
## draws, and where it comes back to. The store and the covers' CDN are the
## request workers' hook (jsIoHook); the covers are data URLs unless a test
## asks for network ones. FRAMEOS_STORE_SHOTS=<dir> writes each picture there.

import std/[base64, json, locks, monotimes, os, strutils, times, unittest]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../scene_store_hooks
import ../layout_choice
import ../types
import ../js_runtime/app_runtime
import ../js_runtime/js_io
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
    "installed": [], "preview": nil, "removeAny": false}
  asked: seq[(string, string, JsonNode)]

var networkCovers = false
  ## Covers as https URLs the request workers answer (jsIoHook), after a
  ## while, as a CDN does; data URLs otherwise.

let coverPng = block:
  let image = newImage(80, 60)
  image.fill(parseHtmlColor("#ef4444").rgbx)
  image.encodeImage(PngFormat)

var
  requestsLock: Lock
  requests: seq[string] ## what the workers were asked, guarded by requestsLock
  page = "" ## the store's answer to a listing (set before the workers are asked)
initLock(requestsLock)

jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
  {.cast(gcsafe).}:
    withLock requestsLock:
      requests.add request.url
    if "/api/store/device/scenes?" in request.url:
      return JsIoResult(code: 200, body: page)
    sleep(150)
    JsIoResult(code: 200, body: coverPng)

proc requested(part: string): seq[string] =
  withLock requestsLock:
    for url in requests:
      if part in url: result.add url

proc listing(names: openArray[string], more = false, categories = true): JsonNode =
  result = %*{"page": 1, "more": more, "scenes": []}
  for i, name in names:
    result["scenes"].add %*{"id": "0000000" & $i & "-0000-4000-8000-00000000000" & $i, "name": name,
      "category": (if i == 0: "fun" else: "weather"), "version": 3, "by": "FrameOS",
      "about": name & " on the frame, all day long.",
      "image": (if networkCovers: "https://cdn.test/cover" & $i & ".png"
                else: coverUrl(["#ef4444", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#14b8a6"][i mod 6]))}
  if categories:
    result["categories"] = %*[{"slug": "photos", "title": "Photos"}, {"slug": "weather", "title": "Weather"},
      {"slug": "fun", "title": "Fun & animations"}, {"slug": "layouts", "title": "Full screen layouts", "layout": true}]

let sixScenes = ["Bouncing logo", "Rain radar", "Forecast", "Moon", "Tides", "Sunrise"]
page = $listing(sixScenes, more = true)

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

  proc settle(ms = 3000): int =
    ## The runner's loop: answers pumped until nothing is pending; the
    ## renders the scene asked for.
    let started = getMonoTime()
    while (getMonoTime() - started).inMilliseconds < ms:
      discard pumpJsAsync()
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        if message[1] == "render": inc result
      if jsAsyncPending() == 0: break
      sleep(5)

  proc opened(config: FrameConfig, name: string): FrameScene =
    ## The store with its first page in.
    result = load(config)
    discard draw(result, config, name & "-loading")
    discard settle()
    discard draw(result, config, name)

  test "fetches the first page of its grid off the render, and draws it when it comes":
    asked = @[]
    problems = @[]
    withLock requestsLock: requests = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let started = getMonoTime()
    discard draw(scene, config, "loading")
    check (getMonoTime() - started).inMilliseconds < 150
    check asked.len == 0 # nothing of the host
    check settle() >= 1
    let pages = requested("/api/store/device/scenes?")
    check pages.len == 1
    # A fast panel puts the scenes made for it first, Featured is scenes (the
    # layouts have shelves of their own); the shelves come with the first page;
    # the page is the grid's; the store is the host's.
    check pages[0].startsWith("https://store.test/") and "version=2026.11.8" in pages[0]
    check "prefer=fast" in pages[0] and "categories=1" in pages[0] and "page=1" in pages[0]
    check "exclude=desktops,layouts" in pages[0] and "without=" notin pages[0]
    check "limit=8" in pages[0]
    # Data URL covers are there at once; covers from the network are the test
    # below.
    let first = draw(scene, config, "page")
    # The next page is asked for while nothing else runs.
    discard settle()
    check requested("page=2").len == 1
    check problems.len == 0
    if problems.len > 0: echo problems
    check first.width == 800

  test "covers from the network come off the render, all at once, and a tap does not wait for them":
    problems = @[]
    networkCovers = true
    page = $listing(sixScenes, more = false)
    defer:
      networkCovers = false
      page = $listing(sixScenes, more = true)
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "net-loading")
    discard settle()
    withLock requestsLock: requests = @[]
    var started = getMonoTime()
    discard draw(scene, config, "net-placeholders")
    let placeholderMs = (getMonoTime() - started).inMilliseconds
    # Six 150 ms downloads: one after the other in the render, this was a
    # second, and a pass per cover.
    check placeholderMs < 150
    check jsIoInFlight() == 6
    # A tap while they download is answered at once: the first card.
    started = getMonoTime()
    scene.tap(300, 150)
    discard draw(scene, config, "net-detail")
    check (getMonoTime() - started).inMilliseconds < 150
    check scene.state{"spot"}{"detail"}{"name"}.getStr() == "Bouncing logo"
    # Back to the grid; the covers land together and the scene asks to be
    # drawn again.
    var spot = scene.state{"spot"}
    spot["detail"] = newJNull()
    scene.state["spot"] = spot
    started = getMonoTime()
    check settle() >= 1
    check jsAsyncPending() == 0
    check (getMonoTime() - started).inMilliseconds < 1000
    started = getMonoTime()
    let withCovers = draw(scene, config, "net-covers")
    let coversMs = (getMonoTime() - started).inMilliseconds
    var red = 0
    for y in 60 ..< 240:
      for x in 230 ..< 420:
        let c = withCovers[x, y]
        if c.r > 200 and c.g < 100 and c.b < 100: inc red
    check red > 1000
    # What a render of the page costs once nothing downloads.
    started = getMonoTime()
    discard draw(scene, config, "net-again")
    echo "  placeholders ", placeholderMs, " ms, with covers ", coversMs, " ms, again ",
      (getMonoTime() - started).inMilliseconds, " ms"
    check jsIoInFlight() == 0
    # Each cover once, and the first one again at the size of its page.
    check requested("cdn.test").len == 7
    check problems.len == 0
    if problems.len > 0: echo problems

  test "opens a scene's page, installs it without leaving, and comes back to the same spot":
    asked = @[]
    problems = @[]
    let config = frame(800, 480)
    var scene = opened(config, "again")
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
    scene.state["spot"] = %*{"page": 1, "detail": listing(sixScenes)["scenes"][1]}
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

  test "the browser preview's host offers Preview, then Show and Discard, never Install":
    let config = frame(800, 480)
    let scene = load(config)
    facts["installed"] = %*[]
    facts["previewOnly"] = %true
    let detail = listing(sixScenes)["scenes"][1]
    proc tapAll(): seq[string] =
      asked = @[]
      for x in countup(420, 780, 20):
        for y in countup(40, 470, 10):
          scene.state["spot"] = %*{"page": 1, "detail": detail}
          scene.tap(x, y)
      for (_, action, _) in asked:
        result.add action
    scene.state["spot"] = %*{"page": 1, "detail": detail}
    discard draw(scene, config, "preview-only")
    let before = tapAll()
    check "preview" in before
    check "install" notin before
    facts["preview"] = %*{"store": "00000001-0000-4000-8000-000000000001", "id": "radar", "name": "Rain radar"}
    scene.state["spot"] = %*{"page": 1, "detail": detail}
    discard draw(scene, config, "preview-only-shown")
    let after = tapAll()
    check "discard" in after
    check "install" notin after
    facts["preview"] = newJNull()
    facts.delete("previewOnly")

  test "a layout is tried, worn by every scene, and put back by Discard":
    let config = frame(800, 480)
    let scene = load(config)
    facts["installed"] = %*[]
    chooseLayout("")
    var detail = listing(sixScenes)["scenes"][2]
    detail["category"] = %"layouts"
    detail["name"] = %"Top bar"
    proc tapAll(): seq[(string, JsonNode)] =
      asked = @[]
      for x in countup(420, 780, 20):
        for y in countup(40, 470, 10):
          scene.state["spot"] = %*{"page": 1, "detail": detail, "tried": scene.state{"spot", "tried"}}
          scene.tap(x, y)
      for (_, action, args) in asked:
        result.add (action, args)
    scene.state["spot"] = %*{"page": 1, "detail": detail}
    discard draw(scene, config, "layout")
    # Try is a preview that stays on the store; there is no Preview or Open.
    let tries = tapAll()
    var tried = false
    for (action, args) in tries:
      if action == "preview":
        check args{"show"}.getBool(true) == false
        tried = true
    check tried
    # The frame holds it now: the store puts it on every scene, itself too.
    scene.state["spot"] = %*{"page": 1, "detail": detail,
      "tried": {"store": detail["id"].getStr(), "before": ""}}
    facts["preview"] = %*{"store": detail["id"], "id": "layout-top-bar", "name": "Top bar"}
    discard draw(scene, config, "layout-tried")
    check chosenLayout() == "layout-top-bar"
    check parseJson(sceneStoreFactsForTests("store")){"layout"}.getStr() == "layout-top-bar"
    # Discard drops the preview and gives the frame back what it wore.
    var discarded = false
    for (action, _) in tapAll():
      if action == "discard": discarded = true
    check discarded
    check chosenLayout() == ""
    facts["preview"] = newJNull()

  test "a square screen gets the shelves as a select and a smaller grid":
    problems = @[]
    withLock requestsLock: requests = @[]
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "square")
    discard settle()
    discard draw(scene, config, "square-page")
    check requested("limit=").len > 0
    check problems.len == 0

  test "e-paper is not offered the scenes that move, and fetches its own page":
    problems = @[]
    discard settle() # what the last test left
    withLock requestsLock: requests = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "paper")
    # One refresh an answer: the page is fetched in the render, nothing after.
    check requested("/api/store/").len == 0
    check jsAsyncPending() == 0
    check fetched.len > 0 and "without=fast" in fetched[^1] and "prefer=fast" notin fetched[^1]
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
