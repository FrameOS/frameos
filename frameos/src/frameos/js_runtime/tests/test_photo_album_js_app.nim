## The Photo album code app (repo/apps/image/photoAlbum) run for real through
## the JS app runtime, against a mock of the Photos share routes
## (docs/photos.md, "Share routes") on a thread: the counter in scene state,
## the order, root-relative and absolute photo addresses, a CDN redirect, a
## photo's color profile, an empty album, a dead link and the setup mistakes.

import std/[json, net, os, strutils, tables, unittest, uri]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/asset_colors
import frameos/utils/dither
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "photoAlbum"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

## Mock share routes on a thread. The token picks the album:
##   pk_rel    three photos, root-relative urls
##   pk_abs    three photos, absolute urls
##   pk_cdn    three photos whose /file answers 302 to /cdn/...
##   pk_colors three photos; a.jpg has a color profile (one stop up and a
##             two-color palette), b.jpg `colors: null`, c.jpg no key at all
##   pk_empty  no photos
##   pk_broken one photo whose file is gone
##   pk_loop   three photos whose /file redirects to itself forever
## any other token is a 404, like a deleted link. Photo i is a PNG of
## (5 + i) x (3 + i) pixels, so the image size says which one was shown.
var mockPort: Port
var mockThread: Thread[void]

const Names = ["a.jpg", "b.jpg", "c.jpg"]

proc pngBytes(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgba(40, 120, 200, 255))
  encodeImage(image, PngFormat)

proc reply(client: Socket, status: string, contentType: string, body: string, extra = "") =
  client.send("HTTP/1.1 " & status & "\r\nContent-Type: " & contentType & "\r\n" & extra &
    "Content-Length: " & $body.len & "\r\nConnection: close\r\n\r\n" & body)
  client.close()

proc queryParam(query: string, name: string): string =
  for (key, value) in decodeQuery(query):
    if key == name:
      return value
  ""

proc photoAt(token: string, order: string, index: int, base: string): JsonNode =
  ## `sequential` and `oldest` keep the list order, `newest` reverses it,
  ## anything else (`random`, the default) starts one photo later: enough to
  ## tell which order the app asked for.
  var i = index mod Names.len
  if order == "newest":
    i = Names.len - 1 - i
  elif order notin ["sequential", "oldest"]:
    i = (i + 1) mod Names.len
  let path = "beach/" & Names[i]
  let fileUrl = "/api/photos/shared/" & token & "/file?path=" & encodeUrl(path)
  result = %*{"path": path, "name": Names[i], "url": (if token == "pk_abs": base & fileUrl else: fileUrl),
     "size": 1234, "mtime": 1760000000 + i, "width": 5 + i, "height": 3 + i,
     "content_type": "image/png"}
  if token == "pk_colors" and i < 2:
    result["colors"] = if i == 0: %*{"exposure": 1, "palette": ["#000000", "#ffffff"]} else: newJNull()

