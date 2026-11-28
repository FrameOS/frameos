## The node cache's keys (interpreter.nim `cacheLookup`): a value an input or a
## cache expression had, as 64 bits. An entry is still good while its keys
## are the same; nothing of the value is kept, so a cached node's text input
## is not held a second time in its key, and a JSON value changed in place
## later cannot change a key that was taken.
##
## Values that compare equal as JSON key the same: a string and a text, a
## scene id or a color's hex as the string, an integer and a node id; an
## object's keys in any order. An image keys by its size, a spool by its
## length and bytes (read a window at a time, never whole). 0 is no key.

import std/[json, tables]
import pixie
import frameos/types
import frameos/spool

{.push overflowChecks: off, boundChecks: off.}

type CacheKey* = uint64

const
  NoCacheKey* = 0'u64
  FnvOffset = 14695981039346656037'u64
  FnvPrime = 1099511628211'u64

proc mixByte(h: var uint64, b: uint8) {.inline.} =
  h = (h xor b.uint64) * FnvPrime

proc mixWord(h: var uint64, x: uint64) =
  for i in 0 ..< 8:
    h.mixByte(uint8((x shr (i * 8)) and 0xff))

proc mixText(h: var uint64, s: openArray[char]) =
  h.mixWord(s.len.uint64)
  for c in s:
    h.mixByte(c.uint8)

proc mixFloat(h: var uint64, f: float64) =
  h.mixByte('f'.uint8)
  # 0.0 and -0.0 are equal as JSON.
  h.mixWord(cast[uint64](if f == 0.0: 0.0 else: f))

proc mixJson(h: var uint64, j: JsonNode) =
  if j.isNil:
    h.mixByte('n'.uint8)
    return
  case j.kind
  of JNull: h.mixByte('n'.uint8)
  of JBool:
    h.mixByte('b'.uint8)
    h.mixByte(j.bval.uint8)
  of JInt:
    h.mixByte('i'.uint8)
    h.mixWord(cast[uint64](j.num))
  of JFloat: h.mixFloat(j.fnum)
  of JString:
    h.mixByte('s'.uint8)
    h.mixText(j.str)
  of JArray:
    h.mixByte('a'.uint8)
    h.mixWord(j.elems.len.uint64)
    for x in j.elems:
      h.mixJson(x)
  of JObject:
    # In any order: each member keyed alone, the keys summed.
    h.mixByte('o'.uint8)
    h.mixWord(j.fields.len.uint64)
    var sum = 0'u64
    for k, v in j.fields:
      var e = FnvOffset
      e.mixText(k)
      e.mixJson(v)
      sum += e
    h.mixWord(sum)

proc nonZero(h: uint64): CacheKey {.inline.} =
  if h == NoCacheKey: 1'u64 else: h

proc valueKey*(v: Value): CacheKey =
  ## The key of a value an input or a cache expression had.
  var h = FnvOffset
  case v.kind
  of fkString, fkText:
    h.mixByte('s'.uint8)
    h.mixText(v.s)
  of fkScene:
    h.mixByte('s'.uint8)
    h.mixText(v.sId.string)
  of fkColor:
    h.mixByte('s'.uint8)
    h.mixText(v.col.toHtmlHex)
  of fkInteger:
    h.mixByte('i'.uint8)
    h.mixWord(cast[uint64](v.i))
  of fkNode:
    h.mixByte('i'.uint8)
    h.mixWord(cast[uint64](v.nId.int64))
  of fkFloat: h.mixFloat(v.f)
  of fkBoolean:
    h.mixByte('b'.uint8)
    h.mixByte(v.b.uint8)
  of fkJson:
    # No JSON at all keys as an empty object.
    if v.j.isNil: h.mixJson(newJObject()) else: h.mixJson(v.j)
  of fkImage, fkImageSpool:
    # Images key by their size (pointer identity would be fragile), whichever
    # tier they sit in.
    let (w, ht) = if v.kind == fkImage: (v.img.width, v.img.height)
      else: (v.imgSp.width, v.imgSp.height)
    h.mixByte('m'.uint8)
    h.mixWord(w.uint64)
    h.mixWord(ht.uint64)
  of fkSpool:
    # Byte by byte, so the key depends on the bytes and not on how the tier
    # chunked them: the same body can sit in memory one render and in a file
    # the next.
    h.mixByte('p'.uint8)
    h.mixWord(v.sp.len.uint64)
    for window in v.sp.windows():
      for c in window:
        h.mixByte(c.uint8)
  of fkNone: h.mixByte('n'.uint8)
  nonZero(h)

proc fieldKey*(field: string): uint64 =
  var h = FnvOffset
  h.mixText(field)
  h

proc setInputKey*(keys: var seq[(uint64, CacheKey)], field: string, value: Value) =
  ## A field's value this run, over what the field had before in the run
  ## (the last input into a field is the one its app sees).
  let f = fieldKey(field)
  let k = valueKey(value)
  for entry in keys.mitems:
    if entry[0] == f:
      entry[1] = k
      return
  keys.add (f, k)

proc inputsKey*(keys: openArray[(uint64, CacheKey)]): CacheKey =
  ## The key of a run's inputs, in any order; NoCacheKey for none.
  if keys.len == 0:
    return NoCacheKey
  var sum = 0'u64
  for (f, k) in keys:
    var e = FnvOffset
    e.mixWord(f)
    e.mixWord(k)
    sum += e
  nonZero(sum)

{.pop.}
