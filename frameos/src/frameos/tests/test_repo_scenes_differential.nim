import std/[json, os, sets, strutils, tables]
import pixie
import ../interpreter
import ../planner

# Bounded decodes are equivalent, not byte-identical; the pixel-exact A/B
# runs with requestedBounds off (it has its own classified test).
imageBoundsEnabled = false
import ../types
import ../utils/memory

# Principle 4 over the shipped corpus: every offline-safe sample scene must
# render the SAME pixels with the planner on and off. The generated-graph
# differential (test_interpreter_fusion_differential) proves the rules over
# 360 synthetic shapes; this proves them over the graphs users actually get.
#
# Scenes are probed for self-determinism first — two materialized renders of
# fresh instances. A scene that disagrees with itself (a clock crossing a
# second, a random image order) cannot be A/B'd and is skipped by name, so a
# nondeterministic scene never becomes a silent hole in the comparison.

const SamplesDir = "../repo/scenes/samples"

# downloadUrl is deliberately NOT here: every sample but XKCD (excluded via
# downloadImage) leaves its url empty, which fails fast and deterministically
# — and that keeps the Calendar-family scenes, whose calendar -> render/image
# edge (a JS app's SVG into the canvas) is exactly the fused generator this comparison wants to exercise.
let networkApps = toHashSet([
  "downloadImage", "wikicommons",
  "frameOSGallery", "weather", "beRecycle", "unsplash", "immich",
  "googlePhotos", "openaiImage", "haSensor",
  # the Chess puzzle sample's own JS app: Lichess's daily puzzle by default
  "lichessPuzzlePanel",
  # the Scene store sample's own JS app: the store's listing, with no host
  "sceneStore",
  # the Browser sample's own JS app: Hacker News, its home page
  "browser",
  # the Hacker News sample's own JS app: the HN and Algolia APIs
  "hackerNews",
  # the Weather, Bird field journal and Flights Above Me samples' own JS apps:
  # Open-Meteo, iNaturalist and OpenSky for the scenes' default places
  "weatherOpenMeteoJS", "birdJournal", "flightRadar"
])
let hostOnlyApps = toHashSet(["chromiumScreenshot", "rstpSnapshot"])

# A fixed budget, so both runs (and every machine) bound the same way, and a
# large enough one that the materialized floor's raster of an 800x480 JS app
# SVG (the Chart sample) is not bounded: under 4 MB it was rasterized smaller
# and stretched, which is the floor saving memory the fused render never
# needs, not a planner difference.
availableRenderBytesOverride = 8 * 1024 * 1024
refreshDecodeBudget()

proc testConfig(assetsPath: string): FrameConfig =
  FrameConfig(
    name: "differential", mode: "embedded", width: 800, height: 480, rotate: 0,
    scalingMode: "cover", assetsPath: assetsPath, debug: false,
    settings: %*{}, saveAssets: %*false
  )

proc testLogger(): Logger =
  var logger = Logger(enabled: false)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc sceneAppKeywords(scene: FrameSceneInput, allScenes: seq[FrameSceneInput],
    visited: var HashSet[string]): HashSet[string] =
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

proc renderOnce(sceneId: SceneId, assetsPath: string, fused: bool,
    persistedState: JsonNode): Image =
  imageFusionEnabled = fused
  let scene = init(sceneId, testConfig(assetsPath), testLogger(),
    persistedState.copy())
  var context = ExecutionContext(
    scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: 0.0
  )
  render(scene, context).copy()

proc maxChannelDelta(a, b: Image): int =
  doAssert a.width == b.width and a.height == b.height
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      let
        pa = a.data[a.dataIndex(x, y)]
        pb = b.data[b.dataIndex(x, y)]
      result = max(result, max(
        abs(pa.r.int - pb.r.int), max(
        abs(pa.g.int - pb.g.int), max(
        abs(pa.b.int - pb.b.int),
        abs(pa.a.int - pb.a.int)))))