proc mockPhotosLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  mockPort = boundPort
  let base = "http://127.0.0.1:" & $int(boundPort)

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
    let target = if parts.len >= 2: parts[1] else: "/"
    if target == "/quit":
      client.reply("200 OK", "text/plain", "")
      break
    let parsed = parseUri(target)
    let query = parsed.query

    if parsed.path.startsWith("/cdn/"):
      let i = Names.find(parsed.path["/cdn/".len..^1])
      if i >= 0:
        client.reply("200 OK", "image/png", pngBytes(5 + i, 3 + i))
      else:
        client.reply("404 Not Found", "text/plain", "gone")
      continue

    let segments = parsed.path.split('/')
    # "", "api", "photos", "shared", token, route
    if segments.len != 6 or segments[1] != "api" or segments[2] != "photos" or segments[3] != "shared":
      client.reply("404 Not Found", "application/json", """{"detail":"Not Found"}""")
      continue
    let token = segments[4]
    let route = segments[5]
    if token notin ["pk_rel", "pk_abs", "pk_cdn", "pk_colors", "pk_empty", "pk_broken", "pk_loop"]:
      client.reply("404 Not Found", "application/json", """{"detail":"Share link not found"}""")
      continue

    if route == "photo" and queryParam(query, "path") != "":
      # One named photo (a single-photo scene): index and order are ignored.
      let name = queryParam(query, "path").split('/')[^1]
      let i = Names.find(name)
      if i < 0 or token == "pk_empty":
        client.reply("404 Not Found", "application/json", """{"detail":"Not Found"}""")
      else:
        var photo = photoAt(token, "sequential", i, base)
        photo["path"] = %queryParam(query, "path")
        client.reply("200 OK", "application/json", $(%*{"index": 0, "count": 1, "photo": photo}))
    elif route == "photo":
      let index = parseInt(queryParam(query, "index"))
      if token == "pk_empty":
        client.reply("200 OK", "application/json", $(%*{"index": index, "count": 0, "photo": newJNull()}))
      elif token == "pk_broken":
        client.reply("200 OK", "application/json", $(%*{"index": index, "count": 1, "photo":
          {"path": "broken.jpg", "name": "broken.jpg", "url": "/api/photos/shared/pk_broken/file?path=broken.jpg"}}))
      elif queryParam(query, "shapes") != "" and "landscape" notin queryParam(query, "shapes").split(','):
        # `shapes`: every mock photo is landscape, so a choice without it finds none.
        client.reply("200 OK", "application/json", $(%*{"index": index, "count": 0, "photo": newJNull()}))
      else:
        client.reply("200 OK", "application/json",
          $(%*{"index": index, "count": Names.len, "photo": photoAt(token, queryParam(query, "order"), index, base)}))
    elif route == "file":
      let name = queryParam(query, "path").split('/')[^1]
      let i = Names.find(name)
      if i < 0:
        client.reply("404 Not Found", "application/json", """{"detail":"Not Found"}""")
      elif token == "pk_cdn":
        client.reply("302 Found", "text/plain", "", "Location: " & base & "/cdn/" & name & "\r\n")
      elif token == "pk_loop":
        client.reply("302 Found", "text/plain", "", "Location: " & target & "\r\n")
      else:
        client.reply("200 OK", "image/png", pngBytes(5 + i, 3 + i))
    else:
      client.reply("404 Not Found", "application/json", """{"detail":"Not Found"}""")

  server.close()

var mockStarted = false

proc mockBase(): string =
  if not mockStarted:
    mockStarted = true
    createThread(mockThread, mockPhotosLoop)
    for _ in 0 ..< 100:
      if int(mockPort) != 0:
        break
      sleep(20)
  doAssert int(mockPort) != 0
  "http://127.0.0.1:" & $int(mockPort)

proc shareLink(token: string): string =
  mockBase() & "/api/photos/shared/" & token

type Harness = object
  config: FrameConfig
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(): Harness =
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp", settings: %*{})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/photo-album-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "photoAlbum", appKeyword: "photoAlbum", scene: scene, frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    sourceName = "app.ts", sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  Harness(config: config, scene: scene, owner: owner, runtime: runtime, logs: logs)

proc render(h: Harness, config: JsonNode): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: true,
    image: newImage(200, 120), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, config, context)

proc size(value: Value): (int, int) =
  ## (-1, -1) when the app returned no image.
  if value.kind != fkImage:
    return (-1, -1)
  (value.asImage().width, value.asImage().height)

proc logged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if ($entry).contains(needle):
      return true
  false

proc errorLogged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:") and entry{"error"}.getStr().contains(needle):
      return true
  false

proc anyErrorLogged(h: Harness): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:"):
      return true
  false

