import pixie
import std/[json, tables, unittest]

import frameos/js_runtime/runtime
import frameos/interpreter
import frameos/js_runtime/app_runtime
import frameos/values
import frameos/scenes
import frameos/types

proc testLogger(): Logger =
  Logger(
    enabled: true,
    log: proc(payload: JsonNode) = discard payload,
    enable: proc() = discard,
    disable: proc() = discard
  )

suite "scene runtime cleanup":
  test "cleanupSceneRuntime closes quickjs for interpreted scenes recursively":
    let logger = testLogger()
    var child = InterpretedFrameScene(
      id: "tests/cleanup-child".SceneId,
      logger: logger,
      sceneNodes: initTable[NodeId, FrameScene](),
      sceneExportByNodeId: initTable[NodeId, ExportedScene]()
    )
    ensureSceneJs(child)

    var parent = InterpretedFrameScene(
      id: "tests/cleanup-parent".SceneId,
      logger: logger,
      sceneNodes: initTable[NodeId, FrameScene](),
      sceneExportByNodeId: initTable[NodeId, ExportedScene]()
    )
    ensureSceneJs(parent)
    parent.sceneNodes[1.NodeId] = child

    cleanupSceneRuntime(parent)

    check parent.jsReady == false
    check parent.js.context == nil
    check child.jsReady == false
    check child.js.context == nil

  test "closing a scene's js runtime leaves no Nim-side memory behind":
    # BurritoContextData is raw memory (alloc0/dealloc) holding a Nim Table.
    # dealloc does not run that field's destructor, so close() used to leak the
    # function registry's seq payload on EVERY scene teardown — ~2.5K a time on
    # a host, and a frame that cycles scenes tears one down per switch.
    let logger = testLogger()

    proc cycle() =
      var scene = InterpretedFrameScene(
        id: "tests/cleanup-leak".SceneId,
        logger: logger,
        sceneNodes: initTable[NodeId, FrameScene](),
        sceneExportByNodeId: initTable[NodeId, ExportedScene]()
      )
      ensureSceneJs(scene)
      cleanupSceneRuntime(scene)

    # Warm up first: the first runtime faults in one-time allocations (JS
    # atoms, shapes) that are not part of the per-cycle cost.
    for _ in 1 .. 5:
      cycle()
    GC_fullCollect()
    let baseline = getOccupiedMem()

    for _ in 1 .. 20:
      cycle()
    GC_fullCollect()
    let growth = getOccupiedMem() - baseline

    # Each leaked registry was ~2.5K, so 20 cycles leaked ~50K. Allow a small
    # allowance for allocator noise but nothing resembling per-cycle growth.
    check growth < 8 * 1024

  test "cleanupSceneRuntime closes the QuickJS of every JS app node":
    # A JS APP node's interpreter is separate from the scene's own, and costs
    # far more: ~148K of PSRAM each, measured on an ESP32 with -d:memProbe.
    # JsAppRuntime has no destructor and (on embedded) liveJsRuntimes holds a
    # reference to every runtime it ever readied, so dropping the scene freed
    # none of it — a frame cycling two JS scenes shed a few hundred K per
    # switch and rebooted itself after about seven.
    let config = FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover",
      saveAssets: %*false, assetsPath: "/tmp")
    let logger = testLogger()
    var scene = InterpretedFrameScene(
      id: "tests/cleanup-js-app".SceneId,
      frameConfig: config,
      state: %*{},
      logger: logger,
      appsByNodeId: initTable[NodeId, AppRoot](),
      sceneNodes: initTable[NodeId, FrameScene](),
      sceneExportByNodeId: initTable[NodeId, ExportedScene]()
    )
    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = "export const get = () => 'hi'"
    )
    let app = DynamicJsApp(
      nodeId: 1.NodeId, nodeName: "jsApp", scene: scene, frameConfig: config,
      configJson: %*{}, runtime: runtime
    )
    scene.appsByNodeId[1.NodeId] = AppRoot(app)

    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
      hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    discard runtime.get(AppRoot(app), %*{}, context)
    check runtime.ready == true

    cleanupSceneRuntime(scene)
    check runtime.ready == false

  test "a scene with no JS never builds a runtime":
    # ensureSceneJs is called by compileCodeFn/compileAppInlineFn/evalOneShot,
    # so init() building one up front only ever charged scenes that have no
    # code nodes and no inline JS — the common shape for a scene that exists
    # to nest others.
    let config = FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover",
      saveAssets: %*false, assetsPath: "/tmp")
    let logger = testLogger()
    let sceneId = "tests/no-js".SceneId
    var uploaded = initTable[SceneId, ExportedInterpretedScene]()
    uploaded[sceneId] = ExportedInterpretedScene(
      name: "No JS",
      backgroundColor: parseHtmlColor("#000000"),
      refreshInterval: 60.0,
      publicStateFields: @[],
      nodes: @[
        DiagramNode(id: 1.NodeId, nodeType: "event", data: %*{"keyword": "render"}),
        DiagramNode(id: 2.NodeId, nodeType: "app",
          data: %*{"keyword": "render/gradient", "config": {}})
      ],
      edges: @[DiagramEdge(id: 1.NodeId, source: 1.NodeId, sourceHandle: "next",
        target: 2.NodeId, targetHandle: "prev", data: %*{})],
      apps: %*{}
    )
    setUploadedInterpretedScenes(uploaded)
    resetInterpretedScenes()

    let scene = InterpretedFrameScene(interpreter.init(sceneId, config, logger, %*{}))
    check scene.jsReady == false
    check scene.js.runtime == nil

    setUploadedInterpretedScenes(initTable[SceneId, ExportedInterpretedScene]())
