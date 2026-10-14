## The Immich code app (repo/apps/image/immich) run for real through the JS app
## runtime, against a mock Immich server on a thread: every mode, the legacy
## server fallback, the errors (thrown: the interpreter paints them), the
## metadata state and the saved asset.
##
## Set IMMICH_LIVE_URL and IMMICH_LIVE_API_KEY (optionally IMMICH_LIVE_ALBUM_ID)
## to also run the app against a real Immich server; skipped otherwise.

import std/[json, net, os, strutils, tables, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "immich"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

proc withDefaults(config: JsonNode): JsonNode =
  ## What a scene's node hands the app (runtimeConfigFromNode): each field's
  ## typed default (first declaration wins), then the node's values, typed.
  result = %*{}
  var types = initTable[string, string]()
  for field in parseJson(appConfigJson)["fields"]:
    let name = field["name"].getStr()
    if types.hasKey(name):
      continue
    types[name] = field["type"].getStr()
    if field.hasKey("value"):
      result[name] = valueToJson(valueFromJsonByType(field["value"], types[name]))
  for key, value in config:
    result[key] = if types.hasKey(key): valueToJson(valueFromJsonByType(value, types[key])) else: value

## Mock Immich on a thread. The URL prefix selects the server's shape:
## /legacy has no POST /api/search/random (older servers), /v2 is an Immich
## before 3.2 (no structured search filter; album mode reads the album
## timeline), /nomemories answers 404 to /api/memories. Otherwise it is
## Immich 3.3. The album's "shared-1" photo is owned by another user: the flat
## albumIds search, which filters by owner, never returns it.
var mockPort: Port
var mockThread: Thread[void]

proc pngBytes(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgba(200, 40, 40, 255))
  encodeImage(image, PngFormat)

proc reply(client: Socket, status: string, contentType: string, body: string) =
  client.send("HTTP/1.1 " & status & "\r\nContent-Type: " & contentType &
    "\r\nContent-Length: " & $body.len & "\r\n\r\n" & body)
  client.close()

proc mockImmichLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  mockPort = boundPort

  let asset = """{"id": "img-1", "type": "IMAGE", "originalFileName": "IMG_001.HEIC", "isFavorite": false,
    "exifInfo": {"make": "Apple", "model": "iPhone 15", "iso": 64, "lensModel": null},
    "people": [{"name": "Alice"}, {"name": ""}]}"""
  let favorite = """{"id": "fav-1", "type": "IMAGE", "originalFileName": "fav.jpg", "isFavorite": true}"""
  let video = """{"id": "vid-1", "type": "VIDEO", "originalFileName": "clip.mp4"}"""
  let shared = """{"id": "shared-1", "type": "IMAGE", "originalFileName": "theirs.jpg", "ownerId": "partner-less",
    "exifInfo": {"make": "Pixel"}}"""

  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    var apiKey = ""
    var contentLength = 0
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        let lowered = line.toLowerAscii()
        if lowered.startsWith("x-api-key:"):
          apiKey = line.split(":", maxsplit = 1)[1].strip()
        elif lowered.startsWith("content-length:"):
          contentLength = parseInt(line.split(":", maxsplit = 1)[1].strip())
    except CatchableError:
      client.close()
      continue
    var body = ""
    if contentLength > 0:
      try:
        body = client.recv(contentLength, timeout = 5000)
      except CatchableError:
        discard

    let parts = requestLine.splitWhitespace()
    let httpMethod = if parts.len >= 1: parts[0] else: ""
    var path = if parts.len >= 2: parts[1] else: "/"
    if path == "/quit":
      client.reply("200 OK", "text/plain", "")
      break
    var legacy = false
    var v2 = false
    var noMemories = false
    var noImage = false
    if path.startsWith("/legacy/"):
      legacy = true
      path = path[7..^1]
    elif path.startsWith("/v2/"):
      v2 = true
      path = path[3..^1]
    elif path.startsWith("/nomemories/"):
      noMemories = true
      path = path[11..^1]
    elif path.startsWith("/noimage/"):
      noImage = true
      path = path[8..^1]
    if apiKey != "secret":
      client.reply("401 Unauthorized", "application/json", """{"message":"Invalid API key"}""")
      continue

    if path == "/api/server/version":
      if legacy:
        client.reply("404 Not Found", "application/json", """{"message":"Cannot GET /api/server/version"}""")
      elif v2:
        client.reply("200 OK", "application/json", """{"major": 2, "minor": 5, "patch": 0}""")
      else:
        client.reply("200 OK", "application/json", """{"major": 3, "minor": 3, "patch": 1}""")
    elif path == "/api/search/random" and httpMethod == "POST":
      if legacy:
        client.reply("404 Not Found", "application/json", """{"message":"Cannot POST /api/search/random"}""")
      elif body.contains("empty-album"):
        client.reply("200 OK", "application/json", "[]")
      elif body.contains("not-a-uuid"):
        client.reply("400 Bad Request", "application/json", """{"message":["each value in albumIds must be a UUID"]}""")
      elif body.contains("\"filter\":{\"type\":{\"eq\":\"IMAGE\"},\"albumIds\":{\"any\":[\"album-1\"]}}"):
        client.reply("200 OK", "application/json", "[" & shared & "]")
      elif body.contains("\"isFavorite\":true"):
        client.reply("200 OK", "application/json", "[" & favorite & "]")
      else:
        client.reply("200 OK", "application/json", "[" & asset & "]")
    elif path.startsWith("/api/timeline/buckets?albumId="):
      if legacy:
        client.reply("404 Not Found", "application/json", """{"message":"Cannot GET /api/timeline/buckets"}""")
      elif path.endsWith("=empty-album"):
        client.reply("200 OK", "application/json", "[]")
      else:
        client.reply("200 OK", "application/json", """[{"timeBucket": "2024-05-01", "count": 3}]""")
    elif path.startsWith("/api/timeline/bucket?albumId=album-1&timeBucket=2024-05-01"):
      client.reply("200 OK", "application/json",
        """{"id": ["vid-1", "shared-1", "vid-2"], "isImage": [false, true, false], "ownerId": ["me", "partner-less", "me"]}""")
    elif path == "/api/assets/shared-1":
      client.reply("200 OK", "application/json", shared)
    elif path.startsWith("/api/assets/random"):
      client.reply("200 OK", "application/json", "[" & asset & "," & video & "," & favorite & "]")
    elif path.startsWith("/api/memories?for="):
      let forDate = path["/api/memories?for=".len..^1]
      if noMemories:
        client.reply("404 Not Found", "application/json", """{"message":"no memories"}""")
      elif forDate.len != 10 or forDate[4] != '-' or forDate[7] != '-':
        client.reply("400 Bad Request", "application/json", """{"message":["for must be a valid ISO 8601 date string"]}""")
      else:
        client.reply("200 OK", "application/json",
          """[{"id": "mem-1", "assets": [{"id": "mem-img", "type": "IMAGE", "originalFileName": "memory.jpg"}, """ &
          video & "]}, {\"id\": \"mem-2\", \"assets\": []}]")
    elif noImage and path.startsWith("/api/assets/"):
      client.reply("404 Not Found", "application/json", """{"message":"Not found"}""")
    elif path.endsWith("/thumbnail?size=preview"):
      client.reply("200 OK", "image/jpeg", pngBytes(5, 3))
    elif path.endsWith("/original"):
      client.reply("200 OK", "image/heic", pngBytes(7, 2))
    else:
      client.reply("404 Not Found", "application/json", """{"message":"Cannot GET """ & path & "\"}")

  server.close()

var mockStarted = false

proc mockBase(): string =
  if not mockStarted:
    mockStarted = true
    createThread(mockThread, mockImmichLoop)
    for _ in 0 ..< 100:
      if int(mockPort) != 0:
        break
      sleep(20)
  doAssert int(mockPort) != 0
  "http://127.0.0.1:" & $int(mockPort)

type Harness = object
  config: FrameConfig
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(serverUrl: string, apiKey = "secret", assetsPath = "/tmp", saveAssets = false): Harness =
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*saveAssets, assetsPath: assetsPath,
    settings: %*{"immich": {"url": serverUrl, "apiKey": apiKey}})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/immich-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 5.NodeId, nodeName: "immich", appKeyword: "immich", scene: scene, frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    settingsKeys = @["immich"], sourceName = "app.ts",
    sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  Harness(config: config, scene: scene, owner: owner, runtime: runtime, logs: logs)

