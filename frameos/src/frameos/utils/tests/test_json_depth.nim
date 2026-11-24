## utils/json_depth.nim: text a scene or the network made is counted through
## before a parser that calls itself once a bracket sees it, on a board.

import std/[json, strutils, unittest]
import ../json_depth

proc nested(levels: int): string =
  "[".repeat(levels) & "1" & "]".repeat(levels)

suite "json depth":
  test "counts brackets, never those inside strings":
    check jsonNestsWithin(nested(3), 3)
    check not jsonNestsWithin(nested(4), 3)
    check jsonNestsWithin("""{"a": "[[[[[[", "b": "\\", "c": "\"[[[["}""", 1)
    check not jsonNestsWithin("""{"a": [{"b": []}]}""", 3)
    check jsonNestsWithin("", 0)
    check jsonNestsWithin("]]]]", 0) # closing ones count for nothing

  test "a board refuses what nests past the firmware's bound; a host leaves it to std/json":
    let saved = jsonDepthLimit
    defer: jsonDepthLimit = saved
    jsonDepthLimit = MaxJsonDepth
    check parseJsonBounded(nested(MaxJsonDepth)).kind == JArray
    expect JsonParsingError:
      discard parseJsonBounded(nested(MaxJsonDepth + 1))
    expect JsonParsingError: # long before a stack would notice
      discard parseJsonBounded(nested(1_000_000))
    jsonDepthLimit = 0
    check parseJsonBounded(nested(500)).kind == JArray
