import std/[json, os, tables, strutils, sets, options]
import pixie
import ../interpreter
import ../types
import ../utils/image
import ../utils/memory

# Renders the bundled repo scenes through the interpreter with an ESP32-like
# memory budget. Catches scenes that stop parsing, apps that crash instead of
# rendering an error frame, and image decodes that blow past the budget.
#
# Offline by default: scenes whose apps would hit the network with default
# state are only rendered when FRAMEOS_TEST_NETWORK=1. Apps that fail fast
# without API keys (openai, unsplash, haSensor) count as offline-safe: their
# error frames are exactly what an unconfigured frame shows.

const SamplesDir = "../repo/scenes/samples"

# Apps that reach the network with default scene state (bare names)
let networkApps = toHashSet([
  "downloadUrl", "downloadImage", "wikicommons",
  "frameOSGallery", "weather", "beRecycle"
])
# Apps that need host-only child processes; excluded from embedded builds
let hostOnlyApps = toHashSet([
  "chromiumScreenshot", "rstpSnapshot"
])

# ESP32-S3-class headroom: ~4MB largest free PSRAM block for render work
availableRenderBytesOverride = 4 * 1024 * 1024
refreshDecodeBudget()

let verboseLogs = getEnv("FRAMEOS_TEST_VERBOSE") == "1"

# Render-chain crashes (an app raising out of run/get) are logged and
# swallowed by the interpreter; collect them so they fail the test. App-level
# "error:<nodeId>" frames (missing API keys etc.) are the expected offline
# behavior and stay allowed.
var renderChainErrors: seq[string] = @[]

proc testLogger(): Logger =
  var logger = Logger(enabled: false)
  logger.log = proc(payload: JsonNode) =
    if verboseLogs:
      echo payload
    let event = payload{"event"}.getStr()
    if event == "runEventInterpreted:error" or
        (event.startsWith("interpreter:") and event.contains(":error")) or
        event in ["interpreter:graph:hopLimit", "interpreter:graph:cycle", "interpreter:nodeNotFound"]:
      renderChainErrors.add($payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc testConfig(assetsPath: string): FrameConfig =
  FrameConfig(
    name: "test",
    mode: "embedded",
    width: 800,
    height: 480,
    rotate: 0,
    scalingMode: "cover",
    assetsPath: assetsPath,
    debug: false,
    settings: %*{},
    saveAssets: %*false
  )

proc sceneAppKeywords(scene: FrameSceneInput, allScenes: seq[FrameSceneInput],
    visited: var HashSet[string]): HashSet[string] =
  # Scene JSON may use bare keywords ("frameOSGallery") or prefixed ones
  # ("data/frameOSGallery"); normalize to the bare app name. Scene nodes pull
  # in the referenced child scene's apps too.
  if scene.id.string in visited:
    return
  visited.incl(scene.id.string)
  for node in scene.nodes:
    let keyword = node.data{"keyword"}.getStr()
    if keyword.len == 0:
      continue
    if node.nodeType == "app":
      result.incl(keyword.rsplit("/", maxsplit = 1)[^1])
    elif node.nodeType == "scene":
      for childScene in allScenes:
        if childScene.id.string == keyword:
          result.incl(sceneAppKeywords(childScene, allScenes, visited))

proc sceneAppKeywords(scene: FrameSceneInput, allScenes: seq[FrameSceneInput]): HashSet[string] =
  var visited = initHashSet[string]()
  sceneAppKeywords(scene, allScenes, visited)

proc renderScene(sceneId: SceneId, assetsPath: string,
    persistedState: JsonNode = %*{}): (FrameScene, Image) =
  let config = testConfig(assetsPath)
  let scene = init(sceneId, config, testLogger(), persistedState)
  var context = ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )
  let image = render(scene, context)
  (scene, image)

let renderNetworkScenes = getEnv("FRAMEOS_TEST_NETWORK") == "1"

# Fixture "SD card": a 10-megapixel JPEG that only fits through the
# streaming, display-bounded decode path under the ESP32-like budget, and a
# canvas-sized PNG that relies on the streamed scanline decode.
let fixtureDir = getTempDir() / "frameos-test-sd-assets"
removeDir(fixtureDir)
createDir(fixtureDir)
const LargeJpegFixture = "src/frameos/tests/fixtures/large-gradient.jpg"
doAssert fileExists(LargeJpegFixture), "missing " & LargeJpegFixture
copyFile(LargeJpegFixture, fixtureDir / "large-gradient.jpg")
var fixtureNames = @["large-gradient.jpg"]
# The repo template previews are PNG data despite the .jpg name
const CanvasPngFixture = "../repo/scenes/samples/Unsplash image/image.jpg"
if fileExists(CanvasPngFixture):
  copyFile(CanvasPngFixture, fixtureDir / "canvas-sized.png")
  fixtureNames.add("canvas-sized.png")

