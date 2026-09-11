import std/[json, strutils, unittest]

import ../app
import frameos/types

suite "data/weather app":
  test "forecastUrl encodes every scene-supplied value":
    let config = AppConfig(temperatureUnit: "fahrenheit&x=1", windSpeedUnit: "mp h",
      precipitationUnit: "inch#frag", date: "2026-09-11&y=2")
    let url = forecastUrl(config, 52.5, 13.4, "Europe/Berlin", "2026-09-11&y=2")
    check "temperature_unit=fahrenheit%26x%3D1&" in url
    check "windspeed_unit=mp+h&" in url
    check "precipitation_unit=inch%23frag" in url
    check "start_date=2026-09-11%26y%3D2&end_date=2026-09-11%26y%3D2" in url
    check "timezone=Europe%2FBerlin" in url
    check "#" notin url
    check " " notin url

  test "forecastUrl without a date asks for a clamped day count":
    let config = AppConfig(temperatureUnit: "celsius", windSpeedUnit: "kmh", precipitationUnit: "mm",
      forecastDays: 40)
    let url = forecastUrl(config, 1.0, 2.0, "auto", "2026-09-11")
    check url.endsWith("forecast_days=16")
    check "start_date" notin url

  test "missing location returns deterministic validation error":
    let app = App(
      appConfig: AppConfig(location: "", temperatureUnit: "celsius", windSpeedUnit: "kmh", precipitationUnit: "mm")
    )

    let payload = app.get(ExecutionContext())

    check payload["location"].getStr() == ""
    check payload["error"].getStr() == "Location is required."
