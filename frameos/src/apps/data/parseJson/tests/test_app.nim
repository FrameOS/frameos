import std/[json, unittest]

import ../app

suite "data/parseJson app":
  test "parses valid json payload":
    let app = App(appConfig: AppConfig(text: "{\"name\":\"frame\",\"count\":2}"))
    let parsed = app.get(nil)
    check parsed["name"].getStr() == "frame"
    check parsed["count"].getInt() == 2

  test "invalid json raises a value error":
    let app = App(appConfig: AppConfig(text: "{invalid"))
    expect(ValueError):
      discard app.get(nil)
