## The Weather (Open-Meteo) code app (repo/apps/code/weather) run for real
## through the JS app runtime. Every `frameos.httpRequest` is answered by
## `jsHttpRequestHook`, so this pins the geocoding and forecast URLs, the
## output object and the `{location, error}` replies, without Open-Meteo.

import std/[json, os, strutils, times, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/utils/http_client
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "code" / "weather"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

## Runs the app's exported URL builder.
const probeSource = """
import { forecastUrl } from './app'
export function get(app) {
  const c = app.config
  return forecastUrl(c.config, c.latitude, c.longitude, c.timezone, c.requestedDate)
}
"""

const GeocodeUrl = "https://geocoding-api.open-meteo.com/v1/search?"
const ForecastUrl = "https://api.open-meteo.com/v1/forecast?"
const BrusselsResult = """{"results": [{"id": 2800866, "name": "Brussels", "latitude": 50.85045, "longitude": 4.34878,
  "timezone": "Europe/Brussels", "country": "Belgium", "country_code": "BE", "admin1": "Brussels Capital",
  "admin2": "Bruxelles-Capitale", "population": 1019022}], "generationtime_ms": 0.5}"""
const ForecastReply = """{"latitude": 50.854, "longitude": 4.35, "timezone": "Europe/Brussels",
  "utc_offset_seconds": 3600, "current_weather": {"time": "2026-01-18T22:15", "temperature": 5.7},
  "daily": {"time": ["2026-01-18"], "temperature_2m_max": [11.3]}}"""

var requests: seq[string] = @[]
var geocodeReply: tuple[code: int, body: string]
var forecastReply: tuple[code: int, body: string]
var transportError = ""

jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  requests.add(url)
  if transportError.len > 0:
    raise newException(IOError, transportError)
  if url.startsWith(GeocodeUrl):
    return geocodeReply
  if url.startsWith(ForecastUrl):
    return forecastReply
  (404, "")

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime
  logs: ref seq[JsonNode]

proc newHarness(timeZone = "", probe = false): Harness =
  requests = @[]
  geocodeReply = (200, BrusselsResult)
  forecastReply = (200, ForecastReply)
  transportError = ""
  var logs = new(seq[JsonNode])
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: %*{}, timeZone: timeZone)
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/weather-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 7.NodeId, nodeName: "weather", appKeyword: "weather", scene: scene,
    frameConfig: config)
  let sources = %*{"app.ts": appSource, "config.json": appConfigJson, "probe.ts": probeSource}
  let runtime = newJsAppRuntime(category = "data", outputType = (if probe: "string" else: "json"),
    source = (if probe: probeSource else: appSource), settingsKeys = @[],
    sourceName = (if probe: "probe.ts" else: "app.ts"), sources = sources)
  Harness(scene: scene, owner: owner, runtime: runtime, logs: logs)

proc call(h: Harness, config: JsonNode): Value =
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  h.runtime.get(h.owner, config, context)

proc weather(h: Harness, config: JsonNode): JsonNode =
  let value = h.call(config)
  check value.kind == fkJson
  value.asJson()

proc url(h: Harness, config: JsonNode): string =
  let value = h.call(config)
  check value.kind == fkString
  value.asString()

proc defaults(location: string, extra: JsonNode = %*{}): JsonNode =
  ## The node config the editor writes: every field at its config.json value.
  result = %*{"location": location, "date": "", "forecastDays": 1, "temperatureUnit": "celsius",
    "windSpeedUnit": "kmh", "precipitationUnit": "mm"}
  for key, value in extra.pairs:
    result[key] = value

