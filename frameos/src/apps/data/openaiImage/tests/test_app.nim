import std/[json, strutils, unittest]
import pixie

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

suite "data/openaiImage app":
  test "missing prompt returns error image using context dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 4.NodeId,
      nodeName: "data/openaiImage",
      scene: scene,
      frameConfig: FrameConfig(width: 10, height: 5),
      appConfig: AppConfig(prompt: "", model: "gpt-image-1", metadataStateKey: "meta")
    )

    let output = app.get(ExecutionContext(image: newImage(12, 8), hasImage: true))

    check output.width == 12
    check output.height == 8
    check not scene.state.hasKey("meta")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:4:data/openaiImage")

  test "missing api key returns error image with frame render dimensions":
    let logs = LogStore(items: @[])
    let scene = FrameScene(state: %*{}, logger: newLogger(logs))
    let app = App(
      nodeId: 5.NodeId,
      nodeName: "data/openaiImage",
      scene: scene,
      frameConfig: FrameConfig(width: 9, height: 6, rotate: 90, settings: %*{}),
      appConfig: AppConfig(prompt: "frameos", model: "gpt-image-1", metadataStateKey: "meta")
    )

    let output = app.get(ExecutionContext(hasImage: false))

    check output.width == 6
    check output.height == 9
    check not scene.state.hasKey("meta")
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:5:data/openaiImage")
