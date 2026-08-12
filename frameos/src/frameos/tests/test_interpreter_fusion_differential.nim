import std/[json, tables]
import pixie
import ../interpreter
import ../planner
import ../types
import ../utils/app_images
import ../utils/image

# Fused output must equal materialized output.
#
# The planner (frameos/planner.nim) decides which image edges may skip
# materializing a whole `Value` and write straight into a target instead. Every
# one of those decisions is a bet that the pixels come out the same, and the
# bet has been lost before: the XKCD scene asked render/image for "contain" and
# got "cover" for months, because a producer decoded with the FRAME's scaling
# mode instead of the consumer's placement.
#
# So this renders a corpus of graph shapes twice — once with the planner
# enabled, once with it switched off so every edge falls back to the
# materialized floor — and compares the two canvases. A shape where they differ
# is a shape the planner must refuse, not a rendering preference. Each case
# renders TWICE per mode as well: an in-place transformer that scribbles on a
# cached producer's value looks fine on the first frame and wrong on the second.
#
# Two axes are held still, because neither is the planner's doing and each has
# its own home in the plan (docs/value-pipeline.md):
#
# * **The sampler.** A real streaming decoder picks nearest source pixels where
#   scaleAndDrawImage asks pixie for a smooth scale. Closing that is phase 3,
#   and it is why host-side streaming stays gated. The download seam below
#   therefore stands in as the ideal decoder: same fit function, same sampler.
# * **The fit boundary.** A decoder writes decoded pixels straight over its
#   target where a materialized draw composites them, and pixie's smooth draw
#   leaves a soft antialiased border a decoder never produces. So the two
#   disagree within a pixel or two of the fitted rect's edge, always have, and
#   would whatever the planner decided — it is the same precondition already
#   spelled out on readImageIntoTarget in utils/image.nim ("only equivalent to
#   compositing when the source cannot be transparent").
#
# Which is why the corpus runs at two source sizes. At canvas size there is no
# scaling and no boundary anywhere, so equality is demanded pixel-for-pixel
# over the whole frame — that is where the fusion *mechanics* (the identity
# no-op, in-place mutation, cache poisoning, the scratch redraw) are pinned.
# Scaled down, equality is demanded over the interior of the fitted rect, which
# is everything except the antialiased border above.

const
  CanvasWidth = 48
  CanvasHeight = 32
  # 16x16 into 48x32 scales by 3 for cover, 2 for contain, 3x2 for stretch,
  # all with integral offsets: the placements stay distinguishable and none of
  # them lands on a half pixel.
  SmallSource = 16
  # How far in from the fitted rect the comparison starts once scaling is in
  # play. Pixie's bilinear filter softens roughly a texel of border.
  BoundarySkip = 2

proc makeSource(width, height: int): Image =
  ## Opaque, like a photo.
  result = newImage(width, height)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result[x, y] = rgba(uint8(17 + x * 13), uint8(29 + y * 11),
                          uint8((x * y * 3) and 0xFF), 255)

var currentSource = makeSource(CanvasWidth, CanvasHeight)
var hookTargetsSeen = 0

