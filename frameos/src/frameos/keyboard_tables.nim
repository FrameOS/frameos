## The keyboard tables' lookups (frameos/keyboard_gen.nim, generated from
## docs/events-contract.json `keyboard`): what a Linux key number is, the
## `key` of a code that is not printable, and what a printable code means
## under a layout. The tables are packed text, read line by line: a key is a
## rare event, and a `case` per table entry was 34 KB of an ESP32 image.
##
## A frame's own layout (`customKeyboardLayout`) is the contract's shape as
## JSON, `{"inherits": "us", "keys": {"KeyY": ["z", "Z"], ...}}` (or the
## `keys` alone), packed the same way and read first; what it does not list
## is its parent's. The ESP32 ships `us` alone and reads its own from
## `keyboard.json` (embedded/esp32/main/fos_bt.c).

import std/[json, strutils]
import ./keyboard_gen

export keyboard_gen.DefaultKeyboardLayout

type
  CustomKeyboardLayout* = object
    keys*: string   ## packed lines, `code<TAB>unshifted<TAB>shifted<TAB>altGr`
    parent*: int    ## the built-in layout under it

proc lineAt(table: string, index: int): (int, int) =
  ## The bounds of line `index` of `table` ([start, end)); (0, -1) when it has
  ## no such line.
  var start = 0
  var line = 0
  while line < index:
    let next = table.find('\n', start)
    if next < 0:
      return (0, -1)
    start = next + 1
    inc line
  var stop = table.find('\n', start)
  if stop < 0:
    stop = table.len
  (start, stop)

proc linuxKeyCode*(linuxCode: int): string =
  ## The W3C KeyboardEvent.code of a Linux KEY_* number; empty when unknown.
  if linuxCode <= 0:
    return ""
  let (a, b) = lineAt(LinuxKeyCodes, linuxCode)
  if b > a: LinuxKeyCodes[a ..< b] else: ""

proc findLine(table, key: string, sep: char): int =
  ## Where the line of `table` whose first field (up to `sep` or the line's
  ## end) is `key` starts; -1 for none.
  var start = 0
  while start < table.len:
    var stop = table.find('\n', start)
    if stop < 0:
      stop = table.len
    let fieldEnd = block:
      var e = start
      while e < stop and table[e] != sep:
        inc e
      e
    if fieldEnd - start == key.len and (key.len == 0 or table.continuesWith(key, start)):
      return start
    start = stop + 1
  -1

proc keyNamedValue*(code: string): string =
  ## The `key` of a code that is not printable ("Enter", "ArrowLeft"); empty for
  ## a printable one, whose key is the layout's.
  let at = findLine(NamedKeys, code, '=')
  if at < 0:
    return ""
  var stop = NamedKeys.find('\n', at)
  if stop < 0:
    stop = NamedKeys.len
  let eq = at + code.len
  if eq < stop and NamedKeys[eq] == '=': NamedKeys[eq + 1 ..< stop] else: code

proc isKeyboardLayout*(layout: string): bool =
  layout in KeyboardLayoutIds

proc layoutIndex(layout: string): int =
  result = KeyboardLayoutIds.find(layout)
  if result < 0:
    result = max(KeyboardLayoutIds.find(DefaultKeyboardLayout), 0)

proc keyIn(table, code: string, found: var bool): (string, string, string) =
  let at = findLine(table, code, '\t')
  if at < 0:
    return
  found = true
  var stop = table.find('\n', at)
  if stop < 0:
    stop = table.len
  var fields: array[3, string]
  var start = at + code.len + 1
  for i in 0 .. 2:
    if start > stop:
      break
    var e = table.find('\t', start)
    if e < 0 or e > stop:
      e = stop
    fields[i] = table[start ..< e]
    start = e + 1
  (fields[0], fields[1], fields[2])

proc keyboardLayoutKey*(layout, code: string, custom: CustomKeyboardLayout = CustomKeyboardLayout(parent: -1)):
    (string, string, string) =
  ## What a printable `code` means under `layout` (or a frame's own, `custom`,
  ## over its parent): (unshifted, shifted, altGr); empty strings for a code
  ## the layout has no character for. An unknown layout is the default.
  var found = false
  var index = layoutIndex(layout)
  if custom.keys.len > 0:
    result = keyIn(custom.keys, code, found)
    if found:
      return
    index = max(custom.parent, 0)
  while index >= 0:
    result = keyIn(KeyboardLayoutKeys[index], code, found)
    if found:
      return
    index = KeyboardLayoutParents[index]
  if code.len == 4 and code[0 .. 2] == "Key" and code[3] in {'A' .. 'Z'}:
    return ($chr(ord(code[3]) + 32), $code[3], "")
  result = ("", "", "")

proc customKeyboardLayout*(text: string): CustomKeyboardLayout =
  ## A frame's own layout from its JSON (the module's header); raises a
  ## ValueError naming what is wrong. Empty text: none.
  result.parent = -1
  if text.len == 0:
    return
  let node = parseJson(text)
  if node.kind != JObject:
    raise newException(ValueError, "a keyboard layout is a JSON object")
  let keys = if node.hasKey("keys"): node["keys"] else: node
  if keys.kind != JObject:
    raise newException(ValueError, "`keys` is an object of codes")
  let inherits = node{"inherits"}.getStr(DefaultKeyboardLayout)
  result.parent = layoutIndex(inherits)
  for code, values in keys.pairs:
    if code.len == 0 or code.len > 32 or values.kind != JArray or values.len < 1 or values.len > 3:
      raise newException(ValueError, "`" & code & "`: [unshifted, shifted, altGr?]")
    var line = code
    for i in 0 .. 2:
      let value = if i < values.len and values[i].kind == JString: values[i].getStr() else: ""
      if value.len > 16 or '\t' in value or '\n' in value:
        raise newException(ValueError, "`" & code & "`: a short character per place")
      line.add '\t'
      line.add value
    if result.keys.len > 0:
      result.keys.add '\n'
    result.keys.add line
