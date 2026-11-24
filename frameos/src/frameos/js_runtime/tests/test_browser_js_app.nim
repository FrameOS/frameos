## The Browser sample (repo/scenes/samples/Browser): its own tests
## (app.test.tsx) in its interpreter, and the scene drawn, scrolled and tapped
## through its UI against pages served through the request seams.
## FRAMEOS_BROWSER_SHOTS=<dir> writes what it drew. FRAMEOS_BROWSER_SITE=<dir>
## serves saved pages (its urls.txt: "<url> <file>" a line) and
## FRAMEOS_BROWSER_URL=<url> opens one of them, to look at real sites offline;
## FRAMEOS_BROWSER_SIZE=480x480 and FRAMEOS_BROWSER_EMBEDDED=1 say on what.

import std/[json, os, sequtils, strutils, tables, times, unittest]
import pixie
import frameos/interpreter
import frameos/scene_rhythm
import frameos/types
import frameos/js_runtime/app_runtime
import frameos/js_runtime/app_tests
import frameos/js_runtime/js_io
import frameos/js_runtime/runtime
import frameos/channels
import frameos/utils/http_client
import frameos/utils/memory

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let sample = parseFile(Samples / "Browser" / "scenes.json")[0]

const FrontPage = """<html op="news"><head><link rel="stylesheet" href="news.css?v"><title>Hacker News</title>
<script>document.write("<b>not text</b>")</script></head><body><center>
<table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%"><tr>
<td style="width:18px"><a href="https://news.ycombinator.com"><img src="y18.svg" width="18" height="18"></a></td>
<td><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b> <a href="newest">new</a> | <a href="ask">ask</a></span></td>
</tr></table></td></tr><tr style="height:10px"/><tr><td><table border="0" cellpadding="0" cellspacing="0">
<tr class="athing"><td align="right" valign="top" class="title"><span class="rank">1.</span></td>
<td valign="top" class="votelinks"><center><a id='up_1' href='vote?id=1&amp;how=up'><div class='votearrow' title='upvote'></div></a></center></td>
<td class="title"><span class="titleline"><a href="https://example.com/frames">Frames that browse the web</a>
<span class="comhead"> (<a href="from?site=example.com">example.com</a>)</span></span></td></tr>
<tr><td></td><td class="subtext">120 points by <a href="user?id=pg">pg</a> | <a href="item?id=7">33&nbsp;comments</a></td></tr>
</table></td></tr></table></center></body></html>"""

const Story = """<html><head><title>Frames</title></head><body><nav><a href="/">Home</a> <a href="/a">About</a>
<a href="/b">Blog</a> <a href="/c">Contact</a></nav><main><h1>Frames that browse</h1>
<p>A page with <a href="/next">a link</a> and a second sentence that is long enough to take more than one line of the
page at any width a frame has, so that it wraps and the lines below it move down.</p></main></body></html>"""

var asked: seq[string]
var saved: Table[string, string]
var bigPage: string

proc site(): seq[(string, string)] =
  let dir = getEnv("FRAMEOS_BROWSER_SITE")
  if dir.len > 0:
    for line in lines(dir / "urls.txt"):
      let parts = line.splitWhitespace()
      if parts.len == 2:
        result.add (parts[0], dir / parts[1])

proc bodyOf(url: string): tuple[code: int, body: string] =
  if saved.len == 0:
    for (u, file) in site():
      saved[u] = file
  if url in saved and fileExists(saved[url]):
    return (200, readFile(saved[url]))
  if url == "https://news.ycombinator.com/":
    return (200, FrontPage)
  if url == "https://example.com/frames":
    return (200, Story)
  (404, "<html><body><p>Not found</p></body></html>")

