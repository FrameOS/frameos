## Whether a text is JSON as RFC 8259 writes it, and the one reader of an
## app's config.json (docs/app-config-fixtures.json is the corpus; the SPA's
## utils/sceneAccess.ts `parseAppConfig` and the backend's utils/app_config.py
## replay it).
##
## An app's config.json is what it asks for: its `permissions`, the settings
## it reads. The control planes show and approve that from the file as
## `JSON.parse` / `json.loads` read it, and std/json reads more than they do
## (comments, a trailing comma), so a file only this runtime could read asked
## for things no plane ever showed. The rule on every side: a config.json that
## is not strict JSON, an object, and at most `StrictJsonMaxDepth` containers
## deep is no config at all. The depth is part of the rule because the three
## parsers give up at different ones (and std/json's 1000 levels are more
## stack than an ESP32 task has).
##
## A scan over the bytes, nothing allocated: flash is the budget on an ESP32.

import std/json

const StrictJsonMaxDepth* = 32

type Scan = object
  text: ptr UncheckedArray[char]
  len, at: int

{.push raises: [].}

template peek(scan: Scan): char =
  (if scan.at < scan.len: scan.text[scan.at] else: '\0')

proc blanks(scan: var Scan) =
  while scan.at < scan.len and scan.text[scan.at] in {' ', '\t', '\n', '\r'}:
    inc scan.at

proc quoted(scan: var Scan): bool =
  ## A string, from its opening quote: no raw control character, and only the
  ## escapes JSON has.
  inc scan.at
  while scan.at < scan.len:
    let ch = scan.text[scan.at]
    inc scan.at
    if ch == '"':
      return true
    if ch < ' ':
      return false
    if ch == '\\':
      let escape = scan.peek
      inc scan.at
      if escape == 'u':
        for _ in 0 ..< 4:
          if scan.peek notin {'0' .. '9', 'a' .. 'f', 'A' .. 'F'}:
            return false
          inc scan.at
      elif escape notin {'"', '\\', '/', 'b', 'f', 'n', 'r', 't'}:
        return false
  false

proc digits(scan: var Scan): bool =
  let start = scan.at
  while scan.peek in {'0' .. '9'}:
    inc scan.at
  scan.at > start

proc number(scan: var Scan): bool =
  if scan.peek == '-':
    inc scan.at
  if scan.peek == '0':
    inc scan.at
  elif not scan.digits():
    return false
  if scan.peek == '.':
    inc scan.at
    if not scan.digits():
      return false
  if scan.peek in {'e', 'E'}:
    inc scan.at
    if scan.peek in {'+', '-'}:
      inc scan.at
    if not scan.digits():
      return false
  true

proc word(scan: var Scan, text: string): bool =
  for index in 0 ..< text.len:
    if scan.at + index >= scan.len or scan.text[scan.at + index] != text[index]:
      return false
  scan.at += text.len
  true

proc value(scan: var Scan, depth: int): bool =
  scan.blanks()
  case scan.peek
  of '"':
    result = scan.quoted()
  of '{', '[':
    if depth >= StrictJsonMaxDepth:
      return false
    let close = if scan.text[scan.at] == '{': '}' else: ']'
    inc scan.at
    scan.blanks()
    if scan.peek == close:
      inc scan.at
      return true
    while true:
      if close == '}':
        scan.blanks()
        if scan.peek != '"' or not scan.quoted():
          return false
        scan.blanks()
        if scan.peek != ':':
          return false
        inc scan.at
      if not scan.value(depth + 1):
        return false
      scan.blanks()
      let next = scan.peek
      inc scan.at
      if next == close:
        return true
      if next != ',':
        return false
  of 't': result = scan.word("true")
  of 'f': result = scan.word("false")
  of 'n': result = scan.word("null")
  else: result = scan.number()

proc isStrictJson*(text: string): bool =
  ## One JSON value and nothing else, at most `StrictJsonMaxDepth` containers
  ## deep.
  if text.len == 0:
    return false
  var scan = Scan(text: cast[ptr UncheckedArray[char]](unsafeAddr text[0]), len: text.len)
  result = scan.value(0)
  if result:
    scan.blanks()
    result = scan.at == scan.len

{.pop.}

proc strictJsonObject*(text: string): JsonNode =
  ## The object `text` is, read by std/json once the scan above has said it
  ## is JSON; nil for anything else.
  if not isStrictJson(text):
    return nil
  try:
    result = parseJson(text)
    if result.kind != JObject:
      result = nil
  except CatchableError:
    result = nil
