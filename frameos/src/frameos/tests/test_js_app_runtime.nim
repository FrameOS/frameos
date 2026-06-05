import std/[json, sequtils, strutils, tables, unittest]
import pixie

import ../js_runtime/app_runtime
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

  test "runs typed template literal interpolations":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-template".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 11.NodeId, nodeName: "jsTemplate", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """export function get(app: FrameOSApp): string {
          const label = app.config.label as string
          return `<svg><text>${label as string}</text></svg>`
        }"""
    )

    let value = runtime.get(owner, %*{"label": "FrameOS"}, context)
    check value.kind == fkString
    check value.asString() == "<svg><text>FrameOS</text></svg>"

  test "runs text app template init and get functions":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-text-template".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 12.NodeId, nodeName: "jsText", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """export function init(app: FrameOSApp): void {
          app.initialized = true
        }

        export function get(app: FrameOSApp, context: FrameOSContext): string {
          const eventLabel = context.event ? ` (${context.event})` : ''
          return `${app.config.prefix}: ${app.config.message}${app.initialized ? eventLabel : ''}`
        }"""
    )

    let value = runtime.get(owner, %*{"prefix": "FrameOS", "message": "Hello"}, context)
    check value.kind == fkString
    check value.asString() == "FrameOS: Hello (render)"

  test "runs image app template frameos.image output":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-image-template".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 13.NodeId, nodeName: "jsImage", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "image",
      source = """export function get(app: FrameOSApp): FrameOSImageSpec {
          return frameos.image({
            width: app.config.width,
            height: app.config.height,
            color: app.config.color,
            opacity: app.config.opacity,
          })
        }"""
    )

    let value = runtime.get(owner, %*{"width": 5, "height": 3, "color": "#00ff00", "opacity": 0.5}, context)
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    let pixel = value.asImage().data[value.asImage().dataIndex(0, 0)]
    check pixel.g > 0
    check pixel.a > 0

  test "runs logic app template logging path":
    let config = testConfig()
    var logged: seq[JsonNode] = @[]
    var logger = testLogger(config)
    logger.log = proc(payload: JsonNode) =
      logged.add(payload)
    let scene = FrameScene(id: "tests/js-app-logic-template".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 14.NodeId, nodeName: "jsLogic", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "logic",
      outputType = "",
      source = """export function run(app: FrameOSApp, context: FrameOSContext): void {
          const stateKey = app.config.stateKey || 'jsLogicResult'
          app.log('JS logic app ran', { event: context.event, stateKey })
        }"""
    )

    runtime.run(owner, %*{"stateKey": "customState"}, context)
    check logged.len > 0
    check logged[^1]["event"].getStr() == "log:14:jsLogic"
    check "JS logic app ran" in logged[^1]["message"].getStr()
    check "customState" in logged[^1]["message"].getStr()

  test "runs modern ES syntax supported by QuickJS":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-modern-es".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 15.NodeId, nodeName: "jsModernEs", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "integer",
      source = """export function get(app: FrameOSApp): number {
          class Counter {
            value = 1_000
            increment = () => ++this.value
          }
          try {
            const counter = new Counter()
            const configured = app.config?.nested?.count ?? counter.increment()
            const regex = /frame\s*os/i
            return regex.test("Frame OS") ? configured : 0
          } catch {
            return -1
          }
        }"""
    )

    let fallbackValue = runtime.get(owner, %*{}, context)
    check fallbackValue.kind == fkInteger
    check fallbackValue.asInt() == 1001

    let configuredValue = runtime.get(owner, %*{"nested": {"count": 42}}, context)
    check configuredValue.kind == fkInteger
    check configuredValue.asInt() == 42

  test "lazy app proxies support keys and spread":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-proxy-keys".SceneId, frameConfig: config, state: %*{"seen": true}, logger: logger)
    let owner = AppRoot(nodeId: 11.NodeId, nodeName: "jsProxyKeys", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          return {
            configKeys: Object.keys(app.config).sort(),
            stateKeys: Object.keys(app.state).sort(),
            frameKeys: Object.keys(app.frame).sort(),
            contextKeys: Object.keys(context).sort(),
            spreadConfig: { ...app.config },
          }
        }"""
    )

    let value = runtime.get(owner, %*{"message": "hello", "mode": "text"}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    check payload["configKeys"][0].getStr() == "message"
    check payload["configKeys"][1].getStr() == "mode"
    check payload["stateKeys"][0].getStr() == "seen"
    check "width" in payload["frameKeys"].mapIt(it.getStr())
    check "event" in payload["contextKeys"].mapIt(it.getStr())
    check payload["spreadConfig"]["message"].getStr() == "hello"

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