proc serve(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  ## A server that answers byte ranges, as most do for a page that is a file.
  asked.add url
  var (code, text) = bodyOf(url)
  for (name, value) in headers:
    if name.toLowerAscii() == "range" and value.startsWith("bytes=") and code == 200:
      let parts = value[6 .. ^1].split('-')
      let a = parseInt(parts[0])
      let b = min(text.len - 1, parseInt(parts[1]))
      if a >= text.len:
        return (416, "")
      return (206, text[a .. b])
  (code, text)

proc testConfig(width = 800, height = 480): FrameConfig =
  FrameConfig(name: "browser", mode: "rpios", device: getEnv("FRAMEOS_BROWSER_DEVICE", "framebuffer"), width: width, height: height, rotate: 0,
    scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
    timeZone: "UTC", assetsPath: getTempDir())

var logger = Logger(frameConfig: nil, enabled: true)
var problems: seq[string]
var said: seq[string]
logger.log = proc(payload: JsonNode) =
  if payload{"level"}.getStr() == "error" or payload{"event"}.getStr().contains("error"):
    if not payload{"error"}.getStr().startsWith("<img> "): # a saved site has no pictures
      problems.add($payload)
  elif ($payload).contains("browser:"):
    said.add($payload)
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

suite "the Browser's reader, timed":
  test "reads a saved page in the app's interpreter (FRAMEOS_BROWSER_PERF=<file>)":
    # How long read.ts takes in QuickJS, where an ESP32 spends a page's time
    # (it runs this a couple of hundred times slower than a desk does).
    let file = getEnv("FRAMEOS_BROWSER_PERF")
    if file.len == 0:
      skip()
    else:
      var sources = sample["apps"]["browser"]["sources"].copy()
      let reps = getEnv("FRAMEOS_BROWSER_REPS", "5")
      sources["perf.test.ts"] = %("""import { reader, push, finish } from './read'
import { rows, reach } from './lay'
const HTML = """ & $(%readFile(file)) & """

test('perf', () => {
  let best = 1e9, wrap = 0, doc: any = null
  const reps = """ & reps & """

  for (let rep = 0; rep < reps; rep++) {
    const t0 = Date.now()
    const r = reader('https://example.com/')
    for (let i = 0; i < HTML.length; i += 16384) if (!push(r, HTML.slice(i, i + 16384), i + 16384 >= HTML.length)) break
    doc = finish(r)
    best = Math.min(best, Date.now() - t0)
  }
  const t1 = Date.now()
  const rw = rows(doc, { width: 480, px: 17, pics: true, tall: 260 })
  reach(rw, 1e9)
  wrap = Date.now() - t1
  frameos.log('perf: ' + Math.round(HTML.length / 1024) + ' KB, read ' + best + ' ms, ' + doc.n + ' blocks, ' + doc.chars + ' chars, wrap ' + wrap + ' ms, ' + rw.n + ' rows')
})
""")
      if getEnv("FRAMEOS_BROWSER_PERF_DUMP").len > 0:
        writeFile(getEnv("FRAMEOS_BROWSER_PERF_DUMP"), sources["perf.test.ts"].getStr())
      let report = runJsAppTests(sources, "perf.test.ts", testConfig())
      if not report["ok"].getBool(): echo report.pretty()
      for line in report{"children"}[0]{"logs"}: echo "  ", line{"message"}.getStr($line)
      check report["ok"].getBool()

suite "the Browser scene":
  setup:
    asked = @[]
    problems = @[]
    said = @[]
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

  proc load(config: FrameConfig, home = "https://news.ycombinator.com/"): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[sample])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("browser".SceneId, config, logger, %*{"homepage": getEnv("FRAMEOS_BROWSER_URL", home).replace("about:home", "")})

  proc tap(scene: FrameScene, x, y: int) =
    scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  proc settle(scene: FrameScene, config: FrameConfig, name: string, rounds = 400): Image =
    ## Pumps promises and draws at each render asked for, until nothing is pending.
    var quiet = 0
    for i in 0 ..< rounds:
      discard pumpJsAsync()
      var rendered = false
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        if message[1] == "render": rendered = true
      if rendered:
        result = draw(scene, config, name)
        quiet = 0
      elif jsAsyncPending() == 0:
        inc quiet
        if quiet > 3: break
      sleep(5)
    if result.isNil:
      result = draw(scene, config, name)

  proc sizeOf(): (int, int) =
    let parts = getEnv("FRAMEOS_BROWSER_SIZE", "800x480").split('x')
    (parseInt(parts[0]), parseInt(parts[1]))

  # The first pixel in the link color on rows y0 .. y1, from the left: a link's first letter.
  proc findLink(image: Image, y0, y1: int): (int, int) =
    for y in y0 .. y1:
      for x in 0 ..< image.width:
        let c = image[x, y]
        if abs(c.r.int - 11) + abs(c.g.int - 87) + abs(c.b.int - 208) < 40:
          return (x, y)
    (-1, -1)

  proc pumped() =
    jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
      {.cast(gcsafe).}:
        let (code, body) = serve(request.url, request.httpMethod, request.body, request.headers)
        JsIoResult(code: code, body: body)

  test "opens on its start page, with nothing asked of the network":
    asyncPumped = false
    let config = testConfig()
    let scene = load(config, "")
    let image = draw(scene, config, "start")
    check asked.len == 0
    check findLink(image, 60, 300)[0] >= 0 # the bookmarks
    check problems.len == 0

  test "draws a page in the render that asks for it, where nothing pumps promises, and opens a link from a tap":
    # E-paper that sleeps, the editor's preview, a plane's render for a board:
    # the page is read by the runtime inside the fetch() call.
    asyncPumped = false
    let config = testConfig()
    let scene = load(config)
    let image = draw(scene, config, "front")
    check asked == @["https://news.ycombinator.com/"]
    if problems.len > 0: echo problems
    check problems.len == 0
    # Its header's links, then the story's title a few lines down.
    let header = findLink(image, 44, 70)
    check header[0] >= 0
    let title = findLink(image, header[1] + 24, 140)
    check title[0] > 0
    scene.tap(title[0] + 30, title[1] + 4)
    let story = draw(scene, config, "story")
    check asked[^1] == "https://example.com/frames"
    check story != image
    # Its navigation is folded into a line: the page starts with its own words.
    check said.anyIt(it.contains("example.com 200"))
    # Back is the frame's own back (a swipe from the left edge, a key), and the page before was kept.
    scene.send("back", %*{})
    discard draw(scene, config, "back")
    check asked.len == 2

  test "shows the page when it comes, where the frame pumps promises":
    asyncPumped = true
    pumped()
    defer: jsIoHook = nil
    let config = testConfig()
    let scene = load(config)
    let first = draw(scene, config, "opening")
    let page = settle(scene, config, "page")
    check asked == @["https://news.ycombinator.com/"]
    check page != first
    check findLink(page, 44, 70)[0] >= 0
    if problems.len > 0: echo problems
    check problems.len == 0

  test "a page of megabytes costs what its words do, in an ESP32's 4 MB of JS":
    # CNN's front page is 7 MB, 30 KB of it words. Its markup and scripts
    # never reach JavaScript: the runtime reads them as they come.
    asyncPumped = true
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    var config = testConfig(480, 480)
    config.js = JsRuntimeConfig(memoryLimitMb: 4, executionTimeoutMs: -1, maxStackKb: -1)
    var big = "<html><head><title>Big</title><script>" & "var junk = [1,2,3]; ".repeat(100_000) & "</script></head><body>"
    for i in 0 ..< 1500:
      big.add "<div class=\"card c" & $i & "\" data-x=\"" & "y".repeat(400) & "\"><script>" & "f();".repeat(600) &
        "</script><p>Paragraph " & $i & " of a page that goes on, with <a href=\"/a" & $i & "\">a link</a> in it.</p></div>\n"
    big.add "</body></html>"
    check big.len > 5_000_000
    saved["https://big.test/"] = ""
    jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
      {.cast(gcsafe).}:
        asked.add request.url
        JsIoResult(code: 200, body: (if request.url == "https://big.test/": bigPage else: ""))
    defer: jsIoHook = nil
    bigPage = big
    let scene = load(config, "https://big.test/")
    discard draw(scene, config, "big-opening")
    let before = sceneHeapBudgetUsedBytes("browser")
    let image = settle(scene, config, "big", rounds = 3000)
    if problems.len > 0: echo problems
    check problems.len == 0
    check said.anyIt(it.contains("1501 blocks")) # each paragraph, and the fold line before the page
    check findLink(image, 44, 200)[0] >= 0
    # The page's words and its 1,500 links, not its megabytes.
    let grew = sceneHeapBudgetUsedBytes("browser") - before
    checkpoint($grew)
    check grew < 600_000

  test "a frame's buttons walk the page's links and open one":
    asyncPumped = false
    let config = testConfig()
    let scene = load(config)
    discard draw(scene, config, "keys")
    var opened = false
    for presses in 1 .. 12:
      scene.send("button", %*{"pin": 1, "label": "next", "role": "next", "action": "press", "durationMs": 80})
      discard draw(scene, config, "next-" & $presses)
    # On one of the page's links by now (the toolbar's buttons and the address come first): press it.
    scene.send("button", %*{"pin": 2, "label": "primary", "role": "primary", "action": "press", "durationMs": 80})
    discard draw(scene, config, "pressed")
    opened = asked.len == 2 and asked[1].startsWith("https://")
    check opened

  test "draws a saved site, scrolled a screen at a time and back (FRAMEOS_BROWSER_SITE)":
    if getEnv("FRAMEOS_BROWSER_SITE").len == 0:
      skip()
    else:
      let (w, h) = sizeOf()
      var config = testConfig(w, h)
      let embedded = getEnv("FRAMEOS_BROWSER_EMBEDDED") == "1"
      if embedded:
        setSimulatedEmbedded(true)
        config.js = JsRuntimeConfig(memoryLimitMb: 4, executionTimeoutMs: -1, maxStackKb: -1)
      defer: setSimulatedEmbedded(false)
      asyncPumped = getEnv("FRAMEOS_BROWSER_PUMPED", "1") == "1"
      jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
        {.cast(gcsafe).}:
          let (code, body) = serve(request.url, request.httpMethod, request.body, request.headers)
          JsIoResult(code: code, body: body)
      defer: jsIoHook = nil
      let scene = load(config)
      let started = epochTime()
      discard draw(scene, config, "first")
      discard settle(scene, config, "page")
      echo "  page in ", int((epochTime() - started) * 1000), " ms, JS heap ", sceneHeapBudgetUsedBytes("browser") div 1024, " KB"
      # FRAMEOS_BROWSER_TAPS="x,y;x,y;hold:x,y;back": each done and drawn in turn.
      for step in getEnv("FRAMEOS_BROWSER_TAPS").split(';'):
        if step.len == 0: continue
        if step == "back":
          scene.send("back", %*{})
        elif step.startsWith("key:"):
          let key = step[4 .. ^1]
          scene.send("keyDown", %*{"key": key, "code": key, "repeat": false, "shift": false, "ctrl": false, "alt": false, "meta": false})
        elif step.startsWith("button:"):
          scene.send("button", %*{"pin": 1, "label": step[7 .. ^1], "role": step[7 .. ^1], "action": "press", "durationMs": 80})
        elif step.startsWith("type:"):
          for ch in step[5 .. ^1]:
            scene.send("keyDown", %*{"key": $ch, "code": "Key" & $ch})
          scene.send("keyDown", %*{"key": "Enter", "code": "Enter"})
        else:
          let hold = step.startsWith("hold:")
          let xy = (if hold: step[5 .. ^1] else: step).split(',')
          let (x, y) = (parseInt(xy[0]), parseInt(xy[1]))
          if hold:
            scene.send("pointerDown", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})
            scene.send("longPress", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})
            scene.send("pointerUp", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})
          else:
            scene.tap(x, y)
        discard draw(scene, config, "after-" & step.replace(':', '-').replace(',', '-'))
        discard settle(scene, config, "settled-" & step.replace(':', '-').replace(',', '-'))
      for i in 1 .. parseInt(getEnv("FRAMEOS_BROWSER_SCROLLS", "3")):
        scene.send("wheel", %*{"x": w div 2, "y": h div 2, "deltaX": 0, "deltaY": 5})
        discard draw(scene, config, "scrolled-" & $i)
      scene.send("wheel", %*{"x": w div 2, "y": h div 2, "deltaX": 0, "deltaY": -40})
      discard draw(scene, config, "top")
      echo "  JS heap ", sceneHeapBudgetUsedBytes("browser") div 1024, " KB; asked ", asked.len
      for line in said: echo "  ", line
      if problems.len > 0: echo problems
      check problems.len == 0
