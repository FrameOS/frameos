## The OpenAI Text code app (repo/apps/code/openaiText) run for real through
## the JS app runtime, its chat completion answered at `jsHttpRequestHook`:
## the request, the reply, the size-only request log, and the error behavior
## (most errors log and return "", a failed request or a reply that is not JSON
## also returns "OpenAI API error: <message>").
##
## Each render gets the config a scene node arrives with: config.json's typed
## defaults under the node's own values, built by initDynamicJsApp as the
## interpreter builds it. The app reads its fields without fallbacks of its own.

import std/[json, os, strutils, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "code" / "openaiText"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")
let appSources = %*{"app.ts": appSource, "config.json": appConfigJson}
const DefaultSystem = "You're a smart e-ink frame running FrameOS. Reply with plain text only. Space is very limited."

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

proc chatReply(content: string): string =
  $(%*{"id": "chatcmpl-1", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]})

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(apiKey = "sk-test", settings: JsonNode = nil, nodeId = 8): Harness =
  requests = @[]
  replyCode = 200
  replyBody = chatReply("A quiet morning.")
  transportError = ""
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: if settings.isNil: %*{"openAI": {"apiKey": apiKey}} else: settings)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/openai-text-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: nodeId.NodeId, nodeName: "openaiText", appKeyword: "openaiText", scene: scene,
    frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "string", source = appSource,
    settingsKeys = @["openAI"], sourceName = "app.ts", sources = appSources)
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc render(h: Harness, config: JsonNode): Value =
  let node = DiagramNode(id: h.owner.nodeId, nodeType: "app", data: %*{"keyword": "openaiText", "config": config})
  let configJson = DynamicJsApp(initDynamicJsApp("openaiText", node, h.scene, appSources)).configJson
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, configJson, context)

proc errors(h: Harness): seq[string] =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:"):
      result.add(entry{"error"}.getStr())

proc messages(h: Harness): seq[string] =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("log:"):
      result.add(entry{"message"}.getStr())

proc header(request: Request, name: string): string =
  for header in request.headers:
    if header.name == name:
      return header.value
  ""

suite "openaiText code app":
  test "missing system and user prompt logs an error and leaves state alone":
    let h = newHarness()
    let output = h.render(%*{"system": "", "user": ""})
    check output.kind == fkString
    check output.asString() == ""
    check h.scene.state.len == 0
    check h.errors() == @["No system or user prompt provided in app config."]
    check h.logs[].len == 1
    check h.logs[][0]["event"].getStr().contains("error:8:openaiText")
    check requests.len == 0

  test "missing api key logs a settings error and leaves state alone":
    let h = newHarness(settings = %*{}, nodeId = 9)
    let output = h.render(%*{"system": "system", "user": "hello"})
    check output.kind == fkString
    check output.asString() == ""
    check h.scene.state.len == 0
    check h.errors() == @["Please provide an OpenAI API key in the settings."]
    check h.logs[].len == 1
    check h.logs[][0]["event"].getStr().contains("error:9:openaiText")
    check requests.len == 0

  test "the request, the reply, and a log of prompt sizes, never the prompts":
    let h = newHarness()
    let system = "You are private."
    let user = "My address is 1 Secret St."
    let output = h.render(%*{"model": "gpt-test", "system": system, "user": user})
    check output.kind == fkString
    check output.asString() == "A quiet morning."
    check requests.len == 1
    let request = requests[0]
    check request.url == "https://api.openai.com/v1/chat/completions"
    check request.httpMethod == "POST"
    check request.header("Authorization") == "Bearer sk-test"
    check request.header("Content-Type") == "application/json"
    check request.body == $(%*{"model": "gpt-test", "messages": [
      {"role": "system", "content": system}, {"role": "user", "content": user}]})
    check h.messages() == @[
      """{"model":"gpt-test","systemPromptChars":16,"userPromptChars":26}""",
      """{"replyChars":16}"""]
    for entry in h.logs[]:
      check "Secret" notin $entry
      check "private" notin $entry
    check h.errors().len == 0
    check "timeoutMs: 60000" in appSource

  test "sizes are counted in UTF-8 bytes, as the Nim app did":
    let h = newHarness()
    let user = "héllo ✓ 🎉"
    replyBody = chatReply("ünïcode 🎉")
    let output = h.render(%*{"model": "gpt-test", "system": "", "user": user})
    check output.asString() == "ünïcode 🎉"
    check h.messages() == @[
      "{\"model\":\"gpt-test\",\"systemPromptChars\":0,\"userPromptChars\":" & $user.len & "}",
      "{\"replyChars\":" & $"ünïcode 🎉".len & "}"]

  test "one prompt is enough; a missing system prompt and model are the field defaults":
    let userOnly = newHarness()
    check userOnly.render(%*{"system": "", "user": "hi"}).asString() == "A quiet morning."
    check parseJson(requests[0].body)["messages"][0]["content"].getStr() == ""

    let systemOnly = newHarness()
    check systemOnly.render(%*{"system": "Say hi.", "user": ""}).asString() == "A quiet morning."
    check parseJson(requests[0].body)["messages"][1]["content"].getStr() == ""

    let defaults = newHarness()
    check defaults.render(%*{"user": "hi"}).asString() == "A quiet morning."
    let body = parseJson(requests[0].body)
    check body["model"].getStr() == "gpt-5.5"
    check body["messages"][0]["content"].getStr() == DefaultSystem

  test "a reply without a message is an empty string":
    for reply in ["""{"choices": []}""", """{"choices": [{"message": {"content": null}}]}""",
        """{"choices": [{"message": {}}]}""", """{"choices": [null]}""", "{}", "[]", "null"]:
      let h = newHarness()
      replyBody = reply
      let output = h.render(%*{"user": "hi"})
      check output.kind == fkString
      check output.asString() == ""
      check h.messages()[^1] == """{"replyChars":0}"""
      check h.errors().len == 0

  test "API errors log the message from the error JSON and return an empty string":
    for (code, body, expected) in [
        (401, """{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}""",
          "Error making request 401: Incorrect API key provided"),
        (429, """{"error": "slow down"}""", "Error making request 429: slow down"),
        (400, """{"detail": [1, 2]}""", """Error making request 400: {"detail":[1,2]}"""),
        (502, "Bad gateway", "Error making request 502: Bad gateway")]:
      let h = newHarness()
      replyCode = code
      replyBody = body
      let output = h.render(%*{"user": "hi"})
      check output.kind == fkString
      check output.asString() == ""
      check h.errors() == @[expected]
      check h.scene.state.len == 0

  test "a failed request or a reply that is not JSON also becomes the output":
    let transport = newHarness()
    transportError = "Connection refused"
    let output = transport.render(%*{"user": "hi"})
    check output.asString() == "OpenAI API error: Connection refused"
    check "JS app httpRequest failed: Connection refused" in transport.errors()
    check "OpenAI API error: Connection refused" in transport.errors()
    check transport.scene.state.len == 0

    let notJson = newHarness()
    replyBody = "<html>oops</html>"
    let reply = notJson.render(%*{"user": "hi"}).asString()
    check reply.startsWith("OpenAI API error: ")
    check reply.len > "OpenAI API error: ".len
    check notJson.errors() == @[reply]
    for message in transport.errors() & notJson.errors():
      check "JS app get failed" notin message
