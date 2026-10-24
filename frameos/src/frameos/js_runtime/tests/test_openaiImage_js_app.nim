## The OpenAI Image code app (repo/apps/image/openaiImage) run for real through
## the JS app runtime. The API call is answered at `jsHttpRequestHook`; a
## `b64_json` reply decodes through the real `data:` URL path (and saves from
## it), a `url` reply's download is stubbed at `contextDownloadHook`. This pins
## the request (URL, headers, body per model, the embedded overrides), the size
## table, the image, the metadata state, the saved asset and every error.
##
## Each render gets the config a scene node arrives with: config.json's typed
## defaults (the first declaration of a repeated name wins) under the node's
## own values, built by initDynamicJsApp as the interpreter builds it. The app
## reads its fields without fallbacks of its own.
##
## Errors are thrown, as the Nim app raised: the runtime logs "JS app get
## failed: <message>" and raises JsAppError, and the interpreter paints the
## message (test_interpreter_errors.nim).
##
## The ESP32 branches run through `embedded.ts`, a wrapper that hands the real
## `get` an `app.frame` with `embedded: true` — a host build reports false.

import std/[base64, json, os, strutils, tables, unittest]
import pixie

import frameos/apps
import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/app_images
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "image" / "openaiImage"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")
let appSources = %*{"app.ts": appSource, "config.json": appConfigJson}
const embeddedWrapper = """
import { get as appGet } from './app'
export function get(app, context) {
  const f = app.frame
  const frame = { width: f.width, height: f.height, rotate: f.rotate, timeZone: f.timeZone,
    assetsPath: f.assetsPath, debug: false, embedded: true }
  return appGet(Object.assign({}, app, { frame }), context)
}
"""

proc pngBytes(width, height: int): string =
  let image = newImage(width, height)
  image.fill(rgba(30, 140, 200, 255))
  encodeImage(image, PngFormat)

type Request = object
  url: string
  httpMethod: string
  body: string
  headers: seq[SimpleHttpHeader]

var requests: seq[Request] = @[]
var replyCode = 200
var replyBody = ""
var transportError = ""

proc answer(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  requests.add(Request(url: url, httpMethod: httpMethod, body: body, headers: headers))
  if transportError.len > 0:
    raise newException(IOError, transportError)
  (replyCode, replyBody)

jsHttpRequestHook = answer

var downloads: seq[string] = @[]
var downloadError = ""

proc stubDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit,
    boundWidth: int, boundHeight: int): tuple[image: Image, data: string] =
  downloads.add(url)
  if downloadError.len > 0:
    raise newException(IOError, downloadError)
  let image = newImage(7, 2)
  image.fill(rgba(200, 40, 40, 255))
  (image, "downloaded-image-bytes")

proc b64Reply(revisedPrompt = "", width = 5, height = 3): string =
  var item = %*{"b64_json": encode(pngBytes(width, height))}
  if revisedPrompt.len > 0:
    item["revised_prompt"] = %revisedPrompt
  $(%*{"created": 1, "data": [item]})

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(apiKey = "sk-test", width = 200, height = 120, rotate = 0, assetsPath = "/tmp",
    saveAssets = false, embedded = false, stubDownloads = false, settings: JsonNode = nil,
    nodeId = 5): Harness =
  requests = @[]
  replyCode = 200
  replyBody = b64Reply()
  transportError = ""
  downloads = @[]
  downloadError = ""
  contextDownloadHook = if stubDownloads: stubDownload else: nil
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: width, height: height, rotate: rotate, scalingMode: "cover", debug: false,
    saveAssets: %*saveAssets, assetsPath: assetsPath,
    settings: if settings.isNil: %*{"openAI": {"apiKey": apiKey}} else: settings)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/openai-image-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: nodeId.NodeId, nodeName: "openaiImage", appKeyword: "openaiImage", scene: scene,
    frameConfig: config)
  let runtime =
    if embedded:
      newJsAppRuntime(category = "data", outputType = "image", source = embeddedWrapper,
        settingsKeys = @["openAI"], sourceName = "embedded.ts",
        sources = %*{"embedded.ts": embeddedWrapper, "app.ts": appSource, "config.json": appConfigJson})
    else:
      newJsAppRuntime(category = "data", outputType = "image", source = appSource,
        settingsKeys = @["openAI"], sourceName = "app.ts", sources = appSources)
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc nodeConfig(h: Harness, config: JsonNode): JsonNode =
  let node = DiagramNode(id: h.owner.nodeId, nodeType: "app", data: %*{"keyword": "openaiImage", "config": config})
  DynamicJsApp(initDynamicJsApp("openaiImage", node, h.scene, appSources)).configJson

