import std/[json, tables, strutils, unittest]
import pixie
import ../interpreter
import ../types


type LogStore = ref object
  entries: seq[JsonNode]

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 8,
    height: 6,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig, store: LogStore): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    store.entries.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(id, source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(
    id: id.NodeId,
    source: source.NodeId,
    sourceHandle: sourceHandle,
    target: target.NodeId,
    targetHandle: targetHandle,
    edgeType: ""
  )

proc ctx(scene: FrameScene, event: string): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: event,
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )

proc eventPayload(store: LogStore, eventName: string): JsonNode =
  for entry in store.entries:
    if entry.kind == JObject and entry.hasKey("event") and entry["event"].kind == JString and entry["event"].getStr() == eventName:
      return entry
  return nil

proc withUploadedScene(sceneId: SceneId, exported: ExportedInterpretedScene, body: proc(store: LogStore, scene: FrameScene)) =
  let config = testConfig()
  let store = LogStore(entries: @[])
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = exported
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  try:
    let scene = init(sceneId, config, testLogger(config, store), %*{})
    body(store, scene)
  finally:
    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
    resetInterpretedScenes()

suite "interpreter error paths":
  test "invalid node reference logs nodeNotFound without crashing render":
    let sceneId = "tests/interpreter-errors/missing-node".SceneId
    let exported = ExportedInterpretedScene(
      name: "missing node",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"})
      ],
      edges: @[
        edge(100, 10, "next", 999, "prev")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      discard render(scene, ctx(scene, "render"))
      let miss = eventPayload(store, "interpreter:nodeNotFound")
      check not miss.isNil
      check miss["nodeId"].getInt() == 999

  test "runEvent catches node execution errors and logs runEventInterpreted:error":
    let sceneId = "tests/interpreter-errors/source-node".SceneId
    let exported = ExportedInterpretedScene(
      name: "source node runtime error",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(2, "source", %*{"keyword": "source/demo"})
      ],
      edges: @[
        edge(101, 10, "next", 2, "prev")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      discard render(scene, ctx(scene, "render"))
      let err = eventPayload(store, "runEventInterpreted:error")
      check not err.isNil
      check err["nodeId"].getInt() == 2
      check "Source nodes" in err["error"].getStr()

  test "malformed field path is handled as literal key during edge wiring":
    var scene = InterpretedFrameScene(nodes: initTable[NodeId, DiagramNode]())
    scene.nodes[1.NodeId] = node(1, "app", %*{"name": "newImage", "keyword": "data/newImage"})

    scene.setNodeFieldFromEdge(edge(1, 1, "field/state[broken", 7, "prev"))

    check scene.nodes[1.NodeId].data["config"].hasKey("state[broken")
    check scene.nodes[1.NodeId].data["config"]["state[broken"].getInt() == 7
