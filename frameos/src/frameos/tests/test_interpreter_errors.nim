import std/[json, tables, strutils, unittest]
import pixie
import ../channels
import ../interpreter
import ../../apps/data/frameOSGallery/app as galleryApp
import ../types
import ../values


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

proc ctx(scene: FrameScene, event: string, payload: JsonNode): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: event,
    payload: payload,
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )

proc eventPayload(store: LogStore, eventName: string): JsonNode =
  for entry in store.entries:
    if entry.kind == JObject and entry.hasKey("event") and entry["event"].kind == JString and entry["event"].getStr() == eventName:
      return entry
  return nil

proc clearEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

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

  test "data node evaluation does not continue through flow edges":
    let sceneId = "tests/interpreter-errors/data-node-flow-edge".SceneId
    let exported = ExportedInterpretedScene(
      name: "data node flow edge",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[
        StateField(name: "bucket", fieldType: "string", value: %*"")
      ],
      nodes: @[
        node(10, "code", %*{
          "codeArgs": [],
          "codeOutputs": [%*{"name": "bucket", "type": "string"}],
          "codeJS": "'ok'"
        }),
        node(20, "app", %*{
          "keyword": "logic/setAsState",
          "config": {
            "stateKey": "bucket",
            "valueString": "should-not-run"
          }
        })
      ],
      edges: @[
        edge(100, 10, "next", 20, "prev")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      let value = scene.getDataNode(10.NodeId, ctx(scene, "render"))
      check value.kind == fkString
      check value.asString() == "ok"
      check scene.state{"bucket"}.getStr() == ""
      check eventPayload(store, "interpreter:dispatch:ignored").isNil

  test "event node config filters interpreted listener payloads":
    let sceneId = "tests/interpreter-errors/event-filter".SceneId
    let exported = ExportedInterpretedScene(
      name: "event filter",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "keyUp", "config": {"key": "Enter"}}),
        node(20, "source", %*{"keyword": "source/demo"})
      ],
      edges: @[
        edge(100, 10, "next", 20, "prev")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      runEvent(scene, ctx(scene, "keyUp", %*{"key": "Escape"}))
      check eventPayload(store, "runEventInterpreted:error").isNil

      runEvent(scene, ctx(scene, "keyUp", %*{"key": "Enter"}))
      let err = eventPayload(store, "runEventInterpreted:error")
      check not err.isNil
      check err["nodeId"].getInt() == 20

  test "codeJS expression with trailing comma is normalized":
    let sceneId = "tests/interpreter-errors/codejs-trailing-comma".SceneId
    let exported = ExportedInterpretedScene(
      name: "codeJS trailing comma",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "code", %*{
          "codeArgs": [],
          "codeOutputs": [%*{"name": "text", "type": "string"}],
          "codeJS": "`hello ${1 + 1}`,"
        })
      ],
      edges: @[]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      let value = scene.getDataNode(10.NodeId, ctx(scene, "render"))
      check value.kind == fkString
      check value.asString() == "hello 2"
      check eventPayload(store, "interpreter:jsCompileError").isNil

  test "js runtime errors include original diagram node id from parsed scenes":
    let sceneId = "tests/interpreter-errors/source-node-id".SceneId
    let parsed = parseInterpretedScenes($(%*[
      {
        "id": "tests/interpreter-errors/source-node-id",
        "name": "source node id",
        "settings": {
          "backgroundColor": "#000000",
          "refreshInterval": 1
        },
        "fields": [],
        "nodes": [
          {
            "id": "event-node",
            "type": "event",
            "data": {"keyword": "render"}
          },
          {
            "id": "code-node",
            "type": "code",
            "data": {"codeJS": "missingValue"}
          }
        ],
        "edges": [
          {
            "id": "edge-node",
            "source": "event-node",
            "sourceHandle": "next",
            "target": "code-node",
            "targetHandle": "prev"
          }
        ]
      }
    ]))
    let exported = parsed[sceneId]

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      discard render(scene, ctx(scene, "render"))
      let err = eventPayload(store, "interpreter:jsError")
      check not err.isNil
      check err["sourceNodeId"].getStr() == "code-node"

  test "render dispatch from render event is ignored to avoid immediate self loop":
    clearEventChannel()
    let sceneId = "tests/interpreter-errors/render-self-dispatch".SceneId
    let exported = ExportedInterpretedScene(
      name: "render self dispatch",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(20, "dispatch", %*{"keyword": "render", "config": {}})
      ],
      edges: @[
        edge(100, 10, "next", 20, "prev")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      discard render(scene, ctx(scene, "render"))
      let (ok, _) = eventChannel.tryRecv()
      check not ok
      let ignored = eventPayload(store, "interpreter:dispatch:ignored")
      check not ignored.isNil
      check ignored["eventName"].getStr() == "render"
      check ignored["reason"].getStr() == "renderSelfDispatch"
    clearEventChannel()

  test "malformed field path is handled as literal key during edge wiring":
    var scene = InterpretedFrameScene(nodes: initTable[NodeId, DiagramNode]())
    scene.nodes[1.NodeId] = node(1, "app", %*{"name": "newImage", "keyword": "data/newImage"})

    scene.setNodeFieldFromEdge(edge(1, 1, "field/state[broken", 7, "prev"))

    check scene.nodes[1.NodeId].data["config"].hasKey("state[broken")
    check scene.nodes[1.NodeId].data["config"]["state[broken"].getInt() == 7

  test "invalid code syntax logs compile errors during interpreted scene init":
    let sceneId = "tests/interpreter-errors/invalid-code".SceneId
    let exported = ExportedInterpretedScene(
      name: "invalid code syntax",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(20, "code", %*{
          "codeArgs": [],
          "codeOutputs": [%*{"name": "text", "type": "text"}],
          "codeJS": "(() => {"
        })
      ],
      edges: @[
        edge(101, 10, "next", 20, "prev")
      ]
    )

    let config = testConfig()
    let store = LogStore(entries: @[])
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = exported
    setUploadedInterpretedScenes(uploaded)
    resetInterpretedScenes()
    try:
      expect(Exception):
        discard init(sceneId, config, testLogger(config, store), %*{})
      let compileErr = eventPayload(store, "interpreter:jsCompileError")
      check not compileErr.isNil
      check compileErr["nodeId"].getInt() == 20
      check compileErr["sourceKind"].getStr() == "code"
      check compileErr["snippet"].getStr() == "(() => {"
    finally:
      setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
      resetInterpretedScenes()

  test "failed image download paints the error instead of 'No image provided'":
    let savedHook = galleryApp.galleryDownloadHook
    galleryApp.galleryDownloadHook =
      proc(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit): Image =
        raise newException(ValueError, "response too large: 2601969 > 1409024 bytes")
    defer: galleryApp.galleryDownloadHook = savedHook

    let sceneId = "tests/interpreter-errors/image-producer-error".SceneId
    let exported = ExportedInterpretedScene(
      name: "image producer error",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 1.0,
      publicStateFields: @[],
      nodes: @[
        node(10, "event", %*{"keyword": "render"}),
        node(20, "app", %*{"keyword": "render/image", "config": {}}),
        node(30, "app", %*{
          "keyword": "data/frameOSGallery",
          "config": {"category": "random"}
        })
      ],
      edges: @[
        edge(100, 10, "next", 20, "prev"),
        edge(101, 30, "fieldOutput", 20, "fieldInput/image")
      ]
    )

    withUploadedScene(sceneId, exported) do (store: LogStore, scene: FrameScene):
      let rendered = render(scene, ctx(scene, "render"))
      # The failure reason is logged, and nothing says "No image provided"
      var sawDetail = false
      for entry in store.entries:
        if entry.kind != JObject:
          continue
        for key in ["message", "error"]:
          if entry.hasKey(key):
            check "No image provided" notin entry[key].getStr()
            if "response too large" in entry[key].getStr():
              sawDetail = true
      check sawDetail
      # ...and the canvas shows the error image, not the plain background
      var nonBackground = 0
      for pixel in rendered.data:
        if pixel.r.int + pixel.g.int + pixel.b.int > 96:
          inc nonBackground
      check nonBackground > rendered.data.len div 2
