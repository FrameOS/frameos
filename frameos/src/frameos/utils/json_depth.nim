## How deep JSON may nest before it reaches a parser that calls itself once
## for every `[` and `{`: std/json does to 1000 levels, jsony without end.
##
## A Pi's threads have megabytes of stack and 1000 levels fit. An ESP32's
## render task has 40 KB, half of it QuickJS's, and text a scene made is
## anyone's: `frameos.setState("x", "[[[[…")` with a few hundred brackets was
## a stack overflow and a reset, where it should be a value that is refused.
## So on a board such text is counted through first, and anything deeper than
## the firmware's own bound for a scene (FOS_JSON_MAX_DEPTH, fos_json_guard.h)
## is a parse error like any other.

import std/json

const MaxJsonDepth* = 32
  ## The firmware's bound for a whole scene, which no scene comes near.

var jsonDepthLimit* = when defined(frameosEmbedded): MaxJsonDepth else: 0
  ## What `parseJsonBounded` holds text to; 0 leaves it to std/json's 1000.
  ## A plain number, set once (a test sets it to see what a board does).

func jsonNestsWithin*(text: openArray[char], limit: int): bool =
  ## Whether `text` never has more than `limit` brackets open at once, the
  ## ones inside strings aside. One pass, nothing built, no recursion.
  var depth = 0
  var i = 0
  while i < text.len:
    case text[i]
    of '"':
      inc i
      while i < text.len and text[i] != '"':
        if text[i] == '\\': inc i
        inc i
    of '{', '[':
      inc depth
      if depth > limit:
        return false
    of '}', ']':
      if depth > 0: dec depth
    else: discard
    inc i
  true

proc parseJsonBounded*(text: string): JsonNode =
  ## std/json's `parseJson` for text a scene or the network made.
  {.cast(gcsafe).}:
    let limit = jsonDepthLimit
  if limit > 0 and not jsonNestsWithin(text, limit):
    raise newException(JsonParsingError, "JSON nested deeper than " & $limit & " levels")
  parseJson(text)
