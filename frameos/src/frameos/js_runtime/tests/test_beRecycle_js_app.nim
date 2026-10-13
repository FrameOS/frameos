## The Recycling Calendar for Belgium code app (repo/apps/code/beRecycle) run
## for real through the JS app runtime. Every `frameos.httpRequest` is answered
## by `jsHttpRequestHook` (it stands in for the Nim app's
## beRecycleAuthenticateHook / beRecycleFetchCollectionsHook), so this pins the
## three API calls, their headers, the matching rules, the date range, the
## events and the failures, without api.fostplus.be.

import std/[json, os, strutils, times, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "code" / "beRecycle"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

## Runs the app's exported helpers.
const probeSource = """
import { collectionsToEvents, zipcodesUrl, streetsUrl, collectionsUrl, normalizeDay } from './app'
export function get(app) {
  const c = app.config
  if (c.probe === 'events') return collectionsToEvents(c.collections, c.language, c.timezone)
  if (c.probe === 'urls') {
    return {
      streets: streetsUrl('Rue de la Loi', 'zip-1'),
      accented: streetsUrl('Sint-Jorisstraat & Co/é', 'z&1'),
      subDelims: streetsUrl("Rue d'Arlon (x)!*", 'z'),
      zipcodes: zipcodesUrl(1000),
      collections: collectionsUrl('zip 1', 'street/2', 12, '2026-01-05', '2026-01-07'),
    }
  }
  if (c.probe === 'normalizeDay') return c.values.map((value) => normalizeDay(value, 'exportFrom'))
  return null
}
"""

const Api = "https://api.fostplus.be/recyclecms/public/v1"
const ZipcodesReply = """{"items": [{"id": "1020-24131", "code": "1020", "names": [{"nl": "Laken"}]},
  {"id": "1000-24129", "code": "1000", "names": [{"nl": "Brussel"}]}], "total": 2, "pages": 1, "page": 1}"""
const StreetsReply = """{"items": [{"id": "street-main-st", "name": "Main street"}, {"id": "street-main", "name": "Main"}],
  "total": 2}"""
const CollectionsReply = """{"items": [
  {"timestamp": "2026-01-06T00:00:00.000Z", "fraction": {"name": {"en": "Paper", "fr": "Papier", "nl": "Papier-karton"},
    "logo": {"regular": {"1x": "https://example/logo.png"}}, "color": "#ffd700"}},
  {"timestamp": "2026-01-07T00:00:00.000Z", "fraction": {"name": {"en": "PMD", "fr": "PMC", "nl": "PMD"}}}],
  "total": 2, "pages": 1, "page": 1, "size": 100}"""

type Recorded = object
  url: string
  httpMethod: string
  headers: seq[SimpleHttpHeader]

var requests: seq[Recorded] = @[]
var zipcodesReply: tuple[code: int, body: string]
var streetsReply: tuple[code: int, body: string]
var collectionsReply: tuple[code: int, body: string]
var transportError = ""

jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  requests.add(Recorded(url: url, httpMethod: httpMethod, headers: headers))
  if transportError.len > 0:
    raise newException(IOError, transportError)
  if url.startsWith(Api & "/zipcodes?"):
    return zipcodesReply
  if url.startsWith(Api & "/streets?"):
    return streetsReply
  if url.startsWith(Api & "/collections?"):
    return collectionsReply
  (404, "")

proc header(request: Recorded, name: string): string =
  for (headerName, value) in request.headers:
    if headerName.toLowerAscii() == name.toLowerAscii():
      return value
  ""

proc query(url, name: string): string =
  for part in url.split('?', maxsplit = 1)[^1].split('&'):
    if part.startsWith(name & "="):
      return part[name.len + 1 .. ^1]
  ""

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(timeZone = "UTC", probe = false): Harness =
  requests = @[]
  zipcodesReply = (200, ZipcodesReply)
  streetsReply = (200, StreetsReply)
  collectionsReply = (200, CollectionsReply)
  transportError = ""
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: %*{}, timeZone: timeZone)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/be-recycle-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 30.NodeId, nodeName: "beRecycle", appKeyword: "beRecycle", scene: scene,
    frameConfig: config)
  let sources = %*{"app.ts": appSource, "config.json": appConfigJson, "probe.ts": probeSource}
  let runtime = newJsAppRuntime(category = "data", outputType = "json",
    source = (if probe: probeSource else: appSource), settingsKeys = @[],
    sourceName = (if probe: "probe.ts" else: "app.ts"), sources = sources)
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc call(h: Harness, config: JsonNode): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, config, context)

