## The Unsplash code app (repo/apps/image/unsplash) run for real through the JS
## app runtime. The API host is fixed, so `frameos.httpRequest` is answered by
## `jsHttpRequestHook`; the photo URL the API returns points at a mock image
## server on a thread, so the download, the size suffix it gets and the saved
## asset are the real thing. Ports data/unsplash's own tests and covers every
## orientation, the failures, the metadata state and the saved asset.

import std/[json, net, os, strutils, tables, unittest, uri]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "unsplash"
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

## Mock image host on a thread: /img/... answers a 5x3 PNG, anything else 404.
## Every request it sees goes to `mockRequests` as its path.
var mockPort: Port
var mockThread: Thread[void]
var mockRequests: Channel[string]

proc pngBytes(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgba(200, 40, 40, 255))
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
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
    except CatchableError:
      client.close()
      continue
    let parts = requestLine.splitWhitespace()
    let path = if parts.len >= 2: parts[1] else: "/"
    if path == "/quit":
      client.reply("200 OK", "text/plain", "")
      break
    mockRequests.send(path)
    if path.startsWith("/img/"):
      client.reply("200 OK", "image/png", pngBytes(5, 3))
    else:
      client.reply("404 Not Found", "text/plain", "no such image")
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
    let (ok, path) = mockRequests.tryRecv()
    if not ok:
      break
    result.add(path)

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

proc photoJson(rawUrl: string, slug = "a-red-fox-abc123", description = "null"): string =
  """{"id": "abc123", "slug": """ & (if slug.len > 0: "\"" & slug & "\"" else: "null") &
    """, "created_at": "2024-01-02T03:04:05Z", "description": """ & description &
    """, "alt_description": "a red fox in the snow", "location": {"name": "Tallinn, Estonia", "city": "Tallinn"},
    "urls": {"raw": """" & rawUrl & """", "full": "https://images.unsplash.com/full"},
    "links": {"html": "https://unsplash.com/photos/abc123", "download": "https://unsplash.com/photos/abc123/download"},
    "user": {"name": "Jane Doe", "username": "jane", "links": {"html": "https://unsplash.com/@jane"},
      "profile_image": {"small": "https://images.unsplash.com/profile"}}}"""

proc rawUrl(): string = mockBase() & "/img/photo-abc123?ixid=xyz"

proc expectedApiUrl(orientation, search: string): string =
  # The Nim app's own encoding (std/uri encodeUrl: space as '+').
  "https://api.unsplash.com/photos/random/?orientation=" & encodeUrl(orientation) & "&query=" & encodeUrl(search)

type Harness = object
  config: FrameConfig
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(accessKey = "key-1", width = 200, height = 120, rotate = 0, debug = true,
    assetsPath = "/tmp", saveAssets = false): Harness =
  apiCalls = @[]
  discard imageRequests()
  apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, photoJson(rawUrl()))
  var logs = new(seq[JsonNode])
  let settings = if accessKey.len > 0: %*{"unsplash": {"accessKey": accessKey}} else: %*{}
  let config = FrameConfig(width: width, height: height, rotate: rotate, scalingMode: "cover", debug: debug,
    saveAssets: %*saveAssets, assetsPath: assetsPath, settings: settings)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/unsplash-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 6.NodeId, nodeName: "data/unsplash", appKeyword: "unsplash", scene: scene,
    frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    settingsKeys = @["unsplash"], sourceName = "app.ts",
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

proc savedFiles(dir: string): seq[string] =
  if dirExists(dir):
    for file in walkDirRec(dir):
      result.add(file)

