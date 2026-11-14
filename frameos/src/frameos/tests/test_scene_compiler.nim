## The scene compiler (docs/scene-compiler.md): what it decides once, and that
## the program it writes runs.

import std/[json, strutils, tables, unittest]
import pixie
import ../interpreter
import ../js_runtime/runtime
import ../utils/memory
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

proc started(nodes: seq[DiagramNode], edges: seq[DiagramEdge], store: LogStore,
    sceneId = "tests/scene-compiler".SceneId): InterpretedFrameScene =
  # The scenes started before this one stay; one of the same id is replaced.
  var uploaded = getUploadedInterpretedScenes()
  uploaded[sceneId] = ExportedInterpretedScene(name: "compiler", backgroundColor: parseHtmlColor("#000000"),
    refreshInterval: 60.0, publicStateFields: @[StateField(name: "name", fieldType: "string", value: %*"Ada")],
    nodes: nodes, edges: edges, apps: %*{})
  setUploadedInterpretedScenes(uploaded)
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

  proc isolationCase(store: LogStore): tuple[a, b, c, d: InterpretedFrameScene] =
    ## Two scenes with code, the first changing its globals and built-ins,
    ## and two scenes of Nim apps alone, rendered.
    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
    result.a = started(@[node(1, "code", code("(globalThis.leak = 'a', Array.prototype.polluted = 1, 'set')"))],
      @[], store, "tests/realm-a".SceneId)
    result.b = started(@[node(1, "code", code("typeof leak + ',' + typeof [].polluted"))],
      @[], store, "tests/realm-b".SceneId)
    check result.a.getDataNode(1.NodeId, ctx(result.a)).asString() == "set"
    # What scene a did to its globals and built-ins, scene b never sees.
    check result.b.getDataNode(1.NodeId, ctx(result.b)).asString() == "undefined,undefined"
    let flow = @[node(1, "event", %*{"keyword": "render"}),
      node(2, "app", %*{"keyword": "render/color", "config": {}})]
    result.c = started(flow, @[edge(1, "next", 2, "prev")], store, "tests/realm-c".SceneId)
    result.d = started(flow, @[edge(1, "next", 2, "prev")], store, "tests/realm-d".SceneId)
    discard render(result.c, ctx(result.c))
    discard render(result.d, ctx(result.d))
    # Scenes of Nim apps alone run their programs in one shared context.
    check not result.c.js.context.isNil
    check result.c.js.context == result.d.js.context

  proc closeAll(scenes: varargs[InterpretedFrameScene]) =
    for scene in scenes:
      cleanupSceneJs(scene)
      check scene.js.context.isNil
    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())

  test "where there is room, a scene with code has a runtime of its own":
    let store = LogStore()
    let (a, b, c, d) = isolationCase(store)
    check a.jsKind == sjRuntime and b.jsKind == sjRuntime
    check a.js.runtime != b.js.runtime
    check a.js.runtime != c.js.runtime
    check c.jsKind == sjShared
    closeAll(a, b, c, d)

  test "on an 8 MB board, a realm of its own in the runtime the programs share":
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 64 * 1024
    defer: deviceMemoryBytesOverride = 0
    let store = LogStore()
    let (a, b, c, d) = isolationCase(store)
    check a.jsKind == sjRealm and b.jsKind == sjRealm
    check a.js.context != b.js.context
    check a.js.runtime == b.js.runtime
    check a.js.runtime == c.js.runtime
    check c.js.context != a.js.context
    closeAll(a, b, c, d)

  test "where there is room, an abort in one scene takes no other with it":
    let store = LogStore()
    let (a, b, c, d) = isolationCase(store)
    let bRuntime = b.js.runtime
    # An out-of-memory abort jumped out of scene a's program.
    a.onSceneJsStack:
      check abandonMidCallSceneJs().count == 1
    check not a.jsReady
    check b.programReady and b.js.runtime == bRuntime
    check c.programReady # the shared runtime was not in the abort
    check b.getDataNode(1.NodeId, ctx(b)).asString() == "undefined,undefined"
    # Scene a sets up a runtime again on its next run.
    check a.getDataNode(1.NodeId, ctx(a)).asString() == "set"
    closeAll(a, b, c, d)

  test "on an 8 MB board, an abort takes the shared runtime and every scene in it":
    deviceMemoryBytesOverride = 8 * 1024 * 1024 - 64 * 1024
    defer: deviceMemoryBytesOverride = 0
    let store = LogStore()
    let (a, b, c, d) = isolationCase(store)
    a.onSceneJsStack:
      check abandonMidCallSceneJs().count == 1
    # Each sets itself up again on its next run.
    check b.getDataNode(1.NodeId, ctx(b)).asString() == "undefined,undefined"
    discard render(c, ctx(c))
    check c.programReady
    closeAll(a, b, c, d)