proc render(h: Harness, config: JsonNode): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: true,
    image: newImage(200, 120), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, withDefaults(config), context)

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

suite "immich code app":
  test "random mode shows the preview and records metadata":
    let h = newHarness(mockBase())
    let value = h.render(%*{"mode": "random", "metadataStateKey": "photo"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    let metadata = h.scene.state["photo"]
    check metadata["source"].getStr() == "immich"
    check metadata["id"].getStr() == "img-1"
    check metadata["originalFileName"].getStr() == "IMG_001.HEIC"
    check metadata["make"].getStr() == "Apple"
    check metadata["iso"].getInt() == 64
    check not metadata.hasKey("lensModel")
    check metadata["people"] == %["Alice"]
    check h.logged("Immich random search (whole library): HTTP 200, 1 image candidate(s)")
    check h.logged("Showing Immich asset img-1 (IMG_001.HEIC, preview)")
    check h.runtime.images.len == 0

  test "album, favorites and person modes filter server-side":
    let h = newHarness(mockBase())
    let album = h.render(%*{"mode": "album", "albumId": " album-1 ", "metadataStateKey": "photo"})
    check album.kind == fkImage and album.asImage().width == 5
    check h.scene.state["photo"]["id"].getStr() == "shared-1"
    check h.logged("Immich album search (album album-1, all owners): HTTP 200, 1 image candidate(s)")

    let favorites = h.render(%*{"mode": "favorites", "metadataStateKey": "photo"})
    check favorites.kind == fkImage
    check h.scene.state["photo"]["id"].getStr() == "fav-1"
    check h.logged("Immich random search (favorites)")

    let person = h.render(%*{"mode": "random", "personId": "person-9"})
    check person.kind == fkImage
    check h.logged("Immich random search (person person-9)")

  test "album mode before Immich 3.2 reads the album timeline, every owner's photos":
    let h = newHarness(mockBase() & "/v2")
    let album = h.render(%*{"mode": "album", "albumId": "album-1", "metadataStateKey": "photo"})
    check album.kind == fkImage and album.asImage().width == 5
    check h.scene.state["photo"]["id"].getStr() == "shared-1"
    check h.scene.state["photo"]["originalFileName"].getStr() == "theirs.jpg"
    check h.scene.state["photo"]["make"].getStr() == "Pixel"
    check h.logged("Immich album timeline (album album-1, bucket 2024-05-01): HTTP 200, 1 image candidate(s)")

    let empty = newHarness(mockBase() & "/v2")
    expect(JsAppError):
      discard empty.render(%*{"mode": "album", "albumId": "empty-album"})
    check empty.errorLogged("This album contains no images")

  test "memories mode asks for the bare local date and falls back to random":
    let h = newHarness(mockBase())
    let memory = h.render(%*{"mode": "memories", "metadataStateKey": "photo"})
    check memory.kind == fkImage
    check h.scene.state["photo"]["id"].getStr() == "mem-img"
    check h.logged("Immich memories for " & now().format("yyyy-MM-dd") & ": HTTP 200, 1 image candidate(s)")

    let fallback = newHarness(mockBase() & "/nomemories")
    let value = fallback.render(%*{"mode": "memories", "metadataStateKey": "photo"})
    check value.kind == fkImage
    check fallback.scene.state["photo"]["id"].getStr() == "img-1"
    check fallback.logged("No Immich memories for today (HTTP 404: no memories), showing a random image instead.")

  test "an older server without /api/search/random gets the legacy batch, filtered client-side":
    let h = newHarness(mockBase() & "/legacy")
    let favorites = h.render(%*{"mode": "favorites", "metadataStateKey": "photo"})
    check favorites.kind == fkImage
    check h.scene.state["photo"]["id"].getStr() == "fav-1"
    check h.logged("falling back to /api/assets/random")
    # 3 assets in the batch, one of them a video, one a favorite.
    check h.logged("Immich random search (favorites): HTTP 200, 1 image candidate(s)")

  # A failure is thrown; the interpreter paints the message into the consumer's image.
  test "setup mistakes and server errors fail the node with the message":
    let noUrl = newHarness("")
    expect(JsAppError):
      discard noUrl.render(%*{"mode": "random", "metadataStateKey": "photo"})
    check not noUrl.scene.state.hasKey("photo")
    check noUrl.errorLogged("JS app get failed: Please provide an Immich server URL in the settings.")

    let noKey = newHarness(mockBase(), apiKey = "")
    expect(JsAppError):
      discard noKey.render(%*{"mode": "random"})
    check noKey.errorLogged("Please provide an Immich API key in the settings.")

    let noAlbum = newHarness(mockBase())
    expect(JsAppError):
      discard noAlbum.render(%*{"mode": "album", "albumId": " "})
    check noAlbum.errorLogged("Please provide an album ID.")
    check not noAlbum.logged("Immich random search")

    let emptyAlbum = newHarness(mockBase())
    expect(JsAppError):
      discard emptyAlbum.render(%*{"mode": "album", "albumId": "empty-album"})
    check emptyAlbum.errorLogged("This album contains no images")

    let badAlbum = newHarness(mockBase())
    expect(JsAppError):
      discard badAlbum.render(%*{"mode": "album", "albumId": "not-a-uuid"})
    check badAlbum.errorLogged(
      "Error fetching a random image from Immich: HTTP 400: each value in albumIds must be a UUID")

    let wrongKey = newHarness(mockBase(), apiKey = "wrong")
    expect(JsAppError):
      discard wrongKey.render(%*{"mode": "random", "metadataStateKey": "photo"})
    check wrongKey.errorLogged("HTTP 401: Invalid API key")
    check not wrongKey.scene.state.hasKey("photo")

    let noImage = newHarness(mockBase() & "/noimage")
    expect(JsAppError):
      discard noImage.render(%*{"mode": "random", "metadataStateKey": "photo"})
    check noImage.logged("Showing Immich asset img-1")
    check noImage.errorLogged("Error fetching image from Immich: ")
    check not noImage.scene.state.hasKey("photo")

  test "fullsize downloads the original and saves it under its own extension":
    let assetsDir = getTempDir() / "frameos-immich-js-app-save"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let h = newHarness(mockBase(), assetsPath = assetsDir, saveAssets = true)
    let value = h.render(%*{"mode": "random", "previewSize": "fullsize", "saveAssets": "auto"})
    check value.kind == fkImage
    check value.asImage().width == 7
    check h.logged("(IMG_001.HEIC, fullsize)")
    var saved: seq[string] = @[]
    for file in walkDirRec(assetsDir / "saved" / "immich"):
      saved.add(file)
    check saved.len == 1
    check saved[0].extractFilename().startsWith("IMG_001.")
    check saved[0].endsWith(".heic")

    let never = newHarness(mockBase(), assetsPath = assetsDir, saveAssets = true)
    check never.render(%*{"mode": "random", "saveAssets": "never"}).kind == fkImage
    var afterNever = 0
    for _ in walkDirRec(assetsDir / "saved" / "immich"):
      inc afterNever
    check afterNever == 1

  test "live Immich server (IMMICH_LIVE_URL)":
    let liveUrl = getEnv("IMMICH_LIVE_URL")
    let liveKey = getEnv("IMMICH_LIVE_API_KEY")
    if liveUrl.len == 0 or liveKey.len == 0:
      skip()
    else:
      let h = newHarness(liveUrl, apiKey = liveKey)
      for mode in ["random", "favorites", "memories"]:
        let value = h.render(%*{"mode": mode, "metadataStateKey": "photo"})
        check value.kind == fkImage
        check value.asImage().width > 0
        echo mode, ": ", $h.scene.state{"photo"}
      let albumId = getEnv("IMMICH_LIVE_ALBUM_ID")
      if albumId.len > 0:
        let value = h.render(%*{"mode": "album", "albumId": albumId, "metadataStateKey": "photo"})
        check value.kind == fkImage
        echo "album: ", $h.scene.state{"photo"}
      for entry in h.logs[]:
        echo $entry

  test "stop the mock server":
    discard boundedGetContent(mockBase() & "/quit")
