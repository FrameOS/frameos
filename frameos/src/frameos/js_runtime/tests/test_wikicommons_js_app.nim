## The Wikimedia Commons code app (repo/apps/image/wikicommons) run for real
## through the JS app runtime. The API host is fixed, so `frameos.httpRequest`
## is answered by `jsHttpRequestHook`; the image URLs those answers carry
## point at a mock image server on a thread, so the download (with its
## User-Agent), the saved asset and its extension are the real thing. Ports
## data/wikicommons' own tests and covers every mode and alias, the dates each
## one asks for, the retries, the failures, the metadata state and the
## saved asset.
##
## The random modes are made deterministic by answering every request the
## same way; the test then checks that each date asked for is a legal one.

import std/[json, net, os, strutils, tables, times, unittest, uri]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/utils/memory
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "wikicommons"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")
let appFields = parseJson(appConfigJson)["fields"]

proc withDefaults(config: JsonNode): JsonNode =
  ## What the runtime hands a scene's node (runtimeConfigFromNode): every
  ## field's typed default (the first declaration of a name wins), then the
  ## node's own values, typed the same way. The app reads its fields as given.
  result = %*{}
  var types = initTable[string, string]()
  for field in appFields:
    let name = field{"name"}.getStr()
    if name.len > 0 and not types.hasKey(name):
      types[name] = field{"type"}.getStr()
      result[name] = valueToJson(valueFromJsonByType(field["value"], types[name]))
  for key, value in config:
    result[key] = if types.hasKey(key): valueToJson(valueFromJsonByType(value, types[key])) else: value

const CommonsUserAgent = "FrameOS Wikimedia Commons app (https://github.com/FrameOS/frameos)"
const ApiUrl = "https://commons.wikimedia.org/w/api.php"

## Mock image host on a thread: /img/... answers a 5x3 PNG, anything else 404.
## Every request it sees goes to `mockRequests` as "<path>\t<User-Agent>".
var mockPort: Port
var mockThread: Thread[void]
var mockRequests: Channel[string]

proc pngBytes(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgba(40, 120, 200, 255))
  encodeImage(image, PngFormat)

proc reply(client: Socket, status: string, contentType: string, body: string) =
  client.send("HTTP/1.1 " & status & "\r\nContent-Type: " & contentType &
    "\r\nContent-Length: " & $body.len & "\r\n\r\n" & body)
  client.close()

proc mockImageLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  mockPort = boundPort
  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    var userAgent = ""
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        if line.toLowerAscii().startsWith("user-agent:"):
          userAgent = line.split(":", maxsplit = 1)[1].strip()
    except CatchableError:
      client.close()
      continue
    let parts = requestLine.splitWhitespace()
    let path = if parts.len >= 2: parts[1] else: "/"
    if path == "/quit":
      client.reply("200 OK", "text/plain", "")
      break
    mockRequests.send(path & "\t" & userAgent)
    if path.startsWith("/img/"):
      client.reply("200 OK", "image/png", pngBytes(5, 3))
    else:
      client.reply("404 Not Found", "text/plain", "no such file")
  server.close()

var mockStarted = false

proc mockBase(): string =
  if not mockStarted:
    mockStarted = true
    mockRequests.open()
    createThread(mockThread, mockImageLoop)
    for _ in 0 ..< 100:
      if int(mockPort) != 0:
        break
      sleep(20)
  doAssert int(mockPort) != 0
  "http://127.0.0.1:" & $int(mockPort)

proc imageRequests(): seq[string] =
  while true:
    let (ok, request) = mockRequests.tryRecv()
    if not ok:
      break
    result.add(request)

## The API side: every frameos.httpRequest lands here.
type ApiCall = object
  url: string
  httpMethod: string
  headers: seq[SimpleHttpHeader]

var apiCalls: seq[ApiCall] = @[]
var apiAnswer: proc(url: string): tuple[code: int, body: string] = nil