proc render(h: Harness, config: JsonNode, width = 200, height = 120, withImage = true): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: withImage,
    image: (if withImage: newImage(width, height) else: nil), loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, h.nodeConfig(config), context)

proc threw(h: Harness, config: JsonNode, width = 200, height = 120, withImage = true): string =
  ## What get() threw, "" when it returned.
  try:
    discard h.render(config, width, height, withImage)
  except JsAppError as e:
    return e.msg
  ""

proc errors(h: Harness): seq[string] =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:"):
      result.add(entry{"error"}.getStr())

proc lastBody(): JsonNode =
  doAssert requests.len > 0
  parseJson(requests[^1].body)

proc header(request: Request, name: string): string =
  for header in request.headers:
    if header.name == name:
      return header.value
  ""

proc requestedSize(h: Harness, config: JsonNode, width, height: int): string =
  ## The size the app asks for when drawing into a width x height image. The
  ## reply is an error: only the request matters here.
  replyCode = 400
  replyBody = """{"error": {"message": "stop"}}"""
  doAssert h.threw(config, width, height) == "Error making request 400: stop"
  lastBody()["size"].getStr()

proc savedFiles(dir: string): seq[string] =
  if dirExists(dir):
    for file in walkDirRec(dir):
      result.add(file)

suite "openaiImage code app":
  test "missing prompt throws before any request":
    let h = newHarness()
    check h.threw(%*{"prompt": "", "model": "gpt-image-1", "metadataStateKey": "meta"}, 12, 8) ==
      "No prompt provided in app config."
    check not h.scene.state.hasKey("meta")
    check h.errors() == @["JS app get failed: No prompt provided in app config."]
    for entry in h.logs[]:
      if entry{"event"}.getStr().startsWith("error:"):
        check entry{"event"}.getStr().contains("error:5:openaiImage")
    check requests.len == 0

  test "missing api key throws before any request":
    let h = newHarness(width = 9, height = 6, rotate = 90, settings = %*{}, nodeId = 7)
    check h.threw(%*{"prompt": "frameos", "model": "gpt-image-1", "metadataStateKey": "meta"}, withImage = false) ==
      "Please provide an OpenAI API key in the settings."
    check not h.scene.state.hasKey("meta")
    check h.errors() == @["JS app get failed: Please provide an OpenAI API key in the settings."]
    check requests.len == 0

  test "gpt-image-2 by default: the request, the decoded base64 image, the metadata":
    let h = newHarness()
    replyBody = b64Reply(revisedPrompt = "A pumpkin pyjama party, digital art, revised")
    let value = h.render(%*{"prompt": "pumpkin pyjama party", "metadataStateKey": "meta"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check value.asImage().height == 3
    check requests.len == 1
    let request = requests[0]
    check request.url == "https://api.openai.com/v1/images/generations"
    check request.httpMethod == "POST"
    check request.header("Authorization") == "Bearer sk-test"
    check request.header("Content-Type") == "application/json"
    # Same keys, same order as the Nim app's body.
    check request.body == """{"prompt":"pumpkin pyjama party","n":1,"size":"1536x1024","model":"gpt-image-2"}"""
    check $h.scene.state["meta"] == """{"source":"openai","prompt":"pumpkin pyjama party",""" &
      """"generatedPrompt":"A pumpkin pyjama party, digital art, revised","model":"gpt-image-2",""" &
      """"size":"1536x1024","revisedPrompt":"A pumpkin pyjama party, digital art, revised"}"""
    check h.errors().len == 0
    check h.runtime.images.len == 0
    check "timeoutMs: 300000" in appSource

  test "without a revised prompt the metadata repeats the prompt and has no revisedPrompt":
    let h = newHarness()
    let value = h.render(%*{"prompt": "a lighthouse", "model": "gpt-image-1", "metadataStateKey": "meta"}, 100, 300)
    check value.kind == fkImage
    check $h.scene.state["meta"] == """{"source":"openai","prompt":"a lighthouse","generatedPrompt":"a lighthouse",""" &
      """"model":"gpt-image-1","size":"1024x1536"}"""
    let none = newHarness()
    check none.render(%*{"prompt": "a lighthouse"}).kind == fkImage
    check none.scene.state.len == 0

  test "best for orientation follows the image drawn into, per model":
    let h = newHarness()
    for (model, landscape, portrait) in [("dall-e-3", "1792x1024", "1024x1792"),
        ("gpt-image-2", "1536x1024", "1024x1536"), ("gpt-image-1", "1536x1024", "1024x1536"),
        ("gpt-image-1.5", "1536x1024", "1024x1536"), ("dall-e-2", "1024x1024", "1024x1024"),
        ("some-new-model", "1024x1024", "1024x1024")]:
      let config = %*{"prompt": "x", "model": model, "size": "best for orientation"}
      check h.requestedSize(config, 300, 200) == landscape
      check h.requestedSize(config, 200, 300) == portrait
      check h.requestedSize(config, 250, 250) == "1024x1024"
    # No size in the config is the field's default, "best for orientation".
    check h.requestedSize(%*{"prompt": "x", "model": "dall-e-3"}, 300, 200) == "1792x1024"

  test "orientation is the canvas's, which a turned frame hands over turned; no canvas means the default size":
    for (rotate, expected) in [(0, "1536x1024"), (90, "1024x1536"), (180, "1536x1024"), (270, "1024x1536")]:
      let h = newHarness(width = 800, height = 480, rotate = rotate)
      let config = h.owner.frameConfig
      check h.requestedSize(%*{"prompt": "x", "model": "gpt-image-1"}, config.renderWidth(), config.renderHeight()) == expected
    let square = newHarness(width = 480, height = 480, rotate = 90)
    check square.requestedSize(%*{"prompt": "x", "model": "gpt-image-1"}, 480, 480) == "1024x1024"
    check not appSource.contains("rotate")
    let blind = newHarness(width = 800, height = 480)
    replyCode = 400
    replyBody = "{}"
    check blind.threw(%*{"prompt": "x", "model": "gpt-image-1"}, withImage = false) == "Error making request 400: {}"
    check lastBody()["size"].getStr() == "1024x1024"

  test "an explicit size must be one the model offers":
    let h = newHarness()
    for (model, size, expected) in [
        ("dall-e-3", "1792x1024", "1792x1024"), ("dall-e-3", "1024x1792", "1024x1792"),
        ("dall-e-3", "1536x1024", "1024x1024"),
        ("dall-e-2", "256x256", "256x256"), ("dall-e-2", "512x512", "512x512"),
        ("dall-e-2", "1792x1024", "1024x1024"),
        ("gpt-image-2", "1024x640", "1024x640"), ("gpt-image-2", "640x1024", "640x1024"),
        ("gpt-image-2", "1536x1024", "1536x1024"), ("gpt-image-2", "1024x1536", "1024x1536"),
        ("gpt-image-2", "1792x1024", "1024x1024"),
        ("gpt-image-1", "1536x1024", "1536x1024"), ("gpt-image-1", "1024x640", "1024x1024"),
        ("gpt-image-1.5", "1024x1536", "1024x1536"), ("gpt-image-1.5", "512x512", "1024x1024"),
        ("some-new-model", "1536x1024", "1024x1024"),
        ("gpt-image-2", "", "1024x1024")]:
      check h.requestedSize(%*{"prompt": "x", "model": model, "size": size}, 300, 200) == expected

  test "dall-e-3 sends style and quality unless empty; dall-e-2 sends neither":
    let h = newHarness()
    discard h.requestedSize(%*{"prompt": "x", "model": "dall-e-3", "style": "natural", "quality": "hd"}, 300, 200)
    check $lastBody() == """{"prompt":"x","n":1,"size":"1792x1024","model":"dall-e-3","style":"natural","quality":"hd"}"""
    discard h.requestedSize(%*{"prompt": "x", "model": "dall-e-3", "style": "", "quality": ""}, 300, 200)
    check $lastBody() == """{"prompt":"x","n":1,"size":"1792x1024","model":"dall-e-3"}"""
    # The fields' defaults: style vivid, quality standard (the first `quality`).
    discard h.requestedSize(%*{"prompt": "x", "model": "dall-e-3"}, 300, 200)
    check $lastBody() == """{"prompt":"x","n":1,"size":"1792x1024","model":"dall-e-3","style":"vivid","quality":"standard"}"""
    discard h.requestedSize(%*{"prompt": "x", "model": "dall-e-2", "style": "natural", "quality": "hd",
      "outputFormat": "png"}, 300, 200)
    check $lastBody() == """{"prompt":"x","n":1,"size":"1024x1024","model":"dall-e-2"}"""

  test "gpt-image models: quality, output format and compression":
    let h = newHarness()
    proc body(config: JsonNode): string =
      config["prompt"] = %"x"
      discard h.requestedSize(config, 250, 250)
      $lastBody()
    proc expected(model: string, extra: JsonNode = %*{}): string =
      var node = %*{"prompt": "x", "n": 1, "size": "1024x1024", "model": model}
      for key, value in extra.pairs:
        node[key] = value
      $node
    for quality in ["low", "medium", "high", "auto"]:
      check body(%*{"model": "gpt-image-1", "quality": quality}) == expected("gpt-image-1", %*{"quality": quality})
    check body(%*{"model": "gpt-image-1", "quality": "standard"}) == expected("gpt-image-1")
    check body(%*{"model": "gpt-image-1", "quality": ""}) == expected("gpt-image-1")
    # The quality default is the first declaration's ("standard", dall-e-3's): none is sent.
    check body(%*{"model": "gpt-image-1"}) == expected("gpt-image-1")
    check body(%*{"model": "gpt-image-1", "outputFormat": "auto", "outputCompression": 80}) == expected("gpt-image-1")
    check body(%*{"model": "gpt-image-1", "outputFormat": "png", "outputCompression": 80}) ==
      expected("gpt-image-1", %*{"output_format": "png"})
    check body(%*{"model": "gpt-image-1", "outputFormat": "jpeg"}) == expected("gpt-image-1", %*{"output_format": "jpeg"})
    check body(%*{"model": "gpt-image-1", "outputFormat": "jpeg", "outputCompression": 80}) ==
      expected("gpt-image-1", %*{"output_format": "jpeg", "output_compression": 80})
    check body(%*{"model": "gpt-image-1", "outputFormat": "webp", "outputCompression": 150}) ==
      expected("gpt-image-1", %*{"output_format": "webp", "output_compression": 100})
    check body(%*{"model": "gpt-image-1", "outputFormat": "webp", "outputCompression": -5}) ==
      expected("gpt-image-1", %*{"output_format": "webp"})
    check body(%*{"model": "gpt-image-1", "outputFormat": "webp", "outputCompression": "30"}) ==
      expected("gpt-image-1", %*{"output_format": "webp", "output_compression": 30})
    check body(%*{"model": "gpt-image-1", "outputFormat": "webp", "outputCompression": 30.7}) ==
      expected("gpt-image-1", %*{"output_format": "webp", "output_compression": 30})
    check body(%*{"model": "gpt-image-1", "outputFormat": "gif"}) == expected("gpt-image-1")
    check body(%*{"model": "gpt-image-2", "quality": "medium", "outputFormat": "jpeg", "outputCompression": 40}) ==
      expected("gpt-image-2", %*{"quality": "medium", "output_format": "jpeg", "output_compression": 40})
    check body(%*{"model": "gpt-image-1.5", "quality": "low"}) == expected("gpt-image-1.5", %*{"quality": "low"})

  test "on an ESP32 the gpt-image models ask for low quality and a compressed JPEG":
    let h = newHarness(embedded = true)
    proc body(config: JsonNode, width = 300, height = 200): string =
      config["prompt"] = %"x"
      discard h.requestedSize(config, width, height)
      $lastBody()
    check body(%*{"model": "gpt-image-2"}) ==
      """{"prompt":"x","n":1,"size":"1024x640","model":"gpt-image-2","quality":"low","output_format":"jpeg","output_compression":50}"""
    check body(%*{"model": "gpt-image-2"}, 200, 300) ==
      """{"prompt":"x","n":1,"size":"640x1024","model":"gpt-image-2","quality":"low","output_format":"jpeg","output_compression":50}"""
    check body(%*{"model": "gpt-image-2"}, 250, 250) ==
      """{"prompt":"x","n":1,"size":"1024x1024","model":"gpt-image-2","quality":"low","output_format":"jpeg","output_compression":50}"""
    check body(%*{"model": "gpt-image-2", "quality": "high", "outputFormat": "", "outputCompression": 120}) ==
      """{"prompt":"x","n":1,"size":"1024x640","model":"gpt-image-2","quality":"low","output_format":"jpeg","output_compression":100}"""
    check body(%*{"model": "gpt-image-2", "quality": "auto", "outputFormat": "png", "outputCompression": 80}) ==
      """{"prompt":"x","n":1,"size":"1024x640","model":"gpt-image-2","quality":"low","output_format":"png"}"""
    check body(%*{"model": "gpt-image-1", "outputFormat": "webp", "outputCompression": 0}) ==
      """{"prompt":"x","n":1,"size":"1536x1024","model":"gpt-image-1","quality":"low","output_format":"webp","output_compression":50}"""
    check body(%*{"model": "gpt-image-1", "outputFormat": "jpeg", "outputCompression": -5}) ==
      """{"prompt":"x","n":1,"size":"1536x1024","model":"gpt-image-1","quality":"low","output_format":"jpeg","output_compression":50}"""
    check body(%*{"model": "gpt-image-1", "outputFormat": "gif"}) ==
      """{"prompt":"x","n":1,"size":"1536x1024","model":"gpt-image-1","quality":"low"}"""
    # An explicit gpt-image-2 size stands; the dall-e models are not overridden.
    check body(%*{"model": "gpt-image-2", "size": "1536x1024"}) ==
      """{"prompt":"x","n":1,"size":"1536x1024","model":"gpt-image-2","quality":"low","output_format":"jpeg","output_compression":50}"""
    check body(%*{"model": "dall-e-3", "quality": "hd"}) ==
      """{"prompt":"x","n":1,"size":"1792x1024","model":"dall-e-3","style":"vivid","quality":"hd"}"""

  test "the ESP32 path shows the base64 image too":
    let h = newHarness(embedded = true)
    let value = h.render(%*{"prompt": "x", "metadataStateKey": "meta"})
    check value.kind == fkImage
    check value.asImage().width == 5
    check h.scene.state["meta"]["size"].getStr() == "1024x640"

  test "the base64 reply is decoded from a data: URL of the requested format":
    let h = newHarness(stubDownloads = true)
    check h.render(%*{"prompt": "x", "model": "gpt-image-1", "outputFormat": "jpeg"}).kind == fkImage
    check downloads.len == 1
    check downloads[0].startsWith("data:image/jpeg;base64,")
    check h.render(%*{"prompt": "x", "model": "gpt-image-1"}).kind == fkImage
    check downloads[1].startsWith("data:image/png;base64,")
    check downloads[1]["data:image/png;base64,".len..^1] == parseJson(replyBody)["data"][0]["b64_json"].getStr()

  test "a url reply (dall-e) downloads the image and records metadata":
    let h = newHarness(stubDownloads = true)
    replyBody = """{"data": [{"url": "https://images.example/img-1.png", "revised_prompt": "A calm sea"}]}"""
    let value = h.render(%*{"prompt": "sea", "model": "dall-e-3", "metadataStateKey": "meta"})
    check value.kind == fkImage
    check value.asImage().width == 7
    check value.asImage().height == 2
    check downloads == @["https://images.example/img-1.png"]
    check $h.scene.state["meta"] == """{"source":"openai","prompt":"sea","generatedPrompt":"A calm sea",""" &
      """"model":"dall-e-3","size":"1792x1024","revisedPrompt":"A calm sea"}"""
    check h.errors().len == 0

  test "the base64 image is saved as an asset named after the prompt, with a .jpg extension":
    let assetsDir = getTempDir() / "frameos-openai-image-js-app-save"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let savedDir = assetsDir / "saved" / "openaiImage"

    let never = newHarness(assetsPath = assetsDir, saveAssets = true)
    check never.render(%*{"prompt": "a red fox", "saveAssets": "never"}).kind == fkImage
    check savedFiles(savedDir).len == 0

    let autoOff = newHarness(assetsPath = assetsDir, saveAssets = false)
    check autoOff.render(%*{"prompt": "a red fox", "saveAssets": "auto"}).kind == fkImage
    check savedFiles(savedDir).len == 0

    let h = newHarness(assetsPath = assetsDir, saveAssets = true)
    check h.render(%*{"prompt": "a red fox"}).kind == fkImage
    let saved = savedFiles(savedDir)
    check saved.len == 1
    check saved[0].extractFilename().startsWith(cleanFilename("a red fox") & ".")
    check saved[0].endsWith(".jpg")
    check readFile(saved[0]) == pngBytes(5, 3)

    let always = newHarness(assetsPath = assetsDir, saveAssets = false)
    replyBody = b64Reply(width = 4, height = 4)
    check always.render(%*{"prompt": "a blue fox", "saveAssets": "always"}).kind == fkImage
    check savedFiles(savedDir).len == 2

  test "a downloaded image is saved under the same name":
    let assetsDir = getTempDir() / "frameos-openai-image-js-app-save-url"
    removeDir(assetsDir)
    createDir(assetsDir)
    defer: removeDir(assetsDir)
    let h = newHarness(assetsPath = assetsDir, saveAssets = true, stubDownloads = true)
    replyBody = """{"data": [{"url": "https://images.example/img-2.png"}]}"""
    check h.render(%*{"prompt": "sea", "model": "dall-e-2", "saveAssets": "auto"}).kind == fkImage
    let saved = savedFiles(assetsDir / "saved" / "openaiImage")
    check saved.len == 1
    check saved[0].extractFilename().startsWith("sea.")
    check saved[0].endsWith(".jpg")
    check readFile(saved[0]) == "downloaded-image-bytes"

  test "API errors throw the message from the error JSON":
    for (code, body, expected) in [
        (401, """{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}""",
          "Error making request 401: Incorrect API key provided"),
        (500, """{"error": "boom"}""", "Error making request 500: boom"),
        (400, """{"error": {"code": "x"}, "detail": 1}""", """Error making request 400: {"error":{"code":"x"},"detail":1}"""),
        (502, "Bad gateway", "Error making request 502: Bad gateway"),
        (503, "", "Error making request 503: ")]:
      let h = newHarness()
      replyCode = code
      replyBody = body
      check h.threw(%*{"prompt": "x", "metadataStateKey": "meta"}) == expected
      check h.errors() == @["JS app get failed: " & expected]
      check not h.scene.state.hasKey("meta")

  test "a failed request, a bad reply and a bad image throw":
    let transport = newHarness()
    transportError = "Connection refused"
    check transport.threw(%*{"prompt": "x", "metadataStateKey": "meta"}) ==
      "Error fetching image from OpenAI: Connection refused"
    check transport.errors() == @["JS app httpRequest failed: Connection refused",
      "JS app get failed: Error fetching image from OpenAI: Connection refused"]
    check not transport.scene.state.hasKey("meta")

    let notJson = newHarness()
    replyBody = "<html>oops</html>"
    let parseError = notJson.threw(%*{"prompt": "x", "metadataStateKey": "meta"})
    check parseError.startsWith("Error fetching image from OpenAI: ")
    check parseError.len > "Error fetching image from OpenAI: ".len
    check not notJson.scene.state.hasKey("meta")

    for body in ["""{"data": []}""", """{"data": [{}]}""", """{"data": [{"b64_json": "", "url": ""}]}""",
        """{"data": [null]}""", "[]", "null"]:
      let empty = newHarness()
      replyBody = body
      check empty.threw(%*{"prompt": "x", "metadataStateKey": "meta"}) == "No image data returned from OpenAI."
      check not empty.scene.state.hasKey("meta")

    let badImage = newHarness()
    replyBody = $(%*{"data": [{"b64_json": encode("this is not an image")}]})
    check badImage.threw(%*{"prompt": "x", "metadataStateKey": "meta"}).startsWith("Error fetching image from OpenAI: ")
    check not badImage.scene.state.hasKey("meta")

    let download = newHarness(stubDownloads = true)
    downloadError = "HTTP 403"
    replyBody = """{"data": [{"url": "https://images.example/expired.png"}]}"""
    check download.threw(%*{"prompt": "x", "model": "dall-e-3", "metadataStateKey": "meta"}) ==
      "Error fetching image from OpenAI: HTTP 403"
    check not download.scene.state.hasKey("meta")
