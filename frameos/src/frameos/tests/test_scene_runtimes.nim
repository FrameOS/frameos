## Where scene programs run on a board with 8 MB of PSRAM or less
## (js_runtime/runtime.nim): a realm per scene with code in one shared
## runtime, and no context paid for that nobody uses. Its own process, so the
## runtime starts empty.

import std/[json, tables, unittest]
import pixie
import ../interpreter
import ../js_runtime/runtime
import ../types
import ../values
import ../utils/memory

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(source: source.NodeId, sourceHandle: sourceHandle, target: target.NodeId,
    targetHandle: targetHandle, edgeType: "")

proc started(sceneId: string, nodes: seq[DiagramNode], edges: seq[DiagramEdge]): InterpretedFrameScene =
  var uploaded = getUploadedInterpretedScenes()
  uploaded[sceneId.SceneId] = ExportedInterpretedScene(name: sceneId, backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: @[], nodes: nodes, edges: edges, apps: %*{})
  setUploadedInterpretedScenes(uploaded)
  let config = FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", saveAssets: %*false)
  let logger = Logger(enabled: true, log: proc(payload: JsonNode) = discard,
    enable: proc() = discard, disable: proc() = discard)
  InterpretedFrameScene(interpreter.init(sceneId.SceneId, config, logger, %*{}))

proc ctx(scene: FrameScene): ExecutionContext =
  ExecutionContext(scene: scene, event: "render", payload: %*{}, image: newImage(8, 6), hasImage: true,
    loopIndex: 0, loopKey: ".", nextSleep: -1)

proc withCode(id: string, js: string): InterpretedFrameScene =
  started(id, @[node(1, "code", %*{"codeArgs": [], "codeOutputs": [{"name": "out", "type": "string"}],
    "codeJS": js})], @[])

proc withoutCode(id: string): InterpretedFrameScene =
  result = started(id, @[node(1, "event", %*{"keyword": "render"}),
    node(2, "app", %*{"keyword": "render/color", "config": {}})], @[edge(1, "next", 2, "prev")])
  discard render(result, ctx(result))

suite "scene programs on an 8 MB board":
  setup:
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 64 * 1024
  teardown:
    deviceMemoryBytesOverride = 0

  test "one scene with code costs the runtime and the context it was made with":
    let a = withCode("tests/rt/a", "(globalThis.mine = 'a', 'a')")
    check a.getDataNode(1.NodeId, ctx(a)).asString() == "a"
    check a.jsKind == sjRealm
    check programContextsForTest() == 1

    # A scene of Nim apps alone then needs a context for the scenes like it.
    let c = withoutCode("tests/rt/c")
    check c.jsKind == sjShared
    check programContextsForTest() == 2
    let d = withoutCode("tests/rt/d")
    check d.js.context == c.js.context
    check programContextsForTest() == 2

    # A context a scene had is never another's: its globals were that scene's.
    cleanupSceneJs(a)
    check programContextsForTest() == 1
    let b = withCode("tests/rt/b", "typeof mine")
    check b.getDataNode(1.NodeId, ctx(b)).asString() == "undefined"
    check programContextsForTest() == 2
    check b.js.runtime == c.js.runtime
    for scene in [b, c, d]:
      cleanupSceneJs(scene)
    check programContextsForTest() == 1 # the shared one stays
