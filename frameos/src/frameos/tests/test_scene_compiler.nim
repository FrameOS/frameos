## The scene compiler (docs/scene-compiler.md): what it decides once, and that
## the program it writes runs.

import std/[json, strutils, tables, unittest]
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

proc code(js: string, args: seq[string] = @[], output = "string"): JsonNode =
  var declared = newJArray()
  for arg in args:
    declared.add(%*{"name": arg, "type": "string"})
  %*{"codeArgs": declared, "codeOutputs": [{"name": "out", "type": output}], "codeJS": js}

type LogStore = ref object
  entries: seq[JsonNode]

proc started(nodes: seq[DiagramNode], edges: seq[DiagramEdge], store: LogStore): InterpretedFrameScene =
  let sceneId = "tests/scene-compiler".SceneId
  var uploaded = initTable[SceneId, ExportedInterpretedScene]()
  uploaded[sceneId] = ExportedInterpretedScene(name: "compiler", backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: @[StateField(name: "name", fieldType: "string", value: %*"Ada")],
    nodes: nodes, edges: edges, apps: %*{})
  setUploadedInterpretedScenes(uploaded)
  resetInterpretedScenes()
  let config = FrameConfig(width: 8, height: 6, rotate: 0, scalingMode: "cover", saveAssets: %*false)
  let logger = Logger(enabled: true, log: proc(payload: JsonNode) = store.entries.add(payload),
    enable: proc() = discard, disable: proc() = discard)
  InterpretedFrameScene(interpreter.init(sceneId, config, logger, %*{}))

proc ctx(scene: FrameScene, event = "render"): ExecutionContext =
  ExecutionContext(scene: scene, event: event, payload: %*{}, loopIndex: 0, loopKey: ".", nextSleep: -1)

proc logged(store: LogStore, event: string): JsonNode =
  for entry in store.entries:
    if entry{"event"}.getStr() == event:
      return entry

suite "scene compiler":
  test "the events listened for, and a render flow of one node":
    let compiled = compileScene(@[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/color", "config": {}}),
      node(3, "event", %*{"keyword": "button", "config": {"label": "A"}}),
    ], @[edge(1, "next", 2, "prev")])
    check compiled.listens == @["render", "button"]
    check compiled.wholeFrame

  test "a render flow of two nodes is not the whole frame":
    let compiled = compileScene(@[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/color", "config": {}}),
      node(3, "app", %*{"keyword": "render/color", "config": {}}),
    ], @[edge(1, "next", 2, "prev"), edge(2, "next", 3, "prev")])
    check not compiled.wholeFrame

  test "snippets sit on lines of their own, where the program says":
    let compiled = compileScene(@[
      node(4, "code", code("a +\n'!'", @["a"])),
      node(5, "app", %*{"keyword": "render/text", "config": {}}),
    ], @[edge(0, "code/1 + 1", 5, "fieldInput/text")])
    let lines = compiled.source.splitLines()
    check compiled.snippets.len == 2
    for snippet in compiled.snippets:
      let inProgram = lines[snippet.firstLine - 1 .. snippet.lastLine - 1].join("\n")
      check inProgram == snippet.snippet
    check compiled.snippets[0].kind == psCode
    check compiled.snippets[1].kind == psInline
    check compiled.snippets[1].name == "text"

  test "a node no flow reaches gets no flow function":
    let compiled = compileScene(@[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/image", "config": {}}),
      node(3, "code", code("'x'")),
    ], @[edge(1, "next", 2, "prev"), edge(3, "fieldOutput", 2, "fieldInput/placement")])
    check "function f2(" in compiled.source
    check "function f3(" notin compiled.source
    check "function g3(" in compiled.source

  test "only a node on a cycle of its inputs pays for the guard":
    let compiled = compileScene(@[
      node(1, "code", code("a", @["a"])),
      node(2, "code", code("a", @["a"])),
      node(3, "code", code("'leaf'")),
    ], @[edge(2, "fieldOutput", 1, "codeField/a"), edge(1, "fieldOutput", 2, "codeField/a"),
      edge(3, "fieldOutput", 3, "codeField/x")])
    check "W.has(1)" in compiled.source
    check "W.has(2)" in compiled.source
    check "W.has(3)" in compiled.source # a node feeding itself is a cycle too
    let plain = compileScene(@[node(1, "code", code("'a'")), node(2, "code", code("a", @["a"]))],
      @[edge(1, "fieldOutput", 2, "codeField/a")])
    check "W.has" notin plain.source

  test "a code node runs, with its arguments, a state read and an inline value":
    let store = LogStore()
    let scene = started(@[
      node(1, "state", %*{"keyword": "name"}),
      node(2, "code", code("`${greeting}, ${who}`", @["greeting", "who"])),
    ], @[edge(1, "stateOutput", 2, "codeField/who"), edge(0, "code/'Hello'", 2, "codeField/greeting")], store)
    check scene.getDataNode(2.NodeId, ctx(scene)).asString() == "Hello, Ada"

  test "a snippet cannot reach the program's natives":
    let store = LogStore()
    # Scene code is untrusted: a native it kept could be called after its
    # scene is gone. Neither the glue's names nor the natives object reach it.
    let scene = started(@[node(1, "code",
      code("[typeof d, typeof g, typeof N, typeof __N, typeof console.log].join(',')"))], @[], store)
    check scene.getDataNode(1.NodeId, ctx(scene)).asString() == "undefined,undefined,undefined,undefined,function"

  test "a cycle of next edges runs each node once, and says so":
    let store = LogStore()
    let scene = started(@[
      node(1, "event", %*{"keyword": "render"}),
      node(2, "code", code("'a'")),
      node(3, "code", code("'b'")),
    ], @[edge(1, "next", 2, "prev"), edge(2, "next", 3, "prev"), edge(3, "next", 2, "prev")], store)
    discard render(scene, ctx(scene))
    let cycle = store.logged("interpreter:graph:cycle")
    check not cycle.isNil
    check cycle{"atNodeId"}.getInt() == 2

  test "a cache expression that does not compile only loses its cache":
    let store = LogStore()
    let scene = started(@[
      node(1, "code", %*{"codeArgs": [], "codeOutputs": [{"name": "out", "type": "string"}],
        "codeJS": "'cached'",
        "cache": {"enabled": true, "expressionEnabled": true, "expression": "(("}}),
    ], @[], store)
    check scene.getDataNode(1.NodeId, ctx(scene)).asString() == "cached"
    let broken = store.logged("interpreter:cacheExpression:error")
    check not broken.isNil
    check broken{"code"}.getStr() == "(("
    check store.logged("interpreter:jsCompileError").isNil

  test "a value goes from one app to the next as the app made it":
    # render/color's image, through a handle, into render/opacity: never a
    # JavaScript value on the way.
    let store = LogStore()
    let scene = started(@[
      node(1, "app", %*{"keyword": "render/color", "config": {"color": "#ff0000"}}),
      node(2, "app", %*{"keyword": "render/opacity", "config": {"opacity": 1.0}}),
    ], @[edge(1, "fieldOutput", 2, "fieldInput/image")], store)
    let image = scene.getDataNode(2.NodeId, ExecutionContext(scene: scene, event: "render", payload: %*{},
      image: newImage(8, 6), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1))
    check image.kind == fkImage
    check image.asImage().width == 8
    check scene.values.len == 0 # the run's handles went with it
