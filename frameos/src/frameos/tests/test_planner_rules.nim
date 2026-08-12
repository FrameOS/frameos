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

  test "an overwriting producer keeps its overwrite blend":
    # The rule must not over-reach: a decoder overwrites every pixel it fits,
    # so the consumer's overwrite blend stays fusible.
    let scene = sceneWith(
      @[consumer(2, %*{"blendMode": "overwrite"}), producer(3, cached = false)],
      [(2, "image", 3)])
    let (plans, refusal) = scene.plan()
    check plans == 1
    check refusal == frFused