suite "photo album code app":
  test "each render shows the next photo and advances the counter in scene state":
    let h = newHarness()
    # A trailing slash on the link is dropped.
    let config = %*{"album": shareLink("pk_rel") & "/", "order": "sequential", "counterStateKey": "photoIndex"}
    check h.render(config).size() == (5, 3)
    check h.scene.state["photoIndex"].getInt() == 1
    check h.logged("Showing a.jpg (1 of 3)")
    check h.render(config).size() == (6, 4)
    check h.scene.state["photoIndex"].getInt() == 2
    check h.render(config).size() == (7, 5)
    check h.render(config).size() == (5, 3)
    check h.scene.state["photoIndex"].getInt() == 4
    check not h.anyErrorLogged()
    check h.runtime.images.len == 0

  test "one photo by path is asked for by path, and the counter stays put":
    let h = newHarness()
    h.scene.state["photoIndex"] = %7
    let config = %*{"album": shareLink("pk_rel"), "order": "newest", "counterStateKey": "photoIndex", "photo": "beach/c.jpg"}
    check h.render(config).size() == (7, 5)
    check h.render(config).size() == (7, 5)
    check h.scene.state["photoIndex"].getInt() == 7
    check h.logged("Showing c.jpg")
    check not h.logged("of 3")
    check not h.anyErrorLogged()
    # A photo that left the album says so.
    check h.render(%*{"album": shareLink("pk_rel"), "photo": "beach/zzz.jpg"}).size() == (200, 120)
    check h.errorLogged("no longer in the album")

  test "the order and a counter left as a string reach the share route":
    let h = newHarness()
    h.scene.state["position"] = %"1"
    let config = %*{"album": shareLink("pk_rel"), "order": "newest", "counterStateKey": "position"}
    check h.render(config).size() == (6, 4)
    check h.scene.state["position"].getInt() == 2
    check h.render(config).size() == (5, 3)

    # Garbage in the counter starts over at 0; an unknown or missing order is
    # random.
    let g = newHarness()
    g.scene.state["photoIndex"] = %"soon"
    check g.render(%*{"album": shareLink("pk_rel"), "order": "shuffle", "counterStateKey": "photoIndex"}).size() == (6, 4)
    check g.scene.state["photoIndex"].getInt() == 1
    g.scene.state["photoIndex"] = %(-4)
    check g.render(%*{"album": shareLink("pk_rel"), "counterStateKey": "photoIndex"}).size() == (6, 4)
    check g.render(%*{"album": shareLink("pk_rel"), "order": "oldest", "counterStateKey": "photoIndex"}).size() == (6, 4)
    check g.scene.state["photoIndex"].getInt() == 2

  test "absolute photo addresses are used as they are, a CDN redirect is followed":
    let h = newHarness()
    check h.render(%*{"album": shareLink("pk_abs"), "order": "sequential", "counterStateKey": "photoIndex"}).size() == (5, 3)
    let cdn = newHarness()
    cdn.scene.state["photoIndex"] = %2
    check cdn.render(%*{"album": shareLink("pk_cdn"), "order": "sequential", "counterStateKey": "photoIndex"}).size() == (7, 5)
    check cdn.scene.state["photoIndex"].getInt() == 3
    check not h.anyErrorLogged()
    check not cdn.anyErrorLogged()

  test "a photo's color profile reaches the image, null clears the last one's palette":
    let h = newHarness()
    clearRenderPaletteOverride()
    let config = %*{"album": shareLink("pk_colors"), "order": "sequential", "counterStateKey": "photoIndex"}
    let graded = h.render(config)
    check graded.size() == (5, 3)
    # pngBytes is (40, 120, 200): one stop up doubles it, clipped at white.
    let pixel = graded.asImage().data[graded.asImage().dataIndex(2, 1)]
    check (pixel.r, pixel.g, pixel.b) == (80'u8, 240'u8, 255'u8)
    check isImageGraded(graded.asImage())
    check renderPaletteOverride == @[(0, 0, 0), (255, 255, 255)]

    let plain = h.render(config)
    check plain.size() == (6, 4)
    check plain.asImage().data[plain.asImage().dataIndex(2, 1)].b == 200
    check not isImageGraded(plain.asImage())
    check renderPaletteOverride.len == 0
    # A share route without the key (an older backend) is no profile too.
    setRenderPaletteOverride(@[(0, 0, 0), (255, 255, 255)])
    let older = h.render(config)
    check older.size() == (7, 5)
    check not isImageGraded(older.asImage())
    check renderPaletteOverride.len == 0
    check not h.anyErrorLogged()

  test "without a state field each render still shows a photo":
    let h = newHarness()
    let value = h.render(%*{"album": shareLink("pk_rel"), "order": "sequential", "counterStateKey": ""})
    check value.kind == fkImage
    check value.asImage().width in 5 .. 7
    check h.scene.state.len == 0

  test "an empty album paints a calm message and keeps the counter":
    let h = newHarness()
    h.scene.state["photoIndex"] = %5
    check h.render(%*{"album": shareLink("pk_empty"), "counterStateKey": "photoIndex"}).size() == (200, 120)
    check h.scene.state["photoIndex"].getInt() == 5
    check h.logged("This album has no photos yet.")
    check not h.anyErrorLogged()

  test "a deleted link says so and keeps the counter":
    let h = newHarness()
    h.scene.state["photoIndex"] = %5
    check h.render(%*{"album": shareLink("pk_revoked"), "counterStateKey": "photoIndex"}).size() == (200, 120)
    check h.scene.state["photoIndex"].getInt() == 5
    check h.errorLogged("This album link no longer works.")

  test "a photo that will not download still moves the album on":
    let h = newHarness()
    check h.render(%*{"album": shareLink("pk_broken"), "counterStateKey": "photoIndex"}).size() == (200, 120)
    check h.scene.state["photoIndex"].getInt() == 1
    check h.errorLogged("Could not load broken.jpg")

  test "a failed download never shows the share link or the photo's address":
    # The client gives up on the redirect loop with an error that names the
    # URL; the app draws that error and logs it. Neither may carry the token.
    let h = newHarness()
    check h.render(%*{"album": shareLink("pk_loop"), "order": "sequential", "counterStateKey": "photoIndex"}).size() == (200, 120)
    check h.errorLogged("Could not load a.jpg: Too many HTTP redirects fetching " & mockBase())
    check h.logs[].len > 0
    for entry in h.logs[]:
      check "pk_loop" notin $entry
      check "file?path" notin $entry

  test "an unreachable server names the problem":
    let h = newHarness()
    check h.render(%*{"album": "http://127.0.0.1:9/api/photos/shared/pk_rel", "counterStateKey": "photoIndex"}).size() == (200, 120)
    check h.errorLogged("Could not reach the album")
    check not h.scene.state.hasKey("photoIndex")

  test "the shape toggles reach the share route, and all off asks for nothing":
    let h = newHarness()
    let album = shareLink("pk_rel")
    # Every shape on (a boolean, or the "true" a state field hands over): no
    # `shapes` in the query, which is also what an older server understands.
    check h.render(%*{"album": album, "order": "sequential", "counterStateKey": "photoIndex",
      "landscape": true, "portrait": "true", "square": true}).size() == (5, 3)
    check h.scene.state["photoIndex"].getInt() == 1
    # Portrait only: the mock's photos are all landscape, so none match and
    # the counter stays put.
    check h.render(%*{"album": album, "order": "sequential", "counterStateKey": "photoIndex",
      "landscape": "false", "portrait": true, "square": false}).size() == (200, 120)
    check h.logged("This album has no photos of the chosen shapes.")
    check not h.anyErrorLogged()
    check h.scene.state["photoIndex"].getInt() == 1
    # Landscape among the chosen shapes: the album plays on.
    check h.render(%*{"album": album, "order": "sequential", "counterStateKey": "photoIndex",
      "landscape": true, "portrait": false, "square": false}).size() == (6, 4)
    # A scene from before the toggles has none: every shape.
    check h.render(%*{"album": album, "order": "sequential", "counterStateKey": "photoIndex"}).size() == (7, 5)
    # Every shape off: nothing is asked for and the counter does not move.
    let g = newHarness()
    check g.render(%*{"album": album, "counterStateKey": "photoIndex",
      "landscape": false, "portrait": false, "square": false}).size() == (200, 120)
    check g.errorLogged("Turn on at least one photo shape")
    check not g.scene.state.hasKey("photoIndex")

  test "a missing or non-http album link paints the message instead of throwing":
    for album in [%"", %"   ", %"ftp://example.com/api/photos/shared/pk_x", %"pk_rel", %"https://", newJNull(), %42]:
      let h = newHarness()
      check h.render(%*{"album": album, "counterStateKey": "photoIndex"}).size() == (200, 120)
      check h.errorLogged("Please add an album link.")
      check not h.scene.state.hasKey("photoIndex")
    let missing = newHarness()
    check missing.render(%*{}).size() == (200, 120)
    check missing.errorLogged("Please add an album link.")

  test "stop the mock server":
    discard boundedGetContent(mockBase() & "/quit")
