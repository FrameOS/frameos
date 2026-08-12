import std/[json, tables, unittest]
import ../planner
import ../types

# Focused pins for the planner rules that exist because fused output must
# equal materialized output (docs/value-pipeline.md, principle 4). Each case
# builds the smallest graph that could break the rule and checks both the
# decision and the reported refusal, so "why did this edge not fuse" keeps a
# data answer.

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc sceneWith(nodes: seq[DiagramNode],
    inputs: openArray[(int, string, int)]): InterpretedFrameScene =
  result = InterpretedFrameScene(
    nodes: initTable[NodeId, DiagramNode](),
    appInputsForNodeId: initTable[NodeId, Table[string, NodeId]](),
    appInlineInputsForNodeId: initTable[NodeId, Table[string, string]](),
    imageFusionPlans: initTable[NodeId, ImageFusionPlan]()
  )
  for n in nodes:
    result.nodes[n.id] = n
  for (target, field, source) in inputs:
    if not result.appInputsForNodeId.hasKey(target.NodeId):
      result.appInputsForNodeId[target.NodeId] = initTable[string, NodeId]()
    result.appInputsForNodeId[target.NodeId][field] = source.NodeId

proc consumer(id: int, config: JsonNode): DiagramNode =
  node(id, "app", %*{"keyword": "render/image", "config": config})

proc producer(id: int, cached: bool): DiagramNode =
  node(id, "app", %*{
    "keyword": "data/downloadImage",
    "config": {"url": "https://example.invalid/photo.jpg"},
    "cache": {"enabled": cached}
  })

proc plan(scene: InterpretedFrameScene,
    isOpaque: OpaqueCheck = nil): tuple[plans: int, refusal: FusionRefusal] =
  var diagnoses: seq[EdgeDiagnosis] = @[]
  scene.planImageFusion(isOpaque, addr diagnoses)
  doAssert diagnoses.len == 1
  (scene.imageFusionPlans.len, diagnoses[0].refusal)

let jsProducerAt3: OpaqueCheck =
  proc (nodeId: NodeId): bool {.closure, gcsafe, raises: [].} =
    nodeId == 3.NodeId

