## The FrameOS Gallery code app (repo/apps/code/frameOSGallery) run for real
## through the JS app runtime. The download is stubbed at the shared seam
## (`contextDownloadHook`), so this pins the URL the app asks for, the image it
## returns and the panels it paints, without reaching gallery.frameos.net.

import std/[json, os, strutils, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/app_images
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "code" / "frameOSGallery"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

var requestedUrls: seq[string] = @[]
var downloadError = ""

proc stubDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  requestedUrls.add(url)
  if downloadError.len > 0:
    raise newException(IOError, downloadError)
  let image = newImage(5, 3)
  image.fill(rgba(200, 40, 40, 255))
  (image, "")

contextDownloadHook = stubDownload

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(): Harness =
  requestedUrls = @[]
  downloadError = ""
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, settings: %*{})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/frameos-gallery-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 5.NodeId, nodeName: "frameOSGallery", appKeyword: "frameOSGallery", scene: scene,
    frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    settingsKeys = @[], sourceName = "app.ts",
    sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc render(h: Harness, config: JsonNode): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: true,
    image: newImage(200, 120), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, config, context)

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

suite "FrameOS Gallery code app":
  test "a category downloads a random image from that gallery":
    let h = newHarness()
    let value = h.render(%*{"category": "low-poly-animals"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    check requestedUrls == @["https://gallery.frameos.net/image?category=low-poly-animals"]
    check h.logged("FrameOS Gallery category: low-poly-animals")
    check h.runtime.images.len == 0

  test "no category is the field's default":
    let h = newHarness()
    check h.render(%*{}).kind == fkImage
    check requestedUrls == @["https://gallery.frameos.net/image?category=cute"]

  test "other sends the free-text category, URL-encoded":
    let h = newHarness()
    check h.render(%*{"category": "other", "categoryOther": " my gallery&x=1 "}).kind == fkImage
    check requestedUrls == @["https://gallery.frameos.net/image?category=my%20gallery%26x%3D1"]

  test "other without a name paints the message instead of downloading":
    let h = newHarness()
    let value = h.render(%*{"category": "other", "categoryOther": ""})
    check value.kind == fkImage
    check value.asImage().width == 200
    check value.asImage().height == 120
    check requestedUrls.len == 0
    check h.errorLogged("Category (if other)")

  test "a failed download paints the error":
    let h = newHarness()
    downloadError = "HTTP 404"
    let value = h.render(%*{"category": "no-such-gallery"})
    check value.kind == fkImage
    check value.asImage().width == 200
    check value.asImage().height == 120
    check requestedUrls == @["https://gallery.frameos.net/image?category=no-such-gallery"]
    check h.errorLogged("An error occurred while downloading the gallery image. HTTP 404")