suite "unsplash code app":
  test "init trims text fields":
    let h = newHarness()
    let value = h.render(%*{"search": "  blue sky  ", "metadataStateKey": "  meta  "})
    check value.kind == fkImage
    check apiCalls.len == 1
    check apiCalls[0].url == expectedApiUrl("landscape", "blue sky")
    check apiCalls[0].url.endsWith("&query=blue+sky")
    check h.scene.state.hasKey("meta")
    check h.scene.state["meta"]["search"].getStr() == "blue sky"

  test "missing api key fails the node":
    let h = newHarness(accessKey = "", width = 10, height = 6, debug = false)
    check h.failure(%*{"search": "cats", "metadataStateKey": "meta"}, width = 15, height = 9) ==
      "Please provide an Unsplash API key in the settings."
    check not h.scene.state.hasKey("meta")
    check apiCalls.len == 0
    var errorEvents: seq[string] = @[]
    for entry in h.logs[]:
      if entry{"event"}.getStr().startsWith("error:"):
        errorEvents.add(entry["event"].getStr())
    check errorEvents == @["error:6:data/unsplash"]

  test "a random photo: the API call, the sized photo URL and the metadata":
    let h = newHarness()
    let value = h.render(%*{"metadataStateKey": "photo"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    check apiCalls.len == 1
    let call = apiCalls[0]
    # No search configured: the field's default.
    check call.url == "https://api.unsplash.com/photos/random/?orientation=landscape&query=nature"
    check call.httpMethod == "GET"
    check call.header("Authorization") == "Client-ID key-1"
    check call.header("Accept-Version") == "v1"
    check call.header("Content-Type") == "application/json"
    let sizedUrl = rawUrl() & "&w=200&h=120&fit=crop&crop=faces,edges"
    check imageRequests() == @["/img/photo-abc123?ixid=xyz&w=200&h=120&fit=crop&crop=faces,edges"]
    check h.scene.state["photo"] == %*{
      "source": "unsplash",
      "search": "nature",
      "orientation": "landscape",
      "imageUrl": sizedUrl,
      "id": "abc123",
      "title": "a-red-fox-abc123",
      "description": "a red fox in the snow",
      "altDescription": "a red fox in the snow",
      "location": "Tallinn, Estonia",
      "createdAt": "2024-01-02T03:04:05Z",
      "photoUrl": "https://unsplash.com/photos/abc123",
      "author": "Jane Doe",
      "authorUsername": "jane",
      "authorUrl": "https://unsplash.com/@jane"
    }
    check h.logged("API request: https://api.unsplash.com/photos/random/?orientation=landscape&query=nature")
    check h.logged("Downloading image: " & sizedUrl)
    check h.errors().len == 0
    check h.runtime.images.len == 0

  test "metadata: description wins over alt_description, a missing slug falls back to it, nulls are empty":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, """{"id": "x1", "slug": null, "description": "Sunset over the bay", "alt_description": null,
        "location": {"name": null}, "urls": {"raw": """" & rawUrl() & """"}, "user": {"name": "Ann"}}""")
    check h.render(%*{"metadataStateKey": "photo"}).kind == fkImage
    let meta = h.scene.state["photo"]
    check meta["title"].getStr() == "Sunset over the bay"
    check meta["description"].getStr() == "Sunset over the bay"
    check meta["altDescription"].getStr() == ""
    check meta["location"].getStr() == ""
    check meta["createdAt"].getStr() == ""
    check meta["photoUrl"].getStr() == ""
    check meta["author"].getStr() == "Ann"
    check meta["authorUsername"].getStr() == ""
    check meta["authorUrl"].getStr() == ""

  test "no metadata state key, no state":
    let h = newHarness()
    check h.render(%*{"search": "cats"}).kind == fkImage
    check h.scene.state.len == 0

  test "orientation: auto follows the context image, any sends none, the rest go as they are":
    let h = newHarness()
    check h.render(%*{"orientation": "auto"}, width = 120, height = 200).kind == fkImage
    check h.render(%*{"orientation": "auto"}, width = 100, height = 100).kind == fkImage
    check h.render(%*{"orientation": "auto"}, width = 300, height = 100).kind == fkImage
    check h.render(%*{"orientation": "any"}).kind == fkImage
    check h.render(%*{"orientation": "portrait"}).kind == fkImage
    check h.render(%*{"orientation": "squarish"}).kind == fkImage
    check h.render(%*{"orientation": "landscape"}, width = 120, height = 200).kind == fkImage
    var orientations: seq[string] = @[]
    for call in apiCalls:
      orientations.add(call.url.split("orientation=")[1].split("&")[0])
    check orientations == @["portrait", "squarish", "landscape", "", "portrait", "squarish", "landscape"]
    check imageRequests() == @[
      "/img/photo-abc123?ixid=xyz&w=120&h=200&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=100&h=100&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=300&h=100&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=200&h=120&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=200&h=120&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=200&h=120&fit=crop&crop=faces,edges",
      "/img/photo-abc123?ixid=xyz&w=120&h=200&fit=crop&crop=faces,edges",
    ]

  test "a turned frame hands the app a turned canvas; the app reads no rotation itself":
    let h = newHarness(width = 200, height = 120, rotate = 90)
    check h.render(%*{"metadataStateKey": "photo"}, width = 120, height = 200).kind == fkImage
    check not appSource.contains("rotate")
    check apiCalls[0].url == expectedApiUrl("portrait", "nature")
    check imageRequests() == @["/img/photo-abc123?ixid=xyz&w=120&h=200&fit=crop&crop=faces,edges"]
    check h.scene.state["photo"]["orientation"].getStr() == "portrait"

  test "the search is URL-encoded the way the Nim app did":
    let h = newHarness()
    let search = "blue sky & (more)!*'~ ü"
    check h.render(%*{"search": search}).kind == fkImage
    check apiCalls[0].url == expectedApiUrl("landscape", search)

  test "an API error fails with the error message, the error string or the body":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (401, """{"errors": ["OAuth error: The access token is invalid"]}""")
    check h.failure(%*{"metadataStateKey": "photo"}) ==
      """Error making request 401: {"errors":["OAuth error: The access token is invalid"]}"""
    check not h.scene.state.hasKey("photo")

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (403, """{"error": {"message": "Rate limit exceeded"}}""")
    check h.failure(%*{}) == "Error making request 403: Rate limit exceeded"

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (404, """{"error": "Not found"}""")
    check h.failure(%*{}) == "Error making request 404: Not found"

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (500, """{"error": {"message": 42}}""")
    check h.failure(%*{}) == """Error making request 500: {"error":{"message":42}}"""

    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (503, "Service Unavailable")
    check h.failure(%*{}) == "Error making request 503: Service Unavailable"
    check imageRequests().len == 0

  test "a failed request, a body that is not JSON and a missing photo URL fail the node":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      raise newException(IOError, "connection refused")
    check h.failure(%*{"metadataStateKey": "photo"}) == "Error fetching image from Unsplash: connection refused"

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, "<html>oops</html>")
    check h.failure(%*{"metadataStateKey": "photo"}).startsWith("Error fetching image from Unsplash: ")

    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, """{"id": "x", "urls": {}}""")
    check h.failure(%*{"metadataStateKey": "photo"}) == "No image URL returned from Unsplash."
    apiAnswer = proc(url: string): tuple[code: int, body: string] = (200, "null")
    check h.failure(%*{"metadataStateKey": "photo"}) == "No image URL returned from Unsplash."
    check not h.scene.state.hasKey("photo")
    check imageRequests().len == 0

  test "a failed download fails the node and records no metadata":
    let h = newHarness()
    apiAnswer = proc(url: string): tuple[code: int, body: string] =
      (200, photoJson(mockBase() & "/gone/photo?ixid=1"))
    check h.failure(%*{"metadataStateKey": "photo"}) == "Error fetching image from Unsplash: 404 Not Found"
    check not h.scene.state.hasKey("photo")
    check imageRequests() == @["/gone/photo?ixid=1&w=200&h=120&fit=crop&crop=faces,edges"]

  test "debug off: no request logs":
    let h = newHarness(debug = false)
    check h.render(%*{}).kind == fkImage
    check not h.logged("API request:")
    check not h.logged("Downloading image:")

  test "saved assets: named after the search and size, .jpg, honoring auto/always/never":
    let assetsDir = getTempDir() / "frameos-unsplash-js-app-save"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let savedDir = assetsDir / "saved" / "unsplash"

    let auto = newHarness(assetsPath = assetsDir, saveAssets = true)
    check auto.render(%*{"search": "red fox", "saveAssets": "auto"}).kind == fkImage
    let saved = savedFiles(savedDir)
    check saved.len == 1
    check saved[0].extractFilename().startsWith("red fox 200x120.")
    check saved[0].endsWith(".jpg")
    check readFile(saved[0]) == pngBytes(5, 3)

    let never = newHarness(assetsPath = assetsDir, saveAssets = true)
    check never.render(%*{"search": "owls", "saveAssets": "never"}).kind == fkImage
    check savedFiles(savedDir).len == 1

    let autoOff = newHarness(assetsPath = assetsDir, saveAssets = false)
    check autoOff.render(%*{"search": "owls", "saveAssets": "auto"}).kind == fkImage
    check savedFiles(savedDir).len == 1

    let always = newHarness(assetsPath = assetsDir, saveAssets = false)
    check always.render(%*{"search": "owls", "saveAssets": "always"}, width = 120, height = 200).kind == fkImage
    var names: seq[string] = @[]
    for file in savedFiles(savedDir):
      names.add(file.extractFilename())
    check names.len == 2
    var foundOwls = false
    for name in names:
      if name.startsWith("owls 120x200.") and name.endsWith(".jpg"):
        foundOwls = true
    check foundOwls

  test "stop the mock server":
    discard boundedGetContent(mockBase() & "/quit")
