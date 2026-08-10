import std/[json, os, strutils, tables]
import pixie
import ../interpreter
import ../types
import ../utils/app_images
import ../../apps/data/frameOSGallery/app as galleryApp

# The interpreter's decode-target hint, from the interpreter's side.
#
# An image producer that is drawn full-frame by render/image gets told what to
# decode into, so it never materializes a native-resolution intermediate — the
# thing that OOMs an ESP32. Which form of the hint it gets depends on the
# producer's own node cache:
#
#   cache off -> the live canvas (render/image then no-ops on identity)
#   cache on  -> a canvas SIZE the producer allocates itself, because a cache
#                holding the live canvas would redraw it onto itself forever
#
# Every gallery/photo scene the repo ships caches its producer, so the cached
# path is the common one, not the exception.

var hookTarget: Image = nil
var hookCalls = 0
var hookTargets: seq[Image] = @[]

proc recordingDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit): Image =
  hookCalls += 1
  hookTarget = target
  hookTargets.add(target)
  if not target.isNil:
    return target
  # What an unhinted producer really does on embedded: decode the source at
  # its native resolution. 1024x1024 is what gallery.frameos.net serves, and
  # 4MB of RGBA is what blew the ESP32 decode budget.
  newImage(1024, 1024)

galleryDownloadHook = recordingDownload

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 8,
    height: 4,
    rotate: 0,
    scalingMode: "cover",
    debug: false,
    settings: %*{},
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: false)
  logger.log = proc(payload: JsonNode) = discard payload
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int,
    targetHandle: string): DiagramEdge =
  DiagramEdge(id: id.NodeId, source: source.NodeId, sourceHandle: sourceHandle,
    target: target.NodeId, targetHandle: targetHandle, data: %*{})

proc galleryScene(producerCached: bool, imageConfig: JsonNode):
    ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: "Decode target test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: @[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": imageConfig}),
      node(3, "app", %*{
        "keyword": "data/frameOSGallery",
        "config": {"category": "nature"},
        "cache": {
          "enabled": producerCached,
          "inputEnabled": false,
          "durationEnabled": producerCached,
          "duration": "60",
          "expressionEnabled": false
        }
      })
    ],
    edges: @[
      edge(1, 1, "next", 2, "prev"),
      edge(2, 3, "fieldOutput", 2, "fieldInput/image")
    ],
    apps: %*{}
  )

proc renderWith(producerCached: bool, imageConfig: JsonNode = %*{}):
    tuple[target: Image, canvas: Image, calls: int] =
  let sceneId = "tests/decode-target".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = galleryScene(producerCached, imageConfig)
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  hookTarget = nil
  hookCalls = 0
  let config = testConfig()
  let scene = init(sceneId, config, testLogger(config), %*{})
  var context = ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: 0.0
  )
  let canvas = render(scene, context)
  (hookTarget, canvas, hookCalls)

block uncached_producer_gets_the_live_canvas:
  let (target, canvas, calls) = renderWith(producerCached = false)
  doAssert calls == 1
  doAssert not target.isNil, "an uncached full-frame producer must be hinted"
  doAssert target == canvas, "it should decode straight into the live canvas"

block cached_producer_gets_a_canvas_sized_target:
  # The regression: this producer used to get no hint at all and decoded at
  # native resolution, which is what blew the ESP32 decode budget on every
  # shipped gallery scene.
  let (target, canvas, calls) = renderWith(producerCached = true)
  doAssert calls == 1
  doAssert not target.isNil, "a cached full-frame producer must still be bounded"
  doAssert target != canvas, "a cached producer must never own the live canvas"
  doAssert target.width == canvas.width and target.height == canvas.height

block cached_contain_over_overwrite_stays_unhinted:
  # The one shape a scratch target would change: contain leaves letterbox
  # margins, and drawing a scratch's transparent margins with overwrite would
  # erase what the canvas already had there.
  let (target, _, calls) = renderWith(producerCached = true,
    imageConfig = %*{"placement": "contain", "blendMode": "overwrite"})
  doAssert calls == 1
  doAssert target.isNil

block offset_draw_stays_unhinted:
  # Not a full-frame draw: render/image has to do a real placed draw, so the
  # producer cannot be handed the canvas it would be drawn onto.
  let (target, _, calls) = renderWith(producerCached = false,
    imageConfig = %*{"offsetX": 10})
  doAssert calls == 1
  doAssert target.isNil

