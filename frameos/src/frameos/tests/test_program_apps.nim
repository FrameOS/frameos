## The built-in apps a scene's program runs itself (scene_compiler.nim
## `ProgramApps`, docs/scene-compiler.md "Program apps"): no Nim app, no
## registry row, the same behaviour as the Nim apps they stand in for (whose
## own tests, src/apps/<app>/tests, keep the modules compiled scenes import).

import std/[algorithm, json, os, strutils, tables, unittest]
import pixie
import ../interpreter
import ../scene_compiler
import ../types
import ../values

proc node(id: int, nodeType: string, data: JsonNode): DiagramNode =
  DiagramNode(id: id.NodeId, nodeType: nodeType, data: data)

proc edge(source: int, sourceHandle: string, target: int, targetHandle: string): DiagramEdge =
  DiagramEdge(source: source.NodeId, sourceHandle: sourceHandle, target: target.NodeId,
    targetHandle: targetHandle, edgeType: "")

proc app(keyword: string, config: JsonNode = %*{}): JsonNode =
  %*{"keyword": keyword, "config": config}

proc code(js: string, output = "string"): JsonNode =
  %*{"codeArgs": [], "codeOutputs": [{"name": "out", "type": output}], "codeJS": js}

type LogStore = ref object
  entries: seq[JsonNode]

proc started(nodes: seq[DiagramNode], edges: seq[DiagramEdge], store: LogStore,
    flow: seq[int] = @[]): InterpretedFrameScene =
  ## `flow`: the nodes a `button` listener leads to, as a logic app always
  ## is in a scene (a node no flow reaches is only read for its value).
  var nodes = nodes
  var edges = edges
  for id in flow:
    nodes.add node(100 + id, "event", %*{"keyword": "button"})
    edges.add edge(100 + id, "next", id, "prev")
  let sceneId = "tests/program-apps".SceneId
  var uploaded = getUploadedInterpretedScenes()
  uploaded[sceneId] = ExportedInterpretedScene(name: "program apps", backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: newSeq[StateField](), nodes: nodes, edges: edges, apps: %*{})
  setUploadedInterpretedScenes(uploaded)
  let config = FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", saveAssets: %*false)
  let logger = Logger(enabled: true, log: proc(payload: JsonNode) = store.entries.add(payload),
    enable: proc() = discard, disable: proc() = discard)
  InterpretedFrameScene(interpreter.init(sceneId, config, logger, %*{}))

proc ctx(scene: FrameScene): ExecutionContext =
  ExecutionContext(scene: scene, event: "render", payload: %*{}, loopIndex: 0, loopKey: ".", nextSleep: -1)

proc logged(store: LogStore, event: string): JsonNode =
  for entry in store.entries:
    if entry{"event"}.getStr() == event:
      return entry

proc branchScene(condition: JsonNode, store: LogStore, wired = ""): InterpretedFrameScene =
  ## ifElse (2) picking setAsState "then" (3) or "else" (4).
  var nodes = @[
    node(2, "app", app("logic/ifElse", if condition.isNil: %*{} else: %*{"condition": condition})),
    node(3, "app", app("logic/setAsState", %*{"stateKey": "picked", "valueString": "then"})),
    node(4, "app", app("logic/setAsState", %*{"stateKey": "picked", "valueString": "else"})),
  ]
  var edges = @[edge(2, "field/thenNode", 3, "prev"), edge(2, "field/elseNode", 4, "prev")]
  if wired.len > 0:
    nodes.add node(5, "code", code(wired, "boolean"))
    edges.add edge(5, "fieldOutput", 2, "fieldInput/condition")
  started(nodes, edges, store, flow = @[2])

