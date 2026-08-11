# values.nim
import std/[json]
import strutils
import pixie
import options
import frameos/types

# ---------- Constructors ----------
proc VString*(s: string): Value {.inline.} = Value(kind: fkString, s: s)
proc VText*(s: string): Value {.inline.} = Value(kind: fkText, s: s)
proc VFloat*(x: float | float32 | float64): Value {.inline.} =
  Value(kind: fkFloat, f: x.float64)
proc VInt*(x: int | int32 | int64): Value {.inline.} =
  Value(kind: fkInteger, i: x.int64)
proc VBool*(x: bool): Value {.inline.} = Value(kind: fkBoolean, b: x)
proc VColor*(c: Color): Value = Value(kind: fkColor, col: c)
proc VJson*(n: JsonNode): Value {.inline.} = Value(kind: fkJson, j: n)
proc VImage*(im: Image): Value {.inline.} = Value(kind: fkImage, img: im)
proc VSpool*(sp: Spool): Value {.inline.} = Value(kind: fkSpool, sp: sp)
proc VNode*(nodeId: NodeId): Value {.inline.} = Value(kind: fkNode, nId: nodeId)
proc VScene*(sceneId: SceneId): Value {.inline.} = Value(kind: fkScene, sId: sceneId)
proc VNone*(): Value {.inline.} = Value(kind: fkNone)

# Optional: lightweight implicit conversions for convenience.
converter toValue*(s: string): Value = VString(s) # use VText(...) when you need 'text'
converter toValue*(x: int): Value = VInt(x)
converter toValue*(x: float): Value = VFloat(x)
converter toValue*(x: bool): Value = VBool(x)
converter toValue*(c: Color): Value = VColor(c)
converter toValue*(j: JsonNode): Value = VJson(j)
converter toValue*(im: Image): Value = VImage(im)
converter toValue*(sp: Spool): Value = VSpool(sp)
converter toValue*(n: NodeId): Value = VNode(n)
converter toValue*(s: SceneId): Value = VScene(s)

# ---------- Accessors (checked) ----------
template expectKind(v: Value; k: FieldKind) =
  if v.kind != k:
    raise newException(ValueError, "Value is " & $v.kind & ", expected " & $k)

proc asString*(v: Value): string =
  ## Materializes a spooled value, which is the tier floor: every existing
  ## consumer keeps working unchanged, it just pays for the bytes. Consumers
  ## that can fold incrementally should reach for `asSpool` instead.
  if v.kind == fkSpool:
    return v.sp.materialize()
  if v.kind notin {fkString, fkText}:
    raise newException(ValueError, "Value is " & $v.kind & ", expected fkString or fkText")
  v.s

proc asSpool*(v: Value): Spool =
  ## The bytes without materializing them. A plain string value answers as an
  ## in-memory spool, so a consumer written against this API does not have to
  ## care which tier it got.
  case v.kind
  of fkSpool: v.sp
  of fkString, fkText: newMemorySpool(v.s)
  else:
    raise newException(ValueError, "Value is " & $v.kind & ", expected a string or spool")
proc asFloat*(v: Value): float64 {.inline.} =
  case v.kind
  of fkFloat:
    v.f
  of fkInteger:
    v.i.float64
  else:
    raise newException(ValueError, "Value is " & $v.kind & ", expected fkFloat or fkInteger")
proc asInt*(v: Value): int64 {.inline.} = v.expectKind fkInteger; v.i
proc asBool*(v: Value): bool {.inline.} = v.expectKind fkBoolean; v.b
proc asColor*(v: Value): Color = (doAssert v.kind == fkColor; v.col)
proc asJson*(v: Value): JsonNode {.inline.} = v.expectKind fkJson; v.j
proc asImage*(v: Value): Image {.inline.} = v.expectKind fkImage; v.img
proc asNode*(v: Value): NodeId {.inline.} = v.expectKind fkNode; v.nId
proc asScene*(v: Value): SceneId {.inline.} = v.expectKind fkScene; v.sId
proc isNone*(v: Value): bool {.inline.} = v.kind == fkNone