# One instant for every render (utils/frame_time.nim, as the e2e snapshots
# pin it): a scene drawn from the clock (a game's blink, its seed, a clock
# face) is then the same picture fused or not, and is compared instead of
# skipped. Unpinned, Road racer's two materialized renders could land on the
# same picture with the fused one between them on another (CI, 2026-11-18).
putEnv("FRAMEOS_E2E_FIXED_EPOCH", "1767225600")

let fixtureDir = getTempDir() / "frameos-differential-assets"
removeDir(fixtureDir)
createDir(fixtureDir)
const CanvasPngFixture = "../repo/scenes/samples/Unsplash image/image.jpg"
if fileExists(CanvasPngFixture):
  # The repo template previews are PNG data despite the .jpg name.
  copyFile(CanvasPngFixture, fixtureDir / "canvas-sized.png")

var compared = 0
var fusedEdges = 0
var skipped: seq[string] = @[]

for kind, templateDir in walkDir(SamplesDir):
  if kind != pcDir:
    continue
  let scenesPath = templateDir / "scenes.json"
  if not fileExists(scenesPath):
    continue
  let templateName = templateDir.splitPath().tail
  let inputs = parseInterpretedSceneInputs(readFile(scenesPath))
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in buildInterpretedScenes(inputs):
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  for sceneInput in inputs:
    var visited = initHashSet[string]()
    let apps = sceneAppKeywords(sceneInput, inputs, visited)
    let sceneLabel = templateName & " / " & sceneInput.name
    if (apps * hostOnlyApps).len > 0 or (apps * networkApps).len > 0:
      continue

    let persistedState =
      if templateName in ["Ken Burns slideshow", "SD card image"]:
        %*{"imageFolder": fixtureDir, "cycleSeconds": 3600}
      else: %*{}

    # Self-determinism probe BRACKETS the fused render: a time-dependent
    # scene (Ken Burns' pan) can agree with itself across two quick renders
    # and still drift by the third — only if the two materialized renders on
    # either side of the fused one agree is the comparison meaningful.
    let a1 = renderOnce(sceneInput.id, fixtureDir, fused = false, persistedState)
    let fusedImage = renderOnce(sceneInput.id, fixtureDir, fused = true, persistedState)
    let a2 = renderOnce(sceneInput.id, fixtureDir, fused = false, persistedState)
    if maxChannelDelta(a1, a2) > 0:
      skipped.add(sceneLabel)
      continue

    # A JSX overlay with see-through paint under anti-aliased edges (a
    # translucent card behind text over a transparent root) comes out up to 2
    # levels apart here: fused, it blends onto the canvas step by step;
    # materialized, onto a transparent image first and then onto the canvas,
    # and 8-bit source-over is not associative (correct rounding still leaves
    # 1). Unfusing it would cost a canvas-sized image, so samples keep such
    # overlays opaque (Weather, painted's card, 2026-11-23).
    let delta = maxChannelDelta(a1, fusedImage)
    doAssert delta == 0,
      sceneLabel & ": fused render differs from materialized (max channel delta " &
      $delta & ")"
    compared += 1

    # Count how many of these comparisons actually exercised a fused edge, so
    # a capability regression that silently unfuses everything fails loudly.
    imageFusionEnabled = true
    let planned = init(sceneInput.id, testConfig(fixtureDir), testLogger(), %*{})
    fusedEdges += InterpretedFrameScene(planned).imageFusionPlans.len

imageFusionEnabled = true

echo "test_repo_scenes_differential: ", compared,
  " scenes compared pixel-exact, ", fusedEdges, " fused edges exercised, ",
  skipped.len, " nondeterministic skipped (", skipped.join(", "), ")"
doAssert compared >= 8, "expected most offline scenes to be comparable, got " & $compared
doAssert fusedEdges >= 2, "the comparison exercised no fused edges — capability regression?"