jsHttpRequestHook = proc(url, httpMethod, body: string,
    headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  apiCalls.add(ApiCall(url: url, httpMethod: httpMethod, headers: headers))
  apiAnswer(url)

proc header(call: ApiCall, name: string): string =
  for header in call.headers:
    if header.name == name:
      return header.value
  ""

proc param(call: ApiCall, name: string): string =
  for (key, value) in decodeQuery(parseUri(call.url).query):
    if key == name:
      return value
  ""

proc expectedUrl(params: openArray[(string, string)]): string =
  ## The Nim app's queryString: std/uri encodeUrl on every key and value.
  var all = @[("format", "json"), ("formatversion", "2")]
  all.add(params)
  var parts: seq[string] = @[]
  for (key, value) in all:
    parts.add(encodeUrl(key) & "=" & encodeUrl(value))
  ApiUrl & "?" & parts.join("&")

## Only the extmetadata the app reads: the full set is several KB per page,
## held in the QuickJS heap while the reply is parsed.
const MetadataFilter = ("iiextmetadatafilter", "ImageDescription|ObjectName|Artist|LicenseShortName")

proc potdUrl(date: string, width: int): string =
  expectedUrl([("action", "query"), ("generator", "images"), ("titles", "Template:Potd/" & date),
    ("gimlimit", "20"), ("prop", "imageinfo"), ("iiprop", "url|mime|extmetadata"), MetadataFilter,
    ("iiurlwidth", $width)])

proc randomUrl(width: int): string =
  expectedUrl([("action", "query"), ("generator", "random"), ("grnnamespace", "6"), ("grnlimit", "20"),
    ("prop", "imageinfo"), ("iiprop", "url|mime|extmetadata"), MetadataFilter, ("iiurlwidth", $width)])

proc page(title, imageUrl: string, mime = "image/jpeg", description = "",
    objectName = "", artist = "", license = "", urlKey = "thumburl"): JsonNode =
  var info = %*{
    "mime": mime,
    "descriptionurl": "https://commons.wikimedia.org/wiki/" & title.replace(" ", "_"),
    "width": 4000, "height": 3000, "size": 1234567,
    "extmetadata": {
      "DateTime": {"value": "2024-05-01 10:00:00", "source": "mediawiki-metadata", "hidden": ""},
      "LicenseShortName": {"value": license, "source": "commons-desc-page", "hidden": ""}
    }
  }
  if urlKey == "thumburl":
    info["thumburl"] = %imageUrl
    info["thumbwidth"] = %960
    info["thumbheight"] = %720
    info["url"] = %"https://upload.wikimedia.org/original.jpg"
  else:
    info["url"] = %imageUrl
  if description.len > 0:
    info["extmetadata"]["ImageDescription"] = %*{"value": description, "source": "commons-desc-page"}
  if objectName.len > 0:
    info["extmetadata"]["ObjectName"] = %*{"value": objectName, "source": "mediawiki-metadata"}
  if artist.len > 0:
    info["extmetadata"]["Artist"] = %*{"value": artist, "source": "commons-desc-page"}
  %*{"pageid": 42, "ns": 6, "title": title, "imagerepository": "local", "imageinfo": [info]}

proc query(pages: varargs[JsonNode]): string =
  var list = newJArray()
  for p in pages:
    list.add(p)
  $(%*{"batchcomplete": true, "query": {"pages": list}})

proc foxPage(): JsonNode =
  page("File:Red fox (Vulpes vulpes).jpg", mockBase() & "/img/960px-Red_fox.JPEG?v=1",
    description = "<div class=\"description en\">A <b>red</b> fox &amp; &quot;friends&quot; &lt;3 &#039;x&apos;</div>\n",
    objectName = "Red fox",
    artist = "<a href=\"//commons.wikimedia.org/wiki/User:Jane\" title=\"User:Jane\">Jane Doe</a>",
    license = "CC BY-SA 4.0")

proc foxAnswer(url: string): tuple[code: int, body: string] =
  ## A PDF first (not an image), then a page without imageinfo, then the fox.
  (200, query(
    page("File:Annual report.pdf", mockBase() & "/img/report.pdf.jpg", mime = "application/pdf"),
    %*{"pageid": 7, "ns": 6, "title": "File:Missing.jpg", "missing": true},
    foxPage()))

proc today(): string = now().format("yyyy-MM-dd")

type Harness = object
  config: FrameConfig
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(width = 200, height = 120, rotate = 0, debug = true, assetsPath = "/tmp",
    saveAssets = false): Harness =
  apiCalls = @[]
  discard imageRequests()
  apiAnswer = foxAnswer
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: width, height: height, rotate: rotate, scalingMode: "cover", debug: debug,
    saveAssets: %*saveAssets, assetsPath: assetsPath, settings: %*{})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/wikicommons-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 12.NodeId, nodeName: "data/wikicommons", appKeyword: "wikicommons", scene: scene,
    frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    settingsKeys = @[], sourceName = "app.ts",
    sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  Harness(config: config, scene: scene, owner: owner, runtime: runtime, logs: logs)

