import std/[base64, json, net, os, sequtils, strutils, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

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

## A tiny blocking HTTP echo server on a thread, so frameos.httpRequest can be
## tested end to end (method, headers, body, binary responses) without the network.

var echoServerPort: Port
var echoServerThread: Thread[void]

proc echoServerLoop() {.thread.} =
  var server = newSocket()
  server.setSockOpt(OptReuseAddr, true)
  server.bindAddr(Port(0), "127.0.0.1")
  server.listen()
  var boundAddr: string
  var boundPort: Port
  (boundAddr, boundPort) = server.getLocalAddr()
  echoServerPort = boundPort

  while true:
    var client: Socket
    server.accept(client)
    var requestLine = ""
    var authHeader = ""
    var contentLength = 0
    try:
      requestLine = client.recvLine(timeout = 5000)
      while true:
        let line = client.recvLine(timeout = 5000)
        if line == "\r\n" or line.len == 0:
          break
        let lowered = line.toLowerAscii()
        if lowered.startsWith("authorization:"):
          authHeader = line.split(":", maxsplit = 1)[1].strip()
        elif lowered.startsWith("content-length:"):
          contentLength = parseInt(line.split(":", maxsplit = 1)[1].strip())
    except CatchableError:
      client.close()
      continue

    var body = ""
    if contentLength > 0:
      try:
        body = client.recv(contentLength, timeout = 5000)
      except CatchableError:
        discard

    let parts = requestLine.splitWhitespace()
    let httpMethod = if parts.len >= 1: parts[0] else: ""
    let path = if parts.len >= 2: parts[1] else: "/"

    case path
    of "/quit":
      client.send("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
      client.close()
      break
    of "/binary":
      var payload = newString(256)
      for i in 0 ..< 256:
        payload[i] = chr(i)
      client.send("HTTP/1.1 200 OK\r\nContent-Length: 256\r\n\r\n" & payload)
      client.close()
    else:
      let reply = $(%*{"method": httpMethod, "auth": authHeader, "body": body})
      client.send("HTTP/1.1 200 OK\r\nContent-Length: " & $reply.len & "\r\n\r\n" & reply)
      client.close()

  server.close()

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
            static label = "counter"
            #step = 1n
            value = 1_000
            increment = () => {
              this.value += Number(this.#step)
              return this.value
            }
          }
          try {
            const counter = new Counter()
            let configured = app.config?.nested?.count ?? 0
            configured ||= counter.increment()
            const regex = /frame\s*os/i
            return regex.test("Frame OS") && Counter.label === "counter" ? configured : 0
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

  test "maps JS app runtime errors to original source lines":
    let config = testConfig()
    var logged: seq[JsonNode] = @[]
    var logger = testLogger(config)
    logger.log = proc(payload: JsonNode) =
      logged.add(payload)
    let scene = FrameScene(id: "tests/js-app-error-map".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 16.NodeId, nodeName: "jsErrorMap", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "text",
      source = """export function get(app: FrameOSApp): string {
          const value: number = 1
          throw new Error("app mapped boom")
        }"""
    )

    discard runtime.get(owner, %*{}, context)
    let stackLogs = logged.filterIt("jsApp:error" in it{"event"}.getStr())
    check stackLogs.len == 1
    check ">:3:" in stackLogs[0]{"stack"}.getStr()

  test "asset management bindings":
    let assetsDir = getTempDir() / "frameos-js-assets-test"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)

    let config = testConfig()
    config.assetsPath = assetsDir
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-assets".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 20.NodeId, nodeName: "jsAssets", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          return {
            missing: frameos.readAsset("nope.txt"),
            missingSize: frameos.assetSize("nope.txt"),
            wrote: frameos.writeAsset("js/test.txt", "aGVsbG8="),
            appended: frameos.appendAsset("js/test.txt", "IHdvcmxk"),
            size: frameos.assetSize("js/test.txt"),
            read: frameos.readAsset("js/test.txt"),
            slice: frameos.readAsset("js/test.txt", { offset: 6, length: 5 }),
            list: frameos.listAssets(""),
            exists: frameos.assetExists("js/test.txt"),
            escaped: frameos.writeAsset("../evil.txt", "aGVsbG8="),
            absolute: frameos.writeAsset("/etc/evil.txt", "aGVsbG8="),
            deleted: frameos.deleteAsset("js/test.txt"),
            existsAfter: frameos.assetExists("js/test.txt"),
          }
        }"""
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    check payload["missing"].kind == JNull
    check payload["missingSize"].getInt() == -1
    check payload["wrote"].getBool()
    check payload["appended"].getBool()
    check payload["size"].getFloat() == 11.0
    check decode(payload["read"].getStr()) == "hello world"
    check decode(payload["slice"].getStr()) == "world"
    check payload["list"].mapIt(it.getStr()) == @["js/test.txt"]
    check payload["exists"].getBool()
    check not payload["escaped"].getBool()
    check not payload["absolute"].getBool()
    check payload["deleted"].getBool()
    check not payload["existsAfter"].getBool()
    check not fileExists(assetsDir.parentDir() / "evil.txt")

  test "loads asset images within display bounds":
    let assetsDir = getTempDir() / "frameos-js-asset-image-test"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)

    var source = newImage(3, 2)
    source.fill(parseHtmlColor("#336699"))
    writeFile(assetsDir / "plate.png", encodeImage(source, PngFormat))

    let config = testConfig()
    config.assetsPath = assetsDir
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-asset-image".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 21.NodeId, nodeName: "jsAssetImage", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "image",
      source = """export function get(app, context) {
          return frameos.loadAssetImage("plate.png")
        }"""
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkImage
    check value.asImage().width == 3
    check value.asImage().height == 2
    check runtime.images.len == 0

  test "stream bindings round-trip strings and asset files":
    let assetsDir = getTempDir() / "frameos-js-streams-test"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)

    let config = testConfig()
    config.assetsPath = assetsDir
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-streams".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 22.NodeId, nodeName: "jsStreams", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          // String stream: write, rewind, read back in small chunks.
          const scratch = frameos.createStream()
          frameos.streamWrite(scratch, "aGVsbG8=")   // "hello"
          frameos.streamWrite(scratch, "IHdvcmxk")   // " world"
          frameos.streamRewind(scratch)
          let chunks = []
          while (!frameos.streamAtEnd(scratch)) {
            chunks.push(frameos.streamRead(scratch, 4))
          }
          const closedScratch = frameos.streamClose(scratch)

          // File stream: write an asset via a stream, read it back whole.
          const out = frameos.openAssetStream("streams/out.txt", "w")
          frameos.streamWrite(out, "c3RyZWFtZWQ=")   // "streamed"
          frameos.streamClose(out)
          const back = frameos.openAssetStream("streams/out.txt", "r")
          const fileChunk = frameos.streamRead(back, 65536)
          frameos.streamClose(back)

          return {
            chunks,
            closedScratch,
            fileChunk,
            missing: frameos.openAssetStream("streams/nope.txt", "r"),
            badRead: frameos.streamRead({ id: 999999 }, 4),
          }
        }"""
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    var recovered = ""
    for chunk in payload["chunks"].items:
      recovered.add(decode(chunk.getStr()))
    check recovered == "hello world"
    check payload["closedScratch"].getBool()
    check decode(payload["fileChunk"].getStr()) == "streamed"
    check payload["missing"].kind == JNull
    check payload["badRead"].kind == JNull
    check readFile(assetsDir / "streams" / "out.txt") == "streamed"

  test "httpRequest posts with headers and fetches binary responses":
    createThread(echoServerThread, echoServerLoop)
    for _ in 0 ..< 100:
      if int(echoServerPort) != 0:
        break
      sleep(20)
    check int(echoServerPort) != 0
    let base = "http://127.0.0.1:" & $int(echoServerPort)

    let config = testConfig()
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-http".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 23.NodeId, nodeName: "jsHttp", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          const post = frameos.httpRequest(`${app.config.base}/echo`, {
            method: "POST",
            headers: { "Authorization": "Bearer sk-test", "Content-Type": "application/json" },
            body: JSON.stringify({ hello: "world" }),
          })
          const binary = frameos.httpRequest(`${app.config.base}/binary`, { base64: true })
          const failed = frameos.httpRequest("http://127.0.0.1:1/nothing", { timeoutMs: 1000 })
          return { post, binary, failed }
        }"""
    )

    let value = runtime.get(owner, %*{"base": base}, context)
    discard boundedGetContent(base & "/quit")
    check value.kind == fkJson
    let payload = value.asJson()
    check payload["post"]["status"].getInt() == 200
    let echoed = parseJson(payload["post"]["body"].getStr())
    check echoed["method"].getStr() == "POST"
    check echoed["auth"].getStr() == "Bearer sk-test"
    check parseJson(echoed["body"].getStr())["hello"].getStr() == "world"
    check payload["binary"]["status"].getInt() == 200
    var expected = newString(256)
    for i in 0 ..< 256:
      expected[i] = chr(i)
    check decode(payload["binary"]["bodyBase64"].getStr()) == expected
    check payload["failed"]["status"].getInt() == 0
    check payload["failed"]["error"].getStr().len > 0

  test "getSetting honors declared settings namespaces":
    let config = testConfig()
    config.settings = %*{"openAI": {"apiKey": "sk-test"}, "unsplash": {"accessKey": "u-test"}}
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-app-settings".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 24.NodeId, nodeName: "jsSettings", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          const allowed = frameos.getSetting("openAI", "apiKey")
          const namespaceObj = frameos.getSetting("openAI")
          const denied = frameos.getSetting("unsplash", "accessKey")
          const missing = frameos.getSetting("openAI", "nope")
          return {
            allowed: allowed ?? null,
            namespaceKey: (namespaceObj && namespaceObj.apiKey) || null,
            denied: denied ?? null,
            missing: missing ?? null,
          }
        }"""
      , settingsKeys = @["openAI"]
    )

    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkJson
    let payload = value.asJson()
    check payload["allowed"].getStr() == "sk-test"
    check payload["namespaceKey"].getStr() == "sk-test"
    check payload["denied"].kind == JNull
    check payload["missing"].kind == JNull

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
