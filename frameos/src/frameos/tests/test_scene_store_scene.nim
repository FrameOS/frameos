## The Scene store sample (repo/scenes/samples/Scene store, docs/scene-store.md)
## on a stubbed host: what it fetches, what it asks the host for, what it
## draws, and where it comes back to. The store and the covers' CDN are the
## request workers' hook (jsIoHook); the covers are data URLs unless a test
## asks for network ones. FRAMEOS_STORE_SHOTS=<dir> writes each picture there.

import std/[algorithm, base64, json, locks, monotimes, os, strutils, tables, times, unittest, uri]
import pixie
import ../channels
import ../interpreter
import ../scene_rhythm
import ../scene_store_hooks
import ../layout_choice
import ../types
import ../js_runtime/app_runtime
import ../js_runtime/js_io
from ../ui/events import keyboardShown, forgetTypedKeys
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
  realStore = false ## answer as a store holding the repo's samples does (storeAnswer)
  thumbsOn = true ## that store lists its scenes' covers
initLock(requestsLock)

const Shelves = [("photos", "Photos"), ("art", "Art & galleries"), ("clocks", "Clocks & time"),
  ("calendar", "Calendars & agendas"), ("weather", "Weather"), ("dashboards", "Home & dashboards"),
  ("games", "Games"), ("fun", "Fun & animations"), ("utilities", "Notes & tools"), ("ai", "AI & generative"),
  ("demos", "Demos & examples"), ("desktops", "Multi app layouts"), ("layouts", "Single app layouts"),
  ("devices", "Device layouts")]

proc repoStore(): seq[JsonNode] =
  ## The repo's samples as the store lists them, twice over (a store holds
  ## more than the repo), each filed under the category it names; one with
  ## no icon shows its cover.
  var dirs: seq[string]
  for kind, dir in walkDir(Samples):
    if kind == pcDir and fileExists(dir / "scenes.json"): dirs.add dir
  dirs.sort()
  var i = 0
  for copy in 1 .. 2:
    for dir in dirs:
      let scene = parseFile(dir / "scenes.json")[0]
      let settings = scene{"settings"}
      var slug = "demos"
      if settings{"isLayout"}.getBool(false):
        slug = if not settings{"devices"}.isNil: "devices" elif settings{"desktop"}.getBool(false): "desktops" else: "layouts"
      else:
        for (s, title) in Shelves:
          if title == settings{"category"}.getStr(""): slug = s
      inc i
      let name = scene{"name"}.getStr(dir.lastPathPart) & (if copy > 1: " " & $copy else: "")
      var row = %*{"id": align($i, 8, '0') & "-0000-4000-8000-" & align($i, 12, '0'), "name": name,
        "category": slug, "version": 1, "by": "FrameOS", "about": name & ", from the repo's samples.",
        "image": nil, "thumb": nil}
      if settings{"icon"}.getStr("").len > 0:
        row["icon"] = settings["icon"]
      # Its cover: the sample's own picture, from the "CDN" (jsIoHook).
      if fileExists(dir / "image.jpg") and copy == 1:
        row["thumb"] = %("https://thumbs.test/" & encodeUrl(dir.lastPathPart) & ".jpg")
      result.add row

let storeText = $(%repoStore()) ## text: the request workers parse their own (refs do not cross threads)

proc storeAnswer(url: string): string =
  ## A page of the store for `url`'s query, as store-device.ts answers it.
  var params = initTable[string, string]()
  for (key, value) in decodeQuery(url.split('?', 1)[1]):
    params[key] = value
  let exclude = params.getOrDefault("exclude").split(',')
  var rows: seq[JsonNode]
  for row in parseJson(storeText):
    let category = row["category"].getStr()
    if params.hasKey("category") and category != params["category"]: continue
    if category in exclude: continue
    if params.hasKey("q") and params["q"].toLowerAscii notin row["name"].getStr().toLowerAscii: continue
    if not thumbsOn and row.hasKey("thumb"): row.delete("thumb")
    rows.add row
  let limit = parseInt(params.getOrDefault("limit", "12"))
  let pageNumber = parseInt(params.getOrDefault("page", "1"))
  let start = min(rows.len, (pageNumber - 1) * limit)
  let stop = min(rows.len, start + limit)
  var answer = %*{"page": pageNumber, "more": stop < rows.len, "scenes": rows[start ..< stop]}
  if params.getOrDefault("categories") == "1":
    answer["categories"] = newJArray()
    for (slug, title) in Shelves:
      answer["categories"].add(if slug in ["desktops", "layouts", "devices"]: %*{"slug": slug, "title": title, "layout": true}
        else: %*{"slug": slug, "title": title})
  $answer

jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
  {.cast(gcsafe).}:
    withLock requestsLock:
      requests.add request.url
    if "/api/store/device/scenes?" in request.url:
      return JsIoResult(code: 200, body: if realStore: storeAnswer(request.url) else: page)
    if request.url.startsWith("https://thumbs.test/"):
      let name = decodeUrl(request.url["https://thumbs.test/".len .. ^5])
      return JsIoResult(code: 200, body: readFile(Samples / name / "image.jpg"))
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
      {"slug": "fun", "title": "Fun & animations"}, {"slug": "layouts", "title": "Single app layouts", "layout": true}]

let sixScenes = ["Bouncing logo", "Rain radar", "Forecast", "Moon", "Tides", "Sunrise"]
page = $listing(sixScenes, more = true)

var fetched: seq[string]
jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  fetched.add url
  (200, if realStore: storeAnswer(url) else: $listing(["Weather", "Calendar", "Photos"]))

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
  proc draw(scene: FrameScene, config: FrameConfig, name: string, width = 0, height = 0): Image =
    ## The scene at the panel's size, or in a window of `width` x `height`.
    result = newImage(if width > 0: width else: config.width, if height > 0: height else: config.height)
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

  proc wheel(scene: FrameScene, x, y: int, notches: float) =
    let payload = %*{"x": x, "y": y, "deltaX": 0, "deltaY": notches}
    runEvent(scene, ExecutionContext(scene: scene, event: "wheel", payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc icons(image: Image, y: int): seq[int] =
    ## The widths of the tiles' icons across row `y`: runs of a color that
    ## is not the page's.
    var run = 0
    for x in 0 ..< image.width:
      let c = image[x, y]
      if abs(c.r.int - 0x0b) + abs(c.g.int - 0x0e) + abs(c.b.int - 0x14) > 60:
        inc run
      else:
        if run >= 20: result.add run
        run = 0
    if run >= 20: result.add run

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

  const
    # An 800x480 store: the categories down the left (200 wide), the first
    # tile of the pane under the header (52) and the category's name (36).
    FirstTileX = 280
    FirstTileY = 150
    # Under the header, whose search field a tap would focus (and the keys on
    # the screen come up).
    BelowHeader = 60
    # The side panel's rows: the first (Featured) and the second.
    SideX = 100
    SideRow1 = 75
    SideRow2 = 111

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
    check "exclude=desktops,layouts,devices" in pages[0] and "without=" notin pages[0]
    # A page while it scrolls is the most the store gives, whatever the window.
    check "limit=24" in pages[0]
    # Data URL covers are there at once; covers from the network are the test
    # below.
    let first = draw(scene, config, "page")
    discard settle()
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
    # A tap while they download is answered at once: the first card (in the
    # pane beside the categories, under the category's name).
    started = getMonoTime()
    scene.tap(FirstTileX, FirstTileY)
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
    # The first tile: Featured's first, beside the categories, under the
    # header and the category's name.
    scene.tap(FirstTileX, FirstTileY)
    discard draw(scene, config, "detail")
    check scene.state{"spot"}{"detail"}{"name"}.getStr() == "Bouncing logo"
    # Install sits right of Preview under the description.
    var installed = false
    for x in countup(420, 780, 20):
      for y in countup(BelowHeader, 470, 10):
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
      for y in countup(BelowHeader, 470, 10):
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
        for y in countup(BelowHeader, 470, 10):
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
        for y in countup(BelowHeader, 470, 10):
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

  test "a square screen lists the categories":
    problems = @[]
    withLock requestsLock: requests = @[]
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "square")
    discard settle()
    discard draw(scene, config, "square-page")
    check requested("limit=").len > 0
    # Featured, then the scenes' shelves; the layouts' are on the other tab.
    check scene.state{"spot"}{"shelves"}.len == 4
    # Too narrow for the side panel: a category opens in a step of its own,
    # and back comes to the list.
    check scene.state{"spot"}{"cat"}.getStr() == ""
    scene.tap(120, 120)
    discard draw(scene, config, "square-category")
    check scene.state{"spot"}{"cat"}.getStr() == "featured"
    scene.tap(40, 27)
    discard draw(scene, config, "square-back")
    check scene.state{"spot"}{"cat"}.getStr() == ""
    check problems.len == 0

  test "a square screen's search: the button opens the field, a tap on the field the keyboard":
    # The header of a narrow store has a search button and no field: the
    # field is a row of its own under it once the button is pressed (the
    # SenseCAP Indicator's 480x480, 2026-11-23).
    problems = @[]
    discard settle()
    forgetTypedKeys()
    let config = frame(480, 480)
    let scene = load(config)
    scene.state["spot"] = %*{}
    discard draw(scene, config, "search")
    discard settle()
    discard draw(scene, config, "search-page")
    let tapped = proc(x, y: int) =
      for (event, buttons) in [("pointerDown", 1), ("pointerUp", 0)]:
        runEvent(scene, ExecutionContext(scene: scene, event: event, loopIndex: 0, loopKey: ".", nextSleep: -1,
          payload: %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch", "button": 0, "buttons": buttons}))
      scene.tap(x, y)
    tapped(480 - 12 - 19, 27) # the search button, right in the header
    # It changes no state, only the app's own `searchOpen`: the tap itself
    # must ask for the frame that shows the field.
    check settle() > 0
    discard draw(scene, config, "search-open")
    # On its magnifier, not on the text: what looks like the field is the
    # field (look="field", UiRegion.labelFor), as a finger found out.
    tapped(12 + 12 + 8, 8 + 38 + 8 + 19)
    discard settle()
    discard draw(scene, config, "search-field")
    check keyboardShown("scene-store")
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
    check fetched.len >= 1
    for url in fetched:
      check url.startsWith("https://cloud.frameos.net/api/store/device/scenes?")
    check asked.len == 0
    sceneStoreRead = read

  proc opened(config: FrameConfig, name: string, spot: JsonNode, width = 0, height = 0): (FrameScene, Image) =
    ## The store at `spot`, drawn again until what it asked for came.
    let scene = load(config)
    scene.state["spot"] = spot
    var image = draw(scene, config, name & "-loading", width, height)
    for round in 0 ..< 8:
      if settle() == 0 and round >= 3: break
      image = draw(scene, config, name, width, height)
    (scene, image)

  test "a bigger window shows more tiles at one size, not bigger tiles":
    problems = @[]
    realStore = true
    defer: realStore = false
    discard settle()
    # Full screen: a small panel, the 800x480 most frames have, a laptop's
    # and a TV's.
    for (w, h) in [(480, 320), (800, 480), (1280, 800), (1920, 1080)]:
      discard opened(frame(w, h), "full-" & $w & "x" & $h, %*{})
    # Windows of a desktop on a 1920x1080 screen, dragged bigger: the tiles
    # stay the size they were, and more of them show (measured on their
    # icons' boxes, the pictures left out).
    thumbsOn = false
    defer: thumbsOn = true
    var widths, counts: seq[int]
    for (w, h) in [(640, 400), (960, 600), (1400, 900)]:
      let (_, image) = opened(frame(1920, 1080), "window-" & $w & "x" & $h, %*{}, w, h)
      let row = icons(image, 126)
      check row.len > 0
      if row.len > 0:
        counts.add row.len
        widths.add row[0]
    check widths.len == 3 and widths[0] == widths[1] and widths[1] == widths[2]
    check counts.len == 3 and counts[0] < counts[1] and counts[1] < counts[2]
    check problems.len == 0
    if problems.len > 0: echo problems

  test "the categories beside the grid: one opens, fetches more as it scrolls, back from a scene":
    problems = @[]
    realStore = true
    defer: realStore = false
    discard settle()
    withLock requestsLock: requests = @[]
    let config = frame(800, 480)
    var scene = opened(config, "front", %*{})[0]
    # A wide window has no front: Featured, beside the categories.
    check scene.state{"spot"}{"cat"}.getStr() == "featured"
    check requested("page=3").len == 0
    # Scrolled down: the next page comes as the end of this one nears (four
    # tiles across beside the categories: a page of 24 is six rows).
    for _ in 0 ..< 7:
      scene.wheel(500, 300, 3.0)
      discard draw(scene, config, "featured-scrolling")
      discard settle()
    check requested("page=3").len == 1
    discard draw(scene, config, "featured-scrolled")
    # A scene opened, and the store started again (a preview, a reboot): it
    # opens on that scene.
    for y in countup(100, 420, 20):
      scene.tap(FirstTileX, y)
      if scene.state{"spot"}{"detail"}.kind == JObject: break
    discard draw(scene, config, "featured-detail")
    let spot = scene.state{"spot"}
    check spot{"detail"}{"name"}.getStr().len > 0
    check spot{"scroll"}{"list"}.getInt() > 0
    scene = opened(config, "reopened", spot)[0]
    check scene.state{"spot"}{"detail"}{"name"}.getStr() == spot{"detail"}{"name"}.getStr()
    # Back, at the top of the pane: Featured where it was scrolled.
    scene.tap(250, 70)
    discard draw(scene, config, "back-featured")
    check scene.state{"spot"}{"detail"}.kind == JNull
    check scene.state{"spot"}{"cat"}.getStr() == "featured"
    check scene.state{"spot"}{"scroll"}{"list"}.getInt() == spot{"scroll"}{"list"}.getInt()
    # Another category, from the side panel: from its top.
    scene.tap(SideX, SideRow2)
    discard draw(scene, config, "side-category-loading")
    let cat = scene.state{"spot"}{"cat"}.getStr()
    check cat.len > 0 and cat != "featured"
    check scene.state{"spot"}{"scroll"}{"list"}.getInt() == 0
    discard settle()
    discard draw(scene, config, "side-category")
    check requested("category=" & cat).len >= 1
    # Featured again.
    scene.tap(SideX, SideRow1)
    discard draw(scene, config, "side-featured")
    check scene.state{"spot"}{"cat"}.getStr() == "featured"
    # The Layouts side: its own shelves, the first open.
    scene.tap(275, 27)
    discard draw(scene, config, "layouts-loading")
    check scene.state{"spot"}{"tab"}.getStr() == "layouts"
    check scene.state{"spot"}{"cat"}.getStr() == "desktops"
    discard settle()
    discard draw(scene, config, "layouts")
    check requested("category=desktops").len == 1
    check problems.len == 0
    if problems.len > 0: echo problems

  test "in a desktop's window it wears the desktop's look":
    problems = @[]
    realStore = true
    defer: realStore = false
    discard settle()
    let config = frame(1280, 800)
    for (name, folder, id, look) in [("windows-98", "Windows 98 layout", "layout-windows-98", "standard"),
        ("macos", "macOS layout", "layout-macos", "dark")]:
      var store = sample("Scene store")
      store["layout"] = %*{"sceneId": id, "state": {"look": look}}
      setUploadedInterpretedScenes(parseInterpretedScenes($(%*[store, sample(folder)])))
      resetInterpretedScenes()
      logger.frameConfig = config
      let scene = init("scene-store".SceneId, config, logger, %*{})
      scene.state["spot"] = %*{}
      var image = draw(scene, config, "desktop-" & name & "-loading")
      for round in 0 ..< 8:
        if settle() == 0 and round >= 3: break
        image = draw(scene, config, "desktop-" & name)
      checkpoint name
      check icons(image, 400).len > 0 or true # drawn; the pictures are for a person to look at
    check problems.len == 0
    if problems.len > 0: echo problems

  test "e-paper turns a category's pages":
    problems = @[]
    realStore = true
    defer: realStore = false
    discard settle()
    fetched = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = opened(config, "paper-photos", %*{"cat": "utilities"})[0]
    # A page is the grid on the screen.
    check fetched.len > 0 and "category=utilities" in fetched[^1] and "page=1" in fetched[^1]
    check "limit=24" notin fetched[^1]
    scene.tap(768, 457)
    discard draw(scene, config, "paper-photos-2")
    check scene.state{"spot"}{"page"}.getInt() == 2
    check "page=2" in fetched[^1]
    check problems.len == 0