# ---------- Debug string (safe; doesn’t dump big payloads) ----------
proc `$`*(v: Value): string =
  case v.kind
  of fkString: "string(" & $min(v.s.len, 64) & " chars)"
  of fkSpool: "spool(" & $v.sp.len & " bytes, " & (if v.sp.isFileBacked(): "file" else: "memory") & ")"
  of fkText: "text(" & $min(v.s.len, 64) & " chars)"
  of fkFloat: "float(" & $v.f & ")"
  of fkInteger: "integer(" & $v.i & ")"
  of fkBoolean: "boolean(" & $v.b & ")"
  of fkColor: "color(rgb:" & $v.col.r & "," & $v.col.g & "," & $v.col.b & ")"
  of fkJson: "json(" & $v.j.kind & ")"
  of fkImage: "image(" & $v.img.width & "x" & $v.img.height & ")"
  of fkNode: "node(" & $v.nId & ")"
  of fkScene: "scene(" & $v.sId & ")"
  of fkNone: "none"

proc approxByteSize*(j: JsonNode, depth = 0): int =
  ## Roughly how much memory a JSON tree holds. Not exact — it counts payload,
  ## not std/json's per-node overhead — and deliberately cheap, since this runs
  ## per node per render in debug mode.
  if j.isNil or depth > 32:
    return 0
  case j.kind
  of JString: result = j.getStr().len
  of JInt, JFloat: result = 8
  of JBool: result = 1
  of JNull: result = 0
  of JArray:
    for item in j.items:
      result += approxByteSize(item, depth + 1)
  of JObject:
    for key, item in j.pairs:
      result += key.len + approxByteSize(item, depth + 1)

proc approxByteSize*(v: Value): int =
  ## What this value costs to hold, for the memory profile in debug mode.
  ## Images dominate everything else by orders of magnitude, which is the whole
  ## point of measuring (docs/value-pipeline.md, phase 0).
  case v.kind
  of fkString, fkText: v.s.len
  of fkSpool:
    # What it costs to HOLD, which for a file-backed spool is a window, not the
    # body — that is the whole point of the tier.
    if v.sp.isFileBacked(): DefaultWindowBytes else: v.sp.len
  of fkJson: approxByteSize(v.j)
  of fkImage:
    if v.img.isNil: 0 else: v.img.width * v.img.height * 4
  else: 0

proc valueToJson*(v: Value): JsonNode =
  ## Convert interpreter Value -> JsonNode so we can write into scene.state.
  case v.kind
  of fkString, fkText: %* v.s
  of fkSpool: %* v.sp.materialize()
  of fkFloat: %* v.f
  of fkInteger: %* v.i
  of fkBoolean: %* v.b
  of fkColor: %* v.col.toHtmlHex # store colors as "#RRGGBB"
  of fkJson: v.j
  of fkNode: %* v.nId.int # store node ids as ints
  of fkScene: %* v.sId.string # store scene ids as strings
  of fkImage: # images cannot be serialized to json; log and drop
    newJNull()
  of fkNone:
    newJNull()

proc parseBoolish*(s: string): bool =
  let t = s.toLowerAscii()
  result = (t in ["true", "1", "yes", "y"])

proc valueFromJsonByType*(j: JsonNode; fieldType: string): Value =
  if j.isNil:
    return valueFromJsonByType(newJNull(), fieldType)

  case fieldType
  of "integer":
    var v = 0
    if j.kind == JInt:
      v = j.getInt()
    elif j.kind == JFloat:
      v = int(j.getFloat())
    elif j.kind == JString:
      try: v = parseInt(j.getStr())
      except CatchableError: discard
    return VInt(v)

  of "float":
    var v = 0.0
    if j.kind == JFloat:
      v = j.getFloat()
    elif j.kind == JInt:
      v = j.getInt().float
    elif j.kind == JString:
      try: v = parseFloat(j.getStr())
      except CatchableError: discard
    return VFloat(v)

  of "boolean":
    var v = false
    if j.kind == JBool:
      v = j.getBool()
    elif j.kind == JString:
      v = parseBoolish(j.getStr())
    return VBool(v)

  of "color":
    var c: Color
    if j.kind == JString:
      try: c = parseHtmlColor(j.getStr())
      except CatchableError: c = parseHtmlColor("#000000")
    else:
      c = parseHtmlColor("#000000")
    return VColor(c)

  of "json":
    if j.isNil:
      return VJson(%*{})
    return VJson(j)

  of "node":
    var nid = 0
    if j.kind == JInt:
      nid = j.getInt()
    elif j.kind == JFloat:
      nid = int(j.getFloat())
    elif j.kind == JString:
      try: nid = parseInt(j.getStr())
      except CatchableError: discard
    return VNode(NodeId(nid))

  of "scene":
    var sid = ""
    if j.kind == JString:
      sid = j.getStr()
    return VScene(SceneId(sid))

  # default: treat as string (string, text, select, anything unknown)
  else:
    let s = if j.kind == JString: j.getStr() else: $j
    return VString(s)

