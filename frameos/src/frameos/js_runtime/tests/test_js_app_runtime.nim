import std/[base64, json, net, os, sequtils, strutils, tables, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/js_runtime/burrito
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
    check "app.ts:3:" in stackLogs[0]{"stack"}.getStr()

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

  test "a symlink out of the assets folder is not a way out of the sandbox":
    let assetsDir = getTempDir() / "frameos-js-symlink-test"
    let outsideDir = getTempDir() / "frameos-js-symlink-outside"
    removeDir(assetsDir)
    removeDir(outsideDir)
    createDir(assetsDir)
    createDir(outsideDir)
    defer:
      removeDir(assetsDir)
      removeDir(outsideDir)

    writeFile(outsideDir / "secret.txt", "top secret")
    # The kind of link an operator might leave behind (a big media folder
    # mounted into assets); scene JS must not be able to ride it outwards.
    createSymlink(outsideDir, assetsDir / "escape")

    let config = testConfig()
    config.assetsPath = assetsDir
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/js-symlink".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 25.NodeId, nodeName: "jsSymlink", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
                                   loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          return {
            readThroughLink: frameos.readAsset("escape/secret.txt"),
            writeThroughLink: frameos.writeAsset("escape/planted.txt", "aGVsbG8="),
            dottedName: frameos.writeAsset("backup..old.txt", "aGVsbG8="),
          }
        }"""
    )

    let payload = runtime.get(owner, %*{}, context).asJson()
    check payload["readThroughLink"].kind == JNull
    check not payload["writeThroughLink"].getBool()
    check not fileExists(outsideDir / "planted.txt")
    # ".." only escapes as a whole path segment; a file that merely contains
    # two dots is an ordinary name and must still be writable.
    check payload["dottedName"].getBool()
    check fileExists(assetsDir / "backup..old.txt")

  test "assetSandbox=scene confines a scene to its own subtree":
    let assetsDir = getTempDir() / "frameos-js-scene-sandbox-test"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)

    writeFile(assetsDir / "shared.txt", "frame wide")

    let config = testConfig()
    config.assetsPath = assetsDir
    config.js = JsRuntimeConfig(executionTimeoutMs: -1, memoryLimitMb: -1, maxStackKb: -1,
                                assetSandbox: "scene")
    let logger = testLogger(config)
    let scene = FrameScene(id: "tests/scoped".SceneId, frameConfig: config, state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 26.NodeId, nodeName: "jsScoped", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
                                   loopIndex: 0, loopKey: ".", nextSleep: -1)

    let runtime = newJsAppRuntime(
      category = "data",
      outputType = "json",
      source = """export function get(app, context) {
          return {
            wrote: frameos.writeAsset("cache.txt", "aGVsbG8="),
            readBack: frameos.readAsset("cache.txt"),
            sharedVisible: frameos.assetExists("shared.txt"),
          }
        }"""
    )

    let payload = runtime.get(owner, %*{}, context).asJson()
    check payload["wrote"].getBool()
    check decode(payload["readBack"].getStr()) == "hello"
    # Scene ids carry slashes; they are flattened so one scene cannot address
    # another's subtree by naming it.
    check fileExists(assetsDir / "scenes" / "tests_scoped" / "cache.txt")
    # The frame-wide folder is outside this scene's root, so its files are not
    # reachable by name any more.
    check not payload["sharedVisible"].getBool()

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

suite "js app source handling":
  # These pin the three things that make an app cheap to load on a frame:
  # JSX runs only where TypeScript says it may, the module form goes to
  # QuickJS untouched, and the line map is built only if an error needs it.

  test "picks the source file name, which decides whether JSX runs":
    check jsAppSourceNameFromSources(%*{"app.ts": "x"}) == "app.ts"
    check jsAppSourceNameFromSources(%*{"app.tsx": "x"}) == "app.tsx"
    check jsAppSourceNameFromSources(%*{"config.json": "{}"}) == ""

  test "a .tsx source renders JSX":
    let config = testConfig()
    let scene = FrameScene(id: "tests/js-jsx".SceneId, frameConfig: config, state: %*{},
                           logger: testLogger(config))
    let owner = AppRoot(nodeId: 1.NodeId, nodeName: "jsx", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let runtime = newJsAppRuntime(
      category = "data", outputType = "image",
      source = """export const get = () => <image width={4} height={2} color="#112233" />""",
      sourceName = "app.tsx")
    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkImage
    check value.asImage().width == 4

  test "JSX in a .ts source still works, via the retry":
    # TypeScript would reject this, and the JSX pass is skipped for .ts — but
    # apps written before that gate existed must keep working.
    let config = testConfig()
    let scene = FrameScene(id: "tests/js-legacy".SceneId, frameConfig: config, state: %*{},
                           logger: testLogger(config))
    let owner = AppRoot(nodeId: 2.NodeId, nodeName: "legacy", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let runtime = newJsAppRuntime(
      category = "data", outputType = "image",
      source = """export const get = () => <image width={5} height={2} color="#445566" />""",
      sourceName = "app.ts")
    check runtime.allowJsx == false
    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkImage
    check value.asImage().width == 5
    check runtime.allowJsx == true  # the retry stuck, so later renders skip it

  test "a runtime error still names the original source line":
    # The map is no longer built up front, so the error path has to build it —
    # and it has to be a real map, not identity. The interface below is erased,
    # so the failing call sits on a different line in the generated code (3)
    # than in what the author wrote (7).
    let config = testConfig()
    var logged: seq[JsonNode] = @[]
    var logger = Logger(frameConfig: config, enabled: true)
    logger.log = proc(payload: JsonNode) = logged.add(payload)
    logger.enable = proc() = logger.enabled = true
    logger.disable = proc() = logger.enabled = false
    let scene = FrameScene(id: "tests/js-err".SceneId, frameConfig: config, state: %*{},
                           logger: logger)
    let owner = AppRoot(nodeId: 3.NodeId, nodeName: "err", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text",
      source = """interface Removed {
  a: number
  b: string
  c: boolean
}
const helper = () => {
  return missingGlobal()
}
export const get = () => helper()""",
      sourceName = "app.ts")
    discard runtime.get(owner, %*{}, context)
    var stack = ""
    for entry in logged:
      if entry{"stack"}.getStr().len > 0:
        stack = entry{"stack"}.getStr()
    check logged.len > 0
    check stack.len > 0
    # helper's body is line 7 of the source; without the map it would be 3.
    check ":7:" in stack

  test "export default still resolves through the module namespace":
    # __frameosExports() prefers `.default`; with real ES modules that is a
    # property of the namespace rather than something the imports transform
    # assembled.
    let config = testConfig()
    let scene = FrameScene(id: "tests/js-default".SceneId, frameConfig: config, state: %*{},
                           logger: testLogger(config))
    let owner = AppRoot(nodeId: 4.NodeId, nodeName: "def", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text",
      source = """export default { get: (app, context) => `default:${context.event}` }""",
      sourceName = "app.ts")
    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkString
    check value.asString() == "default:render"

suite "js app imports":
  # An app is a set of files, not one: `import` pulls in the app's own .ts,
  # .tsx, .js, .jsx, and .json files through a QuickJS module loader that
  # knows only the sources map. Nothing else is importable on a frame.

  proc importScene(id: string): (FrameScene, AppRoot, ExecutionContext) =
    let config = testConfig()
    let scene = FrameScene(id: id.SceneId, frameConfig: config, state: %*{},
                           logger: testLogger(config))
    let owner = AppRoot(nodeId: 5.NodeId, nodeName: "imports", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    (scene, owner, context)

  proc loadFailure(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext): string =
    try:
      discard runtime.get(owner, %*{}, context)
      ""
    except JSException as error:
      error.msg

  test "joins specifiers the way QuickJS does":
    check joinModulePath("app.ts", "./util") == "util"
    check joinModulePath("app.ts", "./lib/sum.ts") == "lib/sum.ts"
    check joinModulePath("lib/sum.ts", "./numbers") == "lib/numbers"
    check joinModulePath("lib/sum.ts", "../scale.js") == "scale.js"
    check joinModulePath("lib/deep/x.ts", "../../y") == "y"
    check joinModulePath("app.ts", "../outside") == "../outside"
    check joinModulePath("app.ts", "dayjs") == "dayjs"
    check joinModulePath("app.ts", "data.json") == "data.json"

  test "resolves specifiers against the app's files":
    let files = %*{"app.ts": "", "util.ts": "", "icon.tsx": "", "data.json": "",
                   "lib/a.ts": "", "lib/b.js": "", "plain.js": ""}
    check resolveAppModule(files, "util") == "util.ts"
    check resolveAppModule(files, "util.ts") == "util.ts"
    check resolveAppModule(files, "util.js") == "util.ts"      # TS spelling
    check resolveAppModule(files, "icon") == "icon.tsx"
    check resolveAppModule(files, "icon.jsx") == "icon.tsx"
    check resolveAppModule(files, "data.json") == "data.json"
    check resolveAppModule(files, "data") == "data.json"
    check resolveAppModule(files, "lib/a") == "lib/a.ts"
    check resolveAppModule(files, "lib/b") == "lib/b.js"
    check resolveAppModule(files, "plain") == "plain.js"
    check resolveAppModule(files, "missing") == ""
    check resolveAppModule(files, "react") == ""
    check resolveAppModule(files, "") == ""
    check resolveAppModule(nil, "util") == ""

  test "imports named, default, JSX and JSON exports from sibling files":
    let (_, owner, context) = importScene("tests/js-imports")
    let sources = %*{
      "app.ts": """
        import { label, type Labelled } from './util'
        import greet from './greet'
        import { icon } from './icon'
        import data from './data.json'
        export const get = (app: FrameOSApp, context: FrameOSContext): string => {
          const item: Labelled = { name: data.name }
          const image = icon(3)
          return `${label(item)}|${greet(data.greeting)}|${image.props.width}|${data.sizes.length}`
        }
      """,
      "util.ts": """
        export interface Labelled { name: string }
        export const label = (item: Labelled): string => `<${item.name}>`
      """,
      "greet.ts": """
        export default function greet(word: string): string { return word.toUpperCase() }
      """,
      "icon.tsx": """
        export const icon = (width: number) => <image width={width} height={2} color="#000000" />
      """,
      "data.json": """{"name": "frame", "greeting": "hi", "sizes": [1, 2, 3]}""",
      "config.json": """{"name": "imports", "category": "data"}""",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    let value = runtime.get(owner, %*{}, context)
    check value.kind == fkString
    check value.asString() == "<frame>|HI|3|3"

  test "imports chain through folders, and ../ climbs back out":
    let (_, owner, context) = importScene("tests/js-imports-nested")
    let sources = %*{
      "app.ts": """
        import { total } from './lib/sum'
        export const get = () => String(total())
      """,
      "lib/sum.ts": """
        import { numbers } from './numbers'
        import { scale } from '../scale.js'
        export const total = () => numbers.reduce((a, b) => a + b, 0) * scale
      """,
      "lib/numbers.ts": "export const numbers = [1, 2, 3]",
      "scale.ts": "export const scale = 10",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    check runtime.get(owner, %*{}, context).asString() == "60"

  test "a module is evaluated once, however many files import it":
    let (_, owner, context) = importScene("tests/js-imports-once")
    let sources = %*{
      "app.ts": """
        import { counter } from './counter'
        import { fromA } from './a'
        import { fromB } from './b'
        export const get = () => `${fromA()},${fromB()},${counter.evaluations}`
      """,
      "counter.ts": """
        export const counter = { evaluations: 0, ticks: 0 }
        counter.evaluations += 1
      """,
      "a.ts": "import { counter } from './counter'\nexport const fromA = () => ++counter.ticks",
      "b.ts": "import { counter } from './counter'\nexport const fromB = () => ++counter.ticks",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    check runtime.get(owner, %*{}, context).asString() == "1,2,1"

  test "a helper may import the main module back":
    let (_, owner, context) = importScene("tests/js-imports-cycle")
    let sources = %*{
      "app.ts": """
        import { describe } from './helper'
        export const NAME = 'main'
        export const get = () => describe()
      """,
      "helper.ts": """
        import { NAME } from './app'
        export const describe = () => `helper of ${NAME}`
      """,
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    check runtime.get(owner, %*{}, context).asString() == "helper of main"

  test "a bare specifier fails with a message that says why":
    let (_, owner, context) = importScene("tests/js-imports-bare")
    let sources = %*{
      "app.ts": """
        import dayjs from 'dayjs'
        export const get = () => dayjs()
      """,
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    let failure = loadFailure(runtime, owner, context)
    check "Cannot import 'dayjs'" in failure
    check "npm packages are not available" in failure

  test "a missing file fails by name":
    let (_, owner, context) = importScene("tests/js-imports-missing")
    let sources = %*{
      "app.ts": """
        import { x } from './helpers/missing'
        export const get = () => x
      """,
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    check "Cannot import 'helpers/missing'" in loadFailure(runtime, owner, context)

  test "invalid JSON fails naming the file":
    let (_, owner, context) = importScene("tests/js-imports-badjson")
    let sources = %*{
      "app.ts": """
        import data from './data.json'
        export const get = () => data.x
      """,
      "data.json": "{\"x\": 1,}",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    check "data.json" in loadFailure(runtime, owner, context)

  test "a syntax error in an imported file names that file and line":
    let (_, owner, context) = importScene("tests/js-imports-syntax")
    let sources = %*{
      "app.ts": """
        import { broken } from './broken'
        export const get = () => broken()
      """,
      "broken.ts": "export const broken = () => {\n  return 1 +\n}\n",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    let failure = loadFailure(runtime, owner, context)
    check "broken.ts" in failure

  test "a runtime error inside an imported file maps to that file's source line":
    # The helper's `throw` sits on line 5 of util.ts as written; the interface
    # above it is erased, so the generated code has it earlier. The message
    # must still say util.ts:5.
    let config = testConfig()
    var logged: seq[JsonNode] = @[]
    var logger = testLogger(config)
    logger.log = proc(payload: JsonNode) =
      logged.add(payload)
    let scene = FrameScene(id: "tests/js-imports-runtime-error".SceneId, frameConfig: config,
                           state: %*{}, logger: logger)
    let owner = AppRoot(nodeId: 6.NodeId, nodeName: "importErr", scene: scene, frameConfig: config)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let sources = %*{
      "app.ts": "import { explode } from './util'\nexport const get = () => explode()\n",
      "util.ts": "export interface Unused {\n  a: number\n}\nexport function explode(): string {\n  throw new Error(\"imported boom\")\n}\n",
    }
    let runtime = newJsAppRuntime(
      category = "data", outputType = "text", source = sources["app.ts"].getStr(),
      sourceName = "app.ts", sources = sources)
    discard runtime.get(owner, %*{}, context)
    var stack = ""
    for entry in logged:
      if "jsApp:error" in entry{"event"}.getStr():
        stack = entry{"stack"}.getStr()
    check "util.ts:5:" in stack
    check "app.ts:2:" in stack

  test "a scene node's sources map feeds the loader":
    let config = testConfig()
    let scene = FrameScene(id: "tests/js-imports-node".SceneId, frameConfig: config, state: %*{},
                           logger: testLogger(config))
    let node = DiagramNode(id: 9.NodeId, data: %*{"name": "withHelper"})
    let sources = %*{
      "config.json": """{"name": "withHelper", "category": "data", "output": [{"name": "text", "type": "string"}]}""",
      "app.ts": "import { text } from './helper'\nexport const get = () => text",
      "helper.ts": "export const text = 'from helper'",
    }
    let app = initDynamicJsApp("withHelper", node, scene, sources)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
                                   hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1)
    let value = app.getDynamicJsApp(context)
    check value.kind == fkString
    check value.asString() == "from helper"
