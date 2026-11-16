## A scene's category (`settings.category`, docs/scene-icons.md "Category"):
## its name as people read it ("Photos", "Real time"), which a desktop groups
## its scene lists by (`category` on each `app.frame.scenes` entry). Nothing on
## a frame maps it to anything: it is only checked to be a short line of text.
## The SPA's `utils/sceneCategory.ts` is the same rule, pinned together by
## docs/scene-category-fixtures.json.

import std/unicode

const SceneCategoryMaxLength* = 32
  ## In characters: a heading in a menu, and it travels to every frame, an
  ## ESP32's scene index included.

{.push overflowChecks: off, rangeChecks: off, boundChecks: off.}

proc sceneCategory*(raw: string): string =
  ## `raw` with the spaces, tabs and line breaks at its ends trimmed, or ""
  ## when that is empty, longer than SceneCategoryMaxLength characters, not
  ## UTF-8, or holds a control character.
  var first = 0
  var last = raw.len - 1
  while first <= last and raw[first] in {' ', '\t', '\n', '\r', '\f', '\v'}:
    inc first
  while last >= first and raw[last] in {' ', '\t', '\n', '\r', '\f', '\v'}:
    dec last
  if last < first or last - first + 1 > SceneCategoryMaxLength * 4:
    return ""
  result = raw[first .. last]
  if validateUtf8(result) >= 0 or result.runeLen > SceneCategoryMaxLength:
    return ""
  for rune in result.runes:
    let code = rune.int
    if code < 0x20 or (code >= 0x7F and code <= 0x9F):
      return ""

{.pop.}