type DefaultedArg* = tuple[name: string, error: string]
  ## A code-node argument whose producer raised, plus that producer's error
  ## message, so the failure stays attributable further down the pipeline.

proc zeroValueForCodeArgType*(fieldType: string): Value =
  ## Zero value substituted for a code-node argument whose producer failed.
  ##
  ## The goal is "no data", not "undefined": one flaky data source must not take
  ## down an entire scene. So these values are picked to be maximally
  ## spread-safe and iterate-safe in JS:
  ##
  ## * string-ish types get `""` — `[...""]` yields nothing, `for (const x of "")`
  ##   runs zero times, and `"" + x` still concatenates.
  ## * `json` **and undeclared/unknown types** get an empty JSON *array*, never
  ##   `null`: `[...null]` and `for (const x of null)` both throw, while
  ##   `[...[]]` is a no-op and `Object.keys([])`/`[].map(...)` are all fine.
  ##   Declared types are unreliable in the wild (real scenes declare
  ##   `type: "string"` on args that carry JSON arrays), so when we are not sure
  ##   we pick the value that survives the most downstream shapes.
  ## * numbers/booleans/colors fall through to the existing
  ##   `valueFromJsonByType(null, …)` zero values (0, 0.0, false, #000000).
  ## * images have no spreadable zero; `fkNone` (JS `null`) is the honest answer.
  case fieldType
  of "integer", "float", "boolean", "color", "node", "scene":
    valueFromJsonByType(newJNull(), fieldType)
  of "text":
    VText("")
  of "string", "select":
    VString("")
  of "image":
    VNone()
  else:
    # "json", "" (no declaration) and anything we do not recognise
    VJson(newJArray())

proc logCodeNodeOutput*(scene: FrameScene; nodeId: NodeId; value: Value) =
  ## Log the output of a code node if it's not an image.
  let value = if value.kind == fkImage:
                %*("<image " & $value.img.width & "x" & $value.img.height & ">")
              else:
                valueToJson(value)

  let payload = %*{
    "event": "codeNode:output",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int,
    "valueKind": $value.kind,
    "value": valueToJson(value)
  }

  scene.logger.log(payload)

proc logCodeNodeOutput*[T](scene: FrameScene; nodeId: NodeId; rawValue: T) =
  ## Generic overload to convert common Nim types to Value before logging.
  when compiles(rawValue.isSome()):
    if rawValue.isSome():
      logCodeNodeOutput(scene, nodeId, rawValue.get())
    else:
      logCodeNodeOutput(scene, nodeId, VNone())
  else:
    let value: Value = rawValue
    logCodeNodeOutput(scene, nodeId, value)

proc eventPayloadValueMatches*(payload: JsonNode, key: string, expected: string): bool =
  ## Event listener filters: does the payload's value for key match the
  ## configured filter string? Empty filters match anything. Shared by the
  ## interpreter and compiled scene codegen.
  if expected.len == 0:
    return true
  if payload.isNil or payload.kind != JObject or not payload.hasKey(key):
    return false
  let value = payload[key]
  case value.kind
  of JString:
    return value.getStr() == expected
  of JInt:
    return $value.getInt() == expected
  of JFloat:
    return $value.getFloat() == expected
  of JBool:
    if value.getBool():
      return expected == "true"
    return expected == "false"
  of JNull:
    return expected == "null"
  else:
    return $value == expected
