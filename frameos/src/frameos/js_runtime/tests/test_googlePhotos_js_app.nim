## The Google Photos code app (repo/apps/image/googlePhotos) run for real
## through the JS app runtime. The shared album page is answered at the
## `frameos.httpRequest` seam (`jsHttpRequestHook`) and the photo at the
## download seam (`contextDownloadHook`), so this pins the page request, the
## paths scraped from it, the album cache, the photo URL the app asks for, the
## order of photos, the metadata state, the saved asset and the errors it
## throws, without reaching Google. A render gets the node config a scene
## would: every config.json default under the node's own values.
##
## Failures are thrown, as the Nim app raised: the runtime logs "JS app get
## failed: <message>" and raises JsAppError, and the interpreter paints the
## message into the consumer's image (tested with the interpreter, not here).
##
## Two small probe modules import the app next to it: `probe.ts` calls its
## pure helpers, and `clock.ts` sets `Date.now` from `state.testNow` before
## calling `get`, so the album cache expires without the test waiting for it.
##
## An ESP32 tears every JS interpreter down after a render, so the album and
## the position must live in `frameos.remember`, not module variables: the
## teardown tests release the interpreter between renders (releaseJsAppRuntime)
## the way the embedded runtime does.

import std/[json, os, strutils, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/app_images
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "googlePhotos"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

const probeSource = """
import { extractPhotoPaths, sizedPhotoUrl, wrapIndex } from './app'
export function get(app) {
  const c = app.config
  if (c.fn === 'extract') return { paths: extractPhotoPaths(c.html) }
  if (c.fn === 'sized') return { url: sizedPhotoUrl(c.base, c.width, c.height, c.fitMode) }
  return { index: wrapIndex(c.counter, c.count) }
}
"""

const clockSource = """
import { get as appGet } from './app'
export function get(app, context) {
  const now = app.state.testNow
  if (typeof now === 'number') Date.now = () => now * 1000
  return appGet(app, context)
}
"""

const
  photoUrlHost = "https://lh3.googleusercontent.com/"
  tokenA = "AP1GczN" & repeat("aB3", 20)
  tokenB = "AP1GczM" & repeat("xY7", 20)
  tokenC = "AF1QipP" & repeat("qW9", 20)
  tokenD = "AP1GczQ" & repeat("kL5", 20)
  pathA = "pw/" & tokenA
  pathB = "pw/" & tokenB
  pathC = tokenC
  pathD = "pw/" & tokenD
  baseA = photoUrlHost & pathA
  baseB = photoUrlHost & pathB
  baseC = photoUrlHost & pathC
  baseD = photoUrlHost & pathD
  shareUrl = "https://photos.app.goo.gl/AbCdEf"
  otherShareUrl = "https://photos.google.com/share/OtherAlbum"
  userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

## The Nim app's own fixture: an og:image (A, sized), the owner's avatar, A
## again raw, B with a size suffix, C (an AF1Qip path without pw/), a short
## pw/ path and D JSON-escaped inside a string.
let albumHtml = ("""
<!DOCTYPE html><html><head><title>Holidays - Google Photos</title>
<meta property="og:image" content="{A}=w600-h315-p-k-no">
</head><body>
<img src="https://lh3.googleusercontent.com/a/ACg8ocJx5vN2mP8qR4sT0uW6yZ2aB8cD4eF0gH=s64-c" alt="avatar">
<script>AF_initDataCallback({key: 'ds:1', data:[
["{A}",1024,768],
["{B}=w417-h174-k-no",417,174],
["{C}",800,600],
["https://lh3.googleusercontent.com/pw/short=w32-h32",32,32],
"[[\"{D}\",417,174]]"
]});</script>
</body></html>
""")
  .replace("{A}", baseA)
  .replace("{B}", baseB)
  .replace("{C}", baseC)
  .replace("{D}", baseD)

let albumPaths = @[pathA, pathB, pathC, pathD]
let albumUrls = @[baseA, baseB, baseC, baseD]
let appFields = parseJson(appConfigJson)["fields"]

proc withDefaults(config: JsonNode): JsonNode =
  ## What the runtime hands a scene's node (runtimeConfigFromNode): every
  ## field's typed default, then the node's own values, typed the same way.
  result = %*{}
  var types: seq[(string, string)] = @[]
  for field in appFields:
    if field.hasKey("name"):
      types.add((field["name"].getStr(), field["type"].getStr()))
      result[field["name"].getStr()] = valueToJson(valueFromJsonByType(field["value"], field["type"].getStr()))
  for key, value in config:
    result[key] = value
    for (name, fieldType) in types:
      if name == key:
        result[key] = valueToJson(valueFromJsonByType(value, fieldType))

## The page seam: every frameos.httpRequest lands here.
type PageRequest = tuple[url, httpMethod: string, headers: seq[SimpleHttpHeader]]
var pageRequests: seq[PageRequest] = @[]
var pageCode = 200
var pageBody = ""
var pageError = ""

proc stubPage(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  pageRequests.add((url, httpMethod, headers))
  if pageError.len > 0:
    raise newException(IOError, pageError)
  (pageCode, pageBody)

jsHttpRequestHook = stubPage

## The photo seam: every frameos.fetchImage download lands here.
const photoBytes = "fake-jpeg-bytes"
var imageRequests: seq[string] = @[]
var imageError = ""

proc stubDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  imageRequests.add(url)
  if imageError.len > 0:
    raise newException(IOError, imageError)
  let image = newImage(5, 3)
  image.fill(rgba(40, 120, 200, 255))
  (image, photoBytes)

contextDownloadHook = stubDownload

proc resetSeams() =
  pageRequests = @[]
  pageCode = 200
  pageBody = albumHtml
  pageError = ""
  imageRequests = @[]
  imageError = ""

type Harness = object
  scene: FrameScene
  owner: DynamicJsApp
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(main = "app.ts", state = %*{}, debug = true, saveAssets = false,
    assetsPath = "/tmp", rotate = 0, outputType = "image", nodeId = 4): Harness =
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: rotate, scalingMode: "cover", debug: debug,
    saveAssets: %*saveAssets, assetsPath: assetsPath, settings: %*{})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/google-photos-js-app".SceneId, frameConfig: config, state: state, logger: logger)
  let source =
    if main == "probe.ts": probeSource
    elif main == "clock.ts": clockSource
    else: appSource
  let runtime = newJsAppRuntime(category = "data", outputType = outputType, source = source,
    settingsKeys = @[], sourceName = main,
    sources = %*{"app.ts": appSource, "probe.ts": probeSource, "clock.ts": clockSource,
      "config.json": appConfigJson})
  let owner = DynamicJsApp(nodeId: nodeId.NodeId, nodeName: "googlePhotos", appKeyword: "googlePhotos", scene: scene,
    frameConfig: config, runtime: runtime, configJson: %*{})
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc teardown(h: Harness) =
  ## What the ESP32 does to every idle interpreter after a render.
  releaseJsAppRuntime(h.owner)
  doAssert not h.runtime.ready

proc render(h: Harness, config: JsonNode, width = 200, height = 120, hasImage = true): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: hasImage,
    image: (if hasImage: newImage(width, height) else: nil), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, withDefaults(config), context)

