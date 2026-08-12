import std/[json, os, sets, strutils, tables]
import pixie
import ../interpreter
import ../planner
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
# — and that keeps the Calendar-family scenes, whose render/calendar edge is
# exactly the fused generator this comparison wants to exercise.
let networkApps = toHashSet([
  "downloadImage", "wikicommons",
  "frameOSGallery", "weather", "beRecycle", "unsplash", "immich",
  "googlePhotos", "openaiImage", "haSensor"
])
let hostOnlyApps = toHashSet(["chromiumScreenshot", "rstpSnapshot"])

availableRenderBytesOverride = 4 * 1024 * 1024
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
