import httpclient
import std/json
import std/strformat
import std/strutils
import std/times
import std/uri
import frameos/types

type
  AppConfig* = object
    location*: string
    date*: string
    timezone*: string
    temperatureUnit*: string
    windSpeedUnit*: string
    precipitationUnit*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc fetchJson(client: HttpClient, url: string): JsonNode =
  parseJson(client.getContent(url))

proc buildError(location: string, message: string): JsonNode =
  %*{
    "location": location,
    "error": message
  }

proc get*(self: App, context: ExecutionContext): JsonNode =
  if self.appConfig.location.len == 0:
    return buildError("", "Location is required.")

  let requestedDate = if self.appConfig.date.len > 0:
    self.appConfig.date
  else:
    now().format("yyyy-MM-dd")

  let encodedLocation = encodeUrl(self.appConfig.location)
  let geocodeUrl = fmt"https://geocoding-api.open-meteo.com/v1/search?name={encodedLocation}&count=1&language=en&format=json"
  let client = newHttpClient(timeout = 30000)

  try:
    let geocodeJson = fetchJson(client, geocodeUrl)
    if not geocodeJson.hasKey("results") or geocodeJson["results"].len == 0:
      return buildError(self.appConfig.location, "No matching locations found.")

    let resultNode = geocodeJson["results"][0]
    let latitude = resultNode["latitude"].getFloat
    let longitude = resultNode["longitude"].getFloat
    let defaultTimezone = if resultNode.hasKey("timezone"):
      resultNode["timezone"].getStr
    else:
      "auto"
    let timezone = if self.appConfig.timezone.len > 0:
      self.appConfig.timezone
    else:
      defaultTimezone

    var params = @[
      "latitude=" & $latitude,
      "longitude=" & $longitude,
      "current_weather=true",
      "hourly=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m",
      "daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,sunrise,sunset,windspeed_10m_max",
      "timezone=" & encodeUrl(timezone),
      "temperature_unit=" & self.appConfig.temperatureUnit,
      "windspeed_unit=" & self.appConfig.windSpeedUnit,
      "precipitation_unit=" & self.appConfig.precipitationUnit
    ]

    if self.appConfig.date.len > 0:
      params.add("start_date=" & requestedDate)
      params.add("end_date=" & requestedDate)
    else:
      params.add("forecast_days=1")

    let forecastUrl = "https://api.open-meteo.com/v1/forecast?" & params.join("&")
    let forecastJson = fetchJson(client, forecastUrl)

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
  finally:
    client.close()
