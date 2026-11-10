## std/private/dragonbox for the ESP32: `$float` without Dragonbox's tables.
##
## Nim prints a float as the shortest decimal that reads back as the same
## double (Dragonbox), which links a 9.9 KB table of powers of ten. QuickJS,
## which every ESP32 image carries, has its own shortest round-trip printer
## (`js_dtoa`, what `Number.prototype.toString` uses). This module asks it for
## the digits and the exponent and lays them out exactly as Dragonbox's
## `formatDigits` does: fixed notation for a decimal point between -6 and 17,
## `d.ddde+X` outside it, `.0` after an integer when asked, `nan`, `inf`,
## `-inf`, `-0.0`.
##
## Both pick the shortest digit string that rounds back to the double and,
## between two of the same length, the one nearer the exact value.
## `tests/test_patched_dragonbox.nim` compares the two over every class of
## double (subnormals, powers of ten, integers, halves, random bit patterns).
##
## patchFile'd by config.nims on frameosEmbedded builds only; formatfloat is
## the one importer, and it calls `toChars` alone.

const dtoaMinBufferLength*: cint = 64

type JSDTOATempMem {.importc, header: "quickjs/dtoa.h", bycopy.} = object

proc js_dtoa(buf: cstring, d: cdouble, radix, nDigits, flags: cint,
             tmp: ptr JSDTOATempMem): cint {.importc, header: "quickjs/dtoa.h".}

const
  JS_DTOA_FORMAT_FREE = 0.cint
  JS_DTOA_EXP_ENABLED = cint(1 shl 2)

proc toChars*(buffer: var openArray[char]; v: float;
              forceTrailingDotZero = false): int {.noinline.} =
  var pos = 0
  if v != v:
    for c in "nan":
      buffer[pos] = c
      inc pos
    return pos
  if v < 0.0 or (v == 0.0 and 1.0 / v < 0.0):
    buffer[pos] = '-'
    inc pos
  let a = abs(v)
  if a == Inf:
    for c in "inf":
      buffer[pos] = c
      inc pos
    return pos
  if a == 0.0:
    buffer[pos] = '0'
    inc pos
    if forceTrailingDotZero:
      buffer[pos] = '.'
      buffer[pos + 1] = '0'
      inc pos, 2
    return pos

  # "d.ddde+X" / "de-X": the shortest digits, trailing zeros already gone.
  var tmp {.noinit.}: JSDTOATempMem
  var raw {.noinit.}: array[40, char]
  let rawLen = js_dtoa(cast[cstring](raw[0].addr), a.cdouble, 10, 0,
                       JS_DTOA_FORMAT_FREE or JS_DTOA_EXP_ENABLED, tmp.addr).int
  var digits {.noinit.}: array[20, char]
  var numDigits = 0
  var i = 0
  while i < rawLen and raw[i] != 'e':
    if raw[i] != '.':
      digits[numDigits] = raw[i]
      inc numDigits
    inc i
  inc i # 'e'
  let negativeExp = raw[i] == '-'
  inc i
  var sciExp = 0
  while i < rawLen:
    sciExp = sciExp * 10 + (ord(raw[i]) - ord('0'))
    inc i
  if negativeExp:
    sciExp = -sciExp
  let decimalPoint = sciExp + 1

  if -6 <= decimalPoint and decimalPoint <= 17:
    if decimalPoint <= 0:
      # 0.[000]digits
      buffer[pos] = '0'
      buffer[pos + 1] = '.'
      inc pos, 2
      for _ in 0 ..< -decimalPoint:
        buffer[pos] = '0'
        inc pos
      for k in 0 ..< numDigits:
        buffer[pos] = digits[k]
        inc pos
    elif decimalPoint < numDigits:
      # dig.its
      for k in 0 ..< numDigits:
        if k == decimalPoint:
          buffer[pos] = '.'
          inc pos
        buffer[pos] = digits[k]
        inc pos
    else:
      # digits[000]
      for k in 0 ..< numDigits:
        buffer[pos] = digits[k]
        inc pos
      for _ in numDigits ..< decimalPoint:
        buffer[pos] = '0'
        inc pos
      if forceTrailingDotZero:
        buffer[pos] = '.'
        buffer[pos + 1] = '0'
        inc pos, 2
  else:
    # dE+123 or d.igitsE+123
    buffer[pos] = digits[0]
    inc pos
    if numDigits > 1:
      buffer[pos] = '.'
      inc pos
      for k in 1 ..< numDigits:
        buffer[pos] = digits[k]
        inc pos
    buffer[pos] = 'e'
    buffer[pos + 1] = (if sciExp < 0: '-' else: '+')
    inc pos, 2
    let k = abs(sciExp)
    if k >= 100:
      buffer[pos] = chr(ord('0') + k div 100)
      inc pos
    if k >= 10:
      buffer[pos] = chr(ord('0') + (k div 10) mod 10)
      inc pos
    buffer[pos] = chr(ord('0') + k mod 10)
    inc pos
  pos
