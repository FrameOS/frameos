import std/[json, os, strutils, tables, unittest]
import pixie

import ../js_app_runtime
import ../types
import ../values

proc testConfig(assetsPath = "/tmp"): FrameConfig =
  FrameConfig(
    width: 6,
    height: 4,
    rotate: 0,
    scalingMode: "cover",
    debug: true,
    saveAssets: %*false,
    assetsPath: assetsPath
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

proc prepareAssetsRoot(name: string): string =
  result = normalizedPath(getTempDir() / name)
  if dirExists(result):
    removeDir(result)
  createDir(result)

suite "js app runtime":
  test "returns string, node, and image values":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 7.NodeId, nodeName: "data/jsText", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """globalThis.__frameosModule = {
        get(app, context) {
          if (app.config.mode === "image") {
            return frameos.image({ width: 3, height: 2, color: "#336699" })
          }
          if (app.config.mode === "node") {
            return frameos.node(app.config.targetNode)
          }
          return `${app.config.message}:${context.event}`
        }
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
    if imageValue.kind == fkImage and not imageValue.asImage().isNil:
      check imageValue.asImage().width == 3
      check imageValue.asImage().height == 2

  test "run can set next sleep and draw a render image":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-run".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 8.NodeId, nodeName: "logic/jsNextSleep", scene: scene, frameConfig: config)
    var image = newImage(4, 3)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: true, image: image, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "render",
      outputType = "image",
      source = """globalThis.__frameosModule = {
        run(app) {
          frameos.setNextSleep(app.config.duration)
          return frameos.image({ width: 4, height: 3, color: "#ff0000" })
        }
      }"""
    )

    runtime.run(owner, %*{"duration": 12.5}, context)
    check abs(context.nextSleep - 12.5) < 0.0001
    let pixel = context.image.data[context.image.dataIndex(0, 0)]
    check pixel.r > 0

  test "image refs are scoped to a single invocation":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-image-refs".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 12.NodeId, nodeName: "data/jsImage", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "image",
      source = """globalThis.__frameosModule = {
        get(app) {
          return app.config.inputImage
        }
      }"""
    )

    var firstImage = newImage(2, 1)
    firstImage.fill(parseHtmlColor("#ff0000"))
    let firstValue = runtime.get(owner, %*{"inputImage": runtime.jsAppFieldToJson(firstImage)}, context)
    check firstValue.kind == fkImage
    if firstValue.kind == fkImage and not firstValue.asImage().isNil:
      check firstValue.asImage().width == 2
      check firstValue.asImage().height == 1
    check runtime.images.len == 0

    var secondImage = newImage(5, 4)
    secondImage.fill(parseHtmlColor("#00ff00"))
    let secondValue = runtime.get(owner, %*{"inputImage": runtime.jsAppFieldToJson(secondImage)}, context)
    check secondValue.kind == fkImage
    if secondValue.kind == fkImage and not secondValue.asImage().isNil:
      check secondValue.asImage().width == 5
      check secondValue.asImage().height == 4
    check runtime.images.len == 0

  test "preserves app instance state across init get and run calls":
    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-state".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 11.NodeId, nodeName: "data/jsText", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """globalThis.__frameosModule = {
        init(app) {
          app.counter = 1
        },
        get(app) {
          const value = `${app.counter}:${app.config.label}`
          app.counter += 1
          return value
        },
        run(app, context) {
          frameos.setNextSleep(app.counter)
          app.counter += 1
          app.log(context.event)
        }
      }"""
    )

    let firstValue = runtime.get(owner, %*{"label": "first"}, context)
    check firstValue.kind == fkString
    check firstValue.asString() == "1:first"

    runtime.run(owner, %*{"label": "second"}, context)
    check abs(context.nextSleep - 2.0) < 0.0001

    let secondValue = runtime.get(owner, %*{"label": "third"}, context)
    check secondValue.kind == fkString
    check secondValue.asString() == "3:third"

  test "asset api can list read write rename and delete inside assets root":
    let assetsPath = prepareAssetsRoot("frameos-js-app-runtime-assets")
    let config = testConfig(assetsPath)
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-assets".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 9.NodeId, nodeName: "data/jsAssets", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """globalThis.__frameosModule = {
        get() {
          frameos.assets.mkdir("notes")
          const written = frameos.assets.writeText("notes/hello.txt", "hello world")
          const listed = frameos.assets.list("notes")
          const contents = frameos.assets.readText("notes/hello.txt")
          const stat = frameos.assets.stat("notes/hello.txt")
          const fromData = frameos.assets.writeDataUrl("notes/from-data.txt", "data:text/plain,hello%20data")
          const renamed = frameos.assets.rename("notes/hello.txt", "notes/goodbye.txt")
          const dataUrl = frameos.assets.readDataUrl("notes/goodbye.txt")
          const deleted = frameos.assets.delete("notes/goodbye.txt")
          return {
            written,
            listed,
            contents,
            stat,
            fromData,
            renamed,
            dataUrl,
            deleted,
            existsAfterDelete: frameos.assets.exists("notes/goodbye.txt"),
          }
        }
      }"""
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    let listed = payload{"listed"}
    check payload{"written"}{"path"}.getStr() == "notes/hello.txt"
    check listed.kind == JArray
    check listed.len == 1
    if listed.kind == JArray and listed.len > 0:
      check listed[0]{"path"}.getStr() == "notes/hello.txt"
    check payload{"contents"}.getStr() == "hello world"
    check payload{"stat"}{"size"}.getInt() == 11
    check payload{"fromData"}{"path"}.getStr() == "notes/from-data.txt"
    check payload{"renamed"}{"path"}.getStr() == "notes/goodbye.txt"
    check payload{"dataUrl"}.getStr().startsWith("data:text/plain;base64,")
    check payload{"deleted"}.getBool()
    check not payload{"existsAfterDelete"}.getBool()
    check readFile(assetsPath / "notes" / "from-data.txt") == "hello data"
    check not fileExists(assetsPath / "notes" / "goodbye.txt")

  test "asset api rejects paths outside the assets root":
    let assetsPath = prepareAssetsRoot("frameos-js-app-runtime-assets-safety")
    let config = testConfig(assetsPath)
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-assets-safety".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 10.NodeId, nodeName: "data/jsAssetsSafety", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let outsidePath = "/tmp/frameos-js-app-runtime-escape.txt"
    if fileExists(outsidePath):
      removeFile(outsidePath)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """globalThis.__frameosModule = {
        get() {
          const errors = []
          for (const path of ["../escape.txt", "/tmp/frameos-js-app-runtime-escape.txt"]) {
            try {
              frameos.assets.writeText(path, "should fail")
              errors.push("allowed")
            } catch (error) {
              errors.push(String(error && error.message || error))
            }
          }
          return errors
        }
      }"""
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    check payload.kind == JArray
    check payload.len == 2
    for item in payload.items:
      check item.getStr().contains("Invalid asset path")
    check not fileExists(outsidePath)
