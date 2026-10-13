## The Home Assistant Sensor code app (repo/apps/code/haSensor) run for real
## through the JS app runtime. Every `frameos.httpRequest` is answered by
## `jsHttpRequestHook`, so this pins the URL, the headers, the replies the app
## returns (state JSON or `{error}`), the one-second reuse of the last good
## reply and the debug logs, without a Home Assistant.

import std/[json, os, strutils, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "code" / "haSensor"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

## Runs the app's exported helpers, and its get() next to a way to age the
## reused reply (the module state the app keeps between calls).
const probeSource = """
import { isHaEntityId, errorReply, lastReply, haStateUrl, get as appGet } from './app'
export function get(app, context) {
  const probe = app.config.probe
  if (probe === 'isHaEntityId') return app.config.values.map((value) => isHaEntityId(value))
  if (probe === 'errorReply') return errorReply(app.config.message)
  if (probe === 'haStateUrl') return haStateUrl(app.config.haUrl, app.config.entityId)
  if (probe === 'age') lastReply.at -= 2000
  return appGet(app, context)
}
"""

type Recorded = object
  url: string
  httpMethod: string
  headers: seq[SimpleHttpHeader]

var requests: seq[Recorded] = @[]
var replyCode = 200
var replyBody = """{"entity_id": "sensor.outdoor_temp", "state": "21.5", "attributes": {"unit_of_measurement": "°C"}}"""
var transportError = ""

jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  requests.add(Recorded(url: url, httpMethod: httpMethod, headers: headers))
  if transportError.len > 0:
    raise newException(IOError, transportError)
  (replyCode, replyBody)

proc header(request: Recorded, name: string): string =
  for (headerName, value) in request.headers:
    if headerName.toLowerAscii() == name.toLowerAscii():
      return value
  ""

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(settings: JsonNode, probe = false): Harness =
  requests = @[]
  replyCode = 200
  replyBody = """{"entity_id": "sensor.outdoor_temp", "state": "21.5", "attributes": {"unit_of_measurement": "°C"}}"""
  transportError = ""
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: settings)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/ha-sensor-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 3.NodeId, nodeName: "haSensor", appKeyword: "haSensor", scene: scene,
    frameConfig: config)
  let sources = %*{"app.ts": appSource, "config.json": appConfigJson, "probe.ts": probeSource}
  let runtime = newJsAppRuntime(category = "data", outputType = "json",
    source = (if probe: probeSource else: appSource), settingsKeys = @["homeAssistant"],
    sourceName = (if probe: "probe.ts" else: "app.ts"), sources = sources)
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc call(h: Harness, config: JsonNode): JsonNode =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  let value = h.runtime.get(h.owner, config, context)
  check value.kind == fkJson
  value.asJson()

proc logged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("log:") and entry{"message"}.getStr().contains(needle):
      return true
  false

proc errorLogged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:") and entry{"error"}.getStr().contains(needle):
      return true
  false

let goodSettings = %*{"homeAssistant": {"url": "http://ha.local:8123/", "accessToken": "token"}}

