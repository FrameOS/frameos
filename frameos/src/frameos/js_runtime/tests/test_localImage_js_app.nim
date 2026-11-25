## The Local Image app (repo/apps/image/localImage, the port of the retired Nim
## data/localImage) run for real through the JS app runtime, against files on
## disk: the order and its counter, the folder's rules (junk, empty files,
## search), the photo's colour profile, EXIF, the errors it shows, a repeat
## that does not step on, the consumer's bounds, and its place in the folder
## outliving its interpreter. The Nim app's tests, ported.

import std/[json, os, strutils, tables, times, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/asset_colors
import frameos/utils/dither
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "localImage"
const Fixtures = currentSourcePath().parentDir() / ".." / ".." / "tests" / "fixtures"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

proc withDefaults(config: JsonNode): JsonNode =
  ## What a scene's node hands the app: each field's typed default, then the
  ## node's values, typed.
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

type Harness = object
  config: FrameConfig
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newRuntime(): JsAppRuntime =
  ## The grant its config.json's "files" gives: reading the frame's files.
  newJsAppRuntime(category = "data", outputType = "image", source = appSource,
    sourceName = "app.ts", sources = %*{"app.ts": appSource, "config.json": appConfigJson},
    assetGrant = agRead)

proc newHarness(assetsPath: string): Harness =
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: assetsPath, settings: %*{})
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/local-image-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 5.NodeId, nodeName: "localImage", appKeyword: "localImage", scene: scene,
    frameConfig: config)
  Harness(config: config, scene: scene, owner: owner, runtime: newRuntime(), logs: logs)

proc context(h: Harness): ExecutionContext =
  ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0,
    loopKey: ".", nextSleep: -1)

proc get(h: Harness, config: JsonNode, context: ExecutionContext): Image =
  let value = h.runtime.get(h.owner, withDefaults(config), context)
  doAssert value.kind == fkImage, "an image, got " & $value.kind
  value.asImage()

proc get(h: Harness, config: JsonNode): Image =
  h.get(config, h.context())

proc errorLogged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"error"}.getStr().contains(needle):
      return true
  false

proc writePpm(path: string, r, g, b: int) =
  writeFile(path, "P3\n1 1\n255\n" & $r & " " & $g & " " & $b & "\n")

proc uniqueTempDir(prefix: string): string =
  result = getTempDir() / (prefix & "-" & $(epochTime() * 1000).int64)
  createDir(result)

proc withExif(jpeg: string): string =
  ## A real JPEG with an APP1 EXIF segment after its SOI: a little-endian TIFF
  ## holding Make "Canon" (out of line) and Model "EOS" (inline).
  const tiff =
    "II\x2A\x00\x08\x00\x00\x00" &
    "\x02\x00" &
    "\x0F\x01\x02\x00\x06\x00\x00\x00\x26\x00\x00\x00" &
    "\x10\x01\x02\x00\x04\x00\x00\x00EOS\x00" &
    "\x00\x00\x00\x00" &
    "Canon\x00"
  let payload = "Exif\x00\x00" & tiff
  let segmentLen = payload.len + 2
  jpeg[0 .. 1] & "\xFF\xE1" & chr((segmentLen shr 8) and 0xFF) & chr(segmentLen and 0xFF) & payload & jpeg[2 .. ^1]

