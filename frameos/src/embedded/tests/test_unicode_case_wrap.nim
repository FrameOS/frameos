## The ESP32's unicode.toUpper / toLower (Rune): the firmware wraps
## `nuctoUpper` / `nuctoLower` onto QuickJS's case tables
## (embedded/esp32/components/frameos_quickjs/fos_unicode_case.c, -Wl,--wrap)
## so Nim's own tables stay out of the image. Every code point against Nim's
## std/unicode: the same rune wherever Nim maps one, and where Nim maps none,
## only a rune QuickJS's newer tables map (the frame's own JS does the same).

import std/[unittest, unicode, strutils]

const frameosDir = currentSourcePath()[0 ..< currentSourcePath().len - "src/embedded/tests/test_unicode_case_wrap.nim".len]
{.passC: "-I" & frameosDir & "quickjs".}
{.compile: frameosDir & "../embedded/esp32/components/frameos_quickjs/fos_unicode_case.c".}
{.passL: frameosDir & "quickjs/libquickjs.a".}
{.passL: "-lm".}

proc wrapUpper(c: int32): int32 {.importc: "__wrap_nuctoUpper", cdecl.}
proc wrapLower(c: int32): int32 {.importc: "__wrap_nuctoLower", cdecl.}

suite "fos_unicode_case.c against std/unicode":
  test "every code point":
    var mismatches: seq[string]
    var newer = 0
    for c in 0'i32 .. 0x10FFFF:
      for upper in [true, false]:
        let nimRune = if upper: int32(toUpper(Rune(c))) else: int32(toLower(Rune(c)))
        let wrapped = if upper: wrapUpper(c) else: wrapLower(c)
        if wrapped == nimRune:
          continue
        if nimRune == c:
          inc newer
          continue
        if mismatches.len < 20:
          mismatches.add((if upper: "upper " else: "lower ") & c.toHex(5) &
            ": std/unicode " & nimRune.toHex(5) & ", wrapped " & wrapped.toHex(5))
    check mismatches.len == 0
    for line in mismatches:
      echo line
    # Nim's tables are older Unicode than QuickJS's; a QuickJS bump may add a
    # few, a change of the wrap's rule would move this a lot.
    check newer in 250 .. 400

  test "out of range runes are left alone":
    check wrapUpper(-1) == -1
    check wrapLower(0x110000) == 0x110000

  test "the multi-letter mappings take the simple one":
    check wrapUpper(0xDF) == 0xDF      # ß, not SS
    check wrapUpper(0xFB00) == 0xFB00  # ﬀ, not FF
    check wrapLower(0x130) == 0x69     # İ -> i
    check wrapUpper(0x1F80) == 0x1F88  # ᾀ -> ᾈ
    check wrapUpper(0x1FB3) == 0x1FBC  # ᾳ -> ᾼ
    check wrapUpper(int32('a')) == int32('A')
    check wrapLower(0x0416) == 0x0436  # Ж -> ж
