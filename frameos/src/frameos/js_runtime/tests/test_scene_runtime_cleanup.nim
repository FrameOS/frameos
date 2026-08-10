import std/[json, tables, unittest]

import frameos/js_runtime/runtime
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
