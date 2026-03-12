import std/[json, strutils, unittest]

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

suite "data/downloadUrl app":
  test "invalid URL returns error text and emits logError payload":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 17.NodeId,
      nodeName: "data/downloadUrl",
      scene: FrameScene(logger: newLogger(logs)),
      appConfig: AppConfig(url: "not-a-url")
    )

    let output = app.get(ExecutionContext())

    check output.len > 0
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:17:data/downloadUrl")
    check logs.items[0]["error"].getStr() == output