# ---------------------------------------------------------------------------
# The same invariant over the scenes the repo actually ships.
#
# The synthetic cases above pin the interpreter's rules; this pins the rules
# against real scene JSON, which is where the regression actually bit. Every
# photo template caches its producer, and none of them was hinted — the shape
# was correct in the tests and wrong in every file we ship. A new template that
# draws a downloaded image some way that loses the hint fails here.
#
# Two seams feed this: frameOSGallery's own download hook, and the shared
# contextDownloadHook that the other six producers funnel through. Neither
# reaches the network, so this runs offline.
# ---------------------------------------------------------------------------

const RepoScenesDir = "../repo/scenes"

# Producers that decode a downloaded image; the interpreter must hand each of
# them a target when their image is drawn full-frame.
const ImageProducers = [
  "frameOSGallery", "downloadImage", "unsplash", "immich",
  "googlePhotos", "openaiImage", "wikicommons",
]

# Apps that reach the network with default state through something OTHER than
# the image-download seams above (their own API query, an RSS fetch). A scene
# that needs one cannot render offline at all, so it says nothing about the
# decode-target hint either way — and rendering them offline segfaults in the
# code that consumes the failed fetch, which reproduces on main and is not
# this test's business. wikicommons is here because it queries the Commons API
# before it downloads; its image decode is seamed, its search is not.
const OfflineBlockers = ["downloadUrl", "weather", "beRecycle", "wikicommons"]

proc usesImageProducer(sceneJson: string): bool =
  for producer in ImageProducers:
    if sceneJson.contains(producer):
      return true
  false

proc needsUnseamedNetwork(sceneJson: string): bool =
  for app in OfflineBlockers:
    if sceneJson.contains(app):
      return true
  false

proc recordingContextDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit): tuple[image: Image, data: string] =
  (recordingDownload(url, maxBytes, target, fit), "")

contextDownloadHook = recordingContextDownload

var shippedScenesChecked = 0
var shippedProducerCalls = 0
var coveredTemplates: seq[string] = @[]

for scenesPath in walkDirRec(RepoScenesDir):
  if scenesPath.splitPath().tail != "scenes.json":
    continue
  let raw = readFile(scenesPath)
  if not raw.usesImageProducer() or raw.needsUnseamedNetwork():
    continue

  let templateName = scenesPath.parentDir().splitPath().tail
  let inputs = parseInterpretedSceneInputs(raw)
  doAssert inputs.len > 0, templateName & ": no scenes parsed"
  let exportedScenes = buildInterpretedScenes(inputs)

  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  for id, exported in exportedScenes:
    uploaded[id] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  for sceneInput in inputs:
    if not ($(%*sceneInput.nodes)).usesImageProducer():
      continue
    hookTargets = @[]
    hookCalls = 0

    let config = FrameConfig(
      name: "test", mode: "embedded", width: 800, height: 480, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false
    )
    let scene = init(sceneInput.id, config, testLogger(config), %*{})
    var context = ExecutionContext(
      scene: scene, event: "render", payload: %*{}, hasImage: false,
      loopIndex: 0, loopKey: ".", nextSleep: 0.0
    )
    discard render(scene, context)

    let label = templateName & " / " & sceneInput.name
    # A producer that bails before downloading (no API key, no album
    # configured) never reaches a seam. That is the honest offline outcome,
    # not a failure — only what it was HANDED is under test here.
    if hookCalls == 0:
      continue
    shippedScenesChecked += 1
    coveredTemplates.add(label)
    for target in hookTargets:
      shippedProducerCalls += 1
      doAssert not target.isNil,
        label & ": the image producer was given no decode target, so on " &
        "embedded it decodes at native resolution — this is the 1024x1024 " &
        "over-budget crash. Check the decode-target hint in interpreter.nim."
      doAssert target.width <= config.width and target.height <= config.height,
        label & ": decode target " & $target.width & "x" & $target.height &
        " is larger than the 800x480 canvas"

setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
contextDownloadHook = nil

doAssert shippedScenesChecked >= 8,
  "expected the shipped photo templates to be covered, saw only " &
  $shippedScenesChecked & ": " & coveredTemplates.join(", ")

echo "test_interpreter_decode_target: all assertions passed (" &
  $shippedScenesChecked & " shipped scenes, " & $shippedProducerCalls &
  " producer runs)"
for label in coveredTemplates:
  echo "  covered: " & label
