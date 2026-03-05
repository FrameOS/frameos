import std/[json, unittest]

import ../app

suite "data/xmlToJson app":
  test "converts element tree to json document":
    let app = App(appConfig: AppConfig(xml: "<root id='1'><child>Hello</child></root>"))
    let payload = app.get(nil)

    check payload["type"].getStr() == "document"
    check payload["root"]["type"].getStr() == "element"
    check payload["root"]["name"].getStr() == "root"
    check payload["root"]["attributes"]["id"].getStr() == "1"
    check payload["root"]["children"][0]["name"].getStr() == "child"
    check payload["root"]["children"][0]["children"][0]["text"].getStr() == "Hello"

  test "invalid xml raises a value error":
    let app = App(appConfig: AppConfig(xml: "<root>"))
    expect(ValueError):
      discard app.get(nil)