suite "Home Assistant Sensor code app":
  test "missing Home Assistant URL returns deterministic error payload":
    let h = newHarness(%*{"homeAssistant": {"accessToken": "token"}})
    let output = h.call(%*{"entityId": "sensor.outdoor_temp", "debug": false})
    check output == %*{"error": "Please provide a Home Assistant URL in the settings."}
    check h.errorLogged("Please provide a Home Assistant URL in the settings.")
    check requests.len == 0

  test "missing Home Assistant access token returns deterministic error payload":
    let h = newHarness(%*{"homeAssistant": {"url": "http://ha.local"}})
    let output = h.call(%*{"entityId": "sensor.outdoor_temp", "debug": true})
    check output == %*{"error": "Please provide a Home Assistant access token in the settings."}
    check requests.len == 0

  test "no homeAssistant settings at all is the missing URL":
    let h = newHarness(%*{})
    check h.call(%*{"entityId": "sensor.outdoor_temp"}) ==
      %*{"error": "Please provide a Home Assistant URL in the settings."}

  test "entity ids must be <domain>.<object_id>":
    let h = newHarness(goodSettings, probe = true)
    let values = @["sensor.outdoor_temp", "binary_sensor.door_2", "", "sensor", "sensor.", ".temp",
      "sensor.a.b", "Sensor.Temp", "sensor.temp/../../admin", "sensor.temp?x=1", "sensor.temp#frag",
      "sensor.temp\n", "sensor .temp"]
    let output = h.call(%*{"probe": "isHaEntityId", "values": values})
    check output == %*[true, true, false, false, false, false, false, false, false, false, false, false, false]

  test "a malformed entity id never reaches the network":
    let h = newHarness(%*{"homeAssistant": {"url": "http://127.0.0.1:9", "accessToken": "token"}})
    let output = h.call(%*{"entityId": "../../api/config"})
    check output.hasKey("error")
    check "Invalid Home Assistant entity id \"../../api/config\": expected <domain>.<object_id> using only a-z, 0-9 and _." ==
      output["error"].getStr()
    check h.errorLogged("Invalid Home Assistant entity id")
    check requests.len == 0

    let missing = h.call(%*{})
    check missing["error"].getStr().startsWith("Invalid Home Assistant entity id \"\"")
    check requests.len == 0

  test "error helper returns shaped payload":
    let h = newHarness(goodSettings, probe = true)
    check h.call(%*{"probe": "errorReply", "message": "boom"}) == %*{"error": "boom"}
    check h.errorLogged("boom")

  test "the state URL drops one trailing slash and the id is URL-encoded":
    let h = newHarness(goodSettings, probe = true)
    check h.call(%*{"probe": "haStateUrl", "haUrl": "http://ha.local:8123/", "entityId": "sensor.x"}).getStr() ==
      "http://ha.local:8123/api/states/sensor.x"
    check h.call(%*{"probe": "haStateUrl", "haUrl": "http://ha.local:8123", "entityId": "sensor.x"}).getStr() ==
      "http://ha.local:8123/api/states/sensor.x"
    # Only one slash, like Nim's removeSuffix("/").
    check h.call(%*{"probe": "haStateUrl", "haUrl": "https://ha.example//", "entityId": "sensor.x"}).getStr() ==
      "https://ha.example//api/states/sensor.x"

  test "a good reply is the entity's state, fetched with the token":
    let h = newHarness(goodSettings)
    let output = h.call(%*{"entityId": "  sensor.outdoor_temp ", "debug": false})
    check output["state"].getStr() == "21.5"
    check output["attributes"]["unit_of_measurement"].getStr() == "°C"
    check requests.len == 1
    check requests[0].url == "http://ha.local:8123/api/states/sensor.outdoor_temp"
    check requests[0].httpMethod == "GET"
    check requests[0].header("Authorization") == "Bearer token"
    check requests[0].header("Accept") == "application/json"
    check requests[0].header("Accept-Encoding") == "identity"
    check not h.logged("Fetching Home Assistant status")

  test "debug logs the URL and the reply":
    let h = newHarness(goodSettings)
    discard h.call(%*{"entityId": "sensor.outdoor_temp", "debug": true})
    check h.logged("Fetching Home Assistant status from http://ha.local:8123/api/states/sensor.outdoor_temp")
    check h.logged("\"state\":\"21.5\"")

  test "recent cached response avoids a new fetch":
    let h = newHarness(goodSettings, probe = true)
    let first = h.call(%*{"entityId": "sensor.outdoor_temp"})
    check first["state"].getStr() == "21.5"
    check requests.len == 1

    replyBody = """{"state": "changed on the server"}"""
    let output = h.call(%*{"entityId": "sensor.outdoor_temp"})
    check requests.len == 1
    # The reply is a copy: changing it must not change what is reused.
    output["state"] = %"changed"
    check h.call(%*{"entityId": "sensor.outdoor_temp"})["state"].getStr() == "21.5"
    check requests.len == 1

    # Older than a second: asked again.
    let fresh = h.call(%*{"probe": "age", "entityId": "sensor.outdoor_temp"})
    check fresh["state"].getStr() == "changed on the server"
    check requests.len == 2

  test "the reuse applies before the entity id is checked, like the Nim app":
    let h = newHarness(goodSettings)
    discard h.call(%*{"entityId": "sensor.outdoor_temp"})
    check h.call(%*{"entityId": "not an id"})["state"].getStr() == "21.5"
    check requests.len == 1

  test "an HTTP error is an {error} reply with the status and body, and is not reused":
    let h = newHarness(goodSettings)
    replyCode = 401
    replyBody = "401: Unauthorized"
    let output = h.call(%*{"entityId": "sensor.outdoor_temp"})
    check output == %*{"error": "Error fetching Home Assistant status: HTTP 401: 401: Unauthorized"}
    check h.errorLogged("Error fetching Home Assistant status: HTTP 401")

    replyCode = 404
    replyBody = """{"message": "Entity not found."}"""
    check h.call(%*{"entityId": "sensor.outdoor_temp"}) ==
      %*{"error": "Error fetching Home Assistant status: HTTP 404: {\"message\": \"Entity not found.\"}"}
    check requests.len == 2

  test "a transport failure is an {error} reply naming it":
    let h = newHarness(goodSettings)
    transportError = "Could not resolve ha.local"
    let output = h.call(%*{"entityId": "sensor.outdoor_temp"})
    check output == %*{"error": "Error fetching Home Assistant status: Could not resolve ha.local"}

  test "a reply that is not JSON is an {error} reply":
    let h = newHarness(goodSettings)
    replyBody = "<html>login</html>"
    let output = h.call(%*{"entityId": "sensor.outdoor_temp"})
    check output["error"].getStr().startsWith("Error fetching Home Assistant status: ")
    check output.len == 1
    # Nothing was kept: the next call asks again.
    replyBody = """{"state": "on"}"""
    check h.call(%*{"entityId": "sensor.outdoor_temp"})["state"].getStr() == "on"
    check requests.len == 2