suite "program apps":
  test "the apps whose config.json says program are the compiler's":
    let appsDir = currentSourcePath().parentDir.parentDir.parentDir / "apps"
    var flagged: seq[string]
    for category in walkDirs(appsDir / "*"):
      for appDir in walkDirs(category / "*"):
        let config = appDir / "config.json"
        if fileExists(config) and parseFile(config){"program"}.getBool(false):
          flagged.add category.extractFilename & "/" & appDir.extractFilename
    var compiled = @ProgramApps
    check flagged.sorted == compiled.sorted

  test "no app instance for a program app":
    let scene = started(@[node(1, "app", app("data/parseJson", %*{"text": "1"}))], @[], LogStore())
    check not scene.appsByNodeId.hasKey(1.NodeId)

  test "ifElse runs the branch its condition picks":
    for (condition, picked) in [(%*true, "then"), (%*false, "else"), (%*"no", "else"), (%*"yes", "then"),
        (newJNull(), "then")]:
      let scene = branchScene(if condition.kind == JNull: nil else: condition, LogStore())
      scene.execNode(2.NodeId, ctx(scene))
      check scene.state{"picked"}.getStr() == picked

  test "ifElse with its condition wired":
    let scene = branchScene(%*true, LogStore(), wired = "1 > 2")
    scene.execNode(2.NodeId, ctx(scene))
    check scene.state{"picked"}.getStr() == "else"

  test "setAsState writes JSON, and says so with debugLog":
    let store = LogStore()
    let scene = started(@[node(3, "app", %*{"keyword": "logic/setAsState", "name": "keep",
      "config": {"stateKey": "k", "valueJson": {"a": [1, 2]}, "debugLog": "true"}})], @[], store, flow = @[3])
    scene.execNode(3.NodeId, ctx(scene))
    check scene.state{"k"} == %*{"a": [1, 2]}
    let line = store.logged("log:3:keep:setAsState")
    check not line.isNil
    check line{"key"}.getStr() == "k"
    check line{"value"} == %*{"a": [1, 2]}

  test "setAsState refuses both values":
    let store = LogStore()
    let scene = started(@[node(3, "app", app("logic/setAsState",
      %*{"stateKey": "k", "valueString": "x", "valueJson": 1}))], @[], store, flow = @[3])
    scene.execNode(3.NodeId, ctx(scene))
    check not scene.state.hasKey("k")
    check store.logged("error:3"){"error"}.getStr() == "Both valueString and valueJson are set. Only one can be set."

  test "nextSleepDuration sets the run's next sleep":
    let store = LogStore()
    let scene = started(@[node(6, "app", app("logic/nextSleepDuration", %*{"duration": "7.5"}))], @[], store, flow = @[6])
    let context = ctx(scene)
    scene.execNode(6.NodeId, context)
    check context.nextSleep == 7.5
    check store.logged("log:6"){"message"}.getStr() == "Set sleep duration between renders to 7.5 seconds"

  test "breakIfRendering stops a run while the scene renders":
    let scene = started(@[node(7, "app", app("logic/breakIfRendering"))], @[], LogStore(), flow = @[7])
    scene.execNode(7.NodeId, ctx(scene))
    scene.isRendering = true
    expect CatchableError:
      scene.execNode(7.NodeId, ctx(scene))
    scene.isRendering = false

  test "parseJson, prettyJson and log":
    let store = LogStore()
    let text = """{"a":[1,2,{"b":null}],"c":"x","d":{}}"""
    let scene = started(@[
      node(1, "app", app("data/parseJson", %*{"text": text})),
      node(2, "app", app("data/prettyJson")),
      node(3, "app", app("data/prettyJson", %*{"prettify": false})),
      node(4, "app", app("data/log")),
    ], @[edge(1, "fieldOutput", 2, "fieldInput/json"), edge(1, "fieldOutput", 3, "fieldInput/json"),
      edge(1, "fieldOutput", 4, "fieldInput/inputJson")], store)
    check scene.getDataNode(1.NodeId, ctx(scene)).asJson() == parseJson(text)
    check scene.getDataNode(2.NodeId, ctx(scene)).asString() == pretty(parseJson(text), 2)
    check scene.getDataNode(3.NodeId, ctx(scene)).asString() == $parseJson(text)
    check scene.getDataNode(4.NodeId, ctx(scene)).asJson() == parseJson(text)
    check store.logged("log:4:log"){"message"} == parseJson(text)

  test "parseJson that fails says what the Nim app said":
    let scene = started(@[node(1, "app", app("data/parseJson", %*{"text": "{nope"}))], @[], LogStore())
    try:
      discard scene.getDataNode(1.NodeId, ctx(scene))
      check false
    except CatchableError as error:
      check "Failed to parse JSON: " in error.msg

  test "a logic app read as a value, and a data app run in a flow, fail as before":
    let scene = started(@[node(2, "app", app("logic/ifElse")), node(3, "app", app("data/log"))], @[], LogStore(), flow = @[3])
    expect CatchableError:
      discard scene.getDataNode(2.NodeId, ctx(scene))
    expect CatchableError:
      scene.execNode(3.NodeId, ctx(scene))
