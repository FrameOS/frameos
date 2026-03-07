import std/[json, unittest]

import ../app
import frameos/types

suite "data/weather app":
  test "missing location returns deterministic validation error":
    let app = App(
      appConfig: AppConfig(location: "", temperatureUnit: "celsius", windSpeedUnit: "kmh", precipitationUnit: "mm")
    )

    let payload = app.get(ExecutionContext())

    check payload["location"].getStr() == ""
    check payload["error"].getStr() == "Location is required."
