## The Browser sample (repo/scenes/samples/Browser): its own tests
## (app.test.tsx) in its interpreter, and the scene drawn and tapped through
## its UI against a page shaped like Hacker News's front page, served through
## the request seam. FRAMEOS_BROWSER_SHOTS=<dir> writes what it drew;
## FRAMEOS_BROWSER_HN=<dir> serves a saved front.html, item.html and news.css
## in place of the built-in page (to look at the real site offline;
## FRAMEOS_BROWSER_HN_FRONT=item.html opens on the comments).

import std/[json, os, sequtils, strutils, times, unittest]
import pixie
import frameos/interpreter
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_runtime
import frameos/js_runtime/app_tests
import frameos/js_runtime/js_io
import frameos/channels
import frameos/utils/http_client

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let sample = parseFile(Samples / "Browser" / "scenes.json")[0]

const FrontPage = """<html op="news"><head><link rel="stylesheet" href="news.css?v"><title>Hacker News</title>
<script>document.write("<b>not text</b>")</script></head><body><center>
<table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
<td style="width:18px"><a href="https://news.ycombinator.com"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGP4jwQYiOMAANuQL9FuRbCyAAAAAElFTkSuQmCC" width="18" height="18"></a></td>
<td><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b> <a href="newest">new</a> | <a href="ask">ask</a></span></td>
</tr></table></td></tr><tr style="height:10px"/><tr><td><table border="0" cellpadding="0" cellspacing="0">
<tr class="athing"><td align="right" valign="top" class="title"><span class="rank">1.</span></td>
<td class="title"><span class="titleline"><a href="https://example.com/frames">Frames that browse the web</a>
<span class="comhead"> (<a href="from?site=example.com">example.com</a>)</span></span></td></tr>
<tr><td></td><td class="subtext">120 points by <a href="user?id=pg">pg</a> | <a href="item?id=7">33&nbsp;comments</a></td></tr>
</table></td></tr></table></center></body></html>"""

const Css = """body, td { font-family: Verdana; font-size: 10pt; color: #828282; }
a:link { color: #000000; text-decoration: none; }
.subtext { font-size: 7pt; } .subtext a:link { color: #828282; }
.comhead { font-size: 8pt; }"""

const Story = """<html><head><title>Frames</title></head><body><h1>Frames that browse</h1>
<p>A page with <a href="/next">a link</a>.</p></body></html>"""

var asked: seq[string]

