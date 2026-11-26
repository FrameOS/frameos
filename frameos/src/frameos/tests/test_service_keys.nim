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

suite "service keys fixtures":
  test "runtime":
    for c in fixtures["runtime"]:
      let value = settingValue(c{"settings"}, c{"serviceKeys"}, c{"typedKeys"}, c["scene"].getStr(),
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
      var headers: seq[tuple[name, value: string]]
      for name, value in c["headers"].pairs:
        headers.add((name, value.getStr()))
      let got = fillKeys(c{"settings"}, c{"serviceKeys"}, c{"typedKeys"}, c["scene"].getStr(),
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