proc failure(h: Harness, config: JsonNode, width = 200, height = 120, hasImage = true): string =
  ## The message get() threw, "" when it returned.
  try:
    discard h.render(config, width, height, hasImage)
  except JsAppError as e:
    return e.msg

proc probe(config: JsonNode): JsonNode =
  let h = newHarness(main = "probe.ts", outputType = "json")
  let value = h.render(config)
  doAssert value.kind == fkJson, "probe returned " & $value.kind
  value.asJson()

proc logged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("log:") and entry{"message"}.getStr().contains(needle):
      return true
  false

proc errorLogged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:") and entry{"error"}.getStr().contains(needle):
      return true
  false

proc logCount(h: Harness, needle: string): int =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("log:") and entry{"message"}.getStr().contains(needle):
      inc result

proc errorCount(h: Harness, needle: string): int =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:") and entry{"error"}.getStr().contains(needle):
      inc result

proc sized(base: string, width = 200, height = 120, suffix = "-c"): string =
  base & "=w" & $width & "-h" & $height & suffix

proc headerValue(request: PageRequest, name: string): string =
  for header in request.headers:
    if header.name.toLowerAscii() == name.toLowerAscii():
      return header.value
  ""

proc isPhoto(value: Value): bool =
  value.kind == fkImage and value.asImage().width == 5 and value.asImage().height == 3

