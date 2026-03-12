import std/[json, unittest]
import pixie
import frameos/types
import frameos/values
import ../apps

proc newTestConfig(): FrameConfig =
  FrameConfig(
    width: 10,
    height: 8,
    rotate: 0,
  )

proc newTestScene(config: FrameConfig): FrameScene =
  FrameScene(
    id: "test/main".SceneId,
    frameConfig: config,
    state: %*{},
    refreshInterval: 60.0,
    backgroundColor: parseHtmlColor("#000000"),
  )

proc newClockNode(): DiagramNode =
  DiagramNode(
    id: 1.NodeId,
    data: %*{
      "name": "data/clock",
      "config": {
        "format": "HH:mm:ss",
        "formatCustom": "yyyy"
      }
    },
  )

proc newColorNode(): DiagramNode =
  DiagramNode(
    id: 2.NodeId,
    data: %*{
      "name": "render/color",
      "config": {
        "color": "#ffffff"
      }
    },
  )

suite "apps dispatch":
  test "known app keywords route through init, setField, get, and run":
    let config = newTestConfig()
    let scene = newTestScene(config)

    let clockApp = initApp("data/clock", newClockNode(), scene)
    check clockApp != nil
    setAppField("data/clock", clockApp, "format", VString("custom"))
    setAppField("data/clock", clockApp, "formatCustom", VString("yyyy"))
    let clockValue = getApp("data/clock", clockApp, ExecutionContext(hasImage: false))
    check clockValue.kind == fkString
    check clockValue.asString().len == 4

    let colorApp = initApp("render/color", newColorNode(), scene)
    check colorApp != nil
    setAppField("render/color", colorApp, "color", VColor(parseHtmlColor("#00ff00")))
    let context = ExecutionContext(
      scene: scene,
      image: newImage(3, 2),
      hasImage: true,
      event: "render",
      payload: %*{},
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )
    runApp("render/color", colorApp, context)
    let imageValue = getApp("render/color", colorApp, context)
    check imageValue.kind == fkImage
    check imageValue.asImage().width == 3
    check imageValue.asImage().height == 2

  test "unknown app keywords fail predictably":
    let config = newTestConfig()
    let scene = newTestScene(config)
    let context = ExecutionContext(hasImage: false)

    expect(ValueError):
      discard initApp("not/a-real-app", newClockNode(), scene)

    expect(ValueError):
      setAppField("not/a-real-app", nil, "format", VString("HH:mm:ss"))

    expect(Exception):
      runApp("not/a-real-app", nil, context)

    expect(ValueError):
      discard getApp("not/a-real-app", nil, context)
