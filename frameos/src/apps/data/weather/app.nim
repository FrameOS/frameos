import std/json
import std/strformat
import std/strutils
import std/times
import std/uri
import frameos/apps
import frameos/types
import frameos/utils/http_client

type
  AppConfig* = object
    location*: string
    date*: string
    forecastDays*: int
    temperatureUnit*: string
    windSpeedUnit*: string
    precipitationUnit*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc fetchJson(self: App, url: string): JsonNode =
  parseJson(boundedGetContent(url, maxBytes = self.maxHttpResponseBytes()))

proc buildError(location: string, message: string): JsonNode =
  %*{
    "location": location,
    "error": message
  }

proc forecastUrl*(appConfig: AppConfig, latitude, longitude: float, timezone, requestedDate: string): string =
  ## The unit and date fields are selects in the editor but free strings in
  ## a scene's JSON, so every value is encoded like the location is.
  var params = @[
    "latitude=" & $latitude,
    "longitude=" & $longitude,
    "current_weather=true",
    "hourly=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m",
    "daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,sunrise,sunset,windspeed_10m_max",
    "timezone=" & encodeUrl(timezone),
    "temperature_unit=" & encodeUrl(appConfig.temperatureUnit),
    "windspeed_unit=" & encodeUrl(appConfig.windSpeedUnit),
    "precipitation_unit=" & encodeUrl(appConfig.precipitationUnit)
  ]

  if appConfig.date.len > 0:
    params.add("start_date=" & encodeUrl(requestedDate))
    params.add("end_date=" & encodeUrl(requestedDate))
  else:
    params.add("forecast_days=" & $max(1, min(16, appConfig.forecastDays)))

  "https://api.open-meteo.com/v1/forecast?" & params.join("&")

proc get*(self: App, context: ExecutionContext): JsonNode =
  if self.appConfig.location.len == 0:
    return buildError("", "Location is required.")

  let requestedDate = if self.appConfig.date.len > 0:
    self.appConfig.date
  else:
    now().format("yyyy-MM-dd")

  let encodedLocation = encodeUrl(self.appConfig.location)
  let geocodeUrl = fmt"https://geocoding-api.open-meteo.com/v1/search?name={encodedLocation}&count=1&language=en&format=json"

  try:
    let geocodeJson = self.fetchJson(geocodeUrl)
    if not geocodeJson.hasKey("results") or geocodeJson["results"].len == 0:
      return buildError(self.appConfig.location, "No matching locations found.")

    let resultNode = geocodeJson["results"][0]
    let latitude = resultNode["latitude"].getFloat
    let longitude = resultNode["longitude"].getFloat
    let defaultTimezone = if resultNode.hasKey("timezone"):
      resultNode["timezone"].getStr
    else:
      "auto"
    let timezone = if self.frameConfig.timeZone.len > 0:
      self.frameConfig.timeZone
    else:
      defaultTimezone

    let forecastJson = self.fetchJson(forecastUrl(self.appConfig, latitude, longitude, timezone, requestedDate))

    var locationNode = %*{
      "name": resultNode["name"].getStr,
      "latitude": latitude,
      "longitude": longitude,
      "timezone": timezone
    }

    if resultNode.hasKey("country"):
      locationNode["country"] = %*resultNode["country"].getStr
    if resultNode.hasKey("country_code"):
      locationNode["countryCode"] = %*resultNode["country_code"].getStr
    if resultNode.hasKey("admin1"):
      locationNode["admin1"] = %*resultNode["admin1"].getStr
    if resultNode.hasKey("admin2"):
      locationNode["admin2"] = %*resultNode["admin2"].getStr

    return %*{
      "provider": "open-meteo",
      "forecastModes": ["current", "hourly", "daily"],
      "date": requestedDate,
      "location": locationNode,
      "forecast": forecastJson
    }
  except CatchableError as err:
    return buildError(self.appConfig.location, err.msg)
