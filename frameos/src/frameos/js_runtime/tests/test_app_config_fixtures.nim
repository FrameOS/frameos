## The runtime's runner of docs/app-config-fixtures.json: what an app's
## config.json is, and what it asks for (utils/strict_json.nim, read by
## app_runtime.nim). The SPA and the cloud replay the same file
## (shared-spa/app-config-fixtures.test.ts) and so does the backend
## (app/utils/tests/test_app_config.py): a file one of them reads and another
## does not is a permission somebody never saw.

import std/[json, os, strutils, unittest]

import ../app_runtime
import ../../utils/strict_json

const FixturesPath = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "docs" /
  "app-config-fixtures.json"

proc textOf(fixture: JsonNode): string =
  ## `nest`: {"permissions":["frame"],"x":[[…]]} that many containers deep,
  ## the object included.
  if not fixture.hasKey("nest"):
    return fixture["text"].getStr()
  let arrays = fixture["nest"].getInt() - 1
  "{\"permissions\":[\"frame\"],\"x\":" & repeat('[', arrays) & repeat(']', arrays) & "}"

proc names(node: JsonNode): seq[string] =
  if not node.isNil and node.kind == JArray:
    for item in node.items:
      result.add item.getStr()

suite "app config.json (docs/app-config-fixtures.json)":
  let fixtures = parseJson(readFile(FixturesPath))

  test "the depth is the contract's":
    check fixtures["maxDepth"].getInt() == StrictJsonMaxDepth

  test "every case":
    for fixture in fixtures["cases"]:
      let text = textOf(fixture)
      checkpoint fixture["name"].getStr()
      let config = configFromSources(%*{"config.json": text})
      check isStrictJson(text) == fixture["config"].getBool() or
        # JSON that is no object is no config either.
        (isStrictJson(text) and strictJsonObject(text).isNil)
      check (not strictJsonObject(text).isNil) == fixture["config"].getBool()
      if not fixture["config"].getBool():
        # No config: nothing asked, nothing read.
        check config.len == 0
        check grantsFromConfig(config) == (agOwnFolder, false, false, false)
        check settingsKeysFromConfig(config).len == 0
        continue
      let asked = names(fixture["permissions"])
      let grants = grantsFromConfig(config)
      let assets =
        if "assets-write" in asked: agReadWrite
        elif "assets" in asked or "files" in asked: agRead
        else: agOwnFolder
      check grants == (assets, "frame" in asked, "code" in asked, "store" in asked)
      check settingsKeysFromConfig(config) == names(fixture["settings"])

  test "an app with a config.json only this runtime could read gets nothing":
    # std/json reads comments, a trailing comma and a byte order mark; the
    # control planes' parsers do not, so they showed the owner no permissions.
    let lenient = "{\n  // a comment\n  \"permissions\": [\"frame\", \"code\", \"assets-write\", \"store\"],\n" &
      "  \"settings\": [\"openAI\"],\n}"
    check parseJson(lenient)["permissions"].len == 4
    let config = configFromSources(%*{"config.json": lenient})
    check grantsFromConfig(config) == (agOwnFolder, false, false, false)
    check settingsKeysFromConfig(config).len == 0

  test "a config.json that is no string is no config":
    check configFromSources(%*{"config.json": {"permissions": ["frame"]}}).len == 0
    check configFromSources(%*{}).len == 0
    check configFromSources(nil).len == 0
