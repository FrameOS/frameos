## Shared machinery for the generated `app_loader.nim` files.
##
## Every app's loader used to inline the same JSON coercion once per config
## field: 38 loaders, ~700 fields, 131 KB of ESP32 flash (4% of the whole
## firmware) spent writing out the same six routines. The calendar loader alone
## was 508 lines. Now each loader emits a `const` table of field descriptors —
## name, kind, and the field's byte offset inside its own `AppConfig` — and
## hands that table to the two procs below.
##
## The descriptor templates check the Nim field's type at compile time, so a
## mismatch between the type declared in `config.json` and the one declared in
## the app's `AppConfig` is still a compile error, exactly as it was when every
## field carried its own typed assignment.

import std/[json, strutils]
import pixie
import frameos/types
import frameos/values

type
  ConfigFieldKind* = enum
    cfString, cfInt, cfFloat, cfBool, cfColor, cfNode

  ConfigField* = object
    ## One scalar field of an app's `AppConfig`, addressed by byte offset.
    name*: string
    kind*: ConfigFieldKind
    offset*: uint16

template configField*(T: typedesc, f: untyped, k: ConfigFieldKind,
                      FT: typedesc): ConfigField =
  when not (typeof(default(T).f) is FT):
    {.error: "app config field '" & astToStr(f) & "' does not hold a " & $FT.}
  ConfigField(name: astToStr(f), kind: k, offset: uint16(offsetOf(T, f)))

template cfgFieldStr*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfString, string)
template cfgFieldInt*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfInt, int)
template cfgFieldFloat*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfFloat, float)
template cfgFieldBool*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfBool, bool)
template cfgFieldColor*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfColor, Color)
template cfgFieldNode*(T: typedesc, f: untyped): ConfigField =
  configField(T, f, cfNode, NodeId)

proc applyConfigParams*(base: pointer, fields: openArray[ConfigField],
                        params: JsonNode) =
  ## Overwrite the defaults already sitting in `base` with whatever the node's
  ## `config` object carries. A field the config does not mention keeps its
  ## default, and so does one whose JSON type nothing here can read.
  ##
  ## The leniency is the one the editor and the SPA rely on and is unchanged
  ## from the inlined blocks: numbers may arrive as strings, and booleans as
  ## "true" / "1" / "yes" / "y".
  if params.isNil or params.kind != JObject:
    return
  for i in 0 ..< fields.len:
    let n = params{fields[i].name}
    if n.isNil:
      continue
    let p = cast[uint](base) + fields[i].offset.uint
    case fields[i].kind
    of cfString:
      if n.kind == JString:
        cast[ptr string](p)[] = n.getStr()
    of cfInt:
      if n.kind == JInt:
        cast[ptr int](p)[] = n.getInt().int
      elif n.kind == JFloat:
        cast[ptr int](p)[] = int(n.getFloat())
      elif n.kind == JString:
        try: cast[ptr int](p)[] = parseInt(n.getStr())
        except CatchableError: discard
    of cfFloat:
      if n.kind == JFloat:
        cast[ptr float](p)[] = n.getFloat()
      elif n.kind == JInt:
        cast[ptr float](p)[] = n.getInt().float
      elif n.kind == JString:
        try: cast[ptr float](p)[] = parseFloat(n.getStr())
        except CatchableError: discard
    of cfBool:
      if n.kind == JBool:
        cast[ptr bool](p)[] = n.getBool()
      elif n.kind == JString:
        cast[ptr bool](p)[] = n.getStr().toLowerAscii() in ["true", "1", "yes", "y"]
    of cfColor:
      if n.kind == JString:
        try: cast[ptr Color](p)[] = parseHtmlColor(n.getStr())
        except CatchableError: discard
    of cfNode:
      if n.kind == JInt:
        cast[ptr NodeId](p)[] = n.getInt().int.NodeId
      elif n.kind == JFloat:
        cast[ptr NodeId](p)[] = int(n.getFloat()).NodeId
      elif n.kind == JString:
        try: cast[ptr NodeId](p)[] = int(parseFloat(n.getStr())).NodeId
        except CatchableError: discard

proc setConfigField*(base: pointer, fields: openArray[ConfigField],
                     field: string, value: Value): bool =
  ## Runtime counterpart of the old per-app `setField` case arms: assign one
  ## wired `Value` into the config. False when `field` is not a scalar this
  ## table covers — the loader then tries its own arms and raises.
  for i in 0 ..< fields.len:
    if fields[i].name != field:
      continue
    let p = cast[uint](base) + fields[i].offset.uint
    case fields[i].kind
    of cfString: cast[ptr string](p)[] = value.asString()
    of cfInt: cast[ptr int](p)[] = value.asInt().int
    of cfFloat: cast[ptr float](p)[] = value.asFloat()
    of cfBool: cast[ptr bool](p)[] = value.asBool()
    of cfColor: cast[ptr Color](p)[] = value.asColor()
    of cfNode: cast[ptr NodeId](p)[] = value.asNode()
    return true
  false

proc cfgInt*(params: JsonNode, key: string, default: int): int =
  ## Used by the generated seq-bound expressions, which read a dimension from a
  ## sibling field before the config object exists.
  result = default
  if params.hasKey(key):
    let n = params{key}
    if n.kind == JInt: result = n.getInt().int
    elif n.kind == JFloat: result = int(n.getFloat())
    elif n.kind == JString:
      try: result = parseInt(n.getStr())
      except CatchableError: discard