proc idealDecoder(url: string, maxBytes: int, target: Image,
    fit: ScaledDecodeFit, boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  ## What decode-into-target does: fit the source into the caller's image,
  ## overwriting rather than compositing. Without a target the caller gets the
  ## source at its native resolution, which is the materialized floor.
  if target.isNil:
    return (currentSource.copy(), "")
  hookTargetsSeen += 1
  scaleAndDrawImage(target, currentSource, scaledFitPlacement(fit),
    blendMode = OverwriteBlend)
  (target, "")

imageBoundsEnabled = false
contextDownloadHook = idealDecoder

proc testConfig(): FrameConfig =
  FrameConfig(
    name: "test", mode: "embedded", width: CanvasWidth, height: CanvasHeight,
    rotate: 0, scalingMode: "cover", debug: false, settings: %*{},
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

proc cacheBlock(enabled: bool): JsonNode =
  %*{
    "enabled": enabled,
    "inputEnabled": false,
    "durationEnabled": enabled,
    "duration": "900",
    "expressionEnabled": false
  }

type Case = object
  scaled: bool        ## source smaller than the canvas, so a real fit happens
  producerCached: bool
  transformer: string ## "" or "opacity"
  opacity: string
  placement: string
  blendMode: string
  offsetX: int

proc label(c: Case): string =
  "source=" & (if c.scaled: "16x16" else: "canvas") &
    " producerCache=" & $c.producerCached &
    " transformer=" & (if c.transformer.len == 0: "none"
                       else: c.transformer & "(" & c.opacity & ")") &
    " placement=" & c.placement &
    " blend=" & c.blendMode &
    " offsetX=" & $c.offsetX

proc buildScene(c: Case): ExportedInterpretedScene =
  var imageConfig = %*{"placement": c.placement, "blendMode": c.blendMode}
  if c.offsetX != 0:
    imageConfig["offsetX"] = %c.offsetX

  var nodes = @[
    node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/image", "config": imageConfig}),
    node(3, "app", %*{
      "keyword": "data/downloadImage",
      "config": {"url": "https://example.invalid/photo.jpg"},
      "cache": cacheBlock(c.producerCached)
    })
  ]
  var edges = @[edge(1, 1, "next", 2, "prev")]

  if c.transformer.len == 0:
    edges.add(edge(2, 3, "fieldOutput", 2, "fieldInput/image"))
  else:
    nodes.add(node(4, "app", %*{
      "keyword": "render/" & c.transformer,
      "config": {"opacity": c.opacity},
      "cache": cacheBlock(false)
    }))
    edges.add(edge(2, 3, "fieldOutput", 4, "fieldInput/image"))
    edges.add(edge(3, 4, "fieldOutput", 2, "fieldInput/image"))

  ExportedInterpretedScene(
    name: "Fusion differential",
    # Nothing like the source, so a letterboxed "contain" margin that gets
    # erased or drawn over shows up as a difference.
    backgroundColor: parseHtmlColor("#204080"),
    refreshInterval: 60.0,
    publicStateFields: @[],
    nodes: nodes,
    edges: edges,
    apps: %*{}
  )

proc renderFrames(c: Case, fused: bool): tuple[frames: seq[Image], targets: int] =
  ## Two consecutive renders of ONE scene instance, so a cache poisoned by an
  ## in-place mutation shows up on the second frame.
  imageFusionEnabled = fused
  currentSource =
    if c.scaled: makeSource(SmallSource, SmallSource)
    else: makeSource(CanvasWidth, CanvasHeight)

  let sceneId = "tests/fusion-differential".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = buildScene(c)
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()

  hookTargetsSeen = 0
  let config = testConfig()
  let scene = init(sceneId, config, testLogger(config), %*{})

  var frames: seq[Image] = @[]
  for _ in 0 .. 1:
    var context = ExecutionContext(
      scene: scene, event: "render", payload: %*{}, hasImage: false,
      loopIndex: 0, loopKey: ".", nextSleep: 0.0
    )
    frames.add(render(scene, context).copy())
  (frames, hookTargetsSeen)

proc comparedRect(c: Case, fused: bool): tuple[x0, y0, x1, y1: int] =
  ## The region the two renders must agree on exactly. Everything when there is
  ## no fit to soften: an unscaled source, or a shape that did not fuse at all
  ## and so ran the identical code twice.
  if not c.scaled or not fused:
    return (0, 0, CanvasWidth, CanvasHeight)
  case c.placement
  of "contain":
    # min(48/16, 32/16) = 2 -> a 32x32 rect centred horizontally.
    let side = SmallSource * 2
    let x0 = (CanvasWidth - side) div 2
    (x0 + BoundarySkip, BoundarySkip, x0 + side - BoundarySkip, CanvasHeight - BoundarySkip)
  else:
    # cover and stretch both fill the canvas.
    (BoundarySkip, BoundarySkip, CanvasWidth - BoundarySkip, CanvasHeight - BoundarySkip)

proc maxChannelDelta(a, b: Image, rect: tuple[x0, y0, x1, y1: int]): int =
  doAssert a.width == b.width and a.height == b.height
  for y in rect.y0 ..< rect.y1:
    for x in rect.x0 ..< rect.x1:
      let p = a[x, y]
      let q = b[x, y]
      result = max(result, abs(p.r.int - q.r.int))
      result = max(result, abs(p.g.int - q.g.int))
      result = max(result, abs(p.b.int - q.b.int))
      result = max(result, abs(p.a.int - q.a.int))

proc expectFused(c: Case): bool =
  ## The planner's decision, restated from the rules in docs/value-pipeline.md
  ## rather than read back out of the planner: a mismatch means either a rule
  ## changed on purpose or the planner drifted.
  if c.placement notin ["cover", "contain", "stretch"]: return false
  if c.offsetX != 0: return false
  if c.blendMode notin ["normal", "overwrite"]: return false
  # A forwarding transformer mutates in place, so it must own the image it
  # mutates: never the live canvas, never a cached producer's shared value.
  if c.transformer.len > 0 and c.producerCached: return false
  let ownedTarget = c.producerCached or c.transformer.len > 0
  if ownedTarget and c.placement == "contain" and c.blendMode == "overwrite":
    # A scratch carries transparent margins of its own; drawing those over the
    # canvas with overwrite erases what was already there.
    return false
  true

var cases: seq[Case] = @[]
for scaled in [false, true]:
  for producerCached in [false, true]:
    for (transformer, opacity) in [("", ""), ("opacity", "1"), ("opacity", "0.5")]:
      for placement in ["cover", "contain", "stretch", "center", "top-left"]:
        for blendMode in ["normal", "overwrite", "multiply"]:
          for offsetX in [0, 5]:
            cases.add(Case(scaled: scaled, producerCached: producerCached,
              transformer: transformer, opacity: opacity, placement: placement,
              blendMode: blendMode, offsetX: offsetX))

var fusedCount = 0
var exactCount = 0

for c in cases:
  let (fusedFrames, fusedTargets) = renderFrames(c, fused = true)
  let (plainFrames, plainTargets) = renderFrames(c, fused = false)

  doAssert plainTargets == 0,
    c.label() & ": fusion is off, yet a producer was still handed a target"

  let fusedHappened = fusedTargets > 0
  doAssert fusedHappened == c.expectFused(),
    c.label() & ": expected fused=" & $c.expectFused() & ", planner chose " &
      $fusedHappened
  if fusedHappened:
    fusedCount += 1

  let rect = c.comparedRect(fusedHappened)
  if rect == (0, 0, CanvasWidth, CanvasHeight):
    exactCount += 1
  # A pointwise transformer is applied before the scale in the fused path and
  # after it in the materialized one. Uniform alpha commutes with a weighted
  # average, so the two agree to within one step of 8-bit quantization — but
  # nothing may drift further than that, and with no scaling not even that.
  let allowed =
    if fusedHappened and c.scaled and c.transformer.len > 0: 1
    else: 0

  for frameIndex in 0 .. 1:
    let delta = maxChannelDelta(fusedFrames[frameIndex], plainFrames[frameIndex], rect)
    doAssert delta <= allowed,
      c.label() & " frame " & $frameIndex & ": fused and materialized output " &
        "differ by " & $delta & " over " & $rect & " (allowed " & $allowed & ")"

imageFusionEnabled = true
setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
contextDownloadHook = nil

doAssert fusedCount >= 40,
  "the corpus barely fused anything (" & $fusedCount & " of " & $cases.len &
    "), so it is not testing much"

echo "test_interpreter_fusion_differential: " & $cases.len & " graph shapes, " &
  $fusedCount & " fused, " & $exactCount & " compared over the whole frame"