suite "planner rules":
  test "a state-wired fit never feeds a cached producer":
    # The cached canvas-sized value bakes in the fit it was decoded with; a
    # placement that changes per render would keep serving the stale crop.
    let scene = sceneWith(
      @[consumer(2, %*{}), producer(3, cached = true), node(5, "state", %*{})],
      [(2, "image", 3), (2, "placement", 5)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frDynamicFitOverCache

  test "the same wired fit over an uncached producer fuses":
    let scene = sceneWith(
      @[consumer(2, %*{}), producer(3, cached = false), node(5, "state", %*{})],
      [(2, "image", 3), (2, "placement", 5)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused
    check scene.imageFusionPlans[2.NodeId].fitFromNodeId == 5.NodeId

  test "a natural producer is exempt from the stale-fit rule":
    # Its output is target-sized under every placement, so there is no fit to
    # bake into the cache.
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(3, "app", %*{"keyword": "nodeapp_js", "cache": {"enabled": true}}),
        node(5, "state", %*{})],
      [(2, "image", 3), (2, "placement", 5)])
    let (plans, refusal) = scene.plan(jsProducerAt3)
    check plans == 1
    check refusal == frFused
    check scene.imageFusionPlans[2.NodeId].tier == iftOwnedScratch

  test "a compositing producer under an overwrite blend does not fuse":
    # A JS app draws source-over; it cannot honour a consumer blend that
    # erases. Materialized, the overwrite draw would punch the app's
    # transparency through the canvas — fused, the old pixels would survive.
    let scene = sceneWith(
      @[consumer(2, %*{"blendMode": "overwrite"}),
        node(3, "app", %*{"keyword": "nodeapp_js"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan(jsProducerAt3)
    check plans == 0
    check refusal == frCompositeBlend

  test "a compositing producer under the default normal blend fuses":
    let scene = sceneWith(
      @[consumer(2, %*{"placement": "center"}), node(3, "app", %*{"keyword": "nodeapp_js"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan(jsProducerAt3)
    check plans == 1
    check refusal == frFused
    check scene.imageFusionPlans[2.NodeId].tier == iftLiveCanvas

  test "rotate at 180 forwards the target; the chain owns a scratch":
    # 180 preserves dimensions, so rotateImage declares forwardsTarget gated
    # on exactly that config. A forwarding hop forces the owned tier: the
    # transformer mutates in place, and it must own what it mutates.
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(4, "app", %*{"keyword": "data/rotateImage",
          "config": {"rotationDegree": 180}}),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused
    let plan = scene.imageFusionPlans[2.NodeId]
    check plan.tier == iftOwnedScratch
    check plan.inPlaceNodeIds == @[4.NodeId]
    check plan.producerNodeId == 3.NodeId

  test "rotate at 90 is opaque — its output has different dimensions":
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(4, "app", %*{"keyword": "data/rotateImage",
          "config": {"rotationDegree": 90}}),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

  test "an overwriting producer keeps its overwrite blend":
    # The rule must not over-reach: a decoder overwrites every pixel it fits,
    # so the consumer's overwrite blend stays fusible.
    let scene = sceneWith(
      @[consumer(2, %*{"blendMode": "overwrite"}), producer(3, cached = false)],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused

suite "opaque-output producers":
  # render/color and render/gradient declare intoTarget with
  # requireOpaqueColor (docs/value-pipeline.md, transformer audit): an opaque
  # fill overwrites every pixel of its target, so a set and a composite are
  # the same picture and the generator may paint the canvas in place. Any
  # alpha below 1 makes that an erase where the floor composites.

  proc colorProducer(id: int, config: JsonNode): DiagramNode =
    node(id, "app", %*{"keyword": "render/color", "config": config})

  test "an opaque color fill claims the live canvas":
    let scene = sceneWith(
      @[consumer(2, %*{}), colorProducer(3, %*{"color": "#336699"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused
    check scene.imageFusionPlans[2.NodeId].tier == iftLiveCanvas

  test "the unset color falls back to the opaque config default and fuses":
    let scene = sceneWith(
      @[consumer(2, %*{}), colorProducer(3, %*{})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused

  test "every placement fuses: a generator's output is target-sized":
    let scene = sceneWith(
      @[consumer(2, %*{"placement": "center"}),
        colorProducer(3, %*{"color": "#336699"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused

  test "a semi-transparent fill stays on the floor — tint must not erase":
    # Fused, the fill would SET half-transparent pixels over the canvas;
    # materialized, render/image composites them over what is already there.
    # Those are different pictures, so the edge must not fuse.
    let scene = sceneWith(
      @[consumer(2, %*{}),
        colorProducer(3, %*{"color": "rgba(51, 102, 153, 0.5)"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

  test "a wired color never resolves and never fuses":
    let scene = sceneWith(
      @[consumer(2, %*{}), colorProducer(3, %*{}), node(5, "state", %*{})],
      [(2, "image", 3), (3, "color", 5)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

  test "an unparseable color stays on the floor":
    # Only a value that provably parses opaque may fuse. (An empty string —
    # scene JSON's way of saying "use the default" — never reaches the parse;
    # a missing *default* would, and parseHtmlColor throws a Defect on "",
    # which the same except-and-refuse path absorbs.)
    let scene = sceneWith(
      @[consumer(2, %*{}), colorProducer(3, %*{"color": "not-a-color"})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

  test "drawing over an input image is a different node; it stays unfused":
    let scene = sceneWith(
      @[consumer(2, %*{}), colorProducer(3, %*{"color": "#336699"}),
        producer(6, cached = false)],
      [(2, "image", 3), (3, "inputImage", 6)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

  test "a cached gradient gets a scratch of its own, never the canvas":
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(3, "app", %*{"keyword": "render/gradient",
          "config": {"startColor": "#800080", "endColor": "#ffc0cb"},
          "cache": {"enabled": true}})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused
    let gradientPlan = scene.imageFusionPlans[2.NodeId]
    check gradientPlan.tier == iftOwnedScratch
    check gradientPlan.ownedForCache

  test "one semi-transparent gradient stop is enough to refuse":
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(3, "app", %*{"keyword": "render/gradient",
          "config": {"startColor": "#800080",
                     "endColor": "rgba(255, 192, 203, 0.9)"}})],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 0
    check refusal == frChainOpaque

suite "requested bounds":
  # The requestedBounds protocol (docs/value-pipeline.md): edges the fusion
  # planner leaves materialized still pass the consumer's useful resolution
  # upstream — statically or not at all. Each case builds the smallest graph
  # that could get a bound wrong.

  proc plans(scene: InterpretedFrameScene): Table[NodeId, ImageBoundsPlan] =
    scene.planImageFusion()
    scene.planImageBounds()
    scene.imageBoundsPlans

  proc rotate(id: int, degree: string): DiagramNode =
    node(id, "app", %*{"keyword": "data/rotateImage",
      "config": {"rotationDegree": degree}})

  test "a 90-degree rotation swaps the canvas bounds":
    let scene = sceneWith(
      @[consumer(2, %*{}), rotate(4, "90"), producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    let plan = boundsPlans[2.NodeId]
    check plan.producerNodeId == 3.NodeId
    check plan.fromCanvas
    check plan.swapped

  test "a 180-degree rotation fuses instead; bounds stay out of the way":
    # forwardsTarget wins: the chain mutates a scratch in place, which is a
    # stronger promise than a bound.
    let scene = sceneWith(
      @[consumer(2, %*{}), rotate(4, "180"), producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    scene.planImageFusion()
    scene.planImageBounds()
    check scene.imageFusionPlans.len == 1
    check scene.imageBoundsPlans.len == 0

  test "an arbitrary rotation angle refuses — a wrong bound is a bug":
    let scene = sceneWith(
      @[consumer(2, %*{}), rotate(4, "45"), producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    check plans(scene).len == 0

  test "a wired rotation degree refuses":
    let scene = sceneWith(
      @[consumer(2, %*{}), rotate(4, "90"), producer(3, cached = false),
        node(5, "state", %*{})],
      [(2, "image", 4), (4, "image", 3), (4, "rotationDegree", 5)])
    check plans(scene).len == 0

  test "a resize pins the bounds to its own dimensions":
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(4, "app", %*{"keyword": "data/resizeImage",
          "config": {"width": 300, "height": 200}}),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    let plan = boundsPlans[2.NodeId]
    check not plan.fromCanvas
    check plan.fixedWidth == 300
    check plan.fixedHeight == 200
    check not plan.swapped

  test "a rotation above a resize swaps what the resize pinned":
    let scene = sceneWith(
      @[consumer(2, %*{}),
        node(4, "app", %*{"keyword": "data/resizeImage",
          "config": {"width": 300, "height": 200}}),
        rotate(6, "270"),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 6), (6, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    let plan = boundsPlans[2.NodeId]
    check not plan.fromCanvas
    check plan.fixedWidth == 300 and plan.fixedHeight == 200
    check plan.swapped

  test "a refused direct shape still gets bounds":
    # blendMode mask keeps the edge off the fusion tiers, but the consumer's
    # useful resolution is a property of the draw, not the blend.
    let scene = sceneWith(
      @[consumer(2, %*{"blendMode": "mask"}), producer(3, cached = false)],
      [(2, "image", 3)])
    scene.planImageFusion()
    scene.planImageBounds()
    check scene.imageFusionPlans.len == 0
    check scene.imageBoundsPlans.len == 1
    check scene.imageBoundsPlans[2.NodeId].producerNodeId == 3.NodeId

  test "a natural producer has nothing to bound":
    let scene = sceneWith(
      @[consumer(2, %*{"blendMode": "mask"}),
        node(3, "app", %*{"keyword": "render/color",
          "config": {"color": "#336699"}})],
      [(2, "image", 3)])
    check plans(scene).len == 0

  proc zoomPan(id: int, config: JsonNode): DiagramNode =
    node(id, "app", %*{"keyword": "render/zoomPan", "config": config})

  test "a zoomPan consumer multiplies the canvas bounds by its zoom":
    # A bounds-only consumer: it can never hand its producer a target — its
    # draw is a per-render crop — but the largest crop it will ever show uses
    # at most zoom times the canvas resolution from the source.
    let scene = sceneWith(
      @[zoomPan(2, %*{"zoomStart": "1.0", "zoomEnd": "2.0"}),
        producer(3, cached = false)],
      [(2, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    let plan = boundsPlans[2.NodeId]
    check plan.producerNodeId == 3.NodeId
    check plan.fromCanvas
    check plan.scale == 2.0

  test "an unset zoom is the config default, not a refusal":
    let scene = sceneWith(
      @[zoomPan(2, %*{}), producer(3, cached = false)],
      [(2, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    check boundsPlans[2.NodeId].scale == 1.4

  test "the multiplier is the maximum zoom, floored at one":
    # zoomInOut visits every zoom between start and end; a zoom under 1.0 is
    # clamped by the app, so the floor covers it.
    let scene = sceneWith(
      @[zoomPan(2, %*{"zoomStart": "3.0", "zoomEnd": "0.5"}),
        producer(3, cached = false)],
      [(2, "image", 3)])
    check plans(scene)[2.NodeId].scale == 3.0

  test "a wired zoom refuses — a wrong bound is a bug":
    let scene = sceneWith(
      @[zoomPan(2, %*{}), producer(3, cached = false), node(5, "state", %*{})],
      [(2, "image", 3), (2, "zoomEnd", 5)])
    check plans(scene).len == 0

  test "drawing over an input image is a different node; no zoomPan bounds":
    # The inputImage's size, not the canvas's, would define the useful
    # resolution — and it is not statically knowable.
    let scene = sceneWith(
      @[zoomPan(2, %*{}), producer(3, cached = false),
        producer(6, cached = false)],
      [(2, "image", 3), (2, "inputImage", 6)])
    check plans(scene).len == 0

  test "a zoomPan mid-chain multiplies what the consumer requested":
    # Both the render/image edge (through the forwardsBounds hop) and the
    # zoomPan node's own origin resolve to the same producer; the offer is
    # made by whichever runs as the render node.
    let scene = sceneWith(
      @[consumer(2, %*{}), zoomPan(4, %*{"zoomEnd": "1.5"}),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 2
    for nodeId in [2.NodeId, 4.NodeId]:
      let plan = boundsPlans[nodeId]
      check plan.producerNodeId == 3.NodeId
      check plan.fromCanvas
      check plan.scale == 1.5

  test "a resize above a zoomPan discards the accumulated multiplier":
    # A replace means "what is downstream no longer matters": the resize's
    # output is its configured size no matter what the zoom shows of it.
    let scene = sceneWith(
      @[zoomPan(2, %*{"zoomEnd": "2.0"}),
        node(4, "app", %*{"keyword": "data/resizeImage",
          "config": {"width": 300, "height": 200}}),
        producer(3, cached = false)],
      [(2, "image", 4), (4, "image", 3)])
    let boundsPlans = plans(scene)
    check boundsPlans.len == 1
    let plan = boundsPlans[2.NodeId]
    check not plan.fromCanvas
    check plan.fixedWidth == 300 and plan.fixedHeight == 200
    check plan.scale == 1.0