proc events(h: Harness, config: JsonNode): JsonNode =
  let value = h.call(config)
  check value.kind == fkJson
  value.asJson()

proc address(extra: JsonNode = %*{}): JsonNode =
  ## The node config the editor writes: every field at its config.json value.
  result = %*{"streetName": "Main", "number": 1, "postalCode": 1000, "exportFrom": "", "exportUntil": "",
    "exportCount": 50, "language": "en"}
  for key, value in extra.pairs:
    result[key] = value

proc logMessages(h: Harness): seq[string] =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("log:"):
      result.add(entry{"message"}.getStr())

proc errorLogged(h: Harness, needle: string): bool =
  for entry in h.logs[]:
    if entry{"event"}.getStr().startsWith("error:") and entry{"error"}.getStr().contains(needle):
      return true
  false

proc checkThrew(h: Harness, config: JsonNode, message: string) =
  ## A failure is thrown, as the Nim app raised: the runtime logs "JS app get
  ## failed: <message>" and raises it, so the interpreter's producer-failure
  ## handling (defaulted code args, no cache entry) applies.
  var raised = ""
  try:
    discard h.call(config)
  except JsAppError as e:
    raised = e.msg
  check raised == message
  check h.errorLogged("JS app get failed: " & message)

suite "Recycling Calendar for Belgium code app":
  test "collectionsToEvents maps payload into event shape":
    let h = newHarness(probe = true)
    let collections = %*{"items": [{"timestamp": "2026-02-10T05:00:00Z", "fraction": {"name": {"en": "PMD"}}}]}
    let events = h.events(%*{"probe": "events", "collections": collections, "language": "en",
      "timezone": "Europe/Brussels"})
    check events.len == 1
    check events[0] == %*{"summary": "Trash: PMD", "startTime": "2026-02-10T08:00:00",
      "endTime": "2026-02-10T08:15:00", "timezone": "Europe/Brussels"}
    var keys: seq[string] = @[]
    for key in events[0].keys:
      keys.add(key)
    check keys == @["summary", "startTime", "endTime", "timezone"]

  test "the summary is in the configured language, empty when the reply lacks it":
    let h = newHarness(probe = true)
    let collections = parseJson(CollectionsReply)
    let nl = h.events(%*{"probe": "events", "collections": collections, "language": "nl", "timezone": "UTC"})
    check nl[0]["summary"].getStr() == "Trash: Papier-karton"
    check nl[1]["summary"].getStr() == "Trash: PMD"
    let fr = h.events(%*{"probe": "events", "collections": collections, "language": "fr", "timezone": "UTC"})
    check fr[0]["summary"].getStr() == "Trash: Papier"
    let de = h.events(%*{"probe": "events", "collections": collections, "language": "de", "timezone": "UTC"})
    check de[0]["summary"].getStr() == "Trash: "
    check h.events(%*{"probe": "events", "collections": {"items": []}, "language": "en", "timezone": "UTC"}) == %*[]

  test "get forwards the configured day range and returns the events":
    let h = newHarness(timeZone = "UTC")
    let output = h.events(address(%*{"exportFrom": "2026-01-05", "exportUntil": "2026-01-07"}))
    check requests.len == 3
    check requests[0].url == Api & "/zipcodes?q=1000"
    check requests[1].url == Api & "/streets?q=Main&zipcodes=1000-24129"
    check requests[2].url == Api & "/collections?zipcodeId=1000-24129&streetId=street-main&houseNumber=1" &
      "&fromDate=2026-01-05&untilDate=2026-01-07&size=100"
    for request in requests:
      check request.httpMethod == "GET"
      check request.header("User-Agent") == "Mozilla/5.0"
      check request.header("x-consumer") == "recycleapp.be"
      validateHttpRequestUrl(request.url)
    check output.len == 2
    check output[0] == %*{"summary": "Trash: Paper", "startTime": "2026-01-06T08:00:00",
      "endTime": "2026-01-06T08:15:00", "timezone": "UTC"}
    check output[1]["summary"].getStr() == "Trash: PMD"
    check h.logMessages() == @["Preparing request headers...", "Fetching collections...", "Fetching address IDs...",
      """{"event":"reply","eventsInRange":2}""", "Converting collections to events..."]

  test "query parameters are percent-encoded so the runtime client accepts them":
    let h = newHarness(probe = true)
    let urls = h.events(%*{"probe": "urls"})
    let streets = urls["streets"].getStr()
    validateHttpRequestUrl(streets)
    check streets.contains("/streets?q=Rue%20de%20la%20Loi&zipcodes=zip-1")
    check not streets.contains(" ")
    check not streets.contains("+")

    let accented = urls["accented"].getStr()
    validateHttpRequestUrl(accented)
    check accented.contains("q=Sint-Jorisstraat%20%26%20Co%2F%C3%A9&zipcodes=z%261")
    # encodeUrl encodes the sub-delims encodeURIComponent leaves alone.
    check urls["subDelims"].getStr().contains("q=Rue%20d%27Arlon%20%28x%29%21%2A&zipcodes=z")

    check urls["zipcodes"].getStr().endsWith("/zipcodes?q=1000")
    let collections = urls["collections"].getStr()
    validateHttpRequestUrl(collections)
    check collections.contains("zipcodeId=zip%201&streetId=street%2F2&houseNumber=12" &
      "&fromDate=2026-01-05&untilDate=2026-01-07&size=100")

  test "a street name with spaces and accents reaches the streets call encoded":
    let h = newHarness()
    streetsReply = (200, """{"items": [{"id": "s-loi", "name": "Rue de la Loi"}]}""")
    discard h.events(address(%*{"streetName": "Rue de la Loi", "exportFrom": "2026-01-05", "exportUntil": "2026-01-07"}))
    check requests[1].url == Api & "/streets?q=Rue%20de%20la%20Loi&zipcodes=1000-24129"
    check query(requests[2].url, "streetId") == "s-loi"

  test "the zip code matches by number and the street by its exact name":
    let h = newHarness()
    zipcodesReply = (200, """{"items": [{"id": "z-x", "code": "01000x"}, {"id": "z-1", "code": "01000"},
      {"id": "z-2", "code": "1000"}]}""")
    streetsReply = (200, """{"items": [{"id": "s-lower", "name": "main"}, {"id": "s-space", "name": "Main "},
      {"id": "s-exact", "name": "Main"}]}""")
    discard h.events(address(%*{"exportFrom": "2026-01-05", "exportUntil": "2026-01-07"}))
    # "01000" is the integer 1000, like Nim's parseInt; the first match wins.
    check query(requests[1].url, "zipcodes") == "z-1"
    check query(requests[2].url, "zipcodeId") == "z-1"
    check query(requests[2].url, "streetId") == "s-exact"

  test "the default range is today until 366 days later, in the frame's zone":
    let utcFrame = newHarness(timeZone = "UTC")
    let before = epochTime()
    let output = utcFrame.events(address())
    check output[0]["timezone"].getStr() == "UTC"
    check query(requests[2].url, "fromDate") == before.fromUnixFloat().utc().format("yyyy-MM-dd")
    check query(requests[2].url, "untilDate") == (before + 366 * 24 * 60 * 60).fromUnixFloat().utc().format("yyyy-MM-dd")

    # No zone at all is UTC, for the range and for the events.
    let noZone = newHarness(timeZone = "")
    let bare = noZone.events(address())
    check bare[0]["timezone"].getStr() == "UTC"
    check query(requests[2].url, "fromDate") == before.fromUnixFloat().utc().format("yyyy-MM-dd")

    # A zone: the runtime's local time (the test process's zone here).
    let brussels = newHarness(timeZone = "Europe/Brussels")
    let local = brussels.events(address())
    check local[0]["timezone"].getStr() == "Europe/Brussels"
    check query(requests[2].url, "fromDate") == before.fromUnixFloat().local().format("yyyy-MM-dd")
    check query(requests[2].url, "untilDate") ==
      (before + 366 * 24 * 60 * 60).fromUnixFloat().local().format("yyyy-MM-dd")

  test "configured days are normalised the way chrono did":
    let h = newHarness(probe = true)
    check h.events(%*{"probe": "normalizeDay", "values": ["2026-01-05", "2026-02-30", "2026-13-01", "2026-00-00",
      "2024-02-29"]}) == %*["2026-01-05", "2026-03-02", "2027-01-01", "2025-11-30", "2024-02-29"]

    let full = newHarness()
    discard full.events(address(%*{"exportFrom": "2026-02-30", "exportUntil": "2026-13-01"}))
    check query(requests[2].url, "fromDate") == "2026-03-02"
    check query(requests[2].url, "untilDate") == "2027-01-01"

  test "a frame west of UTC asks for the configured days (the Nim app asked a day early)":
    let h = newHarness(timeZone = "America/New_York")
    let output = h.events(address(%*{"exportFrom": "2026-01-05", "exportUntil": "2026-01-07"}))
    check query(requests[2].url, "fromDate") == "2026-01-05"
    check query(requests[2].url, "untilDate") == "2026-01-07"
    check output[0]["timezone"].getStr() == "America/New_York"

  test "a malformed day throws before any request":
    for bad in ["2026-1-05", "2026-01-05x", " 2026-01-05", "2026/01/05", "tomorrow"]:
      let h = newHarness()
      h.checkThrew(address(%*{"exportFrom": bad}), "Invalid exportFrom \"" & bad & "\": expected YYYY-MM-DD.")
      check requests.len == 0
    let h = newHarness()
    h.checkThrew(address(%*{"exportUntil": "2026-1-5"}), "Invalid exportUntil \"2026-1-5\": expected YYYY-MM-DD.")

  test "an unknown zip code or street throws":
    let noZip = newHarness()
    zipcodesReply = (200, """{"items": [{"id": "z-9000", "code": "9000"}]}""")
    noZip.checkThrew(address(), "Could not find the right zip code.")
    check requests.len == 1

    let noItems = newHarness()
    zipcodesReply = (200, """{"total": 0}""")
    noItems.checkThrew(address(), "Could not find the right zip code.")

    let noStreet = newHarness()
    streetsReply = (200, """{"items": [{"id": "s-1", "name": "Mainstraat"}]}""")
    noStreet.checkThrew(address(), "Could not find the right street name.")
    check requests.len == 2

  test "collections without items throw":
    let h = newHarness()
    collectionsReply = (200, """{"message": "nope"}""")
    h.checkThrew(address(), "Something went wrong while fetching collections.")
    check requests.len == 3
    check "Converting collections to events..." notin h.logMessages()

  test "HTTP errors and transport failures throw with the status and body":
    let unauthorized = newHarness()
    zipcodesReply = (401, """{"message":"Access denied"}""")
    unauthorized.checkThrew(address(), """HTTP 401: {"message":"Access denied"}""")
    check requests.len == 1

    let collectionsDown = newHarness()
    collectionsReply = (500, "")
    collectionsDown.checkThrew(address(), "HTTP 500: ")

    let offline = newHarness()
    transportError = "Could not resolve api.fostplus.be"
    offline.checkThrew(address(), "Could not resolve api.fostplus.be")

    let garbage = newHarness()
    streetsReply = (200, "<html>")
    expect(JsAppError):
      discard garbage.call(address())
    check garbage.errorLogged("JS app get failed: ")