proc serve(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  asked.add url
  let saved = getEnv("FRAMEOS_BROWSER_HN")
  if saved.len > 0:
    if url == "https://news.ycombinator.com/":
      return (200, readFile(saved / getEnv("FRAMEOS_BROWSER_HN_FRONT", "front.html")))
    if url.startsWith("https://news.ycombinator.com/news.css"):
      return (200, readFile(saved / "news.css"))
    if url.startsWith("https://news.ycombinator.com/item"):
      return (200, readFile(saved / "item.html"))
  if url == "https://news.ycombinator.com/":
    return (200, FrontPage)
  if url.startsWith("https://news.ycombinator.com/news.css"):
    return (200, Css)
  if url == "https://example.com/frames":
    return (200, Story)
  (404, "<html><body><p>Not found</p></body></html>")

proc testConfig(width = 800, height = 480): FrameConfig =
  FrameConfig(name: "browser", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
    timeZone: "UTC", assetsPath: getTempDir())

var logger = Logger(frameConfig: nil, enabled: true)
var problems: seq[string]
logger.log = proc(payload: JsonNode) =
  if payload{"level"}.getStr() == "error" or payload{"event"}.getStr().contains("error"):
    problems.add($payload)
logger.enable = proc() = logger.enabled = true
logger.disable = proc() = logger.enabled = false

suite "the Browser sample":
  test "its own tests pass in its interpreter":
    let sources = sample["apps"]["browser"]["sources"]
    check appTestFiles(sources) == @["app.test.tsx"]
    for testFile in appTestFiles(sources):
      let report = runJsAppTests(sources, testFile, testConfig())
      if not report["ok"].getBool():
        checkpoint($report)
      check report["ok"].getBool()
      check report["counts"]["total"].getInt() >= 12

  test "it asks for nothing":
    let config = parseJson(sample["apps"]["browser"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*[]

suite "the Browser scene":
  setup:
    asked = @[]
    problems = @[]
    jsHttpRequestHook = serve
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  teardown:
    jsHttpRequestHook = nil
    asyncPumped = true

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let started = epochTime()
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_BROWSER_SHOTS")
    if dir.len > 0:
      echo "  ", name, ": ", int((epochTime() - started) * 1000), " ms"
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("browser".SceneId, config, logger, %*{})

  proc tap(scene: FrameScene, x, y: int) =
    scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  # The first pixel from the left on row y whose color is near `color`.
  proc findColor(image: Image, y: int, color: ColorRGBX, slack = 40): int =
    for x in 0 ..< image.width:
      let c = image[x, y]
      if abs(c.r.int - color.r.int) + abs(c.g.int - color.g.int) + abs(c.b.int - color.b.int) < slack:
        return x
    -1

  test "draws Hacker News where a render may wait, and opens a story from a tap on its title":
    # A frame that fetches in the render (e-paper, a deep sleeper, the browser preview).
    asyncPumped = false
    let config = testConfig()
    let scene = load(config)
    let image = draw(scene, config, "front")
    check image.width == 800 and image.height == 480
    check "https://news.ycombinator.com/" in asked
    check asked.anyIt(it.startsWith("https://news.ycombinator.com/news.css"))
    if problems.len > 0: echo problems
    check problems.len == 0
    if getEnv("FRAMEOS_BROWSER_HN").len > 0:
      # The real front page: the first story's comments, the page as JSX, zoomed in.
      scene.tap(330, 106)
      discard draw(scene, config, "comments")
      check asked[^1].startsWith("https://news.ycombinator.com/item?id=")
      scene.tap(778, 19)
      discard draw(scene, config, "source")
      scene.tap(778, 19)
      scene.tap(738, 19)
      discard draw(scene, config, "zoomed")
      scene.send("pointerDown", %*{"x": 150, "y": 117, "pointerId": 0, "pointerType": "touch"})
      scene.send("longPress", %*{"x": 150, "y": 117, "pointerId": 0, "pointerType": "touch"})
      scene.send("pointerUp", %*{"x": 150, "y": 117, "pointerId": 0, "pointerType": "touch"})
      discard draw(scene, config, "held")
    else:
      # The header's orange under the toolbar, then the first title in black.
      check findColor(image, 60, rgbx(255, 102, 0, 255)) >= 0
      var titleY = -1
      for y in 70 ..< 200:
        if findColor(image, y, rgbx(0, 0, 0, 255), 60) in 30 .. 200:
          titleY = y
          break
      check titleY > 0
      scene.tap(findColor(image, titleY, rgbx(0, 0, 0, 255), 60) + 4, titleY)
      let story = draw(scene, config, "story")
      check asked[^1] == "https://example.com/frames"
      check story != image
      # Back is the frame's own back (a swipe from the left edge, a key).
      scene.send("back", %*{})
      discard draw(scene, config, "back")
      check asked.countIt(it == "https://news.ycombinator.com/") == 1 # the page seen is kept

  test "shows the page when it comes, where the frame pumps promises":
    asyncPumped = true
    let config = testConfig()
    let scene = load(config)
    jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
      {.cast(gcsafe).}:
        let (code, body) = serve(request.url, request.httpMethod, request.body, request.headers)
        JsIoResult(code: code, body: body)
    defer: jsIoHook = nil
    let first = draw(scene, config, "loading")
    var rendered = false
    for i in 0 ..< 300:
      discard pumpJsAsync()
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        if message[1] == "render": rendered = true
      if rendered and asked.anyIt(it.startsWith("https://news.ycombinator.com/news.css")):
        break
      if rendered:
        # The page came: draw it, which asks for its style sheet.
        discard draw(scene, config, "page-unstyled")
        rendered = false
      sleep(10)
    let page = draw(scene, config, "page")
    check "https://news.ycombinator.com/" in asked
    check page != first