proc render(h: Harness, config: JsonNode, width = 200, height = 120, hasImage = true): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: hasImage,
    image: (if hasImage: newImage(width, height) else: nil), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, withDefaults(config), context)

proc logged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if ($entry).contains(needle):
      return true
  false

proc errors(h: Harness): seq[string] =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:"):
      result.add(entry{"error"}.getStr())

proc errorLogged(h: Harness, needle: string): bool =
  for error in h.errors():
    if error.contains(needle):
      return true
  false

proc failure(h: Harness, config: JsonNode, width = 200, height = 120): string =
  ## A failure is thrown, as the Nim app raised: the runtime logs "JS app get
  ## failed: <message>" and raises it, and the interpreter paints the message
  ## into the consumer's image. Returns the message ("" when nothing threw).
  try:
    discard h.render(config, width, height)
  except JsAppError as e:
    result = e.msg
    doAssert h.errorLogged("JS app get failed: " & e.msg), e.msg

proc potdDate(call: ApiCall): DateTime =
  let title = call.param("titles")
  doAssert title.startsWith("Template:Potd/"), title
  parse(title["Template:Potd/".len .. ^1], "yyyy-MM-dd")

proc savedFiles(dir: string): seq[string] =
  if dirExists(dir):
    for file in walkDirRec(dir):
      result.add(file)

