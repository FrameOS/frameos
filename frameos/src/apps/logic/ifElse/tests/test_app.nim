import std/unittest

import ../app
import frameos/types

type ExecStore = ref object
  nodes: seq[NodeId]

proc newScene(store: ExecStore): FrameScene =
  FrameScene(
    execNode: proc(nodeId: NodeId, context: ExecutionContext) =
      store.nodes.add(nodeId)
  )

suite "logic/ifElse app":
  test "runs then branch when condition is true":
    let executed = ExecStore(nodes: @[])
    let app = App(
      scene: newScene(executed),
      appConfig: AppConfig(condition: true, thenNode: 10.NodeId, elseNode: 20.NodeId)
    )

    app.run(ExecutionContext())
    check executed.nodes == @[10.NodeId]

  test "runs else branch when condition is false":
    let executed = ExecStore(nodes: @[])
    let app = App(
      scene: newScene(executed),
      appConfig: AppConfig(condition: false, thenNode: 10.NodeId, elseNode: 20.NodeId)
    )

    app.run(ExecutionContext())
    check executed.nodes == @[20.NodeId]

  test "zero node id is treated as no-op":
    let executed = ExecStore(nodes: @[])
    let app = App(
      scene: newScene(executed),
      appConfig: AppConfig(condition: true, thenNode: 0.NodeId, elseNode: 30.NodeId)
    )

    app.run(ExecutionContext())
    check executed.nodes.len == 0