suite "Google Photos code app":
  setup:
    resetSeams()

  test "extractPhotoPaths finds, unescapes, dedupes and filters photo paths":
    check probe(%*{"fn": "extract", "html": albumHtml})["paths"] == %albumPaths

  test "extractPhotoPaths skips avatars and short paths":
    let html = """
<img src="https://lh3.googleusercontent.com/a/ACg8ocJx5vN2mP8qR4sT0uW6yZ2aB8cD4eF0gH=s64-c">
<img src="https://lh3.googleusercontent.com/pw/short=w32-h32">
"""
    check probe(%*{"fn": "extract", "html": html})["paths"].len == 0

  test "extractPhotoPaths returns empty for html without photos":
    check probe(%*{"fn": "extract", "html": "<html><body>Nothing here</body></html>"})["paths"].len == 0

  test "extractPhotoPaths unescapes \\u003d, \\u0026 and \\/ before cutting the size suffix":
    let escaped = photoUrlHost & "pw\\/" & tokenA & "\\u0026x\\u003dw10-h10"
    check probe(%*{"fn": "extract", "html": "[\"" & escaped & "\"]"})["paths"] == %[pathA & "&x"]

  test "sizedPhotoUrl maps fit modes to url suffixes":
    check probe(%*{"fn": "sized", "base": baseA, "width": 800, "height": 480, "fitMode": "cover"})["url"].getStr() ==
      baseA & "=w800-h480-c"
    check probe(%*{"fn": "sized", "base": baseA, "width": 800, "height": 480, "fitMode": "contain"})["url"].getStr() ==
      baseA & "=w800-h480-no"

  test "wrapIndex wraps the sequential counter":
    for (counter, count, expected) in [(0, 5, 0), (4, 5, 4), (5, 5, 0), (7, 5, 2), (-1, 5, 4), (3, 0, 0)]:
      check probe(%*{"fn": "wrap", "counter": counter, "count": count})["index"].getInt() == expected

  test "trims fields, defaults the cache duration and restores the counter from state":
    let h = newHarness(state = %*{"counter": 7})
    let config = %*{"shareUrl": "  " & shareUrl & "  ", "mode": "sequential", "counterStateKey": "  counter  ",
      "metadataStateKey": "  meta  ", "cacheAlbumSeconds": 0}
    let value = h.render(config)
    check value.isPhoto()
    check pageRequests.len == 1
    check pageRequests[0].url == shareUrl
    # Counter 7 over 4 photos is photo 3; the next one is 0.
    check imageRequests == @[sized(baseD)]
    check h.scene.state["counter"] == %0
    check h.scene.state["meta"] == %*{"source": "googlePhotos", "index": 3, "count": 4, "imageUrl": sized(baseD)}
    check not h.scene.state.hasKey("  meta  ")
    # A cache of 0 seconds is the 3600 s default, not "refetch every time".
    check h.render(config).isPhoto()
    check pageRequests.len == 1
    check imageRequests[1] == sized(baseA)
    check h.scene.state["counter"] == %1

  test "the album page is asked for like a browser, the photo at the context's size":
    let h = newHarness()
    let value = h.render(%*{"shareUrl": shareUrl, "mode": "random", "metadataStateKey": "meta"})
    check value.isPhoto()
    check pageRequests.len == 1
    check pageRequests[0].httpMethod == "GET"
    check pageRequests[0].headerValue("User-Agent") == userAgent
    check pageRequests[0].headerValue("Accept") == "text/html"
    check imageRequests.len == 1
    let meta = h.scene.state["meta"]
    check meta["source"].getStr() == "googlePhotos"
    check meta["count"].getInt() == 4
    let index = meta["index"].getInt()
    check index in 0 .. 3
    check meta["imageUrl"].getStr() == sized(albumUrls[index])
    check imageRequests[0] == sized(albumUrls[index])
    check h.logged("Fetching shared album: " & shareUrl)
    check h.logged("Found 4 photos in the shared album")
    check h.logged("Downloading image: " & sized(albumUrls[index]))
    check h.runtime.images.len == 0

  test "random mode picks across the album and never touches the counter":
    let h = newHarness(state = %*{"counter": 2})
    var seen: seq[int] = @[]
    for _ in 0 ..< 40:
      check h.render(%*{"shareUrl": shareUrl, "mode": "random", "counterStateKey": "counter",
        "metadataStateKey": "meta"}).isPhoto()
      let index = h.scene.state["meta"]["index"].getInt()
      check index in 0 .. 3
      if index notin seen:
        seen.add(index)
    check seen.len > 1
    check h.scene.state["counter"] == %2
    check pageRequests.len == 1

  test "sequential without a state key walks the album in order and wraps":
    let h = newHarness()
    for _ in 0 ..< 5:
      check h.render(%*{"shareUrl": shareUrl, "mode": "sequential"}).isPhoto()
    check imageRequests == @[sized(baseA), sized(baseB), sized(baseC), sized(baseD), sized(baseA)]
    check pageRequests.len == 1
    check h.scene.state.len == 0

  test "sequential with a state key saves the counter, and a reloaded scene resumes from it":
    let first = newHarness()
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "counterStateKey": "counter"}
    check first.render(config).isPhoto()
    check first.render(config).isPhoto()
    check first.scene.state["counter"] == %2
    # A new runtime (the scene loaded again, the frame restarted) starts with
    # nothing remembered and picks up where the state says.
    let second = newHarness(state = first.scene.state)
    check second.render(config).isPhoto()
    check imageRequests == @[sized(baseA), sized(baseB), sized(baseC)]
    check second.scene.state["counter"] == %3
    # A counter that is not an integer starts over.
    let third = newHarness(state = %*{"counter": "seven"})
    check third.render(config).isPhoto()
    check imageRequests[^1] == sized(baseA)

  test "contain asks Google for the whole photo; no context image means the rotated frame size":
    let h = newHarness()
    check h.render(%*{"shareUrl": shareUrl, "mode": "sequential", "fitMode": "contain"}, width = 320, height = 200).isPhoto()
    check imageRequests[^1] == sized(baseA, 320, 200, "-no")

    let rotated = newHarness(rotate = 90)
    check rotated.render(%*{"shareUrl": shareUrl, "mode": "sequential"}, hasImage = false).isPhoto()
    check imageRequests[^1] == sized(baseA, 120, 200)

  test "missing share url fails the node without fetching":
    let h = newHarness(nodeId = 4)
    check h.failure(%*{"shareUrl": "  ", "mode": "random"}, width = 15, height = 9) ==
      "Please provide a Google Photos shared album link."
    check pageRequests.len == 0
    check h.errorCount("") == 1
    check h.logs[][0]["event"].getStr() == "error:4:googlePhotos"
    check h.logs[][0]["error"].getStr() == "JS app get failed: Please provide a Google Photos shared album link."

  test "invalid share url fails the node without fetching":
    let h = newHarness(nodeId = 5)
    check h.failure(%*{"shareUrl": "photos.app.goo.gl/AbCdEf", "mode": "random"}, width = 12, height = 8) ==
      "Invalid shared album link: photos.app.goo.gl/AbCdEf"
    check pageRequests.len == 0
    check imageRequests.len == 0
    check h.errorCount("") == 1
    check h.errorLogged("JS app get failed: Invalid shared album link: photos.app.goo.gl/AbCdEf")

  test "a failed album fetch fails the node and writes no state":
    let h = newHarness()
    pageCode = 404
    pageBody = "<html>Not found</html>"
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "counterStateKey": "counter", "metadataStateKey": "meta"}
    check h.failure(config) == "Error loading the shared album: Error 404 while fetching the shared album page."
    check imageRequests.len == 0
    check h.scene.state.len == 0
    check h.errorLogged("JS app get failed: Error loading the shared album: Error 404 while fetching the shared album page.")

  test "an album page without photos fails with the hint":
    let h = newHarness()
    pageBody = "<html><body>Nothing here</body></html>"
    check h.failure(%*{"shareUrl": shareUrl}) == "Error loading the shared album: No photos found on the shared " &
      "album page. Make sure the link is a public share link and the album is not empty."
    check imageRequests.len == 0

  test "a transport failure fails with the transport error":
    let h = newHarness()
    pageError = "Connection refused"
    check h.failure(%*{"shareUrl": shareUrl}) == "Error loading the shared album: Connection refused"
    check imageRequests.len == 0

  test "the album is cached for cacheAlbumSeconds, then fetched again":
    let h = newHarness(main = "clock.ts", state = %*{"testNow": 1000})
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "cacheAlbumSeconds": 900}
    check h.render(config).isPhoto()
    check pageRequests.len == 1
    h.scene.state["testNow"] = %1899
    check h.render(config).isPhoto()
    check pageRequests.len == 1
    h.scene.state["testNow"] = %1900
    check h.render(config).isPhoto()
    check pageRequests.len == 2
    # The default (no value, or "3600" from the field) is an hour.
    let defaults = newHarness(main = "clock.ts", state = %*{"testNow": 1000})
    check defaults.render(%*{"shareUrl": shareUrl, "cacheAlbumSeconds": "3600"}).isPhoto()
    defaults.scene.state["testNow"] = %4599
    check defaults.render(%*{"shareUrl": shareUrl}).isPhoto()
    check pageRequests.len == 3
    defaults.scene.state["testNow"] = %4600
    check defaults.render(%*{"shareUrl": shareUrl}).isPhoto()
    check pageRequests.len == 4

  test "a changed share url fetches its own album":
    let h = newHarness()
    check h.render(%*{"shareUrl": shareUrl, "mode": "sequential"}).isPhoto()
    pageBody = "[\"" & baseC & "\"]"
    check h.render(%*{"shareUrl": otherShareUrl, "mode": "sequential"}).isPhoto()
    check pageRequests.len == 2
    check pageRequests[1].url == otherShareUrl
    # One photo now: the counter (1) wraps to it.
    check imageRequests[^1] == sized(baseC)

  test "a failed refresh reuses the cached list for the same link, not for another one":
    let h = newHarness(main = "clock.ts", state = %*{"testNow": 1000})
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "metadataStateKey": "meta"}
    check h.render(config).isPhoto()
    pageCode = 500
    h.scene.state["testNow"] = %5000
    check h.render(config).isPhoto()
    check pageRequests.len == 2
    check imageRequests == @[sized(baseA), sized(baseB)]
    check h.errorLogged("Error refreshing the shared album, reusing the cached photo list: " &
      "Error 500 while fetching the shared album page.")
    check h.scene.state["meta"]["index"] == %1
    # The failed refresh did not reset the clock: the next render tries again.
    check h.render(config).isPhoto()
    check pageRequests.len == 3

    let other = %*{"shareUrl": otherShareUrl, "mode": "sequential", "metadataStateKey": "meta"}
    check h.failure(other) == "Error loading the shared album: Error 500 while fetching the shared album page."
    check imageRequests.len == 3
    check h.scene.state["meta"]["index"] == %2

  test "a failed photo download fails the node, writes no metadata, still advances the counter":
    let h = newHarness()
    imageError = "404 Not Found"
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "counterStateKey": "counter", "metadataStateKey": "meta"}
    check h.failure(config) == "Error fetching image from Google Photos: 404 Not Found"
    check imageRequests == @[sized(baseA)]
    check not h.scene.state.hasKey("meta")
    check h.scene.state["counter"] == %1
    check h.errorCount("Error fetching image from Google Photos: 404 Not Found") == 1

  test "saveAssets: auto follows the frame, always saves, never does not":
    let assetsDir = getTempDir() / "frameos-google-photos-js-app-save"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let savedDir = assetsDir / "saved" / "googlePhotos"
    proc savedFiles(): seq[string] =
      if dirExists(savedDir):
        for file in walkDirRec(savedDir):
          result.add(file)

    let frameSaves = newHarness(saveAssets = true, assetsPath = assetsDir)
    check frameSaves.render(%*{"shareUrl": shareUrl, "mode": "sequential", "saveAssets": "auto"}).isPhoto()
    let saved = savedFiles()
    check saved.len == 1
    check saved[0].extractFilename().startsWith("google-photos 0 200x120.")
    check saved[0].endsWith(".jpg")
    check readFile(saved[0]) == photoBytes
    # The field's default is auto.
    check frameSaves.render(%*{"shareUrl": shareUrl, "mode": "sequential"}).isPhoto()
    check savedFiles().len == 2
    check frameSaves.render(%*{"shareUrl": shareUrl, "mode": "sequential", "saveAssets": "never"}).isPhoto()
    check savedFiles().len == 2

    let frameDoesNot = newHarness(saveAssets = false, assetsPath = assetsDir)
    check frameDoesNot.render(%*{"shareUrl": shareUrl, "mode": "sequential", "saveAssets": "auto"}).isPhoto()
    check savedFiles().len == 2
    check frameDoesNot.render(%*{"shareUrl": shareUrl, "mode": "sequential", "saveAssets": "always",
      "fitMode": "contain"}, width = 64, height = 48).isPhoto()
    var always = false
    for file in savedFiles():
      if file.extractFilename().startsWith("google-photos 1 64x48."):
        always = true
    check always
    check savedFiles().len == 3

  test "without debug the fetch and download lines are not logged":
    let h = newHarness(debug = false)
    check h.render(%*{"shareUrl": shareUrl}).isPhoto()
    check not h.logged("Fetching shared album")
    check not h.logged("Found 4 photos")
    check not h.logged("Downloading image")

  test "the album, its age and the position outlive the interpreter (ESP32 teardown)":
    let h = newHarness(main = "clock.ts", state = %*{"testNow": 1000})
    let config = %*{"shareUrl": shareUrl, "mode": "sequential", "cacheAlbumSeconds": 900, "metadataStateKey": "meta"}
    check h.render(config).isPhoto()
    h.teardown()
    # Kept without the fixed host: the paths only.
    check parseJson(h.runtime.memory["album"])["paths"] == %albumPaths
    # Within cacheAlbumSeconds: no refetch, and the next photo in order.
    h.scene.state["testNow"] = %1500
    check h.render(config).isPhoto()
    check pageRequests.len == 1
    h.teardown()
    # Stale, and the refresh fails: the kept list of the same link is reused.
    pageCode = 500
    h.scene.state["testNow"] = %5000
    check h.render(config).isPhoto()
    check pageRequests.len == 2
    check h.errorLogged("Error refreshing the shared album, reusing the cached photo list: " &
      "Error 500 while fetching the shared album page.")
    h.teardown()
    # The failed refresh kept the old fetch time: the next render tries again.
    pageCode = 200
    h.scene.state["testNow"] = %5001
    check h.render(config).isPhoto()
    check pageRequests.len == 3
    h.teardown()
    check h.render(config).isPhoto()
    check pageRequests.len == 3
    # Sequential without a counter state key: in order and wrapping, the
    # position kept by the node, nothing written to the scene state.
    check imageRequests == @[sized(baseA), sized(baseB), sized(baseC), sized(baseD), sized(baseA)]
    check h.scene.state["meta"]["index"] == %0
    check not h.scene.state.hasKey("counter")

  test "an album too big to keep serves its own render only, and says so once":
    let h = newHarness()
    # Fill the node's memory to just short of its limit: the counter still
    # fits, the album list does not.
    let filler = JsAppMemoryMaxBytes - 200
    h.runtime.memoryBytes += filler
    let config = %*{"shareUrl": shareUrl, "mode": "sequential"}
    for _ in 0 ..< 3:
      check h.render(config).isPhoto()
      h.teardown()
    check pageRequests.len == 3
    check imageRequests == @[sized(baseA), sized(baseB), sized(baseC)]
    check not h.runtime.memory.hasKey("album")
    check h.logCount("too many to keep") == 1
    check h.logged("The album's 4 photos are too many to keep: it is fetched on every render.")
    check h.errorCount("frameos.remember(\"album\") refused") == 1
