## The runtime's runner of docs/scene-icon-fixtures.json: what a scene's
## `settings.icon` is (scene_icon.nim). The SPA replays the same file
## (cloud shared-spa scene-icon.test.ts), so the editor and every frame agree
## on which values are an icon.

import std/[json, os, strutils, unittest]

import ../scene_icon

const FixturesPath = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "docs" /
  "scene-icon-fixtures.json"

proc expand(value: string): string =
  ## `@long-N`: a path of exactly N characters ("M0 0", "h1"s, "z" when odd).
  if not value.startsWith("@long-"):
    return value
  let length = parseInt(value["@long-".len .. ^1])
  result = "M0 0"
  while result.len + 2 <= length:
    result.add "h1"
  if result.len < length:
    result.add "z"

suite "scene icons (docs/scene-icon-fixtures.json)":
  let fixtures = parseJson(readFile(FixturesPath))

  test "the limit is the contract's":
    check fixtures["maxLength"].getInt() == SceneIconMaxLength

  test "every case":
    for fixture in fixtures["cases"]:
      let name = fixture["name"].getStr()
      let raw = fixture["icon"]
      # The runtime reads a setting that is no string as no icon (a number is
      # read as written, which no path starts like).
      let input = if raw.kind == JString: expand(raw.getStr()) elif raw.kind == JInt: $raw.getInt() else: ""
      let expected = if fixture["path"].kind == JString: expand(fixture["path"].getStr()) else: ""
      checkpoint name
      check sceneIconPath(input) == expected