var templateCount = 0
var renderedScenes = 0
var skippedNetwork: seq[string] = @[]
var skippedHostOnly: seq[string] = @[]

for kind, templateDir in walkDir(SamplesDir):
  if kind != pcDir:
    continue
  let scenesPath = templateDir / "scenes.json"
  if not fileExists(scenesPath):
    continue
  templateCount += 1
  let templateName = templateDir.splitPath().tail

  # Every template must parse and build
  let inputs = parseInterpretedSceneInputs(readFile(scenesPath))
  doAssert inputs.len > 0, templateName & ": no scenes parsed"
  let exportedScenes = buildInterpretedScenes(inputs)
  doAssert exportedScenes.len == inputs.len, templateName & ": failed to build all scenes"

  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in exportedScenes:
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  for sceneInput in inputs:
    let apps = sceneAppKeywords(sceneInput, inputs)
    let sceneLabel = templateName & " / " & sceneInput.name
    if (apps * hostOnlyApps).len > 0:
      skippedHostOnly.add(sceneLabel)
      continue
    if not renderNetworkScenes and (apps * networkApps).len > 0:
      skippedNetwork.add(sceneLabel)
      continue

    # These scenes default to /srv/assets; point them at the fixture dir
    let persistedState =
      if templateName in ["SD card image", "Ken Burns slideshow"]:
        %*{"imageFolder": fixtureDir}
      else: %*{}
    renderChainErrors = @[]
    let (scene, image) = renderScene(sceneInput.id, fixtureDir, persistedState)
    doAssert image.width == 800 and image.height == 480,
      sceneLabel & ": rendered " & $image.width & "x" & $image.height
    renderedScenes += 1

    # Repeated renders must keep working within the same budget
    var context = ExecutionContext(
      scene: scene, event: "render", payload: %*{}, hasImage: false,
      loopIndex: 0, loopKey: ".", nextSleep: 0.0
    )
    let secondImage = render(scene, context)
    doAssert secondImage.width == 800 and secondImage.height == 480
    doAssert renderChainErrors.len == 0,
      sceneLabel & ": render chain errors:\n" & renderChainErrors.join("\n")

    if templateName == "SD card image":
      # localImage must have loaded a real fixture from the "SD card"
      let metadata = scene.state{"localImageMetadata"}
      doAssert not metadata.isNil and metadata.kind == JObject,
        "SD card image scene did not store image metadata"
      doAssert metadata{"filename"}.getStr() in fixtureNames,
        "unexpected SD card image: " & metadata{"filename"}.getStr()
      doAssert metadata{"width"}.getInt() > 0

    if templateName == "Ken Burns slideshow":
      # zoomPan must have drawn a crop of the fixture, not an error frame
      let metadata = scene.state{"imageMetadata"}
      doAssert not metadata.isNil and metadata{"filename"}.getStr() in fixtureNames,
        "Ken Burns scene did not load the fixture image"

    if templateName == "Chart":
      # The demo data must produce chart marks, not a "no data" message:
      # count pixels that differ from the black background
      var inked = 0
      for color in image.data:
        if color.r.int + color.g.int + color.b.int > 60:
          inc inked
      doAssert inked > 5000, "chart sample drew only " & $inked & " bright pixels"

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

# A canvas-sized PNG must decode through the display-bounded path within the
# same budget (streamed scanline decode; the plan is pixels + fixed overhead)
if fileExists(fixtureDir / "canvas-sized.png"):
  refreshDecodeBudget()
  let png = readImageWithDisplayBounds(fixtureDir / "canvas-sized.png",
    maxEdge = 1600, maxPixels = 800 * 480 * 2)
  doAssert png.width > 0 and png.height > 0

doAssert templateCount >= 15, "expected the full samples repo, found " & $templateCount
doAssert renderedScenes >= 8, "expected to render most sample scenes offline, rendered " & $renderedScenes

echo "test_repo_scenes_esp32: rendered ", renderedScenes, " scenes from ", templateCount,
  " templates (skipped ", skippedNetwork.len, " network, ", skippedHostOnly.len, " host-only)"
