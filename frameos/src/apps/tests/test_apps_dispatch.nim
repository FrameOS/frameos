import std/[json, strutils, unittest]
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

proc newXmlNode(): DiagramNode =
  # data/xmlToJson: a data app still in the registry (the program apps are run
  # by the scene's program, docs/scene-compiler.md).
  DiagramNode(
    id: 1.NodeId,
    data: %*{
      "name": "data/xmlToJson",
      "config": {
        "xml": "<a>1</a>"
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

    let xmlApp = initApp("data/xmlToJson", newXmlNode(), scene)
    check xmlApp != nil
    setAppField("data/xmlToJson", xmlApp, "xml", VString("<b>2</b>"))
    let xmlValue = getApp("data/xmlToJson", xmlApp, ExecutionContext(hasImage: false))
    check xmlValue.kind == fkJson
    check "2" in $xmlValue.asJson()

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
      discard initApp("not/a-real-app", newXmlNode(), scene)

    expect(ValueError):
      setAppField("not/a-real-app", nil, "format", VString("HH:mm:ss"))

    expect(Exception):
      runApp("not/a-real-app", nil, context)

    expect(ValueError):
      discard getApp("not/a-real-app", nil, context)

  test "a program app has no registry row":
    let scene = newTestScene(newTestConfig())
    expect(ValueError):
      discard initApp("logic/ifElse", newXmlNode(), scene)