suite "local image js app":
  test "alphabetical mode goes by name, ignoring case, and keeps the counter in state":
    let root = uniqueTempDir("frameos-local-image-js-sorted")
    defer: removeDir(root)
    writePpm(root / "zeta.ppm", 255, 0, 0)
    writePpm(root / "Alpha.ppm", 0, 255, 0)
    writePpm(root / "middle.ppm", 0, 0, 255)
    let h = newHarness(root)
    h.scene.state["counter"] = %0
    let config = %*{"path": root, "order": "alphabetical", "counterStateKey": "counter", "metadataStateKey": "meta"}
    var names: seq[string] = @[]
    for _ in 0 ..< 3:
      discard h.get(config)
      names.add h.scene.state["meta"]["filename"].getStr()
    check names == @["Alpha.ppm", "middle.ppm", "zeta.ppm"]
    check h.scene.state["counter"].getInt() == 0
    check h.scene.state["meta"]["path"].getStr() == root / "zeta.ppm"
    check h.scene.state["meta"]["total"].getInt() == 3

  test "a sidecar colour profile is applied and its palette left for the dither":
    let root = uniqueTempDir("frameos-local-image-js-colors")
    defer: removeDir(root)
    writePpm(root / "a-plain.ppm", 60, 60, 60)
    writePpm(root / "b-graded.ppm", 60, 60, 60)
    writeFile(sidecarPathFor(root / "b-graded.ppm"),
      """{"version": 1, "colors": {"exposure": 1, "palette": ["#000000", "#ffffff"]}}""")
    writeFile(root / "c-stray.ppm.frameos.json", """{"version": 1, "colors": {}}""")
    let h = newHarness(root)
    let config = %*{"path": root, "order": "alphabetical", "metadataStateKey": "meta"}
    clearRenderPaletteOverride()
    let plain = h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "a-plain.ppm"
    check plain.unsafe[0, 0].r == 60
    check renderPaletteOverride.len == 0
    let graded = h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "b-graded.ppm"
    check graded.unsafe[0, 0].r == 120
    check renderPaletteOverride == @[(0, 0, 0), (255, 255, 255)]
    check h.scene.state["meta"]["total"].getInt() == 2
    discard h.get(config)
    check renderPaletteOverride.len == 0

  test "the folder's junk, what is not an image and empty files are no photos":
    let root = uniqueTempDir("frameos-local-image-js-discovery")
    defer: removeDir(root)
    createDir(root / "sub")
    createDir(root / ".thumbs")
    createDir(root / ".frameos" / "scene_images")
    writePpm(root / "first.PPM", 255, 0, 0)
    writePpm(root / "sub" / "second.ppm", 0, 255, 0)
    writePpm(root / ".thumbs" / "ignored.ppm", 0, 0, 255)
    writePpm(root / ".frameos" / "scene_images" / "ignored.ppm", 255, 255, 0)
    writeFile(root / "not-image.txt", "hello")
    writeFile(root / "empty.bmp", "")
    let h = newHarness(root)
    h.scene.state["counter"] = %0
    let config = %*{"path": "", "order": "alphabetical", "counterStateKey": "counter", "metadataStateKey": "meta"}
    let first = h.get(config)
    check first.width == 1 and first.height == 1
    check h.scene.state["meta"]["total"].getInt() == 2
    check h.scene.state["meta"]["index"].getInt() == 0
    check h.scene.state["meta"]["filename"].getStr() == "first.PPM"
    check h.scene.state["counter"].getInt() == 1
    discard h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "sub/second.ppm"
    check h.scene.state["counter"].getInt() == 0

  test "search filtering ignores case and starts over when the search or the path changes":
    let root = uniqueTempDir("frameos-local-image-js-search")
    defer: removeDir(root)
    createDir(root / "b")
    writePpm(root / "SunSet.ppm", 10, 20, 30)
    writePpm(root / "Ocean.ppm", 30, 20, 10)
    writePpm(root / "b" / "Forest.ppm", 0, 255, 0)
    let h = newHarness(root)
    discard h.get(%*{"path": root, "search": "sunset", "metadataStateKey": "meta"})
    check h.scene.state["meta"]["filename"].getStr() == "SunSet.ppm"
    discard h.get(%*{"path": root, "search": "OCEAN", "metadataStateKey": "meta"})
    check h.scene.state["meta"]["filename"].getStr() == "Ocean.ppm"
    discard h.get(%*{"path": root / "b", "search": "forest", "metadataStateKey": "meta"})
    check h.scene.state["meta"]["filename"].getStr() == "Forest.ppm"
    check h.scene.state["meta"]["path"].getStr() == root / "b" / "Forest.ppm"

  test "a JPEG's EXIF goes into the metadata (frameos.loadAssetImage's exif)":
    let root = uniqueTempDir("frameos-local-image-js-exif")
    defer: removeDir(root)
    writeFile(root / "photo.jpg", withExif(readFile(Fixtures / "large-gradient.jpg")))
    let h = newHarness(root)
    discard h.get(%*{"path": root, "metadataStateKey": "meta"})
    let meta = h.scene.state["meta"]
    check meta["exif"]["make"].getStr() == "Canon"
    check meta["exif"]["model"].getStr() == "EOS"
    check meta["exifSummary"].getStr() == "Canon EOS"

  test "nothing to show is an error picture, logged; a path outside the frame's files too":
    let root = uniqueTempDir("frameos-local-image-js-errors")
    defer: removeDir(root)
    writePpm(root / "sample.ppm", 1, 2, 3)
    let h = newHarness(root)
    let noMatch = h.get(%*{"path": root, "search": "not-found"})
    check noMatch.width == 8 and noMatch.height == 6
    check h.errorLogged("No images matching the search query \"not-found\" found in the folder: " & root)
    let canvas = newImage(7, 5)
    canvas.fill(rgba(0, 255, 0, 255))
    var context = h.context()
    context.hasImage = true
    context.image = canvas
    let empty = h.get(%*{"path": root / "missing"}, context)
    check empty.width == 7 and empty.height == 5
    check cast[pointer](empty) != cast[pointer](canvas)
    check canvas[0, 0] == rgba(0, 255, 0, 255)
    check h.errorLogged("No images found in the folder: " & root / "missing")
    discard h.get(%*{"path": "/home/pi/Pictures"})
    check h.errorLogged("/home/pi/Pictures is outside the frame's files: put the photos in " & root)

  test "a run the node cache only repeats, or a repaint, shows the same photo and leaves the counter":
    let root = uniqueTempDir("frameos-local-image-js-remake")
    defer: removeDir(root)
    writePpm(root / "a.ppm", 255, 0, 0)
    writePpm(root / "b.ppm", 0, 255, 0)
    let h = newHarness(root)
    h.scene.state["counter"] = %0
    let config = %*{"path": root, "order": "alphabetical", "counterStateKey": "counter", "metadataStateKey": "meta"}
    discard h.get(config)
    check h.scene.state["counter"].getInt() == 1
    for _ in 0 ..< 3:
      var remake = h.context()
      remake.remakingCachedValue = true
      check h.get(config, remake).unsafe[0, 0].r == 255
      check h.scene.state["counter"].getInt() == 1
      check h.scene.state["meta"]["filename"].getStr() == "a.ppm"
    h.scene.repainting = true
    check h.get(config).unsafe[0, 0].r == 255
    check h.scene.state["counter"].getInt() == 1
    h.scene.repainting = false
    discard h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "b.ppm"
    check h.scene.state["counter"].getInt() == 0

  test "bounds offered by the consumer cap the decode":
    let root = uniqueTempDir("frameos-local-image-js-bounds")
    defer: removeDir(root)
    copyFile(Fixtures / "large-gradient.jpg", root / "photo.jpg")
    let h = newHarness(root)
    var context = h.context()
    context.decodeBoundsWidth = 800
    context.decodeBoundsHeight = 480
    context.decodeBoundsNodeId = h.owner.nodeId
    let image = h.get(%*{"path": root}, context)
    check image.width == 800
    check image.height == 520
    check context.decodeBoundsWidth == 0 # taken, one-shot
    check context.decodeBoundsClaimedBy == h.owner.nodeId

  test "a working-directory assets folder, named with or without its ./":
    # The e2e harness's frame reads tmp/assets, its scene names ./tmp/assets/image.png.
    let relative = "tmp" / ("local-image-js-relative-" & $(epochTime() * 1000).int64)
    createDir(relative)
    defer: removeDir(relative)
    writePpm(relative / "image.ppm", 9, 9, 9)
    let h = newHarness(relative)
    let shown = h.get(%*{"path": "./" & relative & "/image.ppm", "metadataStateKey": "meta"})
    check shown.unsafe[0, 0].r == 9
    check h.scene.state["meta"]["total"].getInt() == 1

  test "its place in the folder outlives its interpreter":
    # On an ESP32 an idle interpreter goes after each render; what it
    # remembered (frameos.remember) is the node's, not the interpreter's.
    let root = uniqueTempDir("frameos-local-image-js-memory")
    defer: removeDir(root)
    for name in ["a.ppm", "b.ppm", "c.ppm"]:
      writePpm(root / name, 1, 1, 1)
    let h = newHarness(root)
    let config = %*{"path": root, "order": "alphabetical", "metadataStateKey": "meta"}
    discard h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "a.ppm"
    # What single_scene_host does after every render on an ESP32 that sleeps.
    check releaseIdleJsAppRuntimes()
    discard h.get(config)
    check h.scene.state["meta"]["filename"].getStr() == "b.ppm"
