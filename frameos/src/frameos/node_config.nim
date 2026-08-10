## Reads of a diagram node's static configuration.
##
## Shared by the interpreter (which needs them per render) and the planner
## (which needs them once per scene load), so the two can never drift on what
## "cache is on" or "this field is at its default" means.

import json, strutils
import frameos/values

proc jBoolOr*(j: JsonNode, key: string, default: bool): bool =
  if j.isNil or j.kind != JObject or not j.hasKey(key): return default
  let n = j[key]
  case n.kind
  of JBool: n.getBool()
  of JString: parseBoolish(n.getStr())
  of JInt: n.getInt() != 0
  of JFloat: n.getFloat() != 0.0
  else: default

proc jFloatOr*(j: JsonNode, key: string, default: float): float =
  if j.isNil or j.kind != JObject or not j.hasKey(key): return default
  let n = j[key]
  case n.kind
  of JFloat: n.getFloat()
  of JInt: n.getInt().float
  of JString:
    try: parseFloat(n.getStr())
    except CatchableError: default
  else: default

type NodeCacheConfig* = tuple[
  enabled, inputEnabled, durationEnabled: bool, durationSec: float,
  expressionEnabled: bool, expression: string]

proc readCacheConfig*(data: JsonNode): NodeCacheConfig =
  var enabled = false
  var inputEnabled = false
  var durationEnabled = false
  var durationSec = 0.0
  var expressionEnabled = false
  var expression = ""
  if not data.isNil and data.kind == JObject and
      data.hasKey("cache") and data["cache"].kind == JObject:
    let cc = data["cache"]
    enabled = jBoolOr(cc, "enabled", false)
    if enabled:
      inputEnabled = jBoolOr(cc, "inputEnabled", false)
      durationEnabled = jBoolOr(cc, "durationEnabled", false)
      if durationEnabled:
        # 60s matches the compiled codegen's default; an unparseable duration
        # must not become 0 ("expire every render")
        durationSec = jFloatOr(cc, "duration", 60.0)
      expressionEnabled = jBoolOr(cc, "expressionEnabled", false)
      if expressionEnabled:
        expression = cc{"expression"}.getStr("").strip()
        if expression == "":
          expressionEnabled = false
  (enabled, inputEnabled, durationEnabled, durationSec, expressionEnabled, expression)

proc configFieldString*(data: JsonNode, field: string): tuple[present: bool, value: string] =
  ## A node's configured value for `field`, rendered the way the planner
  ## compares it: scene JSON stores numbers as ints or as strings depending on
  ## who wrote it, so `0` and `"0"` must read the same.
  ##
  ## `present` is false when the scene JSON says nothing about the field, in
  ## which case the app's config.json default applies.
  if data.isNil or data.kind != JObject or not data.hasKey("config"):
    return (false, "")
  let config = data["config"]
  if config.kind != JObject or not config.hasKey(field):
    return (false, "")
  let n = config[field]
  if n.isNil:
    return (false, "")
  case n.kind
  of JNull: (false, "")
  of JString:
    let s = n.getStr()
    if s.len == 0: (false, "") else: (true, s)
  of JInt: (true, $n.getInt())
  of JFloat: (true, $n.getFloat())
  of JBool: (true, (if n.getBool(): "true" else: "false"))
  else: (true, $n)
