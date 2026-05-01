import std/[json, tables, unittest]
import pixie

import ../js_app_runtime
import ../types
import ../values

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 6,
    height: 4,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false,
    assetsPath: "/tmp"
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

suite "js app runtime":
  test "returns string, node, and image values":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 7.NodeId, nodeName: "jsText", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """export const get = (app: { config: { mode: string; message?: string; targetNode?: number } }, context: { event: string }) => {
          if (app.config.mode === "image") {
            return <image width={3} height={2} color="#336699" />
          }
          if (app.config.mode === "node") {
            return frameos.node(app.config.targetNode)
          }
          return `${app.config.message}:${context.event}`
        }"""
    )

    let textValue = runtime.get(owner, %*{"message": "hello", "mode": "text"}, context)
    check textValue.kind == fkString
    check textValue.asString() == "hello:render"

    let nodeValue = runtime.get(owner, %*{"mode": "node", "targetNode": 9}, context)
    check nodeValue.kind == fkNode
    check nodeValue.asNode() == 9.NodeId

    let imageValue = runtime.get(owner, %*{"mode": "image"}, context)
    check imageValue.kind == fkImage
    check imageValue.asImage().width == 3
    check imageValue.asImage().height == 2

  test "run can set next sleep, state, and draw a render image":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-run".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 8.NodeId, nodeName: "jsLogic", scene: scene, frameConfig: config)
    var image = newImage(4, 3)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: true, image: image, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "render",
      outputType = "image",
      source = """export function run(app: { config: { duration: number } }) {
          frameos.setNextSleep(app.config.duration)
          frameos.setState("lastDuration", app.config.duration)
          return <image width={4} height={3} color="#ff0000" />
        }"""
    )

    runtime.run(owner, %*{"duration": 12.5}, context)
    check abs(context.nextSleep - 12.5) < 0.0001
    check scene.state["lastDuration"].getFloat() == 12.5
    let pixel = context.image.data[context.image.dataIndex(0, 0)]
    check pixel.r > 0
    check runtime.images.len == 0

  test "clears transient context image refs after JS calls":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-image-refs".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 9.NodeId, nodeName: "jsImageRefs", scene: scene, frameConfig: config)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "image",
      source = """export function get(app, context) {
          return context.image
        }"""
    )

    for i in 0..<3:
      let image = newImage(4 + i, 3)
      let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: true, image: image, loopIndex: i, loopKey: ".", nextSleep: -1)
      let value = runtime.get(owner, %*{}, context)
      check value.kind == fkImage
      check value.asImage().width == 4 + i
      check value.asImage().height == 3
      check runtime.images.len == 0

  test "releases overwritten dynamic field image refs":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-field-refs".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let runtime = newJsAppRuntime(category = "data", outputType = "image", source = "export const get = () => null")
    let app = DynamicJsApp(
      nodeId: 10.NodeId,
      nodeName: "jsFieldRefs",
      scene: scene,
      frameConfig: config,
      configJson: %*{},
      runtime: runtime
    )

    setDynamicJsAppField(app, "inputImage", VImage(newImage(4, 3)))
    check runtime.images.len == 1
    let firstId = app.configJson["inputImage"]["id"].getInt()
    check runtime.images.hasKey(firstId)

    setDynamicJsAppField(app, "inputImage", VImage(newImage(5, 3)))
    check runtime.images.len == 1
    check not runtime.images.hasKey(firstId)
    let secondId = app.configJson["inputImage"]["id"].getInt()
    check secondId != firstId
    check runtime.images.hasKey(secondId)

    setDynamicJsAppField(app, "inputImage", VString("not an image"))
    check runtime.images.len == 0
