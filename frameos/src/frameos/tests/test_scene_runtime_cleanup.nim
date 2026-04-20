import std/[json, tables, unittest]

import ../js_runtime
import ../scenes
import ../types

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
