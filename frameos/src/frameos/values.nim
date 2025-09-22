# values.nim
import std/[json]
import pixie

type
  FieldKind* = enum
    fkString, fkText, fkFloat, fkInteger, fkBoolean, fkColor, fkJson, fkImage, fkNone

  ## A compact tagged union for interpreter values.
  Value* = object
    case kind*: FieldKind
    of fkString, fkText:
      s*: string   ## same storage, different semantics via kind
    of fkFloat:
      f*: float64
    of fkInteger:
      i*: int64
    of fkBoolean:
      b*: bool
    of fkColor:
      col*: Color
    of fkJson:
      j*: JsonNode ## std/json node (ref object)
    of fkImage:
      img*: Image  ## pixie image (ref object)
    of fkNone:
      discard

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
proc VNone*(): Value {.inline.} = Value(kind: fkNone)

# Optional: lightweight implicit conversions for convenience.
converter toValue*(s: string): Value = VString(s) # use VText(...) when you need 'text'
converter toValue*(x: int): Value = VInt(x)
converter toValue*(x: float): Value = VFloat(x)
converter toValue*(x: bool): Value = VBool(x)
converter toValue*(c: Color): Value = VColor(c)
converter toValue*(j: JsonNode): Value = VJson(j)
converter toValue*(im: Image): Value = VImage(im)

# ---------- Accessors (checked) ----------
template expectKind(v: Value; k: FieldKind) =
  if v.kind != k:
    raise newException(ValueError, "Value is " & $v.kind & ", expected " & $k)

proc asString*(v: Value): string {.inline.} =
  assert v.kind in {fkString, fkText}; v.s
proc asFloat*(v: Value): float64 {.inline.} = v.expectKind fkFloat; v.f
proc asInt*(v: Value): int64 {.inline.} = v.expectKind fkInteger; v.i
proc asBool*(v: Value): bool {.inline.} = v.expectKind fkBoolean; v.b
proc asColor*(v: Value): Color = (doAssert v.kind == fkColor; v.col)
proc asJson*(v: Value): JsonNode {.inline.} = v.expectKind fkJson; v.j
proc asImage*(v: Value): Image {.inline.} = v.expectKind fkImage; v.img
proc isNone*(v: Value): bool {.inline.} = v.kind == fkNone

# ---------- Debug string (safe; doesn’t dump big payloads) ----------
proc `$`*(v: Value): string =
  case v.kind
  of fkString: "string(" & $min(v.s.len, 64) & " chars)"
  of fkText: "text(" & $min(v.s.len, 64) & " chars)"
  of fkFloat: "float(" & $v.f & ")"
  of fkInteger: "integer(" & $v.i & ")"
  of fkBoolean: "boolean(" & $v.b & ")"
  of fkColor: "color(rgb:" & $v.col.r & "," & $v.col.g & "," & $v.col.b & ")"
  of fkJson: "json(" & $v.j.kind & ")"
  of fkImage: "image(" & $v.img.width & "x" & $v.img.height & ")"
  of fkNone: "none"

# ---------- Optional: serialize the Value itself (debug / logging) ----------
# Images are represented by metadata only to avoid huge blobs.
proc toJson*(v: Value): JsonNode =
  case v.kind
  of fkString: %* {"type": "string", "value": v.s}
  of fkText: %* {"type": "text", "value": v.s}
  of fkFloat: %* {"type": "float", "value": v.f}
  of fkInteger: %* {"type": "integer", "value": v.i}
  of fkBoolean: %* {"type": "boolean", "value": v.b}
  of fkColor: %* {"type": "color", "value": [v.col.r, v.col.g, v.col.b]}
  of fkJson: %* {"type": "json", "value": v.j}
  of fkImage: %* {"type": "image", "width": v.img.width, "height": v.img.height}
  of fkNone: %* {"type": "none"}

proc fromJson*(n: JsonNode): Value =
  let t = n["type"].getStr()
  case t
  of "string": VString(n["value"].getStr())
  of "text": VText(n["value"].getStr())
  of "float": VFloat(n["value"].getFloat())
  of "integer": VInt(n["value"].getInt().int64)
  of "boolean": VBool(n["value"].getBool())
  of "color": VColor(parseHtmlColor(n["value"].getStr()))
  of "json": VJson(n["value"])
  of "image": raise newException(ValueError, "fromJson: cannot reconstruct images")
  of "none": VNone()
  else: raise newException(ValueError, "fromJson: unknown type " & t)