suite "Weather (Open-Meteo) code app":
  test "forecastUrl encodes every scene-supplied value":
    let h = newHarness(probe = true)
    let url = h.url(%*{"config": {"temperatureUnit": "fahrenheit&x=1", "windSpeedUnit": "mp h",
      "precipitationUnit": "inch#frag", "date": "2026-09-11&y=2", "forecastDays": 1},
      "latitude": 52.5, "longitude": 13.4, "timezone": "Europe/Berlin", "requestedDate": "2026-09-11&y=2"})
    check "temperature_unit=fahrenheit%26x%3D1&" in url
    check "windspeed_unit=mp+h&" in url
    check "precipitation_unit=inch%23frag" in url
    check "start_date=2026-09-11%26y%3D2&end_date=2026-09-11%26y%3D2" in url
    check "timezone=Europe%2FBerlin" in url
    check "#" notin url
    check " " notin url
    validateHttpRequestUrl(url)

  test "forecastUrl without a date asks for a clamped day count":
    let h = newHarness(probe = true)
    proc days(h: Harness, forecastDays: int): string =
      h.url(%*{"config": {"temperatureUnit": "celsius", "windSpeedUnit": "kmh", "precipitationUnit": "mm",
        "date": "", "forecastDays": forecastDays}, "latitude": 1.0, "longitude": 2.0, "timezone": "auto",
        "requestedDate": "2026-09-11"})
    let url = h.days(40)
    check url.endsWith("forecast_days=16")
    check "start_date" notin url
    check h.days(0).endsWith("forecast_days=1")
    check h.days(-3).endsWith("forecast_days=1")
    check h.days(7).endsWith("forecast_days=7")

  test "forecastUrl is the Nim app's, byte for byte":
    let h = newHarness(probe = true)
    let url = h.url(%*{"config": {"temperatureUnit": "celsius", "windSpeedUnit": "kmh", "precipitationUnit": "mm",
      "date": "", "forecastDays": 3}, "latitude": 52.0, "longitude": -0.5, "timezone": "America/New_York",
      "requestedDate": "2026-09-11"})
    check url == "https://api.open-meteo.com/v1/forecast?latitude=52.0&longitude=-0.5&current_weather=true" &
      "&hourly=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m" &
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,sunrise,sunset,windspeed_10m_max" &
      "&timezone=America%2FNew_York&temperature_unit=celsius&windspeed_unit=kmh&precipitation_unit=mm&forecast_days=3"

  test "missing location returns deterministic validation error":
    let h = newHarness()
    let payload = h.weather(defaults(""))
    check payload == %*{"location": "", "error": "Location is required."}
    check requests.len == 0
    # No location key at all is the same.
    check h.weather(%*{})["error"].getStr() == "Location is required."

  test "geocodes, then fetches the forecast in the frame's time zone":
    let h = newHarness(timeZone = "Europe/Amsterdam")
    let payload = h.weather(defaults("Brussels, Belgium", %*{"forecastDays": 2}))
    check requests.len == 2
    check requests[0] == "https://geocoding-api.open-meteo.com/v1/search?name=Brussels%2C+Belgium&count=1&language=en&format=json"
    check requests[1].startsWith("https://api.open-meteo.com/v1/forecast?latitude=50.85045&longitude=4.34878&current_weather=true&")
    check "&timezone=Europe%2FAmsterdam&" in requests[1]
    check requests[1].endsWith("&forecast_days=2")

    check payload["provider"].getStr() == "open-meteo"
    check payload["forecastModes"] == %*["current", "hourly", "daily"]
    check payload["date"].getStr() == now().format("yyyy-MM-dd")
    check payload["location"] == %*{"name": "Brussels", "latitude": 50.85045, "longitude": 4.34878,
      "timezone": "Europe/Amsterdam", "country": "Belgium", "countryCode": "BE", "admin1": "Brussels Capital",
      "admin2": "Bruxelles-Capitale"}
    check payload["forecast"] == parseJson(ForecastReply)
    var keys: seq[string] = @[]
    for key in payload.keys:
      keys.add(key)
    check keys == @["provider", "forecastModes", "date", "location", "forecast"]

  test "the location is encoded like Nim's encodeUrl (sub-delims too, a space is +)":
    let h = newHarness()
    discard h.weather(defaults("a!b'c(d)e*f~g é"))
    check requests[0] == GeocodeUrl & "name=a%21b%27c%28d%29e%2Af~g+%C3%A9&count=1&language=en&format=json"

  test "without a frame time zone the geocoded one is used, else auto":
    let h = newHarness()
    let payload = h.weather(defaults("Brussels"))
    check "&timezone=Europe%2FBrussels&" in requests[1]
    check payload["location"]["timezone"].getStr() == "Europe/Brussels"

    let bare = newHarness()
    geocodeReply = (200, """{"results": [{"name": "Null Island", "latitude": 0, "longitude": 0}]}""")
    let island = bare.weather(defaults("Null Island"))
    check "latitude=0.0&longitude=0.0&" in requests[1]
    check "&timezone=auto&" in requests[1]
    check island["location"] == %*{"name": "Null Island", "latitude": 0, "longitude": 0, "timezone": "auto"}

  test "a date asks for that one day and is the output's date":
    let h = newHarness(timeZone = "Europe/Brussels")
    let payload = h.weather(defaults("Brussels", %*{"date": "2026-01-30", "forecastDays": 9}))
    check requests[1].endsWith("&start_date=2026-01-30&end_date=2026-01-30")
    check "forecast_days" notin requests[1]
    check payload["date"].getStr() == "2026-01-30"

  test "units go into the forecast URL":
    let h = newHarness()
    discard h.weather(defaults("Brussels", %*{"temperatureUnit": "fahrenheit", "windSpeedUnit": "mph",
      "precipitationUnit": "inch"}))
    check "&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&" in requests[1]

  test "no geocoding match is a {location, error} reply":
    let h = newHarness()
    geocodeReply = (200, """{"generationtime_ms": 0.3}""")
    check h.weather(defaults("Atlantis")) == %*{"location": "Atlantis", "error": "No matching locations found."}
    check requests.len == 1

    let empty = newHarness()
    geocodeReply = (200, """{"results": []}""")
    check empty.weather(defaults("Atlantis"))["error"].getStr() == "No matching locations found."

  test "HTTP errors, transport failures and bad replies are {location, error} replies":
    let geocodeDown = newHarness()
    geocodeReply = (500, "upstream down")
    check geocodeDown.weather(defaults("Brussels")) == %*{"location": "Brussels", "error": "HTTP 500: upstream down"}

    let forecastDown = newHarness()
    forecastReply = (400, """{"error": true, "reason": "Invalid timezone"}""")
    check forecastDown.weather(defaults("Brussels")) ==
      %*{"location": "Brussels", "error": "HTTP 400: {\"error\": true, \"reason\": \"Invalid timezone\"}"}

    let noBody = newHarness()
    forecastReply = (503, "")
    check noBody.weather(defaults("Brussels"))["error"].getStr() == "HTTP 503"

    let offline = newHarness()
    transportError = "Could not resolve geocoding-api.open-meteo.com"
    check offline.weather(defaults("Brussels")) ==
      %*{"location": "Brussels", "error": "Could not resolve geocoding-api.open-meteo.com"}

    let garbage = newHarness()
    forecastReply = (200, "<html>")
    let payload = garbage.weather(defaults("Brussels"))
    check payload["location"].getStr() == "Brussels"
    check payload["error"].getStr().len > 0
    check payload.len == 2

    let noCoordinates = newHarness()
    geocodeReply = (200, """{"results": [{"name": "Somewhere"}]}""")
    check noCoordinates.weather(defaults("Somewhere")) == %*{"location": "Somewhere", "error": "key not found: latitude"}
    check requests.len == 1
