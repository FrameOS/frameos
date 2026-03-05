import std/[json, strutils, unittest]

import ../app

suite "data/prettyJson app":
  test "prettify true uses indent":
    let app = App(
      appConfig: AppConfig(
        json: %*{"a": 1, "b": [2, 3]},
        ident: 2,
        prettify: true,
      )
    )
    let output = app.get(nil)
    check output.contains("\n")
    check output.contains("\"a\": 1")

  test "prettify false returns compact json":
    let app = App(
      appConfig: AppConfig(
        json: %*{"a": 1, "b": [2, 3]},
        ident: 2,
        prettify: false,
      )
    )
    check app.get(nil) == "{\"a\":1,\"b\":[2,3]}"
