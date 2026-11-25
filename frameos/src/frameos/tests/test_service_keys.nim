# The Nim runner of docs/service-keys-fixtures.json (`runtime`, `inject`):
# which key an app's getSetting answers with on the frame, and what
# frameos.secret's placeholders become on the way out (docs/service-keys.md).

import std/[json, os, unittest]

import ../service_keys

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "service-keys-fixtures.json"
let fixtures = parseFile(fixturesPath)

proc strings(node: JsonNode): seq[string] =
  if not node.isNil and node.kind == JArray:
    for item in node.elems:
      result.add item.getStr()

var storedLocalKeys {.threadvar.}: string

proc useLocalKeys(node: JsonNode) =
  storedLocalKeys = if node.isNil: "" else: $node
  localKeysLoadHook = proc (): string {.nimcall, gcsafe.} =
    {.cast(gcsafe).}: storedLocalKeys
  localKeysSaveHook = proc (text: string): bool {.nimcall, gcsafe.} =
    {.cast(gcsafe).}: storedLocalKeys = text
    true
  forgetLocalKeysCache()

suite "service keys fixtures":
  test "runtime":
    for c in fixtures["runtime"]:
      useLocalKeys(c{"localKeys"})
      let value = settingValue(c{"settings"}, c{"serviceKeys"}, localKeys(), c["scene"].getStr(),
        strings(c["declared"]), strings(c["path"]))
      let expected = c{"value"}
      if expected.isNil:
        check value.isNil
        if not value.isNil: checkpoint c["name"].getStr() & ": " & $value
      else:
        check value == expected
        if value != expected: checkpoint c["name"].getStr() & ": " & $value

  test "inject":
    for c in fixtures["inject"]:
      useLocalKeys(c{"localKeys"})
      var headers: seq[tuple[name, value: string]]
      for name, value in c["headers"].pairs:
        headers.add((name, value.getStr()))
      let got = fillKeys(c{"settings"}, c{"serviceKeys"}, localKeys(), c["scene"].getStr(),
        strings(c["declared"]), c["url"].getStr(), headers)
      if c.hasKey("refused"):
        check got.refused == c["refused"].getStr()
        if got.refused != c["refused"].getStr(): checkpoint c["name"].getStr() & ": " & got.refused
      else:
        check got.refused == ""
        check got.url == c["expect"]["url"].getStr()
        var gotHeaders = newJObject()
        for header in got.headers:
          gotHeaders[header.name] = %header.value
        check gotHeaders == c["expect"]["headers"]
        if got.refused != "" or got.url != c["expect"]["url"].getStr():
          checkpoint c["name"].getStr() & ": " & got.refused & " " & got.url

suite "service ids":
  test "the corpus's ids":
    for c in fixtures["serviceId"]:
      check isServiceId(c["id"].getStr()) == c["isService"].getBool()

suite "keys typed on the frame":
  test "kept per scene and field, forgotten whole":
    useLocalKeys(nil)
    check setLocalKey("art", "openAI", "apiKey", "sk-typed")
    check localKeys() == %*{"art": {"openAI": {"apiKey": "sk-typed"}}}
    check setLocalKey("art", "homeAssistant", "url", "http://ha")
    check setLocalKey("art", "openAI", "apiKey", "")
    check localKeys() == %*{"art": {"homeAssistant": {"url": "http://ha"}}}
    check setLocalKey("art", "homeAssistant", "", "")
    check localKeys() == %*{}
    check storedLocalKeys == "{}"

  test "refuses what is no service, and more than fits":
    useLocalKeys(nil)
    check not setLocalKey("art", "defaults", "wifiPassword", "x")
    check not setLocalKey("art", "openAI", "bad-name", "x")
    var big = ""
    for i in 0 ..< LocalKeysMaxBytes: big.add 'x'
    check not setLocalKey("art", "openAI", "apiKey", big)
    check localKeys() == %*{}

  test "junk in the store is no key":
    useLocalKeys(%*{"art": {"openAI": {"apiKey": "k", "n": 3}}, "x": 1})
    check serviceGroup(nil, nil, localKeys(), "art", "openAI") == %*{"apiKey": "k"}
    check serviceGroup(nil, nil, localKeys(), "x", "openAI").isNil
    useLocalKeys(%*["not", "an", "object"])
    check localKeys() == %*{}

  test "the Keys page never shows a whole secret":
    useLocalKeys(%*{"art": {"openAI": {"apiKey": "sk-typed-123456"}}})
    let serviceKeys = %*{
      "scenes": {"art": {"openAI": "openAI", "homeAssistant": "homeAssistant"}},
      "keys": {"homeAssistant": {"service": "homeAssistant", "values": {"url": "http://ha.local:8123", "accessToken": "short"}}},
      "services": {
        "openAI": {"title": "OpenAI", "fields": [{"name": "apiKey", "label": "API key"}]},
        "homeAssistant": {"title": "Home Assistant", "fields": [
          {"name": "url", "label": "URL", "secret": false}, {"name": "accessToken", "label": "Access token"}]},
      },
    }
    let rows = keyRows(nil, serviceKeys, "art", ["openAI", "homeAssistant", "acme"])
    check rows.len == 3
    check rows[0]["title"].getStr() == "OpenAI"
    check rows[0]["typed"].getBool()
    check rows[0]["fields"][0]["value"].getStr() == "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa23456"
    check rows[1]["fields"][0]["value"].getStr() == "http://ha.local:8123"
    check rows[1]["fields"][1]["value"].getStr() == "\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2\xe2\x80\xa2"
    check rows[2]["title"].getStr() == "acme"
    check rows[2]["fields"][0]["name"].getStr() == "apiKey"
    check rows[2]["fields"][0]["value"].getStr() == ""