suite "wikicommons code app":
  test "init trims text fields":
    let h = newHarness()
    let value = h.render(%*{"mode": "  pictureOfTheDay  ", "submode": "  day  ", "metadataStateKey": "  commons  "})
    check value.kind == fkImage
    check apiCalls.len == 1
    check apiCalls[0].url == potdUrl(today(), 200)
    check h.scene.state.hasKey("commons")
    check h.scene.state["commons"]["mode"].getStr() == "pictureOfTheDay"

  test "invalid mode fails the node":
    let h = newHarness(width = 10, height = 6, debug = false)
    check h.failure(%*{"mode": "not-a-mode", "metadataStateKey": "meta"}, width = 15, height = 9) ==
      "Error fetching image from Wikimedia Commons: Invalid Wikimedia Commons mode: not-a-mode"
    check not h.scene.state.hasKey("meta")
    check apiCalls.len == 0
    var errorEvents: seq[string] = @[]
    for entry in h.logs[]:
      if entry{"event"}.getStr().startsWith("error:"):
        errorEvents.add(entry["event"].getStr())
    check errorEvents == @["error:12:data/wikicommons"]

  test "picture of the day: the request, the image download and the metadata":
    let h = newHarness()
    let value = h.render(%*{"metadataStateKey": "commons"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    check apiCalls.len == 1
    let call = apiCalls[0]
    check call.url == potdUrl(today(), 200)
    check call.url.contains("&titles=Template%3APotd%2F" & today() & "&")
    check call.url.contains("&iiprop=url%7Cmime%7Cextmetadata&" &
      "iiextmetadatafilter=ImageDescription%7CObjectName%7CArtist%7CLicenseShortName&iiurlwidth=200")
    check call.httpMethod == "GET"
    check call.header("Accept") == "application/json"
    check call.header("User-Agent") == CommonsUserAgent
    let imageUrl = mockBase() & "/img/960px-Red_fox.JPEG?v=1"
    check imageRequests() == @["/img/960px-Red_fox.JPEG?v=1\t" & CommonsUserAgent]
    check h.scene.state["commons"] == %*{
      "source": "wikimedia-commons",
      "mode": "pictureOfTheDay",
      "title": "File:Red fox (Vulpes vulpes).jpg",
      "description": "A red fox & \"friends\" <3 'x'",
      "author": "Jane Doe",
      "license": "CC BY-SA 4.0",
      "pageUrl": "https://commons.wikimedia.org/wiki/File:Red_fox_(Vulpes_vulpes).jpg",
      "imageUrl": imageUrl,
      "mime": "image/jpeg"
    }
    check h.logged("Downloading Wikimedia Commons image: " & imageUrl)
    check h.errors().len == 0
    check h.runtime.images.len == 0

  test "the thumbnail width is the longer side of the canvas, which a turned frame hands over turned":
    let h = newHarness(width = 200, height = 120, rotate = 90)
    check h.render(%*{}, width = 120, height = 300).kind == fkImage
    check h.render(%*{}, width = 120, height = 200).kind == fkImage
    check not appSource.contains("rotate")
    check apiCalls.len == 2
    check apiCalls[0].param("iiurlwidth") == "300"
    check apiCalls[1].param("iiurlwidth") == "200"

  test "an ESP32 asks for the whole panel too":
    # It used to ask for at most 900 px, which a 13.3" panel stretched to
    # 1600. The decode streams into the canvas and clamps itself to the
    # memory budget, so a larger source never costs it the frame.
    setSimulatedEmbedded(true)
    defer: setSimulatedEmbedded(false)
    let h = newHarness(width = 1200, height = 1600)
    check h.render(%*{}, width = 1200, height = 1600).kind == fkImage
    check apiCalls.len == 1
    check apiCalls[0].param("iiurlwidth") == "1600"

  test "on this day: today's month and day in an earlier year":
    let h = newHarness()
    let current = now()
    for _ in 0 ..< 5:
      check h.render(%*{"mode": "onThisDay", "metadataStateKey": "commons"}).kind == fkImage
    check apiCalls.len == 5
    for call in apiCalls:
      let date = call.potdDate()
      check date.monthday == current.monthday
      check date.month == current.month
      check date.year >= 2008
      check date.year <= max(2008, current.year - 1)
    check h.scene.state["commons"]["mode"].getStr() == "onThisDay"

  test "random picture of the day: legal dates, ten attempts, then the last error":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, query())
    let current = now()
    let todayStart = dateTime(current.year, current.month, current.monthday, zone = utc())
    for _ in 0 ..< 3:
      check h.failure(%*{"mode": "randomPictureOfTheDay", "metadataStateKey": "commons"}) ==
        "Error fetching image from Wikimedia Commons: Could not find a random Wikimedia Commons " &
        "picture of the day: No supported image returned from Wikimedia Commons."
    check apiCalls.len == 30
    for call in apiCalls:
      let date = call.potdDate()
      check date.year >= 2008
      check dateTime(date.year, date.month, date.monthday, zone = utc()) <= todayStart
    check not h.scene.state.hasKey("commons")
    check imageRequests().len == 0

  test "random picture of the day: an attempt that fails is retried":
    let h = newHarness()
    var answered = 0
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      inc answered
      if answered == 1:
        return (code: 500, body: "oops")
      if answered == 2:
        return (code: 200, body: """{"error": {"code": "badvalue", "info": "Bad title"}}""")
      foxAnswer(url)
    check h.render(%*{"mode": "randomPictureOfTheDay", "metadataStateKey": "commons"}).kind == fkImage
    check apiCalls.len == 3
    check h.scene.state["commons"]["mode"].getStr() == "randomPictureOfTheDay"
    check h.scene.state["commons"]["title"].getStr() == "File:Red fox (Vulpes vulpes).jpg"
    check h.errors().len == 0

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, """{"error": {"code": "badvalue", "info": "Bad title"}}""")
    check h.failure(%*{"mode": "randomPictureOfTheDay"}) == "Error fetching image from Wikimedia Commons: " &
      "Could not find a random Wikimedia Commons picture of the day: Wikimedia Commons API error: Bad title"

  test "random image: the random generator, ten attempts, then the last error":
    let h = newHarness()
    check h.render(%*{"mode": "randomImage", "metadataStateKey": "commons"}).kind == fkImage
    check apiCalls.len == 1
    check apiCalls[0].url == randomUrl(200)
    check apiCalls[0].header("User-Agent") == CommonsUserAgent
    check h.scene.state["commons"]["mode"].getStr() == "randomImage"
    check imageRequests() == @["/img/960px-Red_fox.JPEG?v=1\t" & CommonsUserAgent]

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (503, "busy")
    apiCalls = @[]
    check h.failure(%*{"mode": "randomImage"}) == "Error fetching image from Wikimedia Commons: " &
      "Could not find a random Wikimedia Commons image: Wikimedia Commons API HTTP 503"
    check apiCalls.len == 10

  test "mode and submode aliases":
    let cases = [
      (%*{}, "pictureOfTheDay"),
      (%*{"mode": ""}, "pictureOfTheDay"),
      (%*{"mode": "potd"}, "pictureOfTheDay"),
      (%*{"mode": "potd", "submode": "day"}, "pictureOfTheDay"),
      (%*{"mode": "pictureOfTheDay", "submode": "onthisday"}, "onThisDay"),
      (%*{"mode": "potd", "submode": "onThisDay"}, "onThisDay"),
      (%*{"mode": "", "submode": "month"}, "randomPictureOfTheDay"),
      (%*{"mode": "potd", "submode": "random"}, "randomPictureOfTheDay"),
      (%*{"mode": "potd", "submode": "randomPotd"}, "randomPictureOfTheDay"),
      (%*{"mode": "potd", "submode": "randomPictureOfTheDay"}, "randomPictureOfTheDay"),
      (%*{"mode": "random"}, "randomImage"),
      (%*{"mode": "onThisDay", "submode": "ignored"}, "onThisDay"),
    ]
    for (config, mode) in cases:
      let h = newHarness()
      var withKey = config.copy()
      withKey["metadataStateKey"] = %"commons"
      check h.render(withKey).kind == fkImage
      check h.scene.state{"commons"}{"mode"}.getStr() == mode
      check apiCalls.len == 1
      if mode == "randomImage":
        check apiCalls[0].param("generator") == "random"
      else:
        check apiCalls[0].param("generator") == "images"
      if mode == "pictureOfTheDay":
        check apiCalls[0].url == potdUrl(today(), 200)

    let unknown = newHarness()
    check unknown.failure(%*{"mode": "potd", "submode": "bogus"}) ==
      "Error fetching image from Wikimedia Commons: Invalid Wikimedia Commons mode: potd"
    check apiCalls.len == 0

  test "API errors fail the node with the message":
    const Prefix = "Error fetching image from Wikimedia Commons: "
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] = (500, "Internal error")
    check h.failure(%*{"metadataStateKey": "commons"}) == Prefix & "Wikimedia Commons API HTTP 500"
    check apiCalls.len == 1

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, """{"error": {"code": "badvalue", "info": "Unrecognized value for parameter \"generator\""}}""")
    check h.failure(%*{}) == Prefix & "Wikimedia Commons API error: Unrecognized value for parameter \"generator\""

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, """{"error": {"code": "x"}}""")
    check h.failure(%*{}) == Prefix & """Wikimedia Commons API error: {"code":"x"}"""

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, """{"error": null}""")
    check h.failure(%*{}) == Prefix & "Wikimedia Commons API error: null"

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      raise newException(IOError, "connection refused")
    check h.failure(%*{}) == Prefix & "connection refused"

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, "<html>not json</html>")
    check h.failure(%*{}).startsWith(Prefix)

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, """{"batchcomplete": true}""")
    check h.failure(%*{}) == Prefix & "No supported image returned from Wikimedia Commons."

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, query(page("File:Clip.webm", mockBase() & "/img/clip.webm.jpg", mime = "video/webm"),
        page("File:Empty.jpg", "")))
    check h.failure(%*{"metadataStateKey": "commons"}) == Prefix & "No supported image returned from Wikimedia Commons."
    check not h.scene.state.hasKey("commons")
    check imageRequests().len == 0

  test "a failed download fails the node and records no metadata":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, query(page("File:Gone.jpg", mockBase() & "/gone/Gone.jpg")))
    check h.failure(%*{"metadataStateKey": "commons"}) == "Error fetching image from Wikimedia Commons: 404 Not Found"
    check not h.scene.state.hasKey("commons")
    check imageRequests() == @["/gone/Gone.jpg\t" & CommonsUserAgent]

  test "metadata: the object name stands in for a missing description, the original URL for a missing thumbnail":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, query(page("File:Tower.png", mockBase() & "/img/Tower.png", mime = "image/png",
        objectName = " <i>Eiffel</i> Tower ", urlKey = "url")))
    check h.render(%*{"metadataStateKey": "commons"}).kind == fkImage
    let meta = h.scene.state["commons"]
    check meta["description"].getStr() == "Eiffel Tower"
    check meta["author"].getStr() == ""
    check meta["license"].getStr() == ""
    check meta["imageUrl"].getStr() == mockBase() & "/img/Tower.png"
    check meta["mime"].getStr() == "image/png"

  test "HTML stripping as the Nim app did it: stray '>' dropped, an open tag runs to the end, &amp; decoded first":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, query(page("File:Cat.jpg", mockBase() & "/img/Cat.jpg",
        description = "Tom > Jerry <i>cat &amp;lt;3 &amp;quot;q&amp;quot; <unclosed")))
    check h.render(%*{"metadataStateKey": "commons"}).kind == fkImage
    check h.scene.state["commons"]["description"].getStr() == "Tom  Jerry cat <3 &quot;q&quot;"

  test "debug off: no download log":
    let h = newHarness(debug = false)
    check h.render(%*{}).kind == fkImage
    check not h.logged("Downloading Wikimedia Commons image:")

  test "saved assets: the title without File:, the extension from the URL or the MIME type":
    let assetsDir = getTempDir() / "frameos-wikicommons-js-app-save"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let savedDir = assetsDir / "saved" / "wikicommons"

    let auto = newHarness(assetsPath = assetsDir, saveAssets = true)
    check auto.render(%*{"saveAssets": "auto"}).kind == fkImage
    var saved = savedFiles(savedDir)
    check saved.len == 1
    # cleanFilename keeps letters, digits, '-', '_' and single spaces.
    check saved[0].extractFilename().startsWith("Red fox Vulpes vulpesjpg.")
    check saved[0].endsWith(".jpg")
    check readFile(saved[0]) == pngBytes(5, 3)

    let never = newHarness(assetsPath = assetsDir, saveAssets = true)
    check never.render(%*{"saveAssets": "never"}).kind == fkImage
    let autoOff = newHarness(assetsPath = assetsDir, saveAssets = false)
    check autoOff.render(%*{"saveAssets": "auto"}).kind == fkImage
    check savedFiles(savedDir).len == 1

    let cases = [
      ("File:Diagram.svg", "/img/600px-Diagram.svg.png", "image/svg+xml", ".png"),
      ("File:Scan one", "/img/scan?id=1", "image/png", ".png"),
      ("File:Scan two", "/img/scan?id=2", "image/gif", ".gif"),
      ("File:Scan three", "/img/scan?id=3", "image/webp", ".webp"),
      ("File:Scan four", "/img/scan?id=4", "image/jpeg", ".jpg"),
      ("File:Scan five", "/img/scan?id=5", "image/svg+xml", ".svg"),
      ("File:Scan six", "/img/scan?id=6", "image/tiff", ".img"),
      ("File:Photo.webp", "/img/Photo.WEBP", "image/webp", ".webp"),
      ("File:Anim.gif", "/img/Anim.gif?x=.png", "image/gif", ".gif"),
    ]
    for (title, path, mime, ext) in cases:
      let always = newHarness(assetsPath = assetsDir, saveAssets = false)
      apiAnswer = proc(url: string): tuple[code: int, body: string] =
        (200, query(page(title, mockBase() & path, mime = mime)))
      check always.render(%*{"saveAssets": "always"}).kind == fkImage
      var found = ""
      let base = title.replace("File:", "").replace(".", "")
      for file in savedFiles(savedDir):
        if file.extractFilename().startsWith(base & "."):
          found = file
      check found.len > 0
      check found.endsWith(ext)
      if not found.endsWith(ext):
        echo title, " -> ", found

  test "stop the mock server":
    discard boundedGetContent(mockBase() & "/quit")
