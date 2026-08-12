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

proc galleryScene(producerCached: bool, imageConfig: JsonNode,
    withOpacity = false): ExportedInterpretedScene =
  var nodes = @[
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
  ]
  var edges = @[edge(1, 1, "next", 2, "prev")]
  if withOpacity:
    nodes.add(node(4, "app", %*{
      "keyword": "render/opacity", "config": {"opacity": "0.5"}}))
    edges.add(edge(2, 3, "fieldOutput", 4, "fieldInput/image"))
    edges.add(edge(3, 4, "fieldOutput", 2, "fieldInput/image"))
  else:
    edges.add(edge(2, 3, "fieldOutput", 2, "fieldInput/image"))

  ExportedInterpretedScene(
    name: "Decode target test",
    backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: nodes,
    edges: edges,
    apps: %*{}
  )

proc renderWith(producerCached: bool, imageConfig: JsonNode = %*{},
    withOpacity = false): tuple[target: Image, canvas: Image, calls: int] =
  let sceneId = "tests/decode-target".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = galleryScene(producerCached, imageConfig, withOpacity)
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

block a_transformer_in_the_middle_forwards_the_hint:
  # The shape the old whitelist could not express: dropping a render/opacity
  # between the producer and render/image used to cost BOTH the fusion (the
  # producer went back to decoding at native resolution) and a full-frame copy
  # inside opacity's get(). The producer now gets a bounded target forwarded
  # through the transformer, which mutates it in place.
  let (target, canvas, calls) = renderWith(producerCached = false,
    withOpacity = true)
  doAssert calls == 1
  doAssert not target.isNil,
    "a producer behind a forwarding transformer must still be bounded"
  doAssert target.width == canvas.width and target.height == canvas.height
  doAssert target != canvas,
    "an in-place transformer must own what it mutates, never the live canvas"

block a_transformer_over_a_cached_producer_stays_unhinted:
  # Mutating a cached producer's value in place would poison the cache: the
  # next render would apply the opacity a second time.
  let (target, _, calls) = renderWith(producerCached = true, withOpacity = true)
  doAssert calls == 1
  doAssert target.isNil

block the_plan_records_why_it_chose_an_owned_target:
  # The distinction the embedded runtime acts on: a scratch chosen only to keep
  # a cached producer off the live canvas can be upgraded back to the canvas
  # when the cache would refuse to store the value anyway (frame-sized images
  # on embedded). A scratch chosen because a transformer needs something of its
  # own to mutate can never be.
  let sceneId = "tests/decode-target".SceneId
  proc planFor(producerCached: bool, withOpacity: bool): ImageFusionPlan =
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = galleryScene(producerCached, %*{}, withOpacity)
    setUploadedInterpretedScenes(uploaded)
    resetInterpretedScenes()
    let config = testConfig()
    let scene = InterpretedFrameScene(init(sceneId, config, testLogger(config), %*{}))
    for _, plan in scene.imageFusionPlans:
      return plan
    nil

  let cachedPlan = planFor(producerCached = true, withOpacity = false)
  doAssert not cachedPlan.isNil
  doAssert cachedPlan.tier == iftOwnedScratch
  doAssert cachedPlan.ownedForCache

  let uncachedPlan = planFor(producerCached = false, withOpacity = false)
  doAssert not uncachedPlan.isNil
  doAssert uncachedPlan.tier == iftLiveCanvas
  doAssert not uncachedPlan.ownedForCache

  let forwardedPlan = planFor(producerCached = false, withOpacity = true)
  doAssert not forwardedPlan.isNil
  doAssert forwardedPlan.tier == iftOwnedScratch
  doAssert not forwardedPlan.ownedForCache,
    "a scratch a transformer mutates in place must never be upgraded away"

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

# Apps that reach the network through something OTHER than the image-download
# seams above (their own API query, an RSS fetch). Those requests would be
# real, so a scene needing one is skipped: this test must not depend on the
# network, and a producer that never got as far as downloading says nothing
# about the decode-target hint anyway. wikicommons is here because it queries
# the Commons API before it downloads — its image decode is seamed, its
# search is not.
const UnseamedNetworkApps = ["downloadUrl", "weather", "beRecycle", "wikicommons"]

proc usesImageProducer(sceneJson: string): bool =
  for producer in ImageProducers:
    if sceneJson.contains(producer):
      return true
  false

proc needsUnseamedNetwork(sceneJson: string): bool =
  for app in UnseamedNetworkApps:
    if sceneJson.contains(app):
      return true
  false

proc recordingContextDownload(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
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
