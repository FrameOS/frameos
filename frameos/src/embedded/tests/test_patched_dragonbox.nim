## The embedded build's float printer (src/embedded/patched_dragonbox.nim,
## QuickJS's js_dtoa underneath) against Nim's own Dragonbox, which every other
## build uses: byte for byte, with and without the trailing ".0".

import std/[random, unittest, math]
proc nextafter(x, y: float): float {.importc, header: "<math.h>".}
import std/private/dragonbox as stock
import ../patched_dragonbox as patched

const frameosDir = currentSourcePath()[0 ..< currentSourcePath().len - "src/embedded/tests/test_patched_dragonbox.nim".len]
{.passL: frameosDir & "quickjs/libquickjs.a".}
{.passL: "-lm".}

proc stockStr(v: float, force: bool): string =
  var buf: array[65, char]
  let n = stock.toChars(buf, v, force)
  result = newString(n)
  for i in 0 ..< n: result[i] = buf[i]

proc patchedStr(v: float, force: bool): string =
  var buf: array[65, char]
  let n = patched.toChars(buf, v, force)
  result = newString(n)
  for i in 0 ..< n: result[i] = buf[i]

var mismatches = 0
proc same(v: float) =
  for force in [true, false]:
    let a = stockStr(v, force)
    let b = patchedStr(v, force)
    if a != b:
      inc mismatches
      if mismatches < 20:
        checkpoint("mismatch for bits " & $cast[uint64](v) & ": dragonbox " & a & ", js_dtoa " & b)
      check a == b

suite "patched dragonbox":
  test "special values":
    for v in [0.0, -0.0, Inf, -Inf, NaN, -NaN, 5e-324, -5e-324,
              1.7976931348623157e308, 2.2250738585072014e-308, 2.2250738585072009e-308]:
      same(v)

  test "small integers, halves and tenths":
    for i in -20_000 .. 20_000:
      same(i.float)
      same(i.float + 0.5)
      same(i.float / 10.0)
      same(i.float / 1000.0)

  test "powers of ten and their neighbours":
    for e in -330 .. 310:
      let p = pow(10.0, e.float)
      same(p)
      same(nextafter(p, Inf))
      same(nextafter(p, -Inf))
      same(-p)
      for m in [1.5, 2.0, 3.0, 9.999, 1.234567890123]:
        same(p * m)

  test "the edges of fixed notation":
    for v in [1e-7, 1.5e-7, 1e-6, 1.5e-6, 0.000001, 0.0000015, 1e16, 1e17,
              1.5e17, 1e18, 123456789012345678.0, 0.1 + 0.2, 1.0 / 3.0, 2.0 / 3.0]:
      same(v)
      same(-v)

  test "random bit patterns":
    var r = initRand(20261110)
    for _ in 0 ..< 300_000:
      let v = cast[float](r.next())
      same(v)

  test "random doubles in everyday ranges":
    var r = initRand(7)
    for _ in 0 ..< 200_000:
      same(r.rand(1.0))
      same(r.rand(10_000.0) - 5_000.0)
      same(round(r.rand(1000.0), 2))
